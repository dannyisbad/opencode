import { describe, expect, test } from "bun:test"
import { toRunModule, isFreeBodyScript, hasRunExport } from "@/workflow/code-transform"
import { gateCodeSource } from "@/workflow/code-gate"
import ts from "typescript"

// Load a transformed module the way the engine's loadModule does (transpile +
// in-memory data: URL) and run it against a recording fake ctx, so the generated
// hook preamble is exercised end to end.
async function loadAndRun(source: string, ctx: any) {
  const out = toRunModule(source)
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(out)
  const mod: any = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"))
  return { meta: mod.meta, result: await mod.run({ topic: "x" }, ctx) }
}

function recordingCtx(over: Partial<any> = {}) {
  const calls: any[] = []
  const ctx: any = {
    budgetTotal: 1,
    budgetRemaining: 0.4,
    setPhase: (s: string) => calls.push(["phase", s]),
    log: (m: string) => calls.push(["log", m]),
    parallel: async (tasks: any[]) => Promise.all(tasks.map((t) => t())),
    pipeline: async (items: any[], ...rest: any[]) => {
      const stages = rest.filter((r) => typeof r === "function")
      return Promise.all(
        items.map(async (item, i) => {
          let cur = item
          for (const s of stages) cur = await s(cur, item, i)
          return cur
        }),
      )
    },
    agent: async (input: any) => {
      calls.push(["agent", input.agent, input.model, input.schema ? "schema" : "noschema"])
      return { data: { picked: input.prompt }, text: "TEXT:" + input.prompt }
    },
    synthesize: async (o: any) => ({ data: null, text: "synth" }),
    ...over,
  }
  return { ctx, calls }
}

describe("code-transform.toRunModule", () => {
  test("wraps a free body into run(), keeping meta verbatim", async () => {
    const src = `export const meta = { name: "Demo", phases: ["scan"] } as const
phase("scan")
log("hi")
const r = await agent("do it")
return r
`
    const { ctx, calls } = recordingCtx()
    const { meta, result } = await loadAndRun(src, ctx)
    expect(meta).toEqual({ name: "Demo", phases: ["scan"] })
    expect(result).toBe("TEXT:do it")
    expect(calls).toEqual([
      ["phase", "scan"],
      ["log", "hi"],
      ["agent", undefined, undefined, "noschema"],
    ])
  })

  test("agent(prompt, {schema}) returns the validated .data object", async () => {
    const src = `export const meta = { name: "S" } as const
return await agent("structured", { schema: { type: "object" } })
`
    const { ctx } = recordingCtx()
    const { result } = await loadAndRun(src, ctx)
    expect(result).toEqual({ picked: "structured" })
  })

  test("agent(prompt, {agentType, model}) maps to ctx.agent({agent, model})", async () => {
    const src = `export const meta = { name: "S" } as const
await agent("p", { agentType: "explore", model: "google/gemini-3.5-flash" })
return "done"
`
    const { ctx, calls } = recordingCtx()
    await loadAndRun(src, ctx)
    expect(calls[0]).toEqual(["agent", "explore", "google/gemini-3.5-flash", "noschema"])
  })

  test("parallel + pipeline proxy through to ctx with the item index", async () => {
    const src = `export const meta = { name: "S" } as const
const a = (await parallel([() => agent("x"), () => agent("y")])).filter(Boolean)
const b = await pipeline([1, 2], (prev, item, i) => agent(\`item \${item} idx \${i}\`))
return { a: a.length, b }
`
    const { ctx } = recordingCtx()
    const { result } = await loadAndRun(src, ctx)
    expect(result.a).toBe(2)
    expect(result.b).toEqual(["TEXT:item 1 idx 0", "TEXT:item 2 idx 1"])
  })

  test("budget exposes { total, remaining(), spent() } in USD", async () => {
    const src = `export const meta = { name: "S" } as const
return { total: budget.total, remaining: budget.remaining(), spent: budget.spent() }
`
    const { ctx } = recordingCtx({ budgetTotal: 1, budgetRemaining: 0.4 })
    const { result } = await loadAndRun(src, ctx)
    expect(result.total).toBe(1)
    expect(result.remaining).toBe(0.4)
    expect(result.spent).toBeCloseTo(0.6)
  })

  test("budget.total is null and remaining() is Infinity when unbudgeted", async () => {
    const src = `export const meta = { name: "S" } as const
return { total: budget.total, remaining: budget.remaining() }
`
    const { ctx } = recordingCtx({ budgetTotal: Infinity, budgetRemaining: Infinity })
    const { result } = await loadAndRun(src, ctx)
    expect(result.total).toBeNull()
    expect(result.remaining).toBe(Infinity)
  })

  test("args is the run() argument object", async () => {
    const src = `export const meta = { name: "S" } as const
return args.topic
`
    const { ctx } = recordingCtx()
    const { result } = await loadAndRun(src, ctx)
    expect(result).toBe("x")
  })

  test("nested workflow() throws a clear error", async () => {
    const src = `export const meta = { name: "S" } as const
try { workflow("other") } catch (e) { return "caught:" + e.message }
return "no throw"
`
    const { ctx } = recordingCtx()
    const { result } = await loadAndRun(src, ctx)
    expect(result).toContain("not supported")
  })

  test("a stray top-level export is demoted to a local", async () => {
    const src = `export const meta = { name: "S" } as const
export const helper = 7
return helper * 2
`
    const { ctx } = recordingCtx()
    const { result } = await loadAndRun(src, ctx)
    expect(result).toBe(14)
  })

  test("an already-run()-shaped module is returned byte-identical (no-op)", () => {
    const src = `export const meta = { name: "X" } as const\nexport async function run(args, ctx) { return "ok" }\n`
    expect(toRunModule(src)).toBe(src)
  })

  test("an export default workflow module is untouched (no-op)", () => {
    const src = `export default { meta: { name: "X" }, async run() { return 1 } }\n`
    expect(toRunModule(src)).toBe(src)
  })

  test("a module with no meta is untouched (no-op)", () => {
    const src = `const x = 1\n`
    expect(toRunModule(src)).toBe(src)
  })

  // The guide's headline pattern (pipeline → adversarial-verify with schemas) is
  // what models will emit; it must pass the gate AND run through the transform.
  test("the canonical pipeline+verify pattern passes the gate and runs", async () => {
    const src = `export const meta = { name: "Review", description: "Review then verify", phases: ["review", "verify"] } as const
phase("review")
const DIMENSIONS = [{ prompt: "find bugs" }, { prompt: "find perf" }]
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { schema: { type: "object" } }),
  (review) => parallel((review.findings ?? []).map((f) => () =>
    agent("verify " + f.title, { schema: { type: "object" } }).then((v) => ({ ...f, verdict: v })))),
)
phase("verify")
return results.flat().filter(Boolean)
`
    expect(gateCodeSource(src)).toEqual([])
    const ctx: any = {
      budgetTotal: Infinity,
      budgetRemaining: Infinity,
      setPhase: () => {},
      log: () => {},
      parallel: async (tasks: any[]) => Promise.all(tasks.map((t) => t())),
      pipeline: async (items: any[], ...rest: any[]) => {
        const stages = rest.filter((r) => typeof r === "function")
        return Promise.all(
          items.map(async (item, i) => {
            let cur = item
            for (const s of stages) cur = await s(cur, item, i)
            return cur
          }),
        )
      },
      agent: async (input: any) =>
        input.schema ? { data: { findings: [{ title: "f" }] }, text: "" } : { data: null, text: "t" },
    }
    const out = toRunModule(src)
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(out)
    const mod: any = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"))
    const result = await mod.run({}, ctx)
    // Two dimensions, each yields one verified finding.
    expect(result).toHaveLength(2)
    expect(result[0]).toHaveProperty("verdict")
  })
})

describe("code-transform predicates", () => {
  test("isFreeBodyScript: meta + no run export → true", () => {
    expect(isFreeBodyScript(`export const meta = { name: "X" }\nreturn 1\n`)).toBe(true)
  })
  test("isFreeBodyScript: meta + run export → false", () => {
    expect(isFreeBodyScript(`export const meta = { name: "X" }\nexport async function run(){}\n`)).toBe(false)
  })
  test("isFreeBodyScript: no meta → false", () => {
    expect(isFreeBodyScript(`const x = 1\n`)).toBe(false)
  })
  test("hasRunExport detects exported const run", () => {
    const file = ts.createSourceFile("x.ts", `export const run = async () => {}\n`, ts.ScriptTarget.Latest, true)
    expect(hasRunExport(file)).toBe(true)
  })
})
