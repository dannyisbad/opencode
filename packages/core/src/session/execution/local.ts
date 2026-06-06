import { Cause, DateTime, Effect, Layer, Option } from "effect"
import { LLMError } from "@opencode-ai/llm"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { LocationServiceMap } from "../../location-layer"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { SessionEvent } from "../event"
import { SessionInput } from "../input"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, void, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, mode) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force: mode === "run" })).pipe(
          Effect.provide(locations.get(session.location)),
        )
      }),
      onFailure: (sessionID, cause, context) =>
        Effect.gen(function* () {
          yield* Effect.logError("Failed to drain Session").pipe(
            Effect.annotateLogs("sessionID", sessionID),
            Effect.annotateLogs("cause", cause),
          )
          if (Cause.hasInterruptsOnly(cause)) return
          const error = Option.getOrUndefined(Cause.findErrorOption(cause))
          // Provider failures already publish Step.Failed before escaping the runner.
          if (error instanceof LLMError) return
          const input = context.seq === undefined
            ? undefined
            : yield* SessionInput.findByAdmittedSeq(database.db, sessionID, context.seq)
          yield* events.publish(SessionEvent.Run.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            reason: error instanceof SessionRunner.StepLimitExceededError ? "step-limit-exceeded" : "execution-failed",
            ...(input === undefined
              ? {}
              : {
                  input: {
                    messageID: input.id,
                    admittedSeq: input.admittedSeq,
                    ...(input.promotedSeq === undefined ? {} : { promotedSeq: input.promotedSeq }),
                  },
                }),
          })
        }),
    })

    return SessionExecution.Service.of({
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)
