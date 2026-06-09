import ts from "typescript"

// Transforms a Claude-Code-style "free body + global hooks" workflow script into
// the `export async function run(args, ctx)` module shape the engine executes.
//
// Claude's `Workflow` tool has the agent author a self-contained script:
//
//     export const meta = { name, description, phases } as const
//     phase("scan")
//     const found = await agent("…")
//     return found
//
// i.e. a literal `meta` export followed by a FREE top-level body that calls bare
// globals (`agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, …) and uses
// top-level `await`/`return`. opencode's engine instead calls
// `module.run(args, ctx)` with primitives hanging off `ctx`. This transform bridges
// the two WITHOUT touching the engine: it keeps the `export const meta` verbatim
// (so the static `MetaReader` still works) and wraps every other top-level statement
// inside a generated `run(args, ctx)` whose preamble binds the globals as thin
// closures over `ctx` (+ `args` from the parameter, + a `budget` object over
// `ctx.budgetRemaining`/`ctx.budgetTotal`).
//
// It fires ONLY for the free-body shape (a `export const meta` form-1 module with
// NO `run` export). Every existing shape — planner code-tier output, the declarative
// compiler's output, a hand-written `export async function run`, `export default {…}`,
// `export default workflow({…})` — carries a `run` (or no form-1 meta) and is returned
// byte-for-byte unchanged, so this is a strict no-op for them.

// Global hook names the preamble binds. A free-body script must NOT re-declare these
// at the top level (the gate enforces this) or it would shadow the preamble.
export const RESERVED_HOOK_NAMES = [
  "agent",
  "parallel",
  "pipeline",
  "phase",
  "log",
  "workflow",
  "synthesize",
  "adversarial",
  "loop",
  "forEach",
  "budget",
] as const

// The preamble injected at the top of the generated `run`. Pure JS over `ctx`/`args`
// — no imports, no banned globals — so it transpiles cleanly and never trips the gate.
// `agent` returns plain text, or the validated `.data` object when a schema is given
// (Claude's contract). `budget` is in USD (opencode meters cost in dollars, not tokens)
// with `total` null when unbudgeted, mirroring Claude's `{ total, spent(), remaining() }`.
const PREAMBLE = `
  const phase = (s) => ctx.setPhase(s)
  const log = (m) => ctx.log(m)
  const parallel = (tasks, opts) => ctx.parallel(tasks, opts)
  const pipeline = (items, ...stages) => ctx.pipeline(items, ...stages)
  const synthesize = (opts) => ctx.synthesize(opts)
  const adversarial = (opts) => ctx.adversarial(opts)
  const loop = (opts) => ctx.loop(opts)
  const forEach = (items, fn, opts) => ctx.forEach(items, fn, opts)
  const agent = async (prompt, opts = {}) => {
    const __r = await ctx.agent({ prompt, agent: opts.agentType ?? opts.agent, model: opts.model, schema: opts.schema })
    return opts.schema ? __r.data : __r.text
  }
  const budget = {
    total: Number.isFinite(ctx.budgetTotal) ? ctx.budgetTotal : null,
    remaining: () => (Number.isFinite(ctx.budgetRemaining) ? ctx.budgetRemaining : Infinity),
    spent: () => (Number.isFinite(ctx.budgetTotal) ? ctx.budgetTotal - ctx.budgetRemaining : 0),
  }
  const workflow = () => {
    throw new Error("nested workflow() is not supported in opencode workflows — author a single workflow")
  }
`

function hasExportModifier(node: ts.Node): boolean {
  return (
    (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false
  )
}

// Form-1 meta: `export const meta = <expr>`.
function isMetaStatement(stmt: ts.Statement): boolean {
  if (!ts.isVariableStatement(stmt) || !hasExportModifier(stmt)) return false
  return stmt.declarationList.declarations.some(
    (d) => ts.isIdentifier(d.name) && d.name.text === "meta" && !!d.initializer,
  )
}

// An exported `run` — `export [async] function run(...)` or `export const run = …`.
export function hasRunExport(file: ts.SourceFile): boolean {
  for (const stmt of file.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === "run" && hasExportModifier(stmt)) return true
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      if (stmt.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === "run")) return true
    }
  }
  return false
}

// True when `source` is a free-body script the transform would rewrite: a form-1
// `export const meta` with no `run` export. Used by the gate to decide whether the
// "must export run" rule applies.
export function isFreeBodyScript(source: string): boolean {
  let file: ts.SourceFile
  try {
    file = ts.createSourceFile("<workflow-script>.ts", source, ts.ScriptTarget.Latest, true)
  } catch {
    return false
  }
  return file.statements.some(isMetaStatement) && !hasRunExport(file)
}

// Remove a leading `export` modifier from a top-level statement (demote
// `export const x` → `const x`) so a stray export inside a free body becomes a
// local inside the generated `run`.
function stripExport(stmt: ts.Statement, source: string, file: ts.SourceFile): string {
  const start = stmt.getStart(file)
  const text = source.slice(start, stmt.getEnd())
  if (!hasExportModifier(stmt)) return text
  const exp = (ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined)?.find(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  )
  if (!exp) return text
  return (text.slice(0, exp.getStart(file) - start) + text.slice(exp.getEnd() - start)).replace(/^\s+/, "")
}

/**
 * Rewrite a free-body workflow script into an `export const meta` + generated
 * `export async function run(args, ctx)` module. Returns `source` unchanged when it
 * is not a free-body script (already has a `run` export, or no form-1 `meta`), or
 * when it does not parse (the gate / transpiler will surface the error).
 */
export function toRunModule(source: string): string {
  let file: ts.SourceFile
  try {
    file = ts.createSourceFile("<workflow-script>.ts", source, ts.ScriptTarget.Latest, true)
  } catch {
    return source
  }
  const metaStmt = file.statements.find(isMetaStatement)
  if (!metaStmt) return source
  if (hasRunExport(file)) return source

  const metaText = source.slice(metaStmt.getStart(file), metaStmt.getEnd())
  const body = file.statements
    .filter((stmt) => stmt !== metaStmt)
    .map((stmt) => stripExport(stmt, source, file))
    .join("\n")

  return `${metaText}\n\nexport async function run(args, ctx) {${PREAMBLE}\n${body}\n}\n`
}

export * as CodeTransform from "./code-transform"
