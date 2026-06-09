import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as ShellBackground from "./shell/background"

export const Parameters = Schema.Struct({
  id: Schema.String.annotate({
    description: "The background id returned when a bash command was backgrounded",
  }),
  description: Schema.String.annotate({
    description: "Brief description of what you are reading",
  }),
})

const DESCRIPTION = [
  "Reads NEW output (everything produced since your last read) from a command that the `bash` tool is",
  "running in the background, identified by its background id.",
  "",
  "The background id is the value the `bash` tool reported when it backgrounded the command.",
  "Reading does NOT stop the command — it keeps running, and a later read returns only what has been",
  "produced since this read. You are also notified automatically when the command completes, so you do",
  "not need to poll: use this when you want to check on progress before that notification arrives.",
].join("\n")

export const BashOutputTool = Tool.define(
  "bash_output",
  Effect.gen(function* () {
    const shellBg = yield* ShellBackground.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const res = yield* shellBg.readNew(params.id)
          if (!res) {
            return {
              title: params.description,
              metadata: { id: params.id, exit: null as number | null, status: "unknown" as string },
              output: `(no background command with id ${params.id})`,
            }
          }
          return {
            title: params.description,
            metadata: { id: params.id, exit: res.exitCode, status: res.status },
            output: res.text || "(no new output)",
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)
