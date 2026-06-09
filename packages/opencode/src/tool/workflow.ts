import { BackgroundJob } from "@/background/job"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { LSP } from "@/lsp/lsp"
import { Session } from "@/session/session"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { createTwoFilesPatch } from "diff"
import path from "path"
import { Cause, Effect, Exit, Schema, Scope } from "effect"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Tool from "./tool"
import { trimDiff } from "./edit"
import { Workflow } from "@/workflow/workflow"
import { planDynamicWorkflow } from "@/workflow/planner"
import { parseModelString } from "@/workflow/resilience"
import { Config } from "@/config/config"

const WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_-]+$/
const DEFAULT_TIMEOUT = 60 * 60 * 1000

const Action = Schema.Literals(["read", "start", "wait", "inspect", "create", "generate"])
const InspectView = Schema.Literals(["summary", "logs", "agents", "agent", "result", "all"])

const Parameters = Schema.Struct({
  action: Action.annotate({
    description:
      "Workflow operation: read, start, wait, inspect, create, or generate. For a natural-language objective, use generate (the planner builds the workflow); reserve create for source the user supplied.",
  }),
  name: Schema.optional(Schema.String).annotate({
    description: "Workflow name for read/start/create. For create, this is the file name without extension.",
  }),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Workflow input arguments as a JSON object",
  }),
  // Non-negative finite, mirroring the engine/HTTP budget schema: a plain
  // Schema.Number would accept NaN/±Infinity, and a NaN cap makes the gate
  // (budgetRemaining <= 0) silently never trip — i.e. unlimited spend.
  budget: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description:
      "Optional cost cap in USD for the whole run. Agent steps stop with a budget error once the cumulative cost reaches this cap. Omit for unlimited.",
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description: "Start the workflow asynchronously and notify this session when it finishes",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Maximum milliseconds to wait for foreground start/wait before returning the running state",
  }),
  run_id: Schema.optional(Schema.String).annotate({
    description: "Workflow run id for wait/inspect",
  }),
  view: Schema.optional(InspectView).annotate({
    description: "Which part of the run to inspect: summary, logs, agents, agent, result, or all",
  }),
  agent_id: Schema.optional(Schema.String).annotate({
    description: "Agent run id to inspect when view is agent",
  }),
  source: Schema.optional(Schema.String).annotate({
    description: "Complete TypeScript workflow source for create",
  }),
  overwrite: Schema.optional(Schema.Boolean).annotate({ description: "Overwrite an existing workflow file" }),
  objective: Schema.optional(Schema.String).annotate({
    description: "Natural language objective for action=generate. The planner will create a dynamic workflow tailored to this task.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description:
      "Optional 'provider/model' override for action=generate (e.g. 'google/gemini-3.1-pro-preview'). Steers BOTH plan generation and every agent step of the generated workflow, taking precedence over the configured dynamic_workflows.model. Omit to use the configured/default model.",
  }),
  generator: Schema.optional(Schema.Literals(["code", "declarative", "auto"])).annotate({
    description:
      "Optional planner-tier override for action=generate. 'code' = the model writes the workflow as executable code (more expressive); 'declarative' = a structured plan compiled to a guaranteed-correct workflow (safer floor); 'auto' (default) routes by model capability. Omit to use the configured default.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Metadata = Record<string, unknown>

const DESCRIPTION = [
  "Manage project-local workflows through one action-based tool.",
  "Do not use workflows by default. Use this only when the user explicitly asks for a workflow, asks to create one, or confirms workflow automation.",
  "Actions:",
  "- read: return workflow metadata, arguments, phases, and path; use before start if behavior is unclear.",
  "- start: start an existing workflow. Foreground waits for completion by default; background=true returns immediately and injects a completion message later.",
  "- wait: wait for a running workflow by run_id.",
  "- inspect: inspect workflow history, logs, agents, a specific agent, result, or all details.",
  "- create: persist a .opencode/workflows/<name>.ts file FROM SOURCE THE USER SUPPLIED. Use ONLY for a workflow the user wrote (or asked you to save verbatim). Do NOT hand-author your own workflow source here to satisfy an objective — that bypasses the planner's correctness guarantees (fan-out isolation, the verify/adversarial kind, the lint/repair loop). Use generate instead.",
  "- generate (PREFER for any objective or task): turn a natural-language objective into a workflow. A deterministic planner + compiler builds a correct-by-construction multi-step workflow — minimal when the task is simple, with fan-out/synthesis/adversarial-verify only when the objective warrants it — and runs it. Whenever the user describes a TASK or OBJECTIVE, ALWAYS use generate; never write the workflow source yourself.",
  "If a generate request fails (e.g. the model was rate-limited or could not produce a plan), report the failure to the user and ask whether to retry — failures are often transient. Do NOT fall back to completing the objective by hand or writing source/task files; that silently bypasses the workflow system.",
].join("\n")

function promptOps(ctx: Tool.Context) {
  const ops = ctx.extra?.promptOps
  if (typeof ops === "object" && ops !== null && typeof Reflect.get(ops, "prompt") === "function") {
    return ops as Workflow.PromptOps
  }
  throw new Error("Workflow tools require prompt operations in the current session")
}

function workflowError(error: Workflow.InvalidError | Workflow.NotFoundError) {
  if (error._tag === "WorkflowInvalidError") return new Error(`Invalid workflow ${error.path}: ${error.message}`)
  return new Error(`Workflow not found: ${error.name}`)
}

function formatUnknown(value: unknown) {
  if (value === undefined) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

function formatWorkflow(info: Workflow.Info) {
  return [
    `<workflow name="${info.name}">`,
    `<path>${info.path}</path>`,
    `<display_name>${info.meta.name}</display_name>`,
    info.meta.description ? `<description>${info.meta.description}</description>` : undefined,
    info.meta.phases?.length ? `<phases>${info.meta.phases.join(", ")}</phases>` : undefined,
    "<arguments>",
    ...Object.entries(info.meta.arguments ?? {}).map(
      ([name, arg]) =>
        `  <argument name="${name}" type="${arg.type ?? "string"}"${arg.default === undefined ? "" : ` default=${JSON.stringify(arg.default)}`}>${arg.description ?? ""}</argument>`,
    ),
    "</arguments>",
    "</workflow>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function formatRunSummary(run: Workflow.Run) {
  return [
    `<workflow_run id="${run.id}" state="${run.status}">`,
    `<workflow>${run.workflow}</workflow>`,
    run.definition ? `<path>${run.definition.path}</path>` : undefined,
    run.definition?.temporary ? "<temporary>true</temporary>" : undefined,
    `<started_at>${new Date(run.started_at).toISOString()}</started_at>`,
    run.completed_at ? `<completed_at>${new Date(run.completed_at).toISOString()}</completed_at>` : undefined,
    run.current_phase ? `<current_phase>${run.current_phase}</current_phase>` : undefined,
    run.args ? `<args>${formatUnknown(run.args)}</args>` : undefined,
    run.error ? `<error>${run.error}</error>` : undefined,
    "</workflow_run>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function formatLogs(run: Workflow.Run) {
  if (run.logs.length === 0) return "<logs>No logs recorded.</logs>"
  return [
    "<logs>",
    ...run.logs.map((log) => {
      const phase = log.phase ? ` phase="${log.phase}"` : ""
      return `  <log time="${new Date(log.time).toISOString()}"${phase}>${log.message}</log>`
    }),
    "</logs>",
  ].join("\n")
}

function formatAgents(run: Workflow.Run, includeOutput: boolean) {
  if (run.agents.length === 0) return "<agents>No agents were run.</agents>"
  return [
    "<agents>",
    ...run.agents.flatMap((agent) => [
      `  <agent id="${agent.id}" state="${agent.status}"${agent.agent ? ` name="${agent.agent}"` : ""}>`,
      agent.phase ? `    <phase>${agent.phase}</phase>` : undefined,
      agent.session_id ? `    <session_id>${agent.session_id}</session_id>` : undefined,
      agent.model ? `    <model>${agent.model}</model>` : undefined,
      agent.tokens?.total ? `    <tokens>${agent.tokens.total}</tokens>` : undefined,
      agent.cost ? `    <cost>${agent.cost}</cost>` : undefined,
      includeOutput ? `    <prompt>${agent.prompt}</prompt>` : undefined,
      includeOutput && agent.output ? `    <output>${agent.output}</output>` : undefined,
      agent.error ? `    <error>${agent.error}</error>` : undefined,
      "  </agent>",
    ]),
    "</agents>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function formatAgent(run: Workflow.Run, id?: string) {
  if (!id) throw new Error("agent_id is required when view is agent")
  const agent = run.agents.find((item) => item.id === id)
  if (!agent) throw new Error(`Workflow agent run not found: ${id}`)
  return [
    `<workflow_agent run_id="${run.id}" id="${agent.id}" state="${agent.status}">`,
    agent.phase ? `<phase>${agent.phase}</phase>` : undefined,
    agent.agent ? `<agent>${agent.agent}</agent>` : undefined,
    agent.session_id ? `<session_id>${agent.session_id}</session_id>` : undefined,
    agent.message_id ? `<message_id>${agent.message_id}</message_id>` : undefined,
    agent.model ? `<model>${agent.model}</model>` : undefined,
    agent.tokens ? `<tokens>${formatUnknown(agent.tokens)}</tokens>` : undefined,
    agent.cost ? `<cost>${agent.cost}</cost>` : undefined,
    `<prompt>${agent.prompt}</prompt>`,
    agent.output ? `<output>${agent.output}</output>` : undefined,
    agent.error ? `<error>${agent.error}</error>` : undefined,
    "</workflow_agent>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

function formatResult(run: Workflow.Run) {
  return run.result === undefined
    ? "<result>No result recorded.</result>"
    : `<result>${formatUnknown(run.result)}</result>`
}

function formatSource(run: Workflow.Run) {
  if (!run.definition?.source) return "<source>No source recorded.</source>"
  return `<source path="${run.definition.path}">${run.definition.source}</source>`
}

function formatInspect(run: Workflow.Run, view: Schema.Schema.Type<typeof InspectView>, agentID?: string) {
  if (view === "logs") return [formatRunSummary(run), formatLogs(run)].join("\n")
  if (view === "agents") return [formatRunSummary(run), formatAgents(run, false)].join("\n")
  if (view === "agent") return formatAgent(run, agentID)
  if (view === "result") return [formatRunSummary(run), formatResult(run)].join("\n")
  if (view === "all") {
    return [formatRunSummary(run), formatLogs(run), formatAgents(run, true), formatResult(run), formatSource(run)].join(
      "\n",
    )
  }
  return [formatRunSummary(run), formatAgents(run, false), formatResult(run)].join("\n")
}

function backgroundStarted(run: Workflow.Run) {
  return [
    `<workflow_run id="${run.id}" state="running">`,
    "<summary>Workflow started in background.</summary>",
    "<instructions>You will be notified automatically when it finishes; do not poll unless the user asks for progress.</instructions>",
    "</workflow_run>",
  ].join("\n")
}

function backgroundMessage(run: Workflow.Run, state: "completed" | "error", text: string) {
  return [
    `<workflow_run id="${run.id}" state="${state}">`,
    `<summary>Background workflow ${state}: ${run.workflow}</summary>`,
    state === "completed" ? "<workflow_result>" : "<workflow_error>",
    text,
    state === "completed" ? "</workflow_result>" : "</workflow_error>",
    "</workflow_run>",
  ].join("\n")
}

function backgroundGenerateStarted(runId: string, workflow: string) {
  return [
    `<workflow_run id="${runId}" state="running">`,
    `<workflow>${workflow}</workflow>`,
    "<summary>Dynamic workflow generation and execution started in background.</summary>",
    "<instructions>The workflow is being planned and will start automatically in the background. You will be notified when it completes.</instructions>",
    "</workflow_run>",
  ].join("\n")
}

// Compact, human-readable elapsed time for the completion summary ("12s",
// "1m02s").
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}m${String(s).padStart(2, "0")}s`
}

// Strip characters that would break an XML attribute so the workflow name can be
// embedded as `label="..."` for the TUI's compact completion line.
function attrSafe(value: string): string {
  return value.replace(/["'<>\n\r]/g, " ").replace(/\s+/g, " ").trim()
}

function backgroundJobMessage(
  runId: string,
  workflow: string,
  state: "completed" | "error",
  text: string,
  durationMs?: number,
) {
  const elapsed = durationMs != null ? ` in ${formatElapsed(durationMs)}` : ""
  const elapsedAttr = durationMs != null ? ` elapsed="${formatElapsed(durationMs)}"` : ""
  // Lead with a newline so the injected completion bubble separates cleanly from
  // whatever preceded it in the conversation.
  return [
    "",
    `<workflow_run id="${runId}" state="${state}" kind="workflow" label="${attrSafe(workflow)}"${elapsedAttr}>`,
    `<summary>Dynamic workflow ${state}: ${workflow}${elapsed}</summary>`,
    state === "completed" ? "<workflow_result>" : "<workflow_error>",
    text,
    state === "completed" ? "</workflow_result>" : "</workflow_error>",
    "</workflow_run>",
  ].join("\n")
}

function sanitizeWorkflowName(name: string) {
  if (!WORKFLOW_NAME_PATTERN.test(name)) {
    throw new Error("Workflow names may only contain letters, numbers, underscores, and dashes")
  }
  return name
}

function workflowPath(directory: string, name: string) {
  return path.join(directory, ".opencode", "workflows", `${sanitizeWorkflowName(name)}.ts`)
}

function projectRoot(instance: { directory: string; worktree: string }) {
  return instance.worktree === "/" ? instance.directory : instance.worktree
}

function terminalOutput(run: Workflow.Run) {
  return [formatRunSummary(run), formatLogs(run), formatAgents(run, false), formatResult(run)].join("\n")
}

function runFailure(run: Workflow.Run) {
  if (run.status === "failed") return new Error(run.error ?? `Workflow failed: ${run.id}`)
  if (run.status === "cancelled") return new Error(`Workflow cancelled: ${run.id}`)
}

function waitForWorkflow(workflow: Workflow.Interface, run: Workflow.Run, timeout?: number) {
  return workflow
    .wait({ id: run.id, timeout })
    .pipe(Effect.map((waited) => ({ run: waited.run ?? run, timedOut: waited.timedOut })))
}

function workflowMetadata(run: Workflow.Run, background: boolean) {
  return {
    runId: run.id,
    sessionId: run.session_id,
    workflow: run.workflow,
    background,
  }
}

function startWorkflow(input: {
  workflow: Workflow.Interface
  background: BackgroundJob.Interface
  sessions: Session.Interface
  scope: Scope.Scope
  params: Params
  name: string
  source?: string
  temporary?: boolean
  ctx: Tool.Context
}) {
  return Effect.gen(function* () {
    const ops = promptOps(input.ctx)
    const run = yield* input.workflow
      .start({
        name: input.name,
        args: input.params.args,
        budget: input.params.budget,
        prompt: ops,
        permissionSessionID: input.ctx.sessionID,
        source: input.source,
        temporary: input.temporary,
      })
      .pipe(Effect.mapError(workflowError))

    yield* input.ctx.metadata({
      title: run.definition?.meta.name ?? run.workflow,
      metadata: workflowMetadata(run, input.params.background === true),
    })

    if (input.params.background) {
      const job = yield* input.background.start({
        id: run.id,
        type: "workflow",
        title: run.workflow,
        metadata: {
          ...workflowMetadata(run, true),
          parentSessionId: input.ctx.sessionID,
        },
        run: waitForWorkflow(input.workflow, run).pipe(
          Effect.flatMap((waited) => {
            const error = runFailure(waited.run)
            return error ? Effect.fail(error) : Effect.succeed(terminalOutput(waited.run))
          }),
          Effect.tap((output) =>
            input.sessions.get(input.ctx.sessionID).pipe(
              Effect.flatMap((session) =>
                ops.prompt({
                  sessionID: input.ctx.sessionID,
                  agent: session.agent ?? input.ctx.agent,
                  parts: [
                    {
                      type: "text",
                      synthetic: true,
                      text: backgroundMessage(run, "completed", output),
                    },
                  ],
                }),
              ),
              Effect.ignore,
              Effect.forkIn(input.scope, { startImmediately: true }),
            ),
          ),
          Effect.catchCause((cause) =>
            input.sessions.get(input.ctx.sessionID).pipe(
              Effect.flatMap((session) =>
                ops.prompt({
                  sessionID: input.ctx.sessionID,
                  agent: session.agent ?? input.ctx.agent,
                  parts: [
                    {
                      type: "text",
                      synthetic: true,
                      text: backgroundMessage(run, "error", Cause.pretty(cause)),
                    },
                  ],
                }),
              ),
              Effect.ignore,
              Effect.forkIn(input.scope, { startImmediately: true }),
              Effect.andThen(Effect.failCause(cause)),
            ),
          ),
        ),
      })

      return {
        title: `Workflow started: ${run.workflow}`,
        metadata: { ...workflowMetadata(run, true), jobId: job.id, timedOut: false },
        output: backgroundStarted(run),
      }
    }

    const waited = yield* waitForWorkflow(input.workflow, run, input.params.timeout ?? DEFAULT_TIMEOUT)
    return {
      title: waited.timedOut ? `Workflow still running: ${run.workflow}` : `Workflow finished: ${run.workflow}`,
      metadata: { ...workflowMetadata(run, false), jobId: "", timedOut: waited.timedOut },
      output: waited.timedOut
        ? [
            formatRunSummary(waited.run),
            '<instructions>Use the workflow tool with action="wait" and this run_id to wait for completion.</instructions>',
          ].join("\n")
        : terminalOutput(waited.run),
    }
  })
}

export const WorkflowTool = Tool.define(
  "workflow",
  Effect.gen(function* () {
    const workflow = yield* Workflow.Service
    const background = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const config = yield* Config.Service
    const scope = yield* Scope.Scope
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          if (params.action === "read") {
            if (!params.name) return yield* Effect.fail(new Error("name is required for action=read"))
            const workflows = yield* workflow.list()
            const info = workflows.find((item) => item.name === params.name)
            if (!info) return yield* Effect.fail(new Error(`Workflow not found: ${params.name}`))
            // A discovered-but-broken file must surface its load error, not a
            // misleadingly empty <workflow> block.
            if (info.valid === false) {
              return yield* Effect.fail(new Error(`Invalid workflow ${info.path}: ${info.error ?? "invalid workflow"}`))
            }
            return {
              title: `Workflow: ${info.name}`,
              metadata: { name: info.name, path: info.path },
              output: formatWorkflow(info),
            }
          }

          if (params.action === "start") {
            if (!params.name) return yield* Effect.fail(new Error("name is required for action=start"))
            const workflows = yield* workflow.list()
            if (!workflows.some((item) => item.name === params.name)) {
              return yield* Effect.fail(new Error(`Workflow not found: ${params.name}`))
            }
            yield* ctx.ask({
              permission: "workflow",
              patterns: [params.name],
              always: [params.name],
              metadata: { name: params.name, args: params.args ?? {}, background: params.background === true },
            })
            return yield* startWorkflow({ workflow, background, sessions, scope, params, name: params.name, ctx })
          }

          if (params.action === "wait") {
            if (!params.run_id) return yield* Effect.fail(new Error("run_id is required for action=wait"))
            const waited = yield* workflow.wait({
              id: Workflow.RunID.make(params.run_id),
              timeout: params.timeout ?? DEFAULT_TIMEOUT,
            })
            if (!waited.run) return yield* Effect.fail(new Error(`Workflow run not found: ${params.run_id}`))
            return {
              title: waited.timedOut
                ? `Workflow still running: ${params.run_id}`
                : `Workflow finished: ${params.run_id}`,
              metadata: { runId: params.run_id, timedOut: waited.timedOut },
              output: waited.timedOut
                ? [
                    formatRunSummary(waited.run),
                    "<instructions>The workflow is still running. Wait again later if the user needs the final result.</instructions>",
                  ].join("\n")
                : terminalOutput(waited.run),
            }
          }

          if (params.action === "inspect") {
            if (!params.run_id) return yield* Effect.fail(new Error("run_id is required for action=inspect"))
            const run = yield* workflow.get(Workflow.RunID.make(params.run_id))
            if (!run) return yield* Effect.fail(new Error(`Workflow run not found: ${params.run_id}`))
            const view = params.view ?? "summary"
            return {
              title: `Workflow run: ${run.id}`,
              metadata: { ...workflowMetadata(run, false), view },
              output: formatInspect(run, view, params.agent_id),
            }
          }

          if (params.action === "create") {
            if (!params.name) return yield* Effect.fail(new Error("name is required for action=create"))
            if (!params.source) return yield* Effect.fail(new Error("source is required for action=create"))
            const instance = yield* InstanceState.context
            const filepath = workflowPath(projectRoot(instance), params.name)
            yield* assertExternalDirectoryEffect(ctx, filepath)
            const exists = yield* fs.existsSafe(filepath)
            if (exists && !params.overwrite) {
              return yield* Effect.fail(
                new Error(`Workflow already exists: ${params.name}. Set overwrite=true to replace it.`),
              )
            }
            const previous = exists ? ((yield* fs.readFileStringSafe(filepath)) ?? "") : ""
            yield* ctx.ask({
              permission: "edit",
              patterns: [path.relative(instance.worktree, filepath)],
              always: ["*"],
              metadata: { filepath, diff: trimDiff(createTwoFilesPatch(filepath, filepath, previous, params.source)) },
            })
            yield* fs.writeWithDirs(filepath, params.source)
            yield* format.file(filepath).pipe(Effect.ignore)
            yield* events.publish(FileSystem.Event.Edited, { file: filepath })
            yield* events.publish(Watcher.Event.Updated, { file: filepath, event: exists ? "change" : "add" })
            yield* lsp.touchFile(filepath, "document")
            const workflows = yield* workflow.list()
            const info = workflows.find((item) => item.name === params.name)
            if (!info) return yield* Effect.fail(new Error(`Workflow was written but not discovered: ${params.name}`))
            // The LLM-generated source may not load (bad meta / missing run /
            // syntax error). Report that as a failure instead of claiming the file
            // was "created and validated".
            if (info.valid === false) {
              return yield* Effect.fail(new Error(`Invalid workflow ${info.path}: ${info.error ?? "invalid workflow"}`))
            }
            return {
              title: `Workflow created: ${params.name}`,
              metadata: { name: params.name, path: filepath, exists },
              output: ["Workflow file created and validated.", "", formatWorkflow(info)].join("\n"),
            }
          }

          if (params.action === "generate") {
            if (!params.objective) return yield* Effect.fail(new Error("objective is required for action=generate"))
            const cfg = yield* config.get()
            let dynamicWorkflowsEnabled = cfg.dynamic_workflows?.enabled === true
            if (!dynamicWorkflowsEnabled && ctx.sessionID) {
              const sess = yield* sessions.get(ctx.sessionID).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (sess?.metadata?.ultracode_enabled === true) {
                dynamicWorkflowsEnabled = true
              }
            }
            if (!dynamicWorkflowsEnabled) {
              return yield* Effect.fail(new Error("Dynamic workflows are disabled in config"))
            }
            const ops = promptOps(ctx)
            const instance = yield* InstanceState.context
            const projectRoot = instance.worktree === "/" ? instance.directory : instance.worktree
            // A human-friendly label for the PRE-PLAN started bubble — the planner
            // hasn't produced the real workflow name yet at this point, so derive
            // one from the objective rather than showing the opaque `dynamic-job_xxx`
            // file id. (The dashboard + completion bubble use the real planner name.)
            const objectiveLabel =
              params.objective && params.objective.length > 60
                ? params.objective.slice(0, 57).trimEnd() + "…"
                : (params.objective ?? "Dynamic workflow")
            const dynamicDir = path.join(projectRoot, ".opencode", "workflows", ".dynamic")
            const runId = Workflow.RunID.ascending()
            // Use the FULL run id: `runId.slice(0, 8)` is only `job_` + the top
            // bytes of the timestamp, which stay constant for a long window, so
            // every generate in a session collapsed to the same `dynamic-job_xxxx`
            // file and clobbered the previous one (and raced when two ran
            // concurrently). The full id is unique per run and filename-safe.
            const workflowName = `dynamic-${runId}`
            const filepath = path.join(dynamicDir, `${workflowName}.ts`)

            // Stage-B gate: a code-tier module passes the planner's static gate
            // (literal meta / no imports / has run) but may still not TYPECHECK.
            // touchFile waits for LSP diagnostics, so once it returns we can read
            // them: if the generated file has type errors, regenerate via the
            // declarative floor (correct-by-construction) and rewrite. No-op when
            // clean, when no TS LSP matches the .dynamic file, or when the
            // declarative fallback itself fails — returns the source to run.
            const typecheckGate = (file: string, source: string) =>
              Effect.gen(function* () {
                const block = LSP.Diagnostic.report(file, (yield* lsp.diagnostics())[FSUtil.normalizePath(file)] ?? [])
                if (!block) return source
                const declExit = yield* planDynamicWorkflow({
                  objective: params.objective!,
                  model: parseModelString(params.model),
                  generator: "declarative",
                }).pipe(Effect.exit)
                if (Exit.isFailure(declExit)) return source
                yield* fs.writeWithDirs(file, declExit.value.source)
                yield* format.file(file).pipe(Effect.ignore)
                yield* lsp.touchFile(file, "document")
                return declExit.value.source
              })

            yield* ctx.ask({
              permission: "workflow",
              patterns: ["generate"],
              always: ["generate"],
              metadata: { objective: params.objective, workflowName },
            })

            if (params.background !== false) {
              // The job/file is named `dynamic-<runid>`, but the planner gives the
              // workflow a real display name. Resolve it once planning completes so
              // the completion/error bubbles read e.g. "Email Validation" instead of
              // the opaque "dynamic-job_xxxx". Captured by the taps below.
              let workflowDisplayName = workflowName
              let workflowDurationMs: number | undefined
              const job = yield* background.start({
                id: runId,
                type: "workflow",
                title: workflowName,
                metadata: {
                  runId,
                  workflow: workflowName,
                  background: true,
                  parentSessionId: ctx.sessionID,
                },
                run: Effect.gen(function* () {
                  const plan = yield* planDynamicWorkflow({
                    objective: params.objective!,
                    model: parseModelString(params.model),
                    generator: params.generator,
                  })
                  workflowDisplayName = plan.name ?? workflowName
                  let generatedSource = plan.source

                  yield* fs.writeWithDirs(filepath, generatedSource)
                  yield* format.file(filepath).pipe(Effect.ignore)
                  yield* events.publish(FileSystem.Event.Edited, { file: filepath })
                  yield* events.publish(Watcher.Event.Updated, { file: filepath, event: "add" })
                  yield* lsp.touchFile(filepath, "document")
                  generatedSource = yield* typecheckGate(filepath, generatedSource)

                  const run = yield* workflow
                    .start({
                      name: workflowName,
                      args: params.args ?? {},
                      budget: params.budget,
                      prompt: ops,
                      permissionSessionID: ctx.sessionID,
                      source: generatedSource,
                      temporary: true,
                      model: params.model,
                    })
                    .pipe(Effect.mapError(workflowError))

                  const waited = yield* waitForWorkflow(workflow, run)
                  workflowDurationMs =
                    waited.run.completed_at != null ? waited.run.completed_at - waited.run.started_at : undefined
                  const error = runFailure(waited.run)
                  if (error) return yield* Effect.fail(error)
                  return terminalOutput(waited.run)
                }).pipe(
                  Effect.tap((output) =>
                    sessions.get(ctx.sessionID).pipe(
                      Effect.flatMap((session) =>
                        ops.prompt({
                          sessionID: ctx.sessionID,
                          agent: session.agent ?? ctx.agent,
                          parts: [
                            {
                              type: "text",
                              synthetic: true,
                              text: backgroundJobMessage(
                                runId,
                                workflowDisplayName,
                                "completed",
                                output,
                                workflowDurationMs,
                              ),
                            },
                          ],
                        }),
                      ),
                      Effect.ignore,
                      Effect.forkIn(scope, { startImmediately: true }),
                    ),
                  ),
                  Effect.catchCause((cause) =>
                    sessions.get(ctx.sessionID).pipe(
                      Effect.flatMap((session) =>
                        ops.prompt({
                          sessionID: ctx.sessionID,
                          agent: session.agent ?? ctx.agent,
                          parts: [
                            {
                              type: "text",
                              synthetic: true,
                              text: backgroundJobMessage(runId, workflowDisplayName, "error", Cause.pretty(cause)),
                            },
                          ],
                        }),
                      ),
                      Effect.ignore,
                      Effect.forkIn(scope, { startImmediately: true }),
                      Effect.andThen(Effect.failCause(cause)),
                    ),
                  ),
                ),
              })

              yield* ctx.metadata({
                title: objectiveLabel,
                metadata: {
                  runId,
                  workflow: objectiveLabel,
                  background: true,
                  jobId: job.id,
                },
              })

              return {
                title: `Dynamic workflow started: ${objectiveLabel}`,
                metadata: {
                  runId,
                  workflow: objectiveLabel,
                  background: true,
                  jobId: job.id,
                  timedOut: false,
                },
                output: backgroundGenerateStarted(runId, objectiveLabel),
              }
            }

            // Generation can fail (model rate-limited across the whole fallback
            // chain, or no valid plan). Catch it and return an instruction rather
            // than letting it die: a raw tool failure makes the agent silently
            // hand-do the objective (writing source/task files into the repo),
            // which bypasses the entire workflow system. Surface the failure
            // instead so the agent reports it.
            const planExit = yield* planDynamicWorkflow({
              objective: params.objective,
              model: parseModelString(params.model),
              generator: params.generator,
            }).pipe(Effect.exit)
            if (Exit.isFailure(planExit)) {
              const squashed = Cause.squash(planExit.cause)
              const reason = squashed instanceof Error ? squashed.message : String(squashed)
              return {
                title: `Dynamic workflow generation failed: ${workflowName}`,
                metadata: { runId, workflow: workflowName, background: false, jobId: "", timedOut: false },
                output: [
                  `<error>Dynamic workflow generation failed: ${reason}</error>`,
                  "<instructions>Generation failed (commonly: the model was rate-limited across all fallback models, or could not produce a valid plan). Do NOT complete the objective by hand and do NOT write any workflow source, code, or task files yourself — doing so bypasses the workflow system. Tell the user generation failed and ask whether to retry (it is often transient) or proceed a different way.</instructions>",
                ].join("\n"),
              }
            }
            let generatedSource = planExit.value.source

            // Write the generated workflow to a temporary file
            yield* fs.writeWithDirs(filepath, generatedSource)
            yield* format.file(filepath).pipe(Effect.ignore)
            yield* events.publish(FileSystem.Event.Edited, { file: filepath })
            yield* events.publish(Watcher.Event.Updated, { file: filepath, event: "add" })
            yield* lsp.touchFile(filepath, "document")
            generatedSource = yield* typecheckGate(filepath, generatedSource)

            // Start the generated workflow
            const run = yield* workflow
              .start({
                name: workflowName,
                args: params.args ?? {},
                budget: params.budget,
                prompt: ops,
                permissionSessionID: ctx.sessionID,
                source: generatedSource,
                temporary: true,
                model: params.model,
              })
              .pipe(Effect.mapError(workflowError))

            yield* ctx.metadata({
              title: run.definition?.meta.name ?? run.workflow,
              metadata: workflowMetadata(run, false),
            })

            const waited = yield* waitForWorkflow(workflow, run, params.timeout ?? DEFAULT_TIMEOUT)
            return {
              title: waited.timedOut
                ? `Dynamic workflow still running: ${run.workflow}`
                : `Dynamic workflow finished: ${run.workflow}`,
              metadata: { ...workflowMetadata(run, false), jobId: "", timedOut: waited.timedOut },
              output: waited.timedOut
                ? [
                    formatRunSummary(waited.run),
                    '<instructions>Use the workflow tool with action="wait" and this run_id to wait for completion.</instructions>',
                  ].join("\n")
                : terminalOutput(waited.run),
            }
          }

          return yield* Effect.fail(new Error(`Unsupported workflow action: ${params.action}`))
        }).pipe(Effect.orDie),
    }
  }),
)
