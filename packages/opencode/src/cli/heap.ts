import path from "path"
import { appendFileSync } from "fs"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
const MINUTE = 60_000
const LIMIT = 2 * 1024 * 1024 * 1024

let timer: Timer | undefined
let lock = false
let armed = true

// Lightweight file logger: this module runs before/outside the Effect runtime
// and must never write to stderr (the TUI owns the screen). Same line format as
// the process-level safety net in index.ts.
function log(level: "INFO" | "ERROR", message: string, extra: Record<string, unknown> = {}) {
  const fields = Object.entries(extra)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ")
  try {
    appendFileSync(
      path.join(Global.Path.log, "opencode.log"),
      `timestamp=${new Date().toISOString()} level=${level} message=${JSON.stringify(message)}${fields ? " " + fields : ""}\n`,
    )
  } catch {}
}

export function start() {
  if (!Flag.OPENCODE_AUTO_HEAP_SNAPSHOT) return
  if (timer) return

  let lastLoggedRss = 0

  const run = async () => {
    if (lock) return

    const stat = process.memoryUsage()
    // Growth curve: one line whenever RSS moved >256MB since the last line.
    // Cheap, and it's the difference between "it leaked to 20GB at some point
    // overnight" and an actual timeline pointing at the trigger.
    if (Math.abs(stat.rss - lastLoggedRss) > 256 * 1024 * 1024) {
      lastLoggedRss = stat.rss
      log("INFO", "heap rss", {
        rssMB: Math.round(stat.rss / 1024 / 1024),
        heapUsedMB: Math.round(stat.heapUsed / 1024 / 1024),
        externalMB: Math.round((stat.external ?? 0) / 1024 / 1024),
        pid: process.pid,
      })
    }

    if (stat.rss <= LIMIT) {
      armed = true
      return
    }
    if (!armed) return

    lock = true
    armed = false
    const file = path.join(
      Global.Path.log,
      `heap-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`,
    )
    log("INFO", "heap snapshot: rss over limit, writing", { file, rssMB: Math.round(stat.rss / 1024 / 1024) })
    await Promise.resolve()
      .then(() => writeHeapSnapshot(file))
      .then(() => log("INFO", "heap snapshot written", { file }))
      .catch((error) => log("ERROR", "heap snapshot failed", { error: String(error) }))

    lock = false
  }

  timer = setInterval(() => {
    void run()
  }, MINUTE)
  timer.unref?.()
}

export * as Heap from "./heap"
