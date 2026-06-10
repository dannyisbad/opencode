import { describe, expect, test } from "bun:test"
import { collectBackgroundCommands } from "../src/routes/session/background-data"
import type { Part } from "@opencode-ai/sdk/v2"

function bashToolPart(id: string, label: string): Part {
  return {
    id: `prt_tool_${id}`,
    messageID: "msg_1",
    sessionID: "ses_1",
    type: "tool",
    callID: id,
    tool: "bash",
    state: {
      status: "completed",
      input: { command: "bun run forever.ts", description: label },
      output: [
        `<terminal_run id="${id}" state="running" kind="bash" label="${label}">`,
        `<summary>Command running in background: ${label}</summary>`,
        `<instructions>...</instructions>`,
        `</terminal_run>`,
      ].join("\n"),
      title: label,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  } as unknown as Part
}

function completionPart(id: string, label: string, state: "completed" | "error", exit?: number): Part {
  const exitAttr = exit !== undefined ? ` exit="${exit}"` : ""
  return {
    id: `prt_done_${id}`,
    messageID: "msg_2",
    sessionID: "ses_1",
    type: "text",
    synthetic: true,
    text: [
      "",
      `<terminal_run id="${id}" state="${state}" kind="bash" label="${label}"${exitAttr} elapsed="1m07s">`,
      `<summary>Background command ${state}: ${label}</summary>`,
      `<terminal_result>output here</terminal_result>`,
      `</terminal_run>`,
    ].join("\n"),
  } as unknown as Part
}

describe("collectBackgroundCommands", () => {
  test("a backgrounded command shows as running", () => {
    const parts = { msg_1: [bashToolPart("bg1", "Run bot")] }
    const result = collectBackgroundCommands(["msg_1"], parts)
    expect(result).toEqual([{ id: "bg1", label: "Run bot", status: "running" }])
  })

  test("a completion part flips the entry and persists it", () => {
    const parts = {
      msg_1: [bashToolPart("bg1", "Run bot")],
      msg_2: [completionPart("bg1", "Run bot", "completed", 0)],
    }
    const result = collectBackgroundCommands(["msg_1", "msg_2"], parts)
    expect(result).toEqual([{ id: "bg1", label: "Run bot", status: "completed", exit: "0", elapsed: "1m07s" }])
  })

  test("an error completion maps to error with exit code", () => {
    const parts = {
      msg_1: [bashToolPart("bg1", "Run bot")],
      msg_2: [completionPart("bg1", "Run bot", "error")],
    }
    const result = collectBackgroundCommands(["msg_1", "msg_2"], parts)
    expect(result[0].status).toBe("error")
  })

  test("running commands sort before completed ones", () => {
    const parts = {
      msg_1: [bashToolPart("a", "First"), bashToolPart("b", "Second")],
      msg_2: [completionPart("a", "First", "completed", 0)],
    }
    const result = collectBackgroundCommands(["msg_1", "msg_2"], parts)
    expect(result.map((x) => x.id)).toEqual(["b", "a"])
    expect(result[0].status).toBe("running")
  })

  test("terminal-tool sessions (kind=terminal) are excluded", () => {
    const part = bashToolPart("t1", "SSH session")
    ;(part as any).state.output = (part as any).state.output.replaceAll('kind="bash"', 'kind="terminal"')
    const result = collectBackgroundCommands(["msg_1"], { msg_1: [part] })
    expect(result).toEqual([])
  })

  test("ordinary completed bash commands produce no entries", () => {
    const part = {
      id: "prt_x",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      callID: "x",
      tool: "bash",
      state: { status: "completed", input: {}, output: "total 4\n-rw-r--r-- file", metadata: {}, time: { start: 1, end: 2 } },
    } as unknown as Part
    const result = collectBackgroundCommands(["msg_1"], { msg_1: [part] })
    expect(result).toEqual([])
  })

  test("a completion without a prior running part still creates a persisted entry", () => {
    const parts = { msg_2: [completionPart("orphan", "Quick job", "completed", 1)] }
    const result = collectBackgroundCommands(["msg_2"], parts)
    expect(result).toEqual([{ id: "orphan", label: "Quick job", status: "completed", exit: "1", elapsed: "1m07s" }])
  })
})
