import { EventV2 } from "@opencode-ai/core/event"
import { Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import * as Log from "@opencode-ai/core/util/log"
import { Process } from "@/util/process"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import fs from "fs/promises"
import path from "path"
import { GlobalBus } from "@/bus/global"

const SUPPORTED_IDES = [
  { name: "Windsurf" as const, cmd: "windsurf" },
  { name: "Visual Studio Code - Insiders" as const, cmd: "code-insiders" },
  { name: "Visual Studio Code" as const, cmd: "code" },
  { name: "Cursor" as const, cmd: "cursor" },
  { name: "VSCodium" as const, cmd: "codium" },
]

const log = Log.create({ service: "ide" })

export const IDE_CLIENT_KEY = "vscode"

export const Event = {
  Installed: EventV2.define({
    type: "ide.installed",
    schema: {
      ide: Schema.String,
    },
  }),
  ContextUpdated: EventV2.define({
    type: "ide.context.updated",
    schema: {
      uri: Schema.optional(Schema.String),
      selection: Schema.optional(
        Schema.Struct({
          start: Schema.Struct({ line: Schema.Number, column: Schema.Number }),
          end: Schema.Struct({ line: Schema.Number, column: Schema.Number }),
          text: Schema.String,
        })
      ),
    },
  }),
}

export const AlreadyInstalledError = NamedError.create("AlreadyInstalledError", {})

export const InstallFailedError = NamedError.create("InstallFailedError", {
  stderr: Schema.String,
})

export function ide() {
  if (process.env["TERM_PROGRAM"] === "vscode") {
    const v = process.env["GIT_ASKPASS"]
    for (const ide of SUPPORTED_IDES) {
      if (v?.includes(ide.name)) return ide.name
    }
  }
  return "unknown"
}

export function alreadyInstalled() {
  return process.env["OPENCODE_CALLER"] === "vscode" || process.env["OPENCODE_CALLER"] === "vscode-insiders"
}

export async function install(ide: (typeof SUPPORTED_IDES)[number]["name"]) {
  const cmd = SUPPORTED_IDES.find((i) => i.name === ide)?.cmd
  if (!cmd) throw new Error(`Unknown IDE: ${ide}`)

  const p = await Process.run([cmd, "--install-extension", "sst-dev.opencode"], {
    nothrow: true,
  })
  const stdout = p.stdout.toString()
  const stderr = p.stderr.toString()

  if (p.code !== 0) {
    throw new InstallFailedError({ stderr })
  }
  if (stdout.includes("already installed")) {
    throw new AlreadyInstalledError({})
  }
}

const LockFileSchema = Schema.Struct({
  pid: Schema.Number,
  workspaceFolders: Schema.Array(Schema.String),
  authToken: Schema.String,
})

export interface DiscoveryResult {
  port: number
  authToken: string
  workspaceFolders: readonly string[]
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: unknown) {
    return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export async function discover(ideDir: string): Promise<DiscoveryResult | null> {
  const portStr = process.env["OPENCODE_MCP_PORT"]
  if (!portStr) {
    log.debug("discover: OPENCODE_MCP_PORT not set, skipping IDE MCP discovery")
    return null
  }

  const port = Number(portStr)
  if (!Number.isFinite(port)) {
    log.warn("discover: OPENCODE_MCP_PORT is not a valid number", { portStr })
    return null
  }
  const lockFilePath = path.join(ideDir, `${port}.lock`)

  const tmpPath = lockFilePath + ".tmp"
  await fs.unlink(tmpPath).catch(() => {})

  const raw = await fs.readFile(lockFilePath, "utf-8").catch(() => null)
  if (raw === null) {
    log.debug("discover: lock file not found", { lockFilePath })
    return null
  }

  const parsed = (() => {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  })()

  const decodeOpt = Schema.decodeUnknownOption(LockFileSchema)(parsed)
  if (decodeOpt._tag === "None") {
    log.warn("discover: lock file is malformed", { lockFilePath })
    return null
  }
  const lockFile = decodeOpt.value

  if (!isProcessRunning(lockFile.pid)) {
    log.debug("discover: stale lock file (pid not running), removing", {
      lockFilePath,
      pid: lockFile.pid,
    })
    await fs.unlink(lockFilePath).catch(() => {})
    return null
  }

  log.info("discover: found live IDE MCP server", {
    port,
    pid: lockFile.pid,
    workspaceFolders: lockFile.workspaceFolders,
  })

  return {
    port,
    authToken: lockFile.authToken,
    workspaceFolders: lockFile.workspaceFolders,
  }
}

export async function connectIde(info: DiscoveryResult): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${info.port}`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${info.authToken}`,
      },
    },
  })
  const client = new Client({
    name: "opencode",
    version: InstallationVersion,
  })
  await client.connect(transport)
  return client
}

export interface EditorContext {
  uri?: string
  selection?: {
    start: { line: number; column: number }
    end: { line: number; column: number }
    text: string
  }
}

const EDITOR_CONTEXT_URI = "editor://context"

let currentContext: EditorContext = {}

export function editorContext(): EditorContext {
  return currentContext
}

export async function subscribeToContext(client: Client): Promise<void> {
  await refreshContext(client)

  await client.subscribeResource({ uri: EDITOR_CONTEXT_URI }).catch((err) => {
    log.debug("failed to subscribe to editor context updates", { error: err })
  })

  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
    if (notification.params.uri === EDITOR_CONTEXT_URI) {
      await refreshContext(client)
    }
  })

  client.onclose = () => {
    currentContext = {}
    GlobalBus.emit("event", {
      payload: {
        type: "ide.context.updated",
        properties: currentContext,
      },
    })
  }
}

async function refreshContext(client: Client): Promise<void> {
  const result = await client.readResource({ uri: EDITOR_CONTEXT_URI }).catch((err) => {
    log.debug("failed to read editor context", { error: err })
    return null
  })
  if (!result) return

  const first = result.contents[0]
  const text = first && "text" in first ? first.text : undefined
  if (typeof text !== "string") return

  const parsed = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  })()

  const schema = Event.ContextUpdated.data
  const decodedOpt = Schema.decodeUnknownOption(schema)(parsed)
  if (decodedOpt._tag === "None") {
    log.debug("editor context failed validation")
    return
  }
  currentContext = decodedOpt.value as EditorContext

  GlobalBus.emit("event", {
    payload: {
      type: "ide.context.updated",
      properties: currentContext,
    },
  })
}

export * as Ide from "."
