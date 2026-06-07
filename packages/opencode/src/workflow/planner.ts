import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect, Schema } from "effect"
import * as Option from "effect/Option"
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

export function dynamicWorkflowPlannerPrompt(objective: string) {
  return [
    "You are a workflow planner for OpenCode. Generate a TypeScript workflow file that solves the following objective.",
    "",
    `Objective: ${objective}`,
    "",
    "Generate a native OpenCode workflow module. The workflow should:",
    "1. Define clear phases that track progress",
    "2. Use ctx.agent() for steps that need model reasoning",
    "3. Use ctx.parallel() for independent steps that can run concurrently",
    "4. Use ctx.synthesize() to combine multiple agent outputs",
    "5. Use ctx.adversarial() for verification when quality matters",
    "6. Use ctx.loop() for iterative refinement",
    "7. Use ctx.forEach() for batch processing",
    "8. Use ctx.pipeline() for sequential multi-stage processing",
    "9. Log progress with ctx.log() at each major step",
    "10. Set phases with ctx.setPhase() to track progress",
    "",
    "Available ContextApi methods:",
    "- ctx.agent({ agent?, model?, prompt, schema? }) -> { data, text }",
    "- ctx.parallel(tasks, { concurrencyLimit? }) -> results[]",
    "- ctx.pipeline(items, stage1, stage2, ..., { concurrencyLimit? }) -> results[]",
    "- ctx.synthesize({ agents, prompt?, model?, agent? }) -> { data, text }",
    "- ctx.adversarial({ worker, rubric?, verifierPrompt?, verifierModel?, verifierAgent? }) -> { worker, verification: { pass: boolean, confidence: number, issues: string[], evidence: string[] } }",
    "- ctx.loop({ fn, until, maxIterations? }) -> results[] (an array containing all iteration results; use results[results.length - 1] or results.at(-1) to get the final iteration result)",
    "- ctx.forEach(items, fn, { concurrencyLimit? }) -> results[]",
    "- ctx.setPhase(phase) -> void",
    "- ctx.log(message) -> void",
    "",
    "IMPORTANT CONSTRAINTS:",
    "- ctx.synthesize({ agents }) requires agents to be full agent results ({ text, data }), not raw strings.",
    "- ctx.forEach(items, fn) can take an async callback function `fn(item, index)` that performs multiple steps and returns any custom value or prompt.",
    "- ctx.loop({ fn, until }) can take an async callback `fn(i, prev)` that performs custom logic and returns a prompt or result, and `until` can be an async function.",
    "- ctx.loop() returns an array containing all iteration results. If you need the last/final iteration result, you MUST access the last element of the returned array, for example: `const lastResult = loopResults[loopResults.length - 1]` or `const lastResult = loopResults.at(-1)`. Do NOT access fields (such as .worker, .text, or .verification) directly on the returned array itself.",
    "- Valid Agent Names: The only valid values for the `agent` parameter in `ctx.agent`, `ctx.synthesize`, `ctx.adversarial`, etc. are: 'build', 'general', and 'explore'. Do NOT use 'plan' (which is reserved for project planning and requires interactive user confirmation) or other agent names (such as 'artist', 'poet', 'writer', 'coder', etc.) under any circumstances. If you need specialized tasks, describe them in the prompt, but set the agent parameter to one of the three allowed names (or omit it to use the default agent).",
    "- ctx.adversarial({ worker }) can take an async function for `worker` that executes nested tasks and returns the final worker result.",
    "- The result of ctx.adversarial() contains a structured `verification` object: `{ pass: boolean, confidence: number, issues: string[], evidence: string[] }`. Do NOT reference `verification.text` or expect `verification` to be a string (they are undefined). To report feedback or synthesize verification results, explicitly iterate/join `verification.issues` and `verification.evidence`.",
    "- Do not invent extra fields like schema on ctx.adversarial. Put schemas only on ctx.agent calls.",
    "- Return plain serializable results from run().",
    "",
    "COORDINATION & OUTPUT QUALITY GUIDELINES:",
    "- Distinct Roles: Assign clear, specialized roles to agents using the `agent` option in `ctx.agent` (e.g., 'explore' for research/finding files, 'build' for code changes/writing, and 'general' for synthesis/verification). Only use these three valid agent names.",,,
    "- Chain-of-Custody (Context Flow): Do not run agents in isolation. Every agent's prompt must explicitly receive and reference the relevant outputs from previous agents (e.g., using string interpolation) so that the coordination is coherent and continuous.",
    "- Rigorous Rubrics: In `ctx.adversarial`, construct extremely strict and comprehensive validation criteria. Rubrics should check for edge cases, correctness, style guides, complete implementation (no placeholders), and formatting.",
    "- Iterative Quality Loop: If quality is critical, wrap worker actions and verifications in a `ctx.loop` to feed verification issues back to the worker, correcting the output iteratively until it passes the rubric or hits maxIterations.",
    "- Comprehensive Synthesis: The final synthesis step must format the inputs into a polished, executive-level markdown report, ensuring all raw agent results are merged logically, conflicts are resolved, and the final output is high-fidelity and user-ready.",
    "",
    "WORKFLOW PATTERNS (choose the best pattern for the objective):",
    "Pattern A: Fan-out Research, Pattern B: Batch Processing, Pattern C: Iterative Refinement, Pattern D: Pipeline Processing, Pattern E: Adversarial Verification.",
    "",
    "The source must be a valid TypeScript file that exports `meta` and `run(args, ctx)` directly.",
    "Prefer small, boring workflows over fancy ones. Use the fewest primitives needed.",
    "",
    "CRITICAL: Your source MUST start with exactly this structure:",
    "export const meta = {",
    "  name: 'Workflow Name',",
    "  description: 'Description',",
    "  phases: ['Phase 1']",
    "}",
    "",
    "export async function run(args: any, ctx: any) {",
    "  // your code here",
    "}"
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

  const model = input.model ?? (yield* provider.defaultModel())
  const resolved = yield* provider.getModel(model.providerID, model.modelID)
  const language = yield* provider.getLanguage(resolved)

  const system = [dynamicWorkflowPlannerPrompt(input.objective)]

  const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
  const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

  const params = {
    experimental_telemetry: undefined,
    temperature: 0.1,
    messages: [
      {
        role: "user" as const,
        content: dynamicWorkflowPlannerPrompt(input.objective),
      },
    ],
    model: language,
    schema: Object.assign(
      Schema.toStandardSchemaV1(DynamicWorkflowPlan),
      Schema.toStandardJSONSchemaV1(DynamicWorkflowPlan),
    ),
  } satisfies Parameters<typeof generateObject>[0]

  let plannerResult: any
  if (isOpenaiOauth) {
    plannerResult = yield* Effect.promise(async () => {
      const result = streamObject({
        ...params,
        providerOptions: ProviderTransform.providerOptions(resolved, {
          instructions: system.join("\n"),
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      return result.object
    })
  } else {
    plannerResult = yield* Effect.promise(() => generateObject(params).then((r) => r.object))
  }

  if (!plannerResult) {
    return yield* Effect.fail(new Error("Planner produced no structured output"))
  }

  let source = String(plannerResult.source ?? "")
  // Sanitize LLM-escaped backticks and template placeholders
  source = source.replace(/\\`/g, "`").replace(/\\\$/g, "$")
  if (!source.includes("export const meta") || !source.includes("export async function run")) {
    return yield* Effect.fail(new Error("Planner did not generate a valid workflow source"))
  }

  return {
    name: String(plannerResult.name ?? "Dynamic Workflow"),
    description: typeof plannerResult.description === "string" ? plannerResult.description : undefined,
    phases: Array.isArray(plannerResult.phases)
      ? plannerResult.phases.filter((x: unknown): x is string => typeof x === "string")
      : undefined,
    source,
  } satisfies DynamicWorkflowPlan
})