import stripAnsi from "strip-ansi"
import * as Tool from "./tool"
import DESCRIPTION from "./terminal.txt"
import * as Log from "@opencode-ai/core/util/log"
import { Shell } from "@/shell/shell"
import { Pty } from "@opencode-ai/core/pty"
import { PtyID } from "@opencode-ai/core/pty/schema"
import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { Effect, Deferred, Stream, Schema, Scope } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { InstanceState } from "@/effect/instance-state"
import { BackgroundJob } from "@/background/job"
import type { TaskPromptOps } from "./task"

export const log = Log.create({ service: "terminal-tool" })

// ---------------------------------------------------------------------------
// Sentinel for exit code detection
// ---------------------------------------------------------------------------

const SENTINEL_PREFIX = "__OPENCODE_EXIT_"
const MAX_SESSIONS = 20

// ---------------------------------------------------------------------------
// Session state for persistent PTY sessions
// ---------------------------------------------------------------------------

type SessionState = {
  ptyId: PtyID
  lastCursor: number
  description: string
  shell: string
  createdAt: number
  exitCode: number | null
  buffer: string
}

// ---------------------------------------------------------------------------
// Sentinel command helper (shell-aware)
// ---------------------------------------------------------------------------

/**
 * Returns the shell-appropriate sentinel command for exit code detection.
 * PowerShell uses $LASTEXITCODE (numeric), POSIX shells use $? (0/1).
 */
export function sentinelCommand(shellName: string): string {
  const isPowerShell = shellName.includes("powershell") || shellName.includes("pwsh")
  const exitVar = isPowerShell ? "$LASTEXITCODE" : "$?"
  return `echo "${SENTINEL_PREFIX}${exitVar}"`
}

// ---------------------------------------------------------------------------
// Parameters — discriminated union on "action"
// ---------------------------------------------------------------------------

const RunAction = Schema.Struct({
  action: Schema.Literal("run"),
  command: Schema.String.annotate({ description: "The command to execute in a TTY-aware terminal session" }),
  timeout: Schema.optional(Schema.Number).annotate({
    description:
      "How long (ms) to stay in the foreground before auto-backgrounding. The command is NOT killed at the timeout — it keeps running in the background and you are handed a sessionId. Defaults to 30000ms.",
  }),
  workdir: Schema.optional(Schema.String).annotate({
    description: "The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.",
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Run in the background and return immediately with a sessionId. Use for commands that block, run indefinitely, or wait for interactive input — dev servers, watchers, `npm run dev`, `tail -f`, REPLs, build/test watch loops. You will be notified when it exits; read incremental output with action=\"read\" on the returned sessionId, send input with action=\"send\", stop it with action=\"close\".",
  }),
  description: Schema.String.annotate({ description: "Clear, concise description of what this command does in 5-10 words" }),
})

const CreateAction = Schema.Struct({
  action: Schema.Literal("create"),
  workdir: Schema.optional(Schema.String).annotate({ description: "Working directory for the session" }),
  description: Schema.optional(Schema.String).annotate({ description: "Description for the terminal session" }),
})

const SendAction = Schema.Struct({
  action: Schema.Literal("send"),
  sessionId: Schema.String,
  input: Schema.String.annotate({
    description: "Text to send to the terminal. Use \\x03 for Ctrl+C, \\x04 for Ctrl+D. Commands are appended with \\n",
  }),
  description: Schema.String.annotate({ description: "Clear, concise description of what this input does in 5-10 words" }),
})

const ReadAction = Schema.Struct({
  action: Schema.Literal("read"),
  sessionId: Schema.String,
  description: Schema.String.annotate({ description: "Clear, concise description of what you are reading" }),
})

const CloseAction = Schema.Struct({
  action: Schema.Literal("close"),
  sessionId: Schema.String,
})

export const Parameters = Schema.Union([RunAction, CreateAction, SendAction, ReadAction, CloseAction])

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable)
// ---------------------------------------------------------------------------

/**
 * Strips the echoed command from the beginning of PTY output.
 * PTYs always echo the typed command. After stripping ANSI, if the first line
 * matches the command (trimmed), we remove it.
 */
export function filterEcho(text: string, command: string): string {
  const lines = text.split("\n")
  if (lines.length === 0) return text
  const firstLine = lines[0].replace(/\r$/, "").trim()
  if (firstLine === command.trim()) {
    return lines.slice(1).join("\n")
  }
  return text
}

/**
 * Extracts the exit code from the sentinel line and removes that line.
 * The sentinel is: __OPENCODE_EXIT_<code>
 */
export function extractExit(text: string): { exit: number | null; cleaned: string } {
  const regex = new RegExp(`^${SENTINEL_PREFIX}(\\d+)$`, "m")
  const match = regex.exec(text)
  if (!match) return { exit: null, cleaned: text }
  const exitCode = parseInt(match[1], 10)
  const cleaned = text
    .replace(match[0], "")
    .replace(/\n{2,}/, "\n")
    .replace(/^\n/, "")
    .replace(/\n$/, "")
  return { exit: exitCode, cleaned }
}

/**
 * Chains stripAnsi → filterEcho → extractExit → trim
 */
export function cleanOutput(raw: string, command: string): { output: string; exit: number | null } {
  const stripped = stripAnsi(raw)
  const filtered = filterEcho(stripped, command)
  const { exit, cleaned } = extractExit(filtered)
  return { output: cleaned.trim(), exit }
}

// ---------------------------------------------------------------------------
// Mock WebSocket for capturing PTY output via Pty.connect()
// ---------------------------------------------------------------------------

type MockSocket = {
  readyState: number
  data: unknown
  send: (data: string | Uint8Array | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
}

function createMockSocket(
  onData: (chunk: string) => void,
  onMeta?: (cursor: number) => void,
): MockSocket {
  return {
    readyState: 1, // OPEN
    data: {},
    send(data: string | Uint8Array | ArrayBuffer) {
      if (typeof data === "string") {
        onData(data)
      } else {
        const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
        if (buf.length > 0 && buf[0] === 0x00) {
          // Meta frame: 0x00 + JSON
          const json = new TextDecoder().decode(buf.slice(1))
          try {
            const meta = JSON.parse(json)
            onMeta?.(meta.cursor)
          } catch (e) {
            // Invalid meta - ignore
          }
        } else {
          onData(new TextDecoder().decode(buf))
        }
      }
    },
    close() {
      this.readyState = 3 // CLOSED
    },
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 2 * 60 * 1000
// A foreground `run` that is still alive after this long is auto-backgrounded
// (promoted to a persistent session + BackgroundJob) rather than killed.
const AUTO_BACKGROUND_MS = 30 * 1000
const MAX_METADATA_LENGTH = 30_000

function preview(text: string): string {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

// Compact elapsed-time label for the completion summary ("12s", "1m02s").
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`
}

// Strip characters that would break an XML attribute value so a description can
// be embedded as `label="..."` for the TUI to render a clean compact line.
function attrSafe(value: string): string {
  return value.replace(/["'<>\n\r]/g, " ").replace(/\s+/g, " ").trim()
}

// Model-facing payload for a backgrounded terminal command. The `running` form is
// returned immediately; the `completed`/`error` form is injected when the PTY
// exits. Structured attributes (label/exit/elapsed) let the TUI render its own
// compact one-line bubble without echoing the model-facing <summary>.
export function renderTerminalBackground(input: {
  sessionId: string
  state: "running" | "completed" | "error"
  description: string
  exit?: number | null
  text?: string
  durationMs?: number
}): string {
  const label = attrSafe(input.description)
  if (input.state === "running") {
    return [
      `<terminal_run id="${input.sessionId}" state="running" kind="terminal" label="${label}">`,
      `<summary>Command running in background: ${input.description}</summary>`,
      `<instructions>You will be notified when it exits. Use action="read" with sessionId="${input.sessionId}" to read output incrementally, action="send" to provide input, action="close" to terminate.</instructions>`,
      `</terminal_run>`,
    ].join("\n")
  }
  const exitStr = input.exit != null ? ` (exit ${input.exit})` : ""
  const elapsed = input.durationMs != null ? ` in ${formatElapsed(input.durationMs)}` : ""
  const tag = input.state === "error" ? "terminal_error" : "terminal_result"
  const attrs = [
    `id="${input.sessionId}"`,
    `state="${input.state}"`,
    `kind="terminal"`,
    `label="${label}"`,
    input.exit != null ? `exit="${input.exit}"` : "",
    input.durationMs != null ? `elapsed="${formatElapsed(input.durationMs)}"` : "",
  ]
    .filter(Boolean)
    .join(" ")
  return [
    `<terminal_run ${attrs}>`,
    `<summary>Background command ${input.state}${exitStr}${elapsed}: ${input.description}</summary>`,
    `<${tag}>`,
    input.text ?? "",
    `</${tag}>`,
    `</terminal_run>`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const TerminalTool = Tool.define(
  "terminal",
  Effect.gen(function* () {
    const pty = yield* Pty.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const events = yield* EventV2.Service
    const background = yield* BackgroundJob.Service
    // Tool-instance scope: completion-notify fibers are forked here so they
    // outlive the foreground `run` scope that promoted the command.
    const toolScope = yield* Scope.Scope

    const shell = Shell.name(Shell.acceptable())
    log.info("terminal tool using shell", { shell })

    // --- InstanceState for persistent sessions ---
    const sessionState = yield* InstanceState.make<Map<string, SessionState>>(
      (_ctx: any) =>
        Effect.gen(function* () {
          const sessions = new Map<string, SessionState>()
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const [id] of sessions) {
                // A backgrounded PTY self-removes on exit (pty.ts onExit), so by
                // teardown some sessions may already be gone — swallow NotFound
                // rather than orDie, which would crash the whole finalizer chain.
                yield* pty.remove(id as PtyID).pipe(Effect.ignore)
              }
              sessions.clear()
            }),
          )
          return sessions
        }),
    )

    const description = DESCRIPTION.replaceAll("${directory}", "the current directory")
      .replaceAll("${shell}", shell)
      .replaceAll("${os}", process.platform)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES))

    return {
      description,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          // --- action: "run" (default, backward-compatible) ---
          if (params.action === "run" || params.action === undefined) {
            return yield* Effect.scoped(Effect.gen(function* () {
              const cwd = params.workdir ?? instance.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              // Foreground window: stay foreground this long, THEN auto-background
              // (the command is not killed). Default 30s, NOT the legacy 2-min cap.
              const timeout = params.timeout ?? AUTO_BACKGROUND_MS

              yield* ctx.ask({
                permission: "terminal",
                patterns: [params.command],
                always: [],
                metadata: {},
              })

              const extra = yield* plugin.trigger(
                "shell.env",
                { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
                { env: {} },
              )
              const env = {
                ...process.env,
                ...extra.env,
                TERM: "xterm-256color",
                OPENCODE_TERMINAL: "1",
              } as Record<string, string>

              if (process.platform === "win32") {
                env.LC_ALL = "C.UTF-8"
                env.LC_CTYPE = "C.UTF-8"
                env.LANG = "C.UTF-8"
              }

              const info = yield* pty.create({
                command: Shell.preferred(),
                args: [],
                cwd,
                title: `Agent: ${params.description.slice(0, 30)}`,
                env,
              })

              // `promoted` is flipped true when the run is backgrounded (explicit
              // background:true or the 30s auto-background): the PTY is then owned
              // by the BackgroundJob + sessionState, so the foreground scope must
              // NOT kill it. Otherwise remove it — swallowing NotFound because the
              // PTY self-removes on exit (a completed run reaches here after the
              // PTY is already gone), which would otherwise orDie and crash.
              let promoted = false
              yield* Effect.addFinalizer(() =>
                promoted ? Effect.void : pty.remove(info.id).pipe(Effect.ignore),
              )

              yield* ctx.metadata({
                metadata: {
                  output: "",
                  description: params.description,
                },
              })

              let buffer = ""

              const mockWs = createMockSocket((chunk) => {
                buffer += chunk
                Effect.runFork(
                  ctx.metadata({
                    metadata: {
                      output: preview(buffer),
                      description: params.description,
                    },
                  }),
                )
              })

              const conn = yield* pty.connect(info.id, mockWs).pipe(
                Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(undefined)),
              )
              if (!conn) {
                return {
                  title: params.description,
                  metadata: {
                    output: "(failed to connect to PTY session)",
                    exit: null,
                    pty: true as const,
                    description: params.description,
                    truncated: false,
                  },
                  output: "(failed to connect to PTY session)",
                }
              }

              const sentinel = sentinelCommand(shell)
              conn.onMessage(params.command + "\n")
              conn.onMessage(sentinel + "\n")

              const exitDeferred = yield* Deferred.make<{ kind: "exit"; code: number } | { kind: "abort" }>()

              // Exit subscriber forked into the TOOL-INIT scope (not the foreground
              // run scope) + take(1): it survives promotion so a backgrounded job
              // can await exitDeferred to learn when the PTY exits, and self-
              // terminates after the single event. Both the foreground race and the
              // background job read the same deferred — no second subscription, no
              // race window between them.
              yield* events
                .subscribe(Pty.Event.Exited)
                .pipe(
                  Stream.filter((evt) => evt.data.id === info.id),
                  Stream.take(1),
                  Stream.runForEach((evt) =>
                    Deferred.succeed(exitDeferred, { kind: "exit" as const, code: evt.data.exitCode }),
                  ),
                  Effect.forkIn(toolScope, { startImmediately: true }),
                )

              // Abort listener (foreground only): user Esc cancels the in-flight run.
              yield* Effect.forkScoped(
                Effect.callback<void>((resume) => {
                  if (ctx.abort.aborted) {
                    resume(Effect.void)
                    return Effect.sync(() => {})
                  }
                  const handler = () => resume(Effect.void)
                  ctx.abort.addEventListener("abort", handler, { once: true })
                  return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
                }).pipe(
                  Effect.andThen(() => Deferred.succeed(exitDeferred, { kind: "abort" as const })),
                ),
              )

              // Auto-background timer: a command still alive after `timeout`
              // (default 30s) is PROMOTED to the background instead of killed.
              // Skipped when the caller asked for background up front.
              const runInBackground = params.background === true
              const promoteDeferred = yield* Deferred.make<void>()
              if (!runInBackground) {
                yield* Effect.forkScoped(
                  Effect.sleep(`${timeout} millis`).pipe(
                    Effect.andThen(() => Deferred.succeed(promoteDeferred, undefined)),
                  ),
                )
              }

              const outcome = runInBackground
                ? ("promote" as const)
                : yield* Effect.raceFirst(
                    Deferred.await(exitDeferred),
                    Deferred.await(promoteDeferred).pipe(Effect.as("promote" as const)),
                  )

              if (outcome === "promote") {
                // The PTY is now owned by the BackgroundJob + sessionState; the
                // foreground finalizer must NOT kill it. Keep the connection OPEN
                // (no onClose) so `buffer` keeps growing until the PTY exits.
                promoted = true
                const ops = ctx.extra?.promptOps as TaskPromptOps | undefined

                const sessions = yield* InstanceState.get(sessionState)
                if (sessions.size >= MAX_SESSIONS) {
                  // Prefer evicting an already-exited session over a live one.
                  const victim =
                    [...sessions.entries()].find(([, s]) => s.exitCode !== null)?.[0] ??
                    sessions.keys().next().value
                  if (victim) {
                    const v = sessions.get(victim)
                    sessions.delete(victim)
                    if (v) yield* pty.remove(v.ptyId).pipe(Effect.ignore)
                  }
                }
                sessions.set(info.id, {
                  ptyId: info.id,
                  lastCursor: 0,
                  description: params.description,
                  shell,
                  createdAt: Date.now(),
                  exitCode: null,
                  buffer,
                })

                // The job's run awaits the PTY exit (via the toolScope subscriber
                // that resolves exitDeferred — it outlives this scope), stamps the
                // exit code into the session, and returns the cleaned output.
                yield* background.start({
                  id: info.id,
                  type: "terminal",
                  title: params.description,
                  metadata: { background: true, sessionId: info.id, description: params.description },
                  onPromote: Effect.void,
                  run: Deferred.await(exitDeferred).pipe(
                    Effect.flatMap((r) =>
                      Effect.gen(function* () {
                        const code = r.kind === "exit" ? r.code : null
                        const { output } = cleanOutput(buffer, params.command)
                        const final = output || "(no output)"
                        const live = yield* InstanceState.get(sessionState)
                        const s = live.get(info.id)
                        // Retain the cleaned final output so a `read` AFTER the PTY
                        // has exited + self-removed still returns it (a fast
                        // backgrounded command would otherwise be unreadable — the
                        // PTY is gone and the buffer lost).
                        if (s) {
                          s.exitCode = code
                          s.buffer = final
                        }
                        return final
                      }),
                    ),
                  ),
                })

                // Inject a compact completion bubble when the job settles. Forked
                // into toolScope so it survives this foreground turn.
                if (ops) {
                  const inject = ops
                  yield* background
                    .wait({ id: info.id })
                    .pipe(
                      Effect.flatMap((res) =>
                        Effect.gen(function* () {
                          const live = yield* InstanceState.get(sessionState)
                          const code = live.get(info.id)?.exitCode ?? null
                          const state: "completed" | "error" = code == null || code === 0 ? "completed" : "error"
                          const durationMs =
                            res.info?.completed_at != null && res.info?.started_at != null
                              ? res.info.completed_at - res.info.started_at
                              : undefined
                          yield* inject
                            .prompt({
                              sessionID: ctx.sessionID,
                              agent: ctx.agent,
                              parts: [
                                {
                                  type: "text",
                                  synthetic: true,
                                  // Lead with a newline so the injected bubble has
                                  // breathing room from the preceding content.
                                  text:
                                    "\n" +
                                    renderTerminalBackground({
                                      sessionId: info.id,
                                      state,
                                      description: params.description,
                                      exit: code,
                                      text: res.info?.output ?? res.info?.error ?? "",
                                      durationMs,
                                    }),
                                },
                              ],
                            })
                            .pipe(Effect.ignore)
                        }),
                      ),
                      Effect.forkIn(toolScope, { startImmediately: true }),
                    )
                }

                return {
                  title: params.description,
                  metadata: {
                    output: "(running in background)",
                    exit: null,
                    pty: true as const,
                    description: params.description,
                    truncated: false,
                  },
                  output: renderTerminalBackground({
                    sessionId: info.id,
                    state: "running",
                    description: params.description,
                  }),
                }
              }

              // Foreground completion: the command exited or was aborted before the
              // auto-background timer fired.
              const result = outcome
              conn.onClose()

              const { output, exit } = cleanOutput(buffer, params.command)
              const exitCode = result.kind === "exit" ? result.code : null

              const meta: string[] = []
              if (result.kind === "abort") {
                meta.push("User aborted the command")
              }

              const truncated = yield* trunc.output(output)

              let finalOutput = truncated.content
              if (!finalOutput) finalOutput = "(no output)"
              if (truncated.truncated && truncated.outputPath) {
                finalOutput = `...output truncated...\n\nFull output saved to: ${truncated.outputPath}\n\n` + finalOutput
              }
              if (meta.length > 0) {
                finalOutput += "\n\n<terminal_metadata>\n" + meta.join("\n") + "\n</terminal_metadata>"
              }

              return {
                title: params.description,
                metadata: {
                  output: preview(finalOutput),
                  exit: exitCode,
                  pty: true as const,
                  description: params.description,
                  truncated: truncated.truncated,
                  ...(truncated.truncated && truncated.outputPath ? { outputPath: truncated.outputPath } : {}),
                },
                output: finalOutput,
              }
            }))
          }

          // --- action: "create" (persistent PTY session) ---
          if (params.action === "create") {
            const cwd = params.workdir ?? instance.directory
            const desc = params.description ?? "Terminal session"

            yield* ctx.ask({
              permission: "terminal",
              patterns: [desc],
              always: [],
              metadata: {},
            })

            const extra = yield* plugin.trigger(
              "shell.env",
              { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
              { env: {} },
            )
            const env = {
              ...process.env,
              ...extra.env,
              TERM: "xterm-256color",
              OPENCODE_TERMINAL: "1",
            } as Record<string, string>

            if (process.platform === "win32") {
              env.LC_ALL = "C.UTF-8"
              env.LC_CTYPE = "C.UTF-8"
              env.LANG = "C.UTF-8"
            }

            const sessions = yield* InstanceState.get(sessionState)

            // FIFO eviction: if at max, remove oldest. Swallow NotFound — an
            // evicted session whose backgrounded PTY already exited is gone.
            if (sessions.size >= MAX_SESSIONS) {
              const oldest = sessions.keys().next().value
              if (oldest) {
                const oldSession = sessions.get(oldest)!
                sessions.delete(oldest)
                yield* pty.remove(oldSession.ptyId).pipe(Effect.ignore)
              }
            }

            const info = yield* pty.create({
              command: Shell.preferred(),
              args: [],
              cwd,
              title: desc.slice(0, 30),
              env,
            })

            sessions.set(info.id, {
              ptyId: info.id,
              lastCursor: 0,
              description: desc,
              shell,
              createdAt: Date.now(),
              exitCode: null,
              buffer: "",
            })

            // Subscribe to PTY exit event to capture the exit code
            Effect.runFork(
              events.subscribe(Pty.Event.Exited).pipe(
                Stream.filter((evt) => evt.data.id === info.id),
                Stream.take(1),
                Stream.runForEach((evt) =>
                  Effect.sync(() => {
                    const s = sessions.get(info.id)
                    if (s) s.exitCode = evt.data.exitCode
                  }),
                ),
              ),
            )

            // Subscribe to output for streaming metadata
            let buffer = ""
            const mockWs = createMockSocket((chunk) => {
              buffer += chunk
              Effect.runFork(
                ctx.metadata({
                  metadata: {
                    output: preview(buffer),
                    description: desc,
                    pty: true as const,
                  },
                }),
              )
            })

            // Connect the mock websocket to stream output metadata to the agent
            // Connection stays alive for the session's lifetime; cleaned up on PTY exit or close
            yield* pty.connect(info.id, mockWs, 0).pipe(
              Effect.catchTag("Pty.NotFoundError", () => Effect.void),
            )

            return {
              title: desc,
              metadata: {
                output: "(session created)",
                exit: null,
                pty: true as const,
                description: desc,
                truncated: false,
                sessionId: info.id,
              },
              output: `Session created: ${info.id}\nShell: ${shell}\nWorkdir: ${cwd}`,
            }
          }

          // --- action: "send" (write to PTY stdin) ---
          if (params.action === "send") {
            const sessions = yield* InstanceState.get(sessionState)
            const session = sessions.get(params.sessionId)
            if (!session) {
              return {
                title: params.description ?? "Send input",
                metadata: {
                  output: `(session ${params.sessionId} not found)`,
                  exit: null,
                  pty: true as const,
                  description: params.description ?? "Send input",
                  truncated: false,
                },
                output: `Error: Session ${params.sessionId} not found. Use action="create" to start a new session.`,
              }
            }

            yield* ctx.ask({
              permission: "terminal",
              patterns: [params.input],
              always: [],
              metadata: {},
            })

            // Send input to PTY — append \n for commands (unless it's a control sequence)
            const data = /^\x03|\x04|\x1a|\x1c$/.test(params.input) ? params.input : params.input + "\n"
            yield* pty.write(session.ptyId, data).pipe(
              Effect.catchTag("Pty.NotFoundError", () => Effect.void),
            )

            return {
              title: params.description ?? "Send input",
              metadata: {
                output: "(input sent)",
                exit: null,
                pty: true as const,
                description: params.description ?? "Send input",
                truncated: false,
              },
              output: `(input sent to session ${params.sessionId})`,
            }
          }

          // --- action: "read" (cursor-based incremental output) ---
          if (params.action === "read") {
            const sessions = yield* InstanceState.get(sessionState)
            const session = sessions.get(params.sessionId)
            if (!session) {
              return {
                title: params.description ?? "Read output",
                metadata: {
                  output: `(session ${params.sessionId} not found)`,
                  exit: null,
                  pty: true as const,
                  description: params.description ?? "Read output",
                  truncated: false,
                  sessionId: params.sessionId,
                },
                output: `Error: Session ${params.sessionId} not found. Use action="create" to start a new session.`,
              }
            }

            // Use a temporary mock socket to capture output from lastCursor
            let newOutput = ""
            let currentCursor = session.lastCursor

            const readWs = createMockSocket(
              (chunk) => {
                newOutput += chunk
              },
              (cursor) => {
                currentCursor = cursor
              },
            )

            const conn = yield* pty.connect(session.ptyId, readWs, session.lastCursor).pipe(
              Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(undefined)),
            )

            if (conn) {
              conn.onClose()
            }

            const cleaned = stripAnsi(newOutput).trim()
            session.lastCursor = currentCursor

            const exitCode = session.exitCode !== null ? session.exitCode : null

            let finalOutput: string
            if (cleaned) {
              // Live incremental output since the last read.
              session.buffer += newOutput
              finalOutput = cleaned
            } else if (!conn && session.exitCode !== null && session.buffer) {
              // PTY gone (a backgrounded command exited + self-removed): the job's
              // exit handler stashed the cleaned final output in session.buffer —
              // deliver it ONCE, then clear so later reads report no new output.
              finalOutput = session.buffer
              session.buffer = ""
            } else {
              finalOutput = "(no new output)"
            }

            const truncated = yield* trunc.output(finalOutput)

            return {
              title: params.description ?? "Read output",
              metadata: {
                output: preview(truncated.content),
                exit: exitCode,
                pty: true as const,
                description: params.description ?? "Read output",
                truncated: truncated.truncated,
                ...(truncated.truncated && truncated.outputPath ? { outputPath: truncated.outputPath } : {}),
                sessionId: params.sessionId,
              },
              output: truncated.content || "(no new output)",
            }
          }

          // --- action: "close" (terminate session + cleanup) ---
          if (params.action === "close") {
            const sessions = yield* InstanceState.get(sessionState)
            const session = sessions.get(params.sessionId)
            if (!session) {
              return {
                title: "Close session",
                metadata: {
                  output: `(session ${params.sessionId} not found)`,
                  exit: null,
                  pty: true as const,
                  description: "Close session",
                  truncated: false,
                },
                output: `Error: Session ${params.sessionId} not found.`,
              }
            }

            // Swallow NotFound: a backgrounded PTY self-removes on exit, so the
            // agent may close a session whose PTY is already gone — that's a
            // successful close, not a crash.
            yield* pty.remove(session.ptyId).pipe(Effect.ignore)
            sessions.delete(params.sessionId)

            return {
              title: "Close session",
              metadata: {
                output: "(session closed)",
                exit: null,
                pty: true as const,
                description: `Closed session ${params.sessionId}`,
                truncated: false,
              },
              output: `(session ${params.sessionId} closed)`,
            }
          }

          // Should never reach here — Zod validates action
          throw new Error(`Unknown action: ${(params as any).action}`)
          }),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)
