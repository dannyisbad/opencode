import { Workflow } from "@/workflow/workflow"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { SessionPrompt } from "@/session/prompt"
import { Session } from "@/session/session"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { type GeneratePayload, type StartPayload, WorkflowApiError } from "../groups/workflow"
import path from "path"
import { planDynamicWorkflow } from "@/workflow/planner"

function apiError(error: Workflow.InvalidError | Workflow.NotFoundError) {
  if (error._tag === "WorkflowInvalidError")
    return new WorkflowApiError({ message: error.message, workflow: error.path })
  return new WorkflowApiError({ message: `Workflow not found: ${error.name}`, workflow: error.name })
}

export const workflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const workflow = yield* Workflow.Service
    const prompt = yield* SessionPrompt.Service
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const sessions = yield* Session.Service

    const list = Effect.fn("WorkflowHttpApi.list")(function* () {
      // list() never fails (broken files are reported as invalid entries), so no
      // error mapping is needed here; apiError still covers start()'s failures.
      return yield* workflow.list()
    })

    const runs = Effect.fn("WorkflowHttpApi.runs")(function* () {
      return yield* workflow.runs()
    })

    const get = Effect.fn("WorkflowHttpApi.get")(function* (ctx: { params: { id: Workflow.RunID } }) {
      // The route param is validated/branded by the params schema (RunID), so a
      // malformed id is a 400 at decode time and never reaches this handler.
      return (yield* workflow.get(ctx.params.id)) ?? null
    })

    const start = Effect.fn("WorkflowHttpApi.start")(function* (ctx: {
      params: { name: string }
      payload?: StartPayload
    }) {
      return yield* workflow
        .start({
          name: ctx.params.name,
          args: ctx.payload?.args,
          budget: ctx.payload?.budget,
          // Already branded by the StartPayload schema decode (SessionID).
          permissionSessionID: ctx.payload?.permissionSessionID,
          prompt,
        })
        .pipe(Effect.mapError(apiError))
    })

    const generate = Effect.fn("WorkflowHttpApi.generate")(function* (ctx: { payload: GeneratePayload }) {
      const cfg = yield* config.get()
      let dynamicWorkflowsEnabled = cfg.dynamic_workflows?.enabled === true
      if (!dynamicWorkflowsEnabled && ctx.payload.permissionSessionID) {
        const sess = yield* sessions
          .get(ctx.payload.permissionSessionID)
          .pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (sess?.metadata?.ultracode_enabled === true) {
          dynamicWorkflowsEnabled = true
        }
      }
      if (!dynamicWorkflowsEnabled) {
        return yield* Effect.fail(new WorkflowApiError({ message: "Dynamic workflows are disabled in config" }))
      }
      const instance = yield* InstanceState.context
      const projectRoot = instance.worktree === "/" ? instance.directory : instance.worktree
      const dynamicDir = path.join(projectRoot, ".opencode", "workflows", ".dynamic")
      const runId = Workflow.RunID.ascending()
      // Full run id, not slice(0, 8): the truncation is constant for a long
      // window, so concurrent/successive generates collided on one
      // `dynamic-job_xxxx.ts` and clobbered each other. The full id is unique.
      const workflowName = `dynamic-${runId}`
      const filepath = path.join(dynamicDir, `${workflowName}.ts`)
      const plan = yield* planDynamicWorkflow({
        objective: ctx.payload.objective,
        model: ctx.payload.model as { providerID: any; modelID: any } | undefined,
        agent: ctx.payload.agent,
        variant: ctx.payload.variant,
      }).pipe(Effect.mapError((error) => new WorkflowApiError({ message: error instanceof Error ? error.message : String(error) })))
      yield* fs
        .writeWithDirs(filepath, plan.source)
        .pipe(Effect.mapError((error) => new WorkflowApiError({ message: String(error) })))
      return yield* workflow
        .start({
          name: workflowName,
          args: ctx.payload.args,
          budget: ctx.payload.budget,
          permissionSessionID: ctx.payload.permissionSessionID,
          prompt,
          source: plan.source,
          temporary: true,
          // Same override the planner used: steer the generated workflow's
          // agents with the requested model, not just plan generation.
          model: ctx.payload.model
            ? `${ctx.payload.model.providerID}/${ctx.payload.model.modelID}`
            : undefined,
        })
        .pipe(Effect.mapError(apiError))
    })

    const cancel = Effect.fn("WorkflowHttpApi.cancel")(function* (ctx: { params: { id: Workflow.RunID } }) {
      return (yield* workflow.cancel(ctx.params.id)) ?? null
    })

    const remove = Effect.fn("WorkflowHttpApi.remove")(function* (ctx: { params: { id: Workflow.RunID } }) {
      return yield* workflow.remove(ctx.params.id)
    })

    return handlers
      .handle("list", list)
      .handle("runs", runs)
      .handle("get", get)
      .handle("start", start)
      .handle("generate", generate)
      .handle("cancel", cancel)
      .handle("remove", remove)
  }),
)
