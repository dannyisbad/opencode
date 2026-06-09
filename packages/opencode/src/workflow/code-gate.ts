import ts from "typescript"
import { MetaReader } from "./meta-reader"
import { CodeTransform } from "./code-transform"

// Names the free-body→run() transform injects (the global hooks) plus the
// generated `run(args, ctx)` and its parameters. A free-body script must not
// redeclare any of these at the top level — it would shadow the preamble or
// collide with the generated wrapper. Reserving `run` also catches the common
// "wrote `run` but forgot to `export` it" mistake (it would otherwise be silently
// treated as a free-body script and the author's `run` ignored).
const RESERVED_SCRIPT_NAMES = new Set<string>([...CodeTransform.RESERVED_HOOK_NAMES, "args", "ctx", "run"])

// Static safety/shape gate for CODE-tier workflow source — the code tier's
// analogue of the declarative tier's `lint`. The LLM authors an executable
// `run(args, ctx)` module (vs the declarative compiler emitting one), so before
// that source is ever written and run we check it statically (pure, no services,
// no execution): the engine's `loadModule` later dynamic-imports the file, so
// top-level code runs — this gate is what keeps an LLM-authored module from
// importing fs/net, calling eval, or carrying a non-literal `meta`.
//
// Returns a list of human-readable problems (empty ⇒ accepted). The planner feeds
// any problems back into the same repair loop the declarative tier uses.
//
// NOTE: it deliberately does NOT ban `Date.now`/`Math.random`. opencode has no
// journaled-replay resume (the declarative compiler itself emits `Date.now()`),
// so the wall-clock/RNG bans that Claude Code's ultracode enforces for replay
// determinism would be cargo-culted constraints here that reject valid code.

// Free identifier references that grant filesystem / process / network / eval
// reach. A code workflow may only act through `ctx.agent` (which goes through the
// permission system); it has no business touching these directly.
const BANNED_IDENTIFIERS = new Set([
  "process",
  "Bun",
  "Deno",
  "globalThis",
  "__dirname",
  "__filename",
  "require",
  "module",
  "child_process",
  "fs",
  "eval",
  "Function",
])

export function gateCodeSource(source: string): string[] {
  const problems: string[] = []

  // 1. `meta` must be a statically-analyzable literal (and a valid Meta). Reusing
  //    the engine's own AST reader gives the literal-only guarantee for free.
  const meta = MetaReader.read(source, "<dynamic-code-workflow>.ts")
  if (meta.valid === false) problems.push(`meta: ${meta.error}`)

  // A free-body script (literal `meta`, no `run` export) is rewritten into a
  // `run(args, ctx)` module by the loader's transform, so it is NOT required to
  // export `run` (rule 8) — but it must not redeclare a hook/param name.
  const freeBody = CodeTransform.isFreeBodyScript(source)

  let file: ts.SourceFile
  try {
    file = ts.createSourceFile("<dynamic-code-workflow>.ts", source, ts.ScriptTarget.Latest, true)
  } catch (e) {
    return [...problems, `source is not parseable TypeScript: ${e instanceof Error ? e.message : String(e)}`]
  }

  let hasRunExport = false

  const visit = (node: ts.Node) => {
    // 2a. No module imports — the module must be self-contained.
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      problems.push("imports are not allowed — the workflow module must be self-contained and only use ctx.*")
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      problems.push("re-exports from other modules are not allowed")
    }
    // 2b. No dynamic import() / require() / eval().
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        problems.push("dynamic import() is not allowed")
      }
      if (ts.isIdentifier(node.expression) && (node.expression.text === "require" || node.expression.text === "eval")) {
        problems.push(`${node.expression.text}() is not allowed`)
      }
    }
    // 2c. No free references to filesystem/process/network/eval globals. A banned
    //     name used as a PROPERTY (`x.process`) or as a declared binding is fine;
    //     only a free value reference (`process.env`, `fs.readFile`) is rejected.
    if (ts.isIdentifier(node) && BANNED_IDENTIFIERS.has(node.text)) {
      const p = node.parent
      const isPropertyName = ts.isPropertyAccessExpression(p) && p.name === node
      const isQualifiedRight = ts.isQualifiedName(p) && p.right === node
      const isBindingName =
        (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isBindingElement(p)) &&
        (p as { name?: ts.Node }).name === node
      const isPropertyAssignmentKey = ts.isPropertyAssignment(p) && p.name === node
      if (!isPropertyName && !isQualifiedRight && !isBindingName && !isPropertyAssignmentKey) {
        problems.push(`use of "${node.text}" is not allowed — a workflow may only act through ctx.* / ctx.agent`)
      }
    }
    ts.forEachChild(node, visit)
  }

  // 3. Must export a `run` function (the entrypoint loadModule invokes) — UNLESS
  //    it is a free-body script, which the transform wraps into one. A free-body
  //    script additionally must not redeclare a reserved hook/param name.
  for (const stmt of file.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === "run" && hasExport(stmt)) hasRunExport = true
    if (ts.isVariableStatement(stmt) && hasExport(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === "run") hasRunExport = true
      }
    }
    if (freeBody) {
      const declaredNames: string[] = []
      if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) declaredNames.push(stmt.name.text)
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text !== "meta") declaredNames.push(decl.name.text)
        }
      }
      for (const name of declaredNames) {
        if (RESERVED_SCRIPT_NAMES.has(name)) {
          problems.push(`"${name}" is a reserved workflow hook/parameter name and cannot be declared at the top level`)
        }
      }
    }
  }
  if (!hasRunExport && !freeBody) {
    problems.push(
      "must export an async `run(args, ctx)` function (e.g. `export async function run(args, ctx) { … }`), or be a free-body script: `export const meta = {…}` plus a top-level body that uses the global hooks (agent/parallel/pipeline/phase/log)",
    )
  }

  visit(file)
  // De-duplicate: the same problem can fire on many nodes (e.g. several imports).
  return [...new Set(problems)]
}

function hasExport(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

export * as CodeGate from "./code-gate"
