import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { Ide } from "@/ide"


import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { Workflow } from "@/workflow/workflow"
import { Config } from "@/config/config"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const workflow = yield* Workflow.Service
    const config = yield* Config.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
            ...getIdeContext(),
          ].join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        const disabled = Permission.disabled(["skill", "workflow"], agent.permission)
        const cfg = yield* config.get()
        const dynamicWorkflowsEnabled = cfg.dynamic_workflows?.enabled === true

        const skillList = disabled.has("skill") ? [] : yield* skill.available(agent)
        const workflowList = disabled.has("workflow")
          ? []
          : yield* workflow.list().pipe(Effect.catch(() => Effect.succeed([])))

        const sections: (string | undefined)[] = [
          skillList.length
            ? [
                "Skills provide specialized instructions and workflows for specific tasks.",
                "Use the skill tool to load a skill when a task matches its description.",
                // the agents seem to ingest the information about skills a bit better if we present a more verbose
                // version of them here and a less verbose version in tool description, rather than vice versa.
                Skill.fmt(skillList, { verbose: true }),
              ].join("\n")
            : undefined,
          workflowList.length
            ? [
                "Workflows are project-local multi-step automations that can run agents, phases, and structured processes.",
                "Do not use workflows by default. Use the workflow tool only when the user asks for a workflow, asks to create one, or clearly confirms workflow automation.",
                'Use the workflow tool with action="read" for details before starting a workflow if the arguments or behavior are unclear.',
                Workflow.fmt(workflowList),
              ].join("\n")
            : undefined,
          dynamicWorkflowsEnabled && !disabled.has("workflow")
            ? [
                "Dynamic workflows are enabled. When the user mentions 'ultracode', 'workflow', or 'workflows', or when a complex task would benefit from multi-agent orchestration (parallel agents, verification loops, batch processing), use the workflow tool with action='generate' to create a dynamic workflow tailored to the task.",
                "Dynamic workflows can use: parallel fan-out, synthesis, adversarial verification, iterative loops, and batch processing. They are generated on-the-fly and run through the native workflow engine with full observability.",
              ].join("\n")
            : undefined,
        ]

        return sections
          .filter((section): section is string => section !== undefined)
          .join("\n\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Layer.mergeAll(Skill.defaultLayer, Workflow.defaultLayer, Config.defaultLayer)))

export function getIdeContext(): string[] {
  const ctx = Ide.editorContext()
  if (!ctx.uri) return []

  return [
    `<ide-context>`,
    `  The user has ${ctx.uri} open in their IDE.`,
    ...(ctx.selection
      ? [
          `  They have ${ctx.selection.start.line === ctx.selection.end.line ? `line ${ctx.selection.start.line + 1}` : `lines ${ctx.selection.start.line + 1}-${ctx.selection.end.line + 1}`} selected:`,
          ctx.selection.text,
        ]
      : []),
    `</ide-context>`,
  ]
}

export * as SystemPrompt from "./system"
