type WorkflowArgumentType = "string" | "number" | "boolean"

type WorkflowArgument = {
  type?: WorkflowArgumentType
  default?: unknown
  description?: string
}

type WorkflowArguments = Record<string, WorkflowArgument>

type WorkflowArgumentValue<T extends WorkflowArgument> = T["type"] extends "number"
  ? number
  : T["type"] extends "boolean"
    ? boolean
    : string

type WorkflowArgs<Args extends WorkflowArguments | undefined> = Args extends WorkflowArguments
  ? { readonly [Key in keyof Args]?: WorkflowArgumentValue<Args[Key]> }
  : Record<string, unknown>

export type WorkflowAgentInput = {
  prompt: string
  agent?: string
  model?: string
  schema?: unknown
  permissionSessionID?: string
}

export type WorkflowAgentResult = {
  data: unknown
  text: string
}

export type WorkflowParallelOptions = { concurrencyLimit?: number }
export type WorkflowPipelineOptions = { concurrencyLimit?: number }

export type WorkflowSynthesizeOptions = {
  agents: WorkflowAgentResult[]
  prompt?: string
  model?: string
  agent?: string
}

export type WorkflowAdversarialOptions = {
  worker:
    | WorkflowAgentResult
    | Promise<WorkflowAgentResult>
    | (() => WorkflowAgentResult | Promise<WorkflowAgentResult>)
    | WorkflowAgentInput
    | (() => WorkflowAgentInput | Promise<WorkflowAgentInput>)
    | any
  rubric?: string | string[]
  verifierPrompt?: string
  verifierModel?: string
  verifierAgent?: string
}

export type WorkflowAdversarialResult = {
  worker: WorkflowAgentResult
  verification: {
    pass: boolean
    confidence: number
    issues: string[]
    evidence: string[]
  }
}

export type WorkflowLoopOptions = {
  fn: (
    iteration: number,
    previous?: WorkflowAgentResult,
  ) => WorkflowAgentInput | Promise<WorkflowAgentInput> | Promise<any> | any
  until: (result: WorkflowAgentResult, iteration: number) => boolean | Promise<boolean> | any
  maxIterations?: number
}

export type WorkflowForEachOptions = { concurrencyLimit?: number }

/** A pipeline stage: receives the previous stage's output for this item plus the
 * original item, and returns the next value. The first stage's `prev` is the
 * item itself. Stages may change the type (`I → S1 → S2 …`). */
export type WorkflowPipelineStage<Prev, Item, Next> = (prev: Prev, item: Item) => Promise<Next>

/** Per-item pipeline. Each item flows through every stage SEQUENTIALLY (stage N+1
 * receives stage N's result for that item), while items run concurrently against
 * each other (no barrier between stages). Result is the last stage's output in
 * item order. Overloaded for 1..4 stages so heterogeneous types flow through.
 *
 * Each item is ISOLATED: if any stage throws, that item drops to `null` (its
 * remaining stages are skipped, the error is logged on the run) instead of
 * aborting the whole pipeline — so one bad item never kills the others. Filter
 * the result before use. Run-fatal signals (cancellation, budget) still
 * propagate. */
export interface WorkflowPipelineFn {
  <I, A>(items: readonly I[], s1: WorkflowPipelineStage<I, I, A>, options?: WorkflowPipelineOptions): Promise<(A | null)[]>
  <I, A, B>(
    items: readonly I[],
    s1: WorkflowPipelineStage<I, I, A>,
    s2: WorkflowPipelineStage<A, I, B>,
    options?: WorkflowPipelineOptions,
  ): Promise<(B | null)[]>
  <I, A, B, C>(
    items: readonly I[],
    s1: WorkflowPipelineStage<I, I, A>,
    s2: WorkflowPipelineStage<A, I, B>,
    s3: WorkflowPipelineStage<B, I, C>,
    options?: WorkflowPipelineOptions,
  ): Promise<(C | null)[]>
  <I, A, B, C, D>(
    items: readonly I[],
    s1: WorkflowPipelineStage<I, I, A>,
    s2: WorkflowPipelineStage<A, I, B>,
    s3: WorkflowPipelineStage<B, I, C>,
    s4: WorkflowPipelineStage<C, I, D>,
    options?: WorkflowPipelineOptions,
  ): Promise<(D | null)[]>
}

export type WorkflowContext = {
  /**
   * Remaining run budget in USD. Reflects the live cost cap the run was started
   * with, decremented by each agent step's actual cost. `Infinity` when the run
   * was started without a budget (unlimited — the default). Read it to make a
   * workflow budget-aware; the engine additionally fails the next `agent()` call
   * with a budget error once this reaches zero.
   */
  readonly budgetRemaining: number
  setPhase(phase: string): void
  log(message: string): void
  /**
   * Run tasks concurrently and wait for all. A task that throws is ISOLATED: it
   * resolves to `null` (the error is logged on the run) instead of aborting the
   * whole fan-out, so one flaky arm never kills its siblings. Filter the result
   * (e.g. `.filter(Boolean)`) before use. Run-fatal signals (cancellation,
   * budget exhaustion) still propagate and abort the run.
   */
  parallel<T>(tasks: readonly (() => Promise<T>)[], options?: WorkflowParallelOptions): Promise<(T | null)[]>
  pipeline: WorkflowPipelineFn
  agent(input: WorkflowAgentInput): Promise<WorkflowAgentResult>
  /**
   * Combine multiple agent outputs into one coherent result.
   * Waits for all agents, combines their outputs, and runs a synthesis agent.
   */
  synthesize(options: WorkflowSynthesizeOptions): Promise<WorkflowAgentResult>
  /**
   * Adversarial verification: run a worker, then have a verifier check it against criteria.
   * Returns the worker result plus a structured verification verdict.
   */
  adversarial(options: WorkflowAdversarialOptions): Promise<WorkflowAdversarialResult>
  /**
   * Iterate calling an agent until a condition is met or max iterations reached.
   * fn produces the agent input for each iteration; until returns true to stop.
   */
  loop(options: WorkflowLoopOptions): Promise<WorkflowAgentResult[]>
  /**
   * Fan-out over an array: spawn one agent per element, then wait for all.
   * Respects the concurrency limit by batching. Each element is ISOLATED — an
   * element whose callback throws yields `null` (logged on the run) rather than
   * aborting the fan-out; run-fatal signals (cancellation, budget) still
   * propagate. Filter the result before use.
   */
  forEach<T>(
    items: readonly T[],
    fn: (item: T, index: number) => WorkflowAgentInput | Promise<any> | any,
    options?: WorkflowForEachOptions,
  ): Promise<any[]>
}

export function workflow<const Args extends WorkflowArguments | undefined = undefined>(input: {
  name: string
  description?: string
  phases?: readonly string[]
  arguments?: Args
  run(args: WorkflowArgs<Args>, ctx: WorkflowContext): Promise<unknown>
}) {
  return {
    meta: {
      name: input.name,
      description: input.description,
      phases: input.phases,
      arguments: input.arguments,
    },
    run: input.run,
  }
}
