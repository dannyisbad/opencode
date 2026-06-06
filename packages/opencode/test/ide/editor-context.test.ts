/**
 * Tests for the IDE editor context pipeline: subscribing to context updates,
 * handling error conditions, schema validation, and system prompt formatting.
 *
 * Uses a fake MCP client — the real server is tested separately in
 * sdks/vscode/test/mcp-server.test.ts.
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test"
import { Ide } from "../../src/ide/index.js"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"
import { Schema, Result } from "effect"

// ---------------------------------------------------------------------------
// Fake MCP Client
// ---------------------------------------------------------------------------

/**
 * Minimal fake of the MCP SDK Client, implementing only the methods that
 * subscribeToContext uses. Returns canned responses rather than making real
 * network calls. Avoids importing the real Client class, which can be
 * replaced by mock.module() in other test files (Bun shares the module
 * cache across test files with no isolation).
 */
function createFakeClient(initial: { context: any }) {
  let context = initial.context
  let handler: ((n: any) => Promise<void>) | null = null
  let isClosed = false

  return {
    async readResource(req: { uri: string }) {
      if (isClosed) throw new Error("Connection closed")
      if (req.uri !== "editor://context") {
        throw new Error(`Unexpected resource uri: ${req.uri}`)
      }
      return {
        contents: [
          {
            uri: req.uri,
            mimeType: "application/json",
            text: JSON.stringify(context),
          },
        ],
      }
    },

    async subscribeResource(req: { uri: string }) {
      if (isClosed) throw new Error("Connection closed")
      if (req.uri !== "editor://context") {
        throw new Error(`Unexpected resource uri: ${req.uri}`)
      }
    },

    setNotificationHandler(schema: any, fn: (n: any) => Promise<void>) {
      handler = fn
    },

    // Test helper to mutate context and trigger a notification.
    setContext(ctx: any) {
      context = ctx
    },

    async sendNotification(uri: string) {
      if (handler) {
        await handler({ params: { uri } })
      }
    },

    // Mock close behavior.
    onclose: null as (() => void) | null,
    async close() {
      isClosed = true
      if (this.onclose) {
        this.onclose()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("subscribeToContext", () => {
  let tmp: Awaited<ReturnType<typeof tmpdir>>
  let client: any = null

  beforeEach(async () => {
    tmp = await tmpdir({ git: true })
    client = null
  })

  afterEach(async () => {
    if (client) {
      await client.close()
    }
    await tmp[Symbol.asyncDispose]()
  })

  test("reads initial context and updates on notification", async () => {
    expect(Ide.editorContext()).toEqual({})

    client = createFakeClient({
      context: { uri: "/initial/file.ts" },
    })

    await Ide.subscribeToContext(client as any)

    // Initial state was read.
    expect(Ide.editorContext().uri).toBe("/initial/file.ts")

    // Simulate the server-side file change + notification.
    client.setContext({ uri: "/updated/file.ts" })
    await client.sendNotification("editor://context")

    expect(Ide.editorContext().uri).toBe("/updated/file.ts")
  })

  test("clears context when client disconnects", async () => {
    client = createFakeClient({
      context: { uri: "/some/file.ts" },
    })

    await Ide.subscribeToContext(client as any)
    expect(Ide.editorContext().uri).toBe("/some/file.ts")

    await client.close()
    client = null
    expect(Ide.editorContext()).toEqual({})
  })

  test("continues on resource subscription failure", async () => {
    client = createFakeClient({
      context: { uri: "/fallback/file.ts" },
    })
    // Simulate subscription failure (e.g. server capabilities mismatch).
    client.subscribeResource = () => Promise.reject(new Error("Subscription rejected"))

    // Should not throw — subscribeToContext should degrade gracefully
    // to "no live updates" while retaining the initial snapshot.
    await expect(Ide.subscribeToContext(client as any)).resolves.toBeUndefined()
    expect(Ide.editorContext().uri).toBe("/fallback/file.ts")
  })

  test("ignores notifications for other resources", async () => {
    client = createFakeClient({
      context: { uri: "/good/file.ts" },
    })
    await Ide.subscribeToContext(client as any)
    expect(Ide.editorContext().uri).toBe("/good/file.ts")

    // Trigger notification for a different resource URI.
    client.setContext({ uri: "/ignored/file.ts" })
    await client.sendNotification("other://resource")

    // State should remain unchanged.
    expect(Ide.editorContext().uri).toBe("/good/file.ts")
  })

  test("ignores read failure on notification", async () => {
    client = createFakeClient({
      context: { uri: "/good/file.ts" },
    })
    await Ide.subscribeToContext(client as any)
    expect(Ide.editorContext().uri).toBe("/good/file.ts")

    // Make follow-up reads fail.
    client.readResource = () => Promise.reject(new Error("Network error"))
    await client.sendNotification("editor://context")

    // State should remain unchanged (degrade gracefully).
    expect(Ide.editorContext().uri).toBe("/good/file.ts")
  })

  test("ignores invalid content type on read", async () => {
    client = createFakeClient({
      context: { uri: "/good/file.ts" },
    })
    await Ide.subscribeToContext(client as any)
    expect(Ide.editorContext().uri).toBe("/good/file.ts")

    // Return non-string/non-JSON content.
    client.readResource = async () => ({
      contents: [{ uri: "editor://context", mimeType: "image/png" }],
    }) as any
    await client.sendNotification("editor://context")

    // State should remain unchanged.
    expect(Ide.editorContext().uri).toBe("/good/file.ts")
  })

  test("ignores malformed JSON on read", async () => {
    client = createFakeClient({
      context: { uri: "/good/file.ts" },
    })
    await Ide.subscribeToContext(client as any)
    expect(Ide.editorContext().uri).toBe("/good/file.ts")

    // Return invalid JSON.
    client.readResource = async () => ({
      contents: [{ uri: "editor://context", mimeType: "application/json", text: "{invalid-json" }],
    })
    await client.sendNotification("editor://context")

    // State should remain unchanged.
    expect(Ide.editorContext().uri).toBe("/good/file.ts")
  })

  test("ignores payloads that fail schema validation", async () => {
    client = createFakeClient({ context: { uri: "/good/file.ts" } })
    await Ide.subscribeToContext(client as any)
    expect(Ide.editorContext().uri).toBe("/good/file.ts")

    // Return valid JSON that doesn't match the EditorContext schema
    // (selection missing required fields).
    client.setContext({ uri: 123, selection: "not-an-object" } as any)
    await client.sendNotification("editor://context")

    // State should be unchanged.
    expect(Ide.editorContext().uri).toBe("/good/file.ts")
  })
})

// ---------------------------------------------------------------------------
// EditorContext schema — contract between VS Code extension and CLI
// ---------------------------------------------------------------------------

describe("EditorContext schema", () => {
  const schema = Ide.Event.ContextUpdated.data

  test("accepts empty object (no active editor)", () => {
    const result = Schema.decodeUnknownResult(schema)({})
    expect(Result.isSuccess(result)).toBe(true)
  })

  test("accepts uri only", () => {
    const result = Schema.decodeUnknownResult(schema)({ uri: "file:///workspace/index.ts" })
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success.uri).toBe("file:///workspace/index.ts")
    }
  })

  test("accepts uri with selection", () => {
    const result = Schema.decodeUnknownResult(schema)({
      uri: "git:///workspace/index.ts?ref=HEAD",
      selection: {
        start: { line: 0, column: 0 },
        end: { line: 5, column: 10 },
        text: "hello",
      },
    })
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success.selection?.text).toBe("hello")
    }
  })

  test("rejects uri with wrong type", () => {
    const result = Schema.decodeUnknownResult(schema)({ uri: 42 })
    expect(Result.isFailure(result)).toBe(true)
  })

  test("rejects selection missing required fields", () => {
    const result = Schema.decodeUnknownResult(schema)({
      uri: "file:///foo",
      selection: { start: { line: 0, column: 0 } },
    })
    expect(Result.isFailure(result)).toBe(true)
  })

  test("strips unknown fields", () => {
    const result = Schema.decodeUnknownResult(schema)({ uri: "file:///foo", extra: "field" })
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect((result.success as any).extra).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// getIdeContext — system prompt formatting
// ---------------------------------------------------------------------------

describe("getIdeContext", () => {
  let tmp: Awaited<ReturnType<typeof tmpdir>>
  let client: any = null

  beforeEach(async () => {
    tmp = await tmpdir({ git: true })
    client = null
  })

  afterEach(async () => {
    if (client) {
      await client.close()
    }
    await tmp[Symbol.asyncDispose]()
  })

  test("returns empty array when no editor is active", async () => {
    // Default state — no IDE connected.
    expect(SystemPrompt.getIdeContext()).toEqual([])
  })

  test("returns empty array for empty context (connected but no open file)", async () => {
    client = createFakeClient({ context: {} })
    await Ide.subscribeToContext(client as any)

    expect(SystemPrompt.getIdeContext()).toEqual([])
  })

  test("formats uri-only context", async () => {
    client = createFakeClient({ context: { uri: "file:///workspace/app.ts" } })
    await Ide.subscribeToContext(client as any)

    const result = SystemPrompt.getIdeContext().join("\n")
    expect(result).toContain("<ide-context>")
    expect(result).toContain("file:///workspace/app.ts")
    expect(result).toContain("</ide-context>")
  })

  test("formats context with selection and 1-indexed lines", async () => {
    client = createFakeClient({
      context: {
        uri: "file:///workspace/app.ts",
        selection: {
          start: { line: 0, column: 0 },
          end: { line: 1, column: 11 },
          text: "const x = 1\nconst y = 2",
        },
      },
    })
    await Ide.subscribeToContext(client as any)

    const result = SystemPrompt.getIdeContext().join("\n")
    // Lines are 0-indexed from VS Code, displayed as 1-indexed.
    expect(result).toContain("<ide-context>")
    expect(result).toContain("lines 1-2 selected:")
    expect(result).toContain("const x = 1\nconst y = 2")
    expect(result).toContain("file:///workspace/app.ts")
    expect(result).toContain("</ide-context>")
  })

  test("uses singular 'line' for single-line selection", async () => {
    client = createFakeClient({
      context: {
        uri: "file:///workspace/app.ts",
        selection: {
          start: { line: 4, column: 0 },
          end: { line: 4, column: 15 },
          text: "const x = 'hi'",
        },
      },
    })
    await Ide.subscribeToContext(client as any)

    const result = SystemPrompt.getIdeContext().join("\n")
    expect(result).toContain("line 5 selected:")
    expect(result).not.toContain("lines")
  })
})
