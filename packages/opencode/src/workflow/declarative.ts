import { Schema } from "effect"
import { Argument } from "./meta"

// The DECLARATIVE workflow tier. A planner LLM emits a flat, enum-constrained
// `WorkflowPlan` (structured data — never code), which `compile()` turns into a
// deterministic, guaranteed-correct TypeScript workflow module. Because the LLM
// never authors the code, the whole class of contract-violation bugs the script
// tier suffers from (reading `verification.text`, using the forbidden `plan`
// agent, hand-writing a broken `loop`/`until`, forgetting `.at(-1)`) is
// structurally impossible: the compiler owns every mechanic.
//
// The schema is deliberately FLAT (one `Step` struct with a `kind` discriminator
// and per-kind optional fields, intuitive key names) because flat schemas decode
// far more reliably than deep/union ones — especially under constrained decoding
// on small models. The linter (`lint`) enforces the per-kind shape the flat
// schema can't, and the planner's repair loop feeds its messages back to the
// model. This module depends only on `Schema` + the `Argument` leaf, so it never
// imports the engine (no cycle) and can be unit-tested in isolation.

const AgentName = Schema.Literals(["build", "general", "explore"])
export type AgentName = Schema.Schema.Type<typeof AgentName>

const PipelineStage = Schema.Struct({
  prompt: Schema.String,
  agent: Schema.optional(AgentName),
})

export const StepKind = Schema.Literals(["agent", "fanout", "pipeline", "verify", "synthesize"])
export type StepKind = Schema.Schema.Type<typeof StepKind>

export const Step = Schema.Struct({
  // Unique within the plan; later steps reference earlier ids to wire context.
  id: Schema.String,
  kind: StepKind,
  // agent | fanout | synthesize: the instruction for the model.
  prompt: Schema.optional(Schema.String),
  // One of build/general/explore (never `plan`). Omit to use the engine default.
  agent: Schema.optional(AgentName),
  // Ids of earlier steps whose outputs are spliced into this step's prompt.
  uses: Schema.optional(Schema.Array(Schema.String)),
  // fanout: literal item list, OR `itemsFrom` = an earlier step whose output is
  // the item list. The per-item prompt may contain `{item}`.
  items: Schema.optional(Schema.Array(Schema.String)),
  itemsFrom: Schema.optional(Schema.String),
  // pipeline: ordered stages run sequentially over a single seed.
  stages: Schema.optional(Schema.Array(PipelineStage)),
  // verify: id of the step to check; rubric drives the adversarial verifier;
  // maxRetries>0 re-runs an agent target with the verifier's issues (refine).
  target: Schema.optional(Schema.String),
  rubric: Schema.optional(Schema.Array(Schema.String)),
  maxRetries: Schema.optional(Schema.Number),
  // synthesize: ids of earlier steps to merge.
  from: Schema.optional(Schema.Array(Schema.String)),
})
export type Step = Schema.Schema.Type<typeof Step>

export const WorkflowPlan = Schema.Struct({
  // Free-text scratchpad emitted BEFORE the structured fields so the model can
  // reason without the JSON constraint degrading it. Ignored by the compiler.
  reasoning: Schema.optional(Schema.String),
  name: Schema.String,
  description: Schema.String,
  arguments: Schema.optional(Schema.Record(Schema.String, Argument)),
  steps: Schema.Array(Step),
})
export type WorkflowPlan = Schema.Schema.Type<typeof WorkflowPlan>

export const decode = Schema.decodeUnknownExit(WorkflowPlan)

// JSON schema for the planner's `generateObject` call. Same conversion the script
// planner uses for its plan schema.
export const jsonSchema = Schema.toStandardJSONSchemaV1(WorkflowPlan)
export const standardSchema = Schema.toStandardSchemaV1(WorkflowPlan)

// ---------------------------------------------------------------------------
// Semantic lint — the per-kind contract the flat schema cannot express. Returns
// a list of human-readable problems (empty ⇒ valid). The planner feeds any
// problems back to the model verbatim as a repair instruction.
// ---------------------------------------------------------------------------
export function lint(plan: WorkflowPlan): string[] {
  const errors: string[] = []
  if (plan.steps.length === 0) errors.push("steps must contain at least one step")

  // All ids are known up front so a reference to a LATER step is reported as a
  // forward reference rather than "unknown". Duplicates are caught here too.
  const allIds = new Set<string>()
  for (const step of plan.steps) {
    if (step.id && allIds.has(step.id)) errors.push(`duplicate step id "${step.id}"`)
    if (step.id) allIds.add(step.id)
  }
  const byId = new Map(plan.steps.map((s) => [s.id, s] as const))

  const seen = new Set<string>()
  // A ref is valid only if it points at a step defined STRICTLY earlier — this
  // also rules out cycles and forward references.
  const earlier = (ref: string, at: number, label: string) => {
    if (!allIds.has(ref)) errors.push(`step #${at + 1} (${label}) references unknown step id "${ref}"`)
    else if (!seen.has(ref)) errors.push(`step #${at + 1} (${label}) references "${ref}" which is not defined before it`)
  }

  plan.steps.forEach((step, i) => {
    const where = `${step.kind} "${step.id}"`
    if (!step.id) errors.push(`step #${i + 1} has an empty id`)
    ;(step.uses ?? []).forEach((u) => earlier(u, i, `${where} uses`))

    switch (step.kind) {
      case "agent":
        if (!step.prompt) errors.push(`${where} requires a prompt`)
        break
      case "fanout":
        if (!step.prompt) errors.push(`${where} requires a prompt (use {item} for the per-item value)`)
        if (!!step.items === !!step.itemsFrom)
          errors.push(`${where} needs exactly one of "items" (a literal list) or "itemsFrom" (an earlier step id)`)
        if (step.itemsFrom) earlier(step.itemsFrom, i, `${where} itemsFrom`)
        break
      case "pipeline":
        if (!step.stages || step.stages.length === 0) errors.push(`${where} requires at least one stage`)
        break
      case "verify":
        if (!step.target) errors.push(`${where} requires a target step id`)
        else {
          earlier(step.target, i, `${where} target`)
          const t = byId.get(step.target)
          if ((step.maxRetries ?? 0) > 0 && t && t.kind !== "agent")
            errors.push(`${where} has maxRetries>0 but target "${step.target}" is a ${t.kind} step — only an agent target can be refined`)
        }
        if (!step.rubric || step.rubric.length === 0) errors.push(`${where} should provide a non-empty rubric`)
        break
      case "synthesize":
        if (!step.from || step.from.length === 0) errors.push(`${where} requires "from" (earlier step ids to merge)`)
        ;(step.from ?? []).forEach((f) => earlier(f, i, `${where} from`))
        break
    }
    seen.add(step.id)
  })
  return errors
}

// ---------------------------------------------------------------------------
// Compiler — a LINTED plan → a deterministic workflow module source string. The
// output is intentionally readable (one labelled `ctx.*` call per step, prior
// outputs wired in explicitly) so a human can audit exactly what will run. All
// embedded strings go through `j` (JSON.stringify), so prompts with quotes,
// newlines, backticks or `${}` are safe with zero escaping games — the bug that
// plagued the script tier.
// ---------------------------------------------------------------------------
const j = (v: unknown) => JSON.stringify(v ?? null)

function emitMeta(plan: WorkflowPlan): string {
  const phases = plan.steps.map((s) => s.id)
  const fields = [
    `name: ${j(plan.name)}`,
    `description: ${j(plan.description)}`,
    `phases: ${j(phases)}`,
    plan.arguments ? `arguments: ${j(plan.arguments)}` : undefined,
  ].filter(Boolean)
  return `export const meta = {\n  ${fields.join(",\n  ")},\n} as const`
}

// `agent: "x", ` prefix for a ctx call, or "" when the step omits the agent
// (so the engine default applies).
const agentField = (agent?: string) => (agent ? `agent: ${j(agent)}, ` : "")
// Appends `+ prior([...])` when a step pulls in earlier outputs.
const usesExpr = (uses?: readonly string[]) => (uses && uses.length ? ` + prior(${j(uses)})` : "")

function emitStep(step: Step, byId: Map<string, Step>): string {
  const id = j(step.id)
  const head = `  ctx.setPhase(${id})\n  ctx.log(${j(`▶ ${step.kind}: ${step.id}`)})`
  switch (step.kind) {
    case "agent":
      return `${head}
  results[${id}] = await ctx.agent({ ${agentField(step.agent)}prompt: ${j(step.prompt)}${usesExpr(step.uses)} })`
    case "fanout": {
      const itemsExpr = step.items ? j(step.items) : `asItems(results[${j(step.itemsFrom)}])`
      return `${head}
  results[${id}] = await ctx.parallel(
    (${itemsExpr}).map((item) => () =>
      ctx.agent({ ${agentField(step.agent)}prompt: ${j(step.prompt)}.replaceAll("{item}", String(item))${usesExpr(step.uses)} }),
    ),
  )`
    }
    case "pipeline": {
      const stages = (step.stages ?? [])
        .map(
          (st) =>
            `    async (prev) => (await ctx.agent({ ${agentField(st.agent)}prompt: ${j(st.prompt)} + "\\n\\n" + textOf(prev) })).text`,
        )
        .join(",\n")
      return `${head}
  results[${id}] = (await ctx.pipeline(
    [${j(step.prompt ?? "")}${usesExpr(step.uses)}],
${stages},
  ))[0]`
    }
    case "verify": {
      const target = byId.get(step.target!)
      const rubric = j(step.rubric ?? [])
      const retries = Math.max(0, Math.floor(step.maxRetries ?? 0))
      // Refine only when the target is an agent step (we have its prompt/agent to
      // re-run with the verifier's issues). Otherwise a single adversarial check.
      const refine =
        retries > 0 && target?.kind === "agent"
          ? `
    for (let i = 0; i < ${retries}; i++) {
      const v = await ctx.adversarial({ worker: () => current, rubric: ${rubric} })
      if (v.verification.pass) return v
      current = await ctx.agent({ ${agentField(target.agent)}prompt: ${j(target.prompt)} + "\\n\\nRevise to fix these issues:\\n" + v.verification.issues.join("\\n") })
    }`
          : ""
      return `${head}
  results[${id}] = await (async () => {
    let current = results[${j(step.target)}]${refine}
    return await ctx.adversarial({ worker: () => current, rubric: ${rubric} })
  })()`
    }
    case "synthesize": {
      const agents = (step.from ?? []).map((f) => `results[${j(f)}]`).join(", ")
      return `${head}
  results[${id}] = await ctx.synthesize({ ${agentField(step.agent)}prompt: ${j(step.prompt ?? "Synthesize the inputs into one coherent result.")}, agents: [${agents}].flat().filter((a) => a && typeof a === "object" && "text" in a) })`
    }
  }
}

export function compile(plan: WorkflowPlan): { name: string; description: string; phases: string[]; source: string } {
  const byId = new Map(plan.steps.map((s) => [s.id, s] as const))
  const lastId = plan.steps[plan.steps.length - 1]?.id
  const body = plan.steps.map((s) => emitStep(s, byId)).join("\n\n")
  const source = `// AUTO-GENERATED from a declarative workflow plan — do not edit by hand.
// Regenerate from the plan instead (compiler: src/workflow/declarative.ts).
${emitMeta(plan)}

export async function run(args: any, ctx: any) {
  const results: Record<string, any> = {}
  // Coerce any prior result to display text for prompt-splicing.
  const textOf = (r: any) =>
    r == null ? "" : typeof r === "string" ? r : typeof r === "object" && "text" in r ? r.text ?? "" : JSON.stringify(r)
  // Build a "Context from previous steps" block from referenced step ids.
  const prior = (ids: string[]) => {
    const blocks = ids.map((id) => "\\n\\n## " + id + "\\n" + textOf(results[id])).join("")
    return blocks ? "\\n\\nContext from previous steps:" + blocks : ""
  }
  // Turn a prior result into a fan-out item list: an array as-is, a {data:[]}'s
  // array, else the text split into non-empty lines.
  const asItems = (r: any): any[] =>
    Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : String(textOf(r)).split("\\n").map((s) => s.trim()).filter(Boolean)

${body}

  return ${lastId ? `results[${j(lastId)}] ?? null` : "null"}
}
`
  return { name: plan.name, description: plan.description, phases: plan.steps.map((s) => s.id), source }
}

export * as Declarative from "./declarative"
