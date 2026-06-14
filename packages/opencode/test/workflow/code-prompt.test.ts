import { describe, test, expect } from "bun:test"
import { codeWorkflowPlannerPrompt } from "@/workflow/code-prompt"
import { gateCodeSource } from "@/workflow/code-gate"
import { ScriptPrompt } from "@/workflow/script-prompt"

describe("code-prompt", () => {
  test("every worked-example module in the prompt passes the static gate", () => {
    const prompt = codeWorkflowPlannerPrompt("test objective")
    const blocks = [...prompt.matchAll(/```ts\n([\s\S]*?)```/g)].map((mm) => mm[1])
    expect(blocks.length).toBeGreaterThanOrEqual(2)
    // If the examples the model copies aren't gate-clean, the prompt teaches a bad shape.
    for (const b of blocks) expect(gateCodeSource(b)).toEqual([])
  })

  test("weaves in the objective and the load-bearing contract points", () => {
    const p = codeWorkflowPlannerPrompt("MY-UNIQUE-OBJECTIVE")
    expect(p).toContain("MY-UNIQUE-OBJECTIVE")
    expect(p).toContain("LITERAL VALUES ONLY")
    expect(p).toContain("export async function run")
    expect(p).toContain("ctx.pipeline")
    expect(p).toContain("ctx.adversarial")
    expect(p).toContain("filter(Boolean)")
    expect(p).toContain("NEVER 'plan'")
    expect(p).toContain("not token thrift")
    expect(p).toContain("large fan-in")
    expect(p).toContain("schema can fail")
    // does NOT carry ultracode's determinism rules (opencode has no journaled resume)
    expect(p).not.toContain("Date.now")
    expect(p).not.toContain("Math.random")
  })

  test("free-body script authoring guide warns about agentic fan-out pitfalls", () => {
    const p = ScriptPrompt.SCRIPT_AUTHORING_GUIDE
    expect(p).toContain("full autonomous OpenCode subagent")
    expect(p).toContain("Do not be timid")
    expect(p).toContain("large fan-in")
    expect(p).toContain("schema can fail")
    expect(p).toContain("must not create or edit files")
  })
})
