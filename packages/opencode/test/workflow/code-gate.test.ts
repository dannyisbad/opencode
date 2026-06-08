import { describe, test, expect } from "bun:test"
import { gateCodeSource } from "@/workflow/code-gate"
import { Declarative } from "@/workflow/declarative"

// The canonical code-tier module shape (the emit target + the prompt's worked
// example): literal `meta`, an exported async `run`, no imports, ctx.* only.
const EXAMPLE = `export const meta = { name: "Research", description: "Compare two topics", phases: ["gather", "report"] } as const
export async function run(args: any, ctx: any) {
  ctx.setPhase("gather")
  const topics = ["auth", "caching"]
  const found = (await ctx.parallel(topics.map((t) => () =>
    ctx.agent({ agent: "explore", prompt: "Find how " + t + " is implemented." })))).filter(Boolean)
  ctx.setPhase("report")
  const report = await ctx.synthesize({ agents: found, prompt: "Write a concise report." })
  return report.text
}
`

const META = `export const meta = { name: "W", description: "d", phases: ["p"] } as const\n`
const RUN = `export async function run(args, ctx) { return "ok" }\n`

describe("code-gate gateCodeSource", () => {
  test("accepts the canonical example module", () => {
    expect(gateCodeSource(EXAMPLE)).toEqual([])
  })

  test("accepts a real Declarative.compile() output (shape-compatible)", () => {
    const compiled = Declarative.compile({
      name: "Round trip",
      description: "proves the code gate accepts the compiler's own emitted shape",
      steps: [
        { id: "find", kind: "fanout", agent: "explore", prompt: "Find how {item} works.", items: ["a", "b"] },
        { id: "report", kind: "agent", agent: "general", prompt: "Write a report.", uses: ["find"] },
      ],
    } as Parameters<typeof Declarative.compile>[0])
    expect(gateCodeSource(compiled.source)).toEqual([])
  })

  test("rejects module imports", () => {
    const out = gateCodeSource(`import fs from "fs"\n${META}${RUN}`)
    expect(out.some((p) => p.includes("import"))).toBe(true)
  })

  test("rejects require()", () => {
    const out = gateCodeSource(`${META}export async function run(a, c) { const fs = require("fs"); return "" }\n`)
    // require flagged both as a banned identifier and as a call — either is fine
    expect(out.some((p) => p.includes("require"))).toBe(true)
  })

  test("rejects eval()", () => {
    const out = gateCodeSource(`${META}export async function run(a, c) { eval("1+1"); return "" }\n`)
    expect(out.some((p) => p.includes("eval"))).toBe(true)
  })

  test("rejects dynamic import()", () => {
    const out = gateCodeSource(`${META}export async function run(a, c) { await import("node:fs"); return "" }\n`)
    expect(out.some((p) => p.includes("dynamic import"))).toBe(true)
  })

  test("rejects process / fs free references", () => {
    const out = gateCodeSource(`${META}export async function run(a, c) { return process.env.SECRET ?? "" }\n`)
    expect(out.some((p) => p.includes("process"))).toBe(true)
  })

  test("rejects a non-literal meta", () => {
    const NAME = "x"
    const out = gateCodeSource(`const NAME = "x"\nexport const meta = { name: NAME, description: "d", phases: [] }\n${RUN}`)
    expect(out.some((p) => p.toLowerCase().includes("meta"))).toBe(true)
    void NAME
  })

  test("rejects a module with no exported run", () => {
    const out = gateCodeSource(`${META}async function run(a, c) { return "" }\n`) // run not exported
    expect(out.some((p) => p.includes("run"))).toBe(true)
  })

  test("does NOT ban Date.now / Math.random (no journaled resume in opencode)", () => {
    const out = gateCodeSource(
      `${META}export async function run(a, c) { ctx.log(String(Date.now())); return String(Math.random()) }\n`,
    )
    expect(out).toEqual([])
  })

  test("a property named like a banned global is fine (only free refs are banned)", () => {
    const out = gateCodeSource(`${META}export async function run(a, c) { const o = { fs: 1, process: 2 }; return String(o.fs) }\n`)
    expect(out).toEqual([])
  })
})
