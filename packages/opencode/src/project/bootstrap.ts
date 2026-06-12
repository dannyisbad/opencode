import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { ShareNext } from "@/share/share-next"
import { Duration, Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      const ms = (d: Duration.Duration) => Math.round(Duration.toMillis(d))
      const [cfgD] = yield* Effect.timed(config.get())
      // Plugin can mutate config so it has to be initialized before anything else.
      const [pluginD] = yield* Effect.timed(plugin.init())
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      const services = [
        ["lsp", lsp],
        ["share", shareNext],
        ["format", format],
        ["vcs", vcs],
        ["snapshot", snapshot],
        ["project", project],
      ] as const
      const [svcD] = yield* Effect.timed(
        Effect.forEach(
          services,
          ([name, s]) =>
            Effect.timed(s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause })))).pipe(
              Effect.tap(([d]) => Effect.logInfo("boot phase", { service: name, ms: ms(d) })),
            ),
          { concurrency: "unbounded", discard: true },
        ).pipe(Effect.withSpan("InstanceBootstrap.init")),
      )
      yield* Effect.logInfo("boot timing", {
        directory: ctx.directory,
        configMs: ms(cfgD),
        pluginMs: ms(pluginD),
        servicesMs: ms(svcD),
      })
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([
    Config.defaultLayer,
    Format.defaultLayer,
    LSP.defaultLayer,
    Plugin.defaultLayer,
    Project.defaultLayer,
    ShareNext.defaultLayer,
    Snapshot.defaultLayer,
    Vcs.defaultLayer,
  ]),
)

export const node = LayerNode.make(layer, [
  Config.node,
  Format.node,
  LSP.node,
  Plugin.node,
  Project.node,
  ShareNext.node,
  Snapshot.node,
  Vcs.node,
])

export * as InstanceBootstrap from "./bootstrap"
