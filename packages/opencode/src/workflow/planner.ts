import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Cause, Effect, Exit, Schema } from "effect"
import * as Option from "effect/Option"
import { Declarative } from "./declarative"
import { modelChain, parseModelString, type ModelDesc } from "./resilience"
import { Provider } from "@/provider/provider"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { generateObject, streamObject } from "ai"
import { ProviderTransform } from "@/provider/transform"

export const DynamicWorkflowPlan = Schema.Struct({
  name: Schema.String.annotate({ description: "Display name for the workflow" }),
  description: Schema.optional(Schema.String).annotate({ description: "What the workflow does" }),
  phases: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Phase names" }),
  source: Schema.String.annotate({ description: "Complete TypeScript source code" }),
})
export type DynamicWorkflowPlan = Schema.Schema.Type<typeof DynamicWorkflowPlan>

// The DECLARATIVE planner prompt. The model returns a structured plan (data, not
// code); a deterministic compiler (declarative.ts) turns it into a correct
// workflow. The model only chooses WHAT to do — every mechanic (wiring prior
// outputs, the verify/refine loop, picking `.at(-1)`, agent sandboxing) is owned
// by the compiler/engine, so the contract-violation bugs of the code tier cannot
// occur. Minimal-by-default: the model is steered to the fewest steps that solve
// the objective rather than reflexively reaching for every primitive.
export function declarativeWorkflowPlannerPrompt(objective: string) {
  return [
    "You are a workflow planner for OpenCode. Produce a STRUCTURED PLAN (data, not code) that solves the objective.",
    "A deterministic compiler turns your plan into a correct workflow — you only choose the steps; never write code.",
    "",
    `Objective: ${objective}`,
    "",
    "Return a WorkflowPlan: { name, description, arguments?, steps[] }. You may emit a short `reasoning` field first to think.",
    "Each step has a unique `id` and a `kind`:",
    "- agent: one model call. Fields: prompt, agent?, uses?",
    "- fanout: run the prompt over many items in parallel. Fields: prompt (use {item} for the per-item value), items?: string[] OR itemsFrom?: <earlier id>, agent?, uses?",
    "- pipeline: send one input through ordered stages. Fields: stages: [{ prompt, agent? }], uses?",
    "- verify: adversarially check an earlier step against a rubric. Fields: target: <earlier id>, rubric: string[], maxRetries? (>0 re-runs an agent target with the verifier's issues)",
    "- synthesize: merge earlier steps into one result. Fields: from: [<earlier id>], prompt?, agent?",
    "",
    "WIRING: to give a step the output of earlier steps, list their ids in `uses` (or `from`/`target`/`itemsFrom`). The compiler splices those outputs into the prompt for you — NEVER write string interpolation or reference results yourself.",
    "",
    "AGENTS: the only valid `agent` values are 'build' (writing/code), 'general' (synthesis/verification), and 'explore' (research/finding files). Never use 'plan' or any other name. Omit `agent` to use the default.",
    "",
    "BE MINIMAL — this is the most important rule. Use the FEWEST steps that actually solve the objective:",
    "- a trivial ask → ONE agent step.",
    "- research/compare/gather → a fanout, optionally one synthesize.",
    "- quality genuinely matters → add ONE verify at the end.",
    "Do NOT add verify, pipelines, loops, or synthesis 'just in case'. Over-engineering a simple objective is a FAILURE, not thoroughness.",
    "",
    "BAD (over-engineered for 'summarize this directory in 3 bullets'): fanout → pipeline → synthesize → verify(maxRetries:3). This is wrong.",
    "GOOD for that objective — a single step:",
    '  { "id": "summary", "kind": "agent", "prompt": "List the files in the current directory and summarize its purpose in exactly 3 bullet points." }',
    "",
    "GOOD for a research objective:",
    '  steps: [',
    '    { "id": "find", "kind": "fanout", "agent": "explore", "prompt": "Find how {item} is implemented and used.", "items": ["auth", "caching"] },',
    '    { "id": "report", "kind": "agent", "agent": "general", "prompt": "Write a concise report of the findings.", "uses": ["find"] }',
    "  ]",
  ].join("\n")
}

export const planDynamicWorkflow = Effect.fn("Workflow.planDynamic")(function* (input: {
  objective: string
  model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  agent?: string
  variant?: string
}) {
  const providerOpt = yield* Effect.serviceOption(Provider.Service)
  const authOpt = yield* Effect.serviceOption(Auth.Service)
  const configOpt = yield* Effect.serviceOption(Config.Service)

  if (Option.isNone(providerOpt) || Option.isNone(authOpt) || Option.isNone(configOpt)) {
    return yield* Effect.fail(new Error("Required services (Provider, Auth, or Config) not found in context"))
  }

  const provider = providerOpt.value
  const auth = authOpt.value
  const config = configOpt.value

  // Resolve the model chain: primary (caller param > config.model > provider
  // default) followed by the configured fallbacks. A failure on one model —
  // notably a RATE LIMIT, which previously made the planner give up entirely and
  // the agent silently hand-do the task — advances to the next model instead of
  // aborting generation.
  const cfg = yield* config.get()
  const primary: ModelDesc = input.model ?? parseModelString(cfg.dynamic_workflows?.model) ?? (yield* provider.defaultModel())
  const chain = modelChain(primary, cfg.dynamic_workflows?.fallback_models)

  const basePrompt = declarativeWorkflowPlannerPrompt(input.objective)

  // Run the full generate → validate (schema) → lint (per-kind/reference
  // contract) → repair(3x) loop against ONE model. `lint` enforces what the flat
  // schema cannot (unique ids, references resolve to earlier steps, per-kind
  // required fields); the repair attempts feed prior problems back so the model
  // converges. tryPromise so a provider rejection (e.g. a rate limit) surfaces as
  // a catchable FAILURE — letting the outer chain advance — not an uncatchable
  // defect. Fails if the model can't produce a valid plan in 3 attempts.
  const planWithModel = (m: ModelDesc) =>
    Effect.gen(function* () {
      const resolved = yield* provider.getModel(m.providerID, m.modelID)
      const language = yield* provider.getLanguage(resolved)
      const authInfo = yield* auth.get(m.providerID).pipe(Effect.orDie)
      const isOpenaiOauth = m.providerID === "openai" && authInfo?.type === "oauth"

      const generate = (promptText: string) =>
        Effect.tryPromise({
          try: async () => {
            const params = {
              experimental_telemetry: undefined,
              temperature: 0.1,
              messages: [{ role: "user" as const, content: promptText }],
              model: language,
              schema: Object.assign(Declarative.standardSchema, Declarative.jsonSchema),
            } satisfies Parameters<typeof generateObject>[0]
            if (isOpenaiOauth) {
              const result = streamObject({
                ...params,
                providerOptions: ProviderTransform.providerOptions(resolved, { instructions: promptText, store: false }),
                onError: () => {},
              })
              for await (const part of result.fullStream) {
                if (part.type === "error") throw part.error
              }
              return result.object
            }
            return generateObject(params).then((r) => r.object)
          },
          catch: (e) => (e instanceof Error ? e : new Error(String(e))),
        })

      let problems: string[] = []
      for (let attempt = 0; attempt < 3; attempt++) {
        const promptText =
          attempt === 0
            ? basePrompt
            : [
                basePrompt,
                "",
                "Your previous plan was REJECTED. Fix EXACTLY these problems and return the corrected plan:",
                ...problems.map((p) => `- ${p}`),
              ].join("\n")
        const raw = yield* generate(promptText)
        const decoded = Declarative.decode(raw, { errors: "all" })
        if (Exit.isFailure(decoded)) {
          problems = [Cause.pretty(decoded.cause)]
          continue
        }
        problems = Declarative.lint(decoded.value)
        if (problems.length === 0) return decoded.value
      }
      return yield* Effect.fail(new Error("no valid plan after 3 attempts: " + problems.join("; ")))
    })

  // Walk the chain: the first model to yield a valid plan wins; any failure
  // (rate limit, or a weaker model that can't satisfy the lint) advances to the
  // next model. The chain is short (primary + a couple fallbacks), so trying each
  // is cheap insurance against a throttled or under-capable primary.
  let plan: Declarative.WorkflowPlan | undefined
  let lastError: unknown
  for (const m of chain) {
    const exit = yield* planWithModel(m).pipe(Effect.exit)
    if (Exit.isSuccess(exit)) {
      plan = exit.value
      break
    }
    lastError = Cause.squash(exit.cause)
  }

  if (!plan) {
    return yield* Effect.fail(
      new Error(
        `Planner could not produce a valid workflow plan (tried ${chain
          .map((m) => `${m.providerID}/${m.modelID}`)
          .join(", ")}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      ),
    )
  }

  // Deterministic compile: a linted plan becomes correct-by-construction source.
  const compiled = Declarative.compile(plan)
  return {
    name: compiled.name,
    description: compiled.description,
    phases: compiled.phases,
    source: compiled.source,
  } satisfies DynamicWorkflowPlan
})