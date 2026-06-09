import { Effect, Fiber, Stream, Deferred, Scope } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@opencode-ai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@/shell/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { BackgroundJob } from "@/background/job"
import * as ShellBackground from "./shell/background"
import type { TaskPromptOps } from "./task"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const POST_EXIT_OUTPUT_IDLE_TIMEOUT = "500 millis"
// Foreground window: a command still running this long is auto-promoted to the
// background (handed a bg id) instead of blocking the turn — NOT killed.
const AUTO_BACKGROUND_MS = 30 * 1000
// Hard cap on a backgrounded command's total lifetime; killed if it exceeds this.
const MAX_BACKGROUND_MS = 5 * 60 * 1000

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`
}

function attrSafe(value: string): string {
  return value.replace(/["'<>\n\r]/g, " ").replace(/\s+/g, " ").trim()
}

// Background-command payload. Reuses the `terminal_run` tag with kind="bash" so
// the TUI's parseBackgroundCompletion + ▣ renderer handle it with no TUI change.
function renderBashBackground(input: {
  id: string
  state: "running" | "completed" | "error"
  description: string
  exit?: number | null
  text?: string
  durationMs?: number
}): string {
  const label = attrSafe(input.description)
  if (input.state === "running") {
    return [
      `<terminal_run id="${input.id}" state="running" kind="bash" label="${label}">`,
      `<summary>Command running in background: ${input.description}</summary>`,
      `<instructions>You will be notified when it exits. Use the bash_output tool with id="${input.id}" to read new output, and bash_kill with id="${input.id}" to stop it.</instructions>`,
      `</terminal_run>`,
    ].join("\n")
  }
  const exitStr = input.exit != null ? ` (exit ${input.exit})` : ""
  const elapsed = input.durationMs != null ? ` in ${formatElapsed(input.durationMs)}` : ""
  const tag = input.state === "error" ? "terminal_error" : "terminal_result"
  const attrs = [
    `id="${input.id}"`,
    `state="${input.state}"`,
    `kind="bash"`,
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
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

const ask = Effect.fn("ShellTool.ask")(function* (
  ctx: Tool.Context,
  scan: Scan,
  input: { command: string; description: string },
) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        description: input.description,
        directories,
        patterns: globs,
      },
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: ShellID.ToolID,
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {
      command: input.command,
      description: input.description,
    },
  })
})

function cmd(shell: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}
const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FSUtil.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const background = yield* BackgroundJob.Service
    const shellBg = yield* ShellBackground.Service
    // Tool-instance scope: completion-notify fibers are forked here so they
    // outlive the foreground execute() that promoted the command.
    const toolScope = yield* Scope.Scope
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return FSUtil.normalizePath(file)
    })

    const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          // git-bash's cygpath resolves a drive-less posix path like /Users/...
          // against the MSYS install root (C:\Program Files\Git\Users\...) — a
          // location that doesn't really exist — instead of the intended
          // drive-relative C:\Users\.... Only trust cygpath when its result lands
          // somewhere real (the path or its parent exists): true for genuine Git
          // Bash mounts (/tmp → %TEMP%, /c/... → C:\...), false for a drive-less
          // Windows path, which then falls through to drive-relative resolution.
          if (file && ((yield* fs.existsSafe(file)) || (yield* fs.existsSafe(path.dirname(file))))) return file
        }
        return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("ShellTool.collect")(function* (
      root: Node,
      cwd: string,
      ps: boolean,
      shell: string,
      instance: InstanceContext,
    ) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }
      const shellKind = ShellID.toKind(Shell.name(shell))

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps || shellKind === "cmd" ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && (FILES.has(cmd) || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
          for (const arg of pathArgs(command, ps, shellKind === "cmd")) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            yield* Effect.logInfo("resolved path", { arg, resolved })
            if (!resolved || containsPath(resolved, instance)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    // Worker: spawn + capture + race exit vs the 5m hard cap, stamp the
    // result/exit into the background registry, return the cleaned output string
    // (which becomes the BackgroundJob's `output`). Runs inside the job's scope,
    // so it outlives the foreground turn once promoted.
    const executeCommand = Effect.fn("ShellTool.executeCommand")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        description: string
      },
      ctx: Tool.Context,
      id: string,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let processed = 0
      let processing = false
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      // Register in the background registry up front so bash_output/bash_kill can
      // reach this command the moment it is promoted. `snapshot` reads the live
      // capture buffer; `kill` cancels the owning job (→ interrupts this worker).
      yield* shellBg.register({
        id,
        command: input.command,
        description: input.description,
        snapshot: () => list.map((item) => item.text).join(""),
        readCursor: 0,
        exitCode: null,
        status: "running",
        startedAt: Date.now(),
        kill: background.cancel(id).pipe(Effect.ignore),
      })

      const markOutputProcessed = Effect.sync(() => {
        processing = false
        processed++
      })

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(cmd(input.shell, input.command, input.cwd, input.env))

          const output = yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              processing = true
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                          description: input.description,
                        },
                      }),
                    ),
                    Effect.ensuring(markOutputProcessed),
                  )
                }
              }

              return ctx
                .metadata({
                  metadata: {
                    output: last,
                    description: input.description,
                  },
                })
                .pipe(Effect.ensuring(markOutputProcessed))
            }),
          )

          // No ctx.abort listener here: a backgrounded command must survive the
          // turn ending. Foreground abort is handled by the run wrapper, which
          // cancels the owning job → interrupts this worker → kills the process.
          const timeout = Effect.sleep(`${MAX_BACKGROUND_MS} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          if (exit.kind === "exit") {
            // Ordinary commands reach EOF immediately; outliving children can keep stdio open.
            // After exit, stop waiting once processed output stays quiet across a 500ms check.
            const settle = Effect.gen(function* () {
              let seen = -1
              while (processing || processed !== seen) {
                seen = processed
                yield* Effect.sleep(POST_EXIT_OUTPUT_IDLE_TIMEOUT)
              }
            })
            yield* Effect.raceAll([Fiber.join(output).pipe(Effect.ignore), settle])
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated the command after exceeding the ${Math.round(
            MAX_BACKGROUND_MS / 1000,
          )}s background limit.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }

      // Stamp the result into the registry (read by the foreground path for rich
      // metadata, and by the completion-notify), and return the output string —
      // which becomes the BackgroundJob's `output`.
      const status: ShellBackground.Status = (code != null && code !== 0) || expired ? "error" : "completed"
      yield* shellBg.setExit(id, code, status)
      yield* shellBg.setResult(id, {
        output,
        exit: code,
        truncated: cut,
        ...(cut && file ? { outputPath: file } : {}),
      })
      return output
    })

    // Orchestrator: the command ALWAYS runs as a BackgroundJob (task.ts pattern,
    // so no fragile mid-flight scope handoff). Foreground just races the job's
    // completion vs promotion vs the 30s window vs abort.
    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        foregroundWindow: number
        background: boolean
        description: string
      },
      ctx: Tool.Context,
    ) {
      const id = ctx.callID ?? `bash_${Date.now().toString(36)}`
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined

      function runningResult() {
        // Metadata shape kept identical to the foreground return (the bgId lives
        // in the running-bubble XML `id="…"`, so metadata needn't carry it).
        return {
          title: input.description,
          metadata: {
            output: "(running in background)",
            exit: null as number | null,
            description: input.description,
            truncated: false,
          },
          output: renderBashBackground({ id, state: "running", description: input.description }),
        }
      }

      // Inject the ▣ completion bubble when the job settles. Forked into toolScope
      // so it survives this turn.
      const notify = Effect.fn("ShellTool.notify")(function* () {
        if (!ops) return
        const inject = ops
        yield* background
          .wait({ id })
          .pipe(
            Effect.flatMap((res) =>
              Effect.gen(function* () {
                const entry = yield* shellBg.get(id)
                const exit = entry?.exitCode ?? null
                const state: "completed" | "error" =
                  entry?.status === "error" || (exit != null && exit !== 0) ? "error" : "completed"
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
                        text:
                          "\n" +
                          renderBashBackground({
                            id,
                            state,
                            description: input.description,
                            exit,
                            text: entry?.result?.output ?? res.info?.output ?? "",
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
      })

      yield* background.start({
        id,
        type: "bash",
        title: input.description,
        // sessionId lets the Ctrl+B (session.background) handler find and promote
        // this command, mirroring how task jobs are promoted by parentSessionId.
        metadata: { description: input.description, sessionId: ctx.sessionID },
        onPromote: Effect.void,
        run: executeCommand(
          { shell: input.shell, command: input.command, cwd: input.cwd, env: input.env, description: input.description },
          ctx,
          id,
        ),
      })

      if (input.background) {
        yield* notify()
        return runningResult()
      }

      const abort = Effect.callback<void>((resume) => {
        if (ctx.abort.aborted) {
          resume(Effect.void)
          return Effect.sync(() => {})
        }
        const handler = () => resume(Effect.void)
        ctx.abort.addEventListener("abort", handler, { once: true })
        return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
      })

      const outcome = yield* Effect.raceAll([
        background.wait({ id }).pipe(Effect.map((w) => ({ kind: "done" as const, info: w.info }))),
        background.waitForPromotion(id).pipe(Effect.map(() => ({ kind: "promoted" as const }))),
        abort.pipe(Effect.map(() => ({ kind: "abort" as const }))),
        Effect.sleep(`${input.foregroundWindow} millis`).pipe(Effect.map(() => ({ kind: "timer" as const }))),
      ])

      if (outcome.kind === "abort") {
        // Snapshot the captured output BEFORE cancelling (cancel interrupts the
        // worker before it can stamp result), so partial output is preserved.
        const entry = yield* shellBg.get(id)
        const captured = (entry?.snapshot() ?? "").trim()
        yield* background.cancel(id).pipe(Effect.ignore)
        return {
          title: input.description,
          metadata: {
            output: preview(captured || "(no output)"),
            exit: null as number | null,
            description: input.description,
            truncated: false,
          },
          output: (captured || "(no output)") + "\n\n<shell_metadata>\nUser aborted the command\n</shell_metadata>",
        }
      }

      if (outcome.kind === "promoted" || outcome.kind === "timer") {
        if (outcome.kind === "timer") yield* background.promote(id).pipe(Effect.ignore)
        yield* notify()
        return runningResult()
      }

      // Foreground completion: read the rich result the worker stamped.
      const entry = yield* shellBg.get(id)
      const result = entry?.result
      return {
        title: input.description,
        metadata: {
          output: preview(result?.output ?? ""),
          exit: result?.exit ?? null,
          description: input.description,
          truncated: result?.truncated ?? false,
          ...(result?.outputPath ? { outputPath: result.outputPath } : {}),
        },
        output: result?.output ?? outcome.info?.output ?? "(no output)",
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              // `timeout` now means the FOREGROUND window before auto-promote
              // (default 30s), NOT a kill deadline. The 5m hard cap lives in the worker.
              const foregroundWindow = params.timeout ?? AUTO_BACKGROUND_MS
              const ps = Shell.ps(shell)
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const tree = yield* Effect.acquireRelease(parse(params.command, ps), (tree) =>
                    Effect.sync(() => tree.delete()),
                  )
                  const scan = yield* collect(tree.rootNode, cwd, ps, shell, instanceCtx)
                  if (!containsPath(cwd, instanceCtx)) scan.dirs.add(cwd)
                  yield* ask(ctx, scan, params)
                }),
              )

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  foregroundWindow,
                  background: params.background === true,
                  description: params.description,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
