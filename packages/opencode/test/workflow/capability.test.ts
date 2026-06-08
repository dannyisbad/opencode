import { describe, test, expect } from "bun:test"
import { isCodeCapable, decideTier } from "@/workflow/capability"
import type { ModelDesc } from "@/workflow/resilience"

const m = (providerID: string, modelID: string) => ({ providerID, modelID }) as ModelDesc

describe("capability.isCodeCapable", () => {
  test("capable: anthropic opus/sonnet, gpt-5, o3/o4, gemini-3 pro", () => {
    expect(isCodeCapable(m("anthropic", "claude-opus-4-8"))).toBe(true)
    expect(isCodeCapable(m("anthropic", "claude-sonnet-4-6"))).toBe(true)
    expect(isCodeCapable(m("openai", "gpt-5-mini"))).toBe(true)
    expect(isCodeCapable(m("openai", "o3"))).toBe(true)
    expect(isCodeCapable(m("openai", "o4-mini"))).toBe(true)
    expect(isCodeCapable(m("google", "gemini-3.1-pro-preview"))).toBe(true)
  })

  test("floor: haiku, flash, mini, unknown → not capable", () => {
    expect(isCodeCapable(m("anthropic", "claude-haiku-4-5"))).toBe(false)
    expect(isCodeCapable(m("google", "gemini-3.5-flash"))).toBe(false)
    expect(isCodeCapable(m("github-copilot", "gemini-3.5-flash"))).toBe(false)
    expect(isCodeCapable(m("openai", "gpt-4o-mini"))).toBe(false)
    expect(isCodeCapable(m("some-local", "llama-3-8b"))).toBe(false)
  })

  test("config globs override the built-in list", () => {
    // custom list makes a local model capable and (by replacement) drops anthropic
    expect(isCodeCapable(m("ollama", "qwen3-coder"), ["ollama/qwen3-coder"])).toBe(true)
    expect(isCodeCapable(m("anthropic", "claude-opus-4-8"), ["ollama/*"])).toBe(false)
  })
})

describe("capability.decideTier", () => {
  const opus = m("anthropic", "claude-opus-4-8")
  const flash = m("google", "gemini-3.5-flash")

  test("auto routes by capability", () => {
    expect(decideTier({ model: opus })).toBe("code")
    expect(decideTier({ model: flash })).toBe("declarative")
  })

  test("explicit config flag wins over auto", () => {
    expect(decideTier({ config: "declarative", model: opus })).toBe("declarative")
    expect(decideTier({ config: "code", model: flash })).toBe("code") // forced even on a weak model
  })

  test("per-call override wins over config", () => {
    expect(decideTier({ override: "code", config: "declarative", model: flash })).toBe("code")
    expect(decideTier({ override: "declarative", config: "code", model: opus })).toBe("declarative")
    expect(decideTier({ override: "auto", config: "declarative", model: opus })).toBe("code")
  })

  test("default (nothing set) = auto", () => {
    expect(decideTier({ model: opus })).toBe("code")
    expect(decideTier({ model: flash })).toBe("declarative")
  })
})
