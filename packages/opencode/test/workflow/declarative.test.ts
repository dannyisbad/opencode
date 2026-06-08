import { describe, test, expect } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Declarative } from "@/workflow/declarative"
import { MetaReader } from "@/workflow/meta-reader"

// A mock ContextApi that records which primitives were invoked and returns
// shaped results, so we can exercise the COMPILED `run()` end-to-end without the
// real engine. This proves the generated wiring is executable and correct.
function mockCtx() {
  const calls = { agent: 0, parallel: 0, pipeline: 0, synthesize: 0, adversarial: 0 }
  const r = (text: string) => ({ text, data: undefined as unknown })
  const ctx = {
    calls,
    setPhase() {},
    log() {},
    async agent({ prompt }: { prompt: string }) {
      calls.agent++
      return r("[agent] " + String(prompt).slice(0, 40))
    },
    async parallel(tasks: (() => Promise<unknown>)[]) {
      calls.parallel++
      return Promise.all(tasks.map((t) => t()))
    },
    async pipeline(items: unknown[], ...stages: ((p: unknown, i: unknown) => Promise<unknown>)[]) {
      calls.pipeline++
      return Promise.all(
        items.map(async (it) => {
          let cur: unknown = it
          for (const s of stages) cur = await s(cur, it)
          return cur
        }),
      )
    },
    async synthesize({ agents }: { agents: unknown[] }) {
      calls.synthesize++
      return r("[synth " + agents.length + "]")
    },
    async adversarial({ worker }: { worker: unknown }) {
      calls.adversarial++
      const w = typeof worker === "function" ? await worker() : await worker
      return { worker: w, verification: { pass: true, confidence: 1, issues: [], evidence: [] } }
    },
  }
  return ctx
}

const dir = mkdtempSync(join(tmpdir(), "declarative-test-"))
let seq = 0
async function loadCompiled(plan: Declarative.WorkflowPlan) {
  const compiled = Declarative.compile(plan)
  // The generated source must be statically discoverable by the meta-reader.
  const meta = MetaReader.read(compiled.source, "generated.ts")
  expect(meta.valid).toBe(true)
  const file = join(dir, `wf${seq++}.ts`)
  writeFileSync(file, compiled.source)
  return import(pathToFileURL(file).href)
}

describe("declarative compiler — compiled workflows run", () => {
  test("trivial objective compiles to a single agent step", async () => {
    const plan: Declarative.WorkflowPlan = {
      name: "inspect",
      description: "summarize",
      steps: [{ id: "summary", kind: "agent", prompt: "List files; summarize in 3 bullets." }],
    }
    expect(Declarative.lint(plan)).toEqual([])
    const mod = await loadCompiled(plan)
    const ctx = mockCtx()
    const out = await mod.run({}, ctx)
    expect(ctx.calls).toMatchObject({ agent: 1, parallel: 0, adversarial: 0 })
    expect(out).toBeDefined()
  })

  test("fanout + synthesize wires prior output", async () => {
    const plan: Declarative.WorkflowPlan = {
      name: "research",
      description: "study",
      steps: [
        { id: "find", kind: "fanout", agent: "explore", prompt: "Find {item}.", items: ["a", "b"] },
        { id: "report", kind: "synthesize", agent: "general", from: ["find"], prompt: "Report." },
      ],
    }
    expect(Declarative.lint(plan)).toEqual([])
    const mod = await loadCompiled(plan)
    const ctx = mockCtx()
    await mod.run({}, ctx)
    expect(ctx.calls.parallel).toBe(1)
    expect(ctx.calls.agent).toBe(2) // one per fan-out item
    expect(ctx.calls.synthesize).toBe(1)
  })

  test("verify with maxRetries compiles to an adversarial refine loop", async () => {
    const plan: Declarative.WorkflowPlan = {
      name: "quality",
      description: "draft + verify",
      steps: [
        { id: "draft", kind: "agent", agent: "build", prompt: "Write it." },
        { id: "check", kind: "verify", target: "draft", rubric: ["complete", "no placeholders"], maxRetries: 2 },
      ],
    }
    expect(Declarative.lint(plan)).toEqual([])
    const mod = await loadCompiled(plan)
    const ctx = mockCtx()
    const out = await mod.run({}, ctx)
    expect(ctx.calls.adversarial).toBeGreaterThanOrEqual(1)
    expect(out).toHaveProperty("verification")
  })

  test("pipeline runs a seed through ordered stages", async () => {
    const plan: Declarative.WorkflowPlan = {
      name: "pipe",
      description: "stages",
      steps: [{ id: "p", kind: "pipeline", stages: [{ prompt: "draft" }, { prompt: "polish" }] }],
    }
    expect(Declarative.lint(plan)).toEqual([])
    const mod = await loadCompiled(plan)
    const ctx = mockCtx()
    await mod.run({}, ctx)
    expect(ctx.calls.pipeline).toBe(1)
  })
})

describe("declarative lint — rejects malformed plans", () => {
  test("unknown reference", () => {
    const errors = Declarative.lint({
      name: "x",
      description: "y",
      steps: [{ id: "a", kind: "synthesize", from: ["missing"] }],
    })
    expect(errors.some((e) => /unknown step id "missing"/.test(e))).toBe(true)
  })

  test("duplicate id", () => {
    const errors = Declarative.lint({
      name: "x",
      description: "y",
      steps: [
        { id: "a", kind: "agent", prompt: "p" },
        { id: "a", kind: "agent", prompt: "p" },
      ],
    })
    expect(errors.some((e) => /duplicate step id "a"/.test(e))).toBe(true)
  })

  test("forward reference (uses a later step)", () => {
    const errors = Declarative.lint({
      name: "x",
      description: "y",
      steps: [
        { id: "a", kind: "agent", prompt: "p", uses: ["b"] },
        { id: "b", kind: "agent", prompt: "p" },
      ],
    })
    expect(errors.some((e) => /not defined before it/.test(e))).toBe(true)
  })

  test("fanout with both items and itemsFrom", () => {
    const errors = Declarative.lint({
      name: "x",
      description: "y",
      steps: [{ id: "f", kind: "fanout", prompt: "p", items: ["x"], itemsFrom: "g" }],
    })
    expect(errors.some((e) => /exactly one of/.test(e))).toBe(true)
  })

  test("empty plan", () => {
    expect(Declarative.lint({ name: "x", description: "y", steps: [] })).not.toEqual([])
  })
})
