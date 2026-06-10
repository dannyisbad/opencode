import type { Part } from "@opencode-ai/sdk/v2"

// Derives the session's background bash commands purely from synced parts —
// the same data the model sees, so no extra server plumbing:
//
// 1. RUNNING: when a bash command is backgrounded (Ctrl+B, `background: true`,
//    or the 30s auto-promote), its tool part settles to `completed` with a
//    `<terminal_run … state="running" kind="bash">` block as the OUTPUT. The
//    block's `id` is the background job id (== the tool callID).
// 2. DONE: when the job exits, the server injects a SYNTHETIC user text part
//    `<terminal_run id="…" state="completed|error" kind="bash" exit="…"
//    elapsed="…">` into the conversation (it re-prompts the model).
//
// Both shapes share the id, so a later completion flips the earlier running
// entry. Completed entries are still returned (the flip is how a running row
// clears), but the strip only DISPLAYS running ones — a finished command's
// durable record is its inline ▣ completion row in scrollback.
export type BackgroundCommand = {
  id: string
  label: string
  status: "running" | "completed" | "error"
  exit?: string
  elapsed?: string
}

const RUNNING_RE = /^\s*<terminal_run\b[^>]*\bstate="running"/
const DONE_RE = /^\s*<terminal_run\b[^>]*\bstate="(completed|error|failed)"/

function attr(text: string, name: string) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(text)?.[1]
}

export function collectBackgroundCommands(messageIDs: string[], parts: Record<string, Part[]>): BackgroundCommand[] {
  const commands = new Map<string, BackgroundCommand>()

  for (const messageID of messageIDs) {
    for (const part of parts[messageID] ?? []) {
      // Backgrounded: the bash tool part's output is the running block.
      if (part.type === "tool" && part.tool === "bash" && part.state.status === "completed") {
        const out = part.state.output ?? ""
        if (!RUNNING_RE.test(out) || attr(out, "kind") !== "bash") continue
        const id = attr(out, "id")
        if (!id || commands.has(id)) continue
        commands.set(id, {
          id,
          label: attr(out, "label") ?? "command",
          status: "running",
        })
        continue
      }

      // Finished: the synthetic completion block flips the entry by id.
      if (part.type === "text" && part.synthetic) {
        const text = part.text ?? ""
        const m = DONE_RE.exec(text)
        if (!m || attr(text, "kind") !== "bash") continue
        const id = attr(text, "id")
        if (!id) continue
        commands.set(id, {
          id,
          label: attr(text, "label") ?? commands.get(id)?.label ?? "command",
          status: m[1] === "completed" ? "completed" : "error",
          exit: attr(text, "exit"),
          elapsed: attr(text, "elapsed"),
        })
      }
    }
  }

  // Running first, then most recent first within each group (message order is
  // chronological, so reversing the insertion order approximates recency).
  const list = [...commands.values()].reverse()
  return [...list.filter((x) => x.status === "running"), ...list.filter((x) => x.status !== "running")]
}
