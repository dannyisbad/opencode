import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"

export type Status = "running" | "completed" | "error" | "killed"

export interface Entry {
  id: string
  command: string
  description: string
  /** Returns the command's full captured output so far (live, from the tool). */
  snapshot: () => string
  /** Character offset of the snapshot already returned by bash_output. */
  readCursor: number
  exitCode: number | null
  status: Status
  startedAt: number
  /** Kills the underlying process. Set when the command is promoted to background. */
  kill: Effect.Effect<void>
  /** Final foreground-style result, stamped when the command settles. */
  result?: { output: string; exit: number | null; truncated: boolean; outputPath?: string }
}

export interface ReadResult {
  text: string
  exitCode: number | null
  status: Status
  command: string
}

export interface Interface {
  register(entry: Entry): Effect.Effect<void>
  /** Returns output produced since the last read, advancing the cursor. */
  readNew(id: string): Effect.Effect<ReadResult | undefined>
  get(id: string): Effect.Effect<Entry | undefined>
  setExit(id: string, exitCode: number | null, status: Status): Effect.Effect<void>
  setResult(id: string, result: NonNullable<Entry["result"]>): Effect.Effect<void>
  /** Runs the entry's kill effect and marks it killed. Returns false if unknown. */
  kill(id: string): Effect.Effect<boolean>
  list(): Effect.Effect<Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellBackground") {}

const MAX_ENTRIES = 50

/** Effect factory: produces a FRESH registry per instance (run once per instance
 * by InstanceState's per-directory ScopedCache), mirroring core BackgroundJob.make. */
export const make: Effect.Effect<Interface> = Effect.sync(() => {
  const entries = new Map<string, Entry>()

  function evictIfNeeded() {
    if (entries.size < MAX_ENTRIES) return
    // Prefer evicting a finished entry over a running one.
    const victim =
      [...entries.entries()].find(([, e]) => e.status !== "running")?.[0] ?? entries.keys().next().value
    if (victim) entries.delete(victim)
  }

  return {
    register: (entry) =>
      Effect.sync(() => {
        evictIfNeeded()
        entries.set(entry.id, entry)
      }),
    readNew: (id) =>
      Effect.sync(() => {
        const e = entries.get(id)
        if (!e) return undefined
        const full = e.snapshot()
        const text = full.slice(e.readCursor)
        e.readCursor = full.length
        return { text, exitCode: e.exitCode, status: e.status, command: e.command }
      }),
    get: (id) => Effect.sync(() => entries.get(id)),
    setExit: (id, exitCode, status) =>
      Effect.sync(() => {
        const e = entries.get(id)
        if (e) {
          e.exitCode = exitCode
          e.status = status
        }
      }),
    setResult: (id, result) =>
      Effect.sync(() => {
        const e = entries.get(id)
        if (e) e.result = result
      }),
    kill: (id) =>
      Effect.gen(function* () {
        const e = entries.get(id)
        if (!e) return false
        if (e.status === "running") {
          yield* e.kill.pipe(Effect.ignore)
          e.status = "killed"
        }
        return true
      }),
    list: () => Effect.sync(() => [...entries.values()]),
  }
})

/** Instance-scoped service layer, mirroring @/background/job's pattern. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() => make)
    return Service.of({
      register: (entry) => InstanceState.useEffect(state, (reg) => reg.register(entry)),
      readNew: (id) => InstanceState.useEffect(state, (reg) => reg.readNew(id)),
      get: (id) => InstanceState.useEffect(state, (reg) => reg.get(id)),
      setExit: (id, exitCode, status) => InstanceState.useEffect(state, (reg) => reg.setExit(id, exitCode, status)),
      setResult: (id, result) => InstanceState.useEffect(state, (reg) => reg.setResult(id, result)),
      kill: (id) => InstanceState.useEffect(state, (reg) => reg.kill(id)),
      list: () => InstanceState.useEffect(state, (reg) => reg.list()),
    })
  }),
)

export const defaultLayer = layer
