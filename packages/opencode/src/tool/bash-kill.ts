import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as ShellBackground from "./shell/background"

export const Parameters = Schema.Struct({
  id: Schema.String.annotate({
    description: "The background id of the bash command to stop",
  }),
  description: Schema.optional(Schema.String).annotate({
    description: "Brief description of what you are stopping",
  }),
})

const DESCRIPTION = [
  "Stops (terminates) a command that the `bash` tool is running in the background, identified by its",
  "background id. The background id is the value the `bash` tool reported when it backgrounded the",
  "command. Use this when a backgrounded command is no longer needed or should be cut short.",
].join("\n")

export const BashKillTool = Tool.define(
  "bash_kill",
  Effect.gen(function* () {
    const shellBg = yield* ShellBackground.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ok = yield* shellBg.kill(params.id)
          return {
            title: params.description ?? `Stop background command ${params.id}`,
            metadata: { id: params.id },
            output: ok
              ? `(background command ${params.id} stopped)`
              : `(no background command with id ${params.id})`,
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)
