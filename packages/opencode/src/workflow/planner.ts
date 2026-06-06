import type { Provider } from "@/provider/provider"
import type { PromptOps } from "@/workflow/workflow"
import type { SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect } from "effect"

export type DynamicWorkflowPlan = {
  name: string
  description?: string
  phases?: string[]
  source: string
}

export const DynamicWorkflowPlanSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Display name for the workflow" },
    description: { type: "string", description: "What the workflow does" },
    phases: { type: "array", items: { type: "string" }, description: "Phase names" },
    source: { type: "string", description: "Complete TypeScript source code" },
  },
  required: ["name", "description", "phases", "source"],
}

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
    "- ctx.adversarial({ worker, rubric?, verifierPrompt?, verifierModel?, verifierAgent? }) -> { worker, verification }",
    "- ctx.loop({ fn, until, maxIterations? }) -> results[]",
    "- ctx.forEach(items, fn, { concurrencyLimit? }) -> results[]",
    "- ctx.setPhase(phase) -> void",
    "- ctx.log(message) -> void",
    "",
    "IMPORTANT CONSTRAINTS:",
    "- ctx.synthesize({ agents }) requires agents to be full agent results ({ text, data }), not raw strings.",
    "- ctx.forEach(items, fn) requires fn to return a WorkflowAgentInput object for ctx.agent, not an async callback.",
    "- ctx.loop({ fn, until }) requires fn to return a WorkflowAgentInput object for ctx.agent.",
    "- ctx.adversarial({ worker }) requires worker to be an agent result object, not a function.",
    "- Do not invent extra fields like schema on ctx.adversarial. Put schemas only on ctx.agent calls.",
    "- Return plain serializable results from run().",
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
  prompt: PromptOps
  sessionID: SessionID
  objective: string
  model?: { providerID: ProviderV2.ID; modelID: ModelV2.ID }
  agent?: string
  variant?: string
}) {
  const plannerSession = yield* input.prompt.prompt({
    sessionID: input.sessionID,
    agent: input.agent ?? "plan",
    model: input.model,
    variant: input.variant,
    parts: [{ type: "text", text: dynamicWorkflowPlannerPrompt(input.objective) }],
    format: { type: "json_schema", schema: DynamicWorkflowPlanSchema },
  })
  const plannerResult =
    plannerSession.info.role === "assistant"
      ? (plannerSession.info.structured as Record<string, unknown> | undefined)
      : undefined
  if (!plannerResult) return yield* Effect.fail(new Error("Planner produced no structured output"))
  const source = String(plannerResult.source ?? "")
  if (!source.includes("export const meta") || !source.includes("export async function run")) {
    return yield* Effect.fail(new Error("Planner did not generate a valid workflow source"))
  }
  return {
    name: String(plannerResult.name ?? "Dynamic Workflow"),
    description: typeof plannerResult.description === "string" ? plannerResult.description : undefined,
    phases: Array.isArray(plannerResult.phases)
      ? plannerResult.phases.filter((x): x is string => typeof x === "string")
      : undefined,
    source,
  } satisfies DynamicWorkflowPlan
})