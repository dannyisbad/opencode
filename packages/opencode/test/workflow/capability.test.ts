import { describe, test, expect } from "bun:test"
import { isCodeCapable, decideTier } from "@/workflow/capability"
import type { ModelDesc } from "@/workflow/resilience"

const m = (providerID: string, modelID: string) => ({ providerID, modelID }) as ModelDesc

describe("capability.isCodeCapable", () => {
  test("capable: the curated fleet, provider-agnostic", () => {
    expect(isCodeCapable(m("anthropic", "claude-opus-4-8"))).toBe(true)
    expect(isCodeCapable(m("google-antigravity", "claude-opus-4-6-thinking"))).toBe(true)
    expect(isCodeCapable(m("github-copilot", "claude-sonnet-4.5"))).toBe(true)
    expect(isCodeCapable(m("openai", "gpt-5.4-mini"))).toBe(true)
    expect(isCodeCapable(m("openai", "gpt-5.5-pro"))).toBe(true)
    expect(isCodeCapable(m("github-copilot", "gpt-5.3-codex"))).toBe(true)
    expect(isCodeCapable(m("openai", "o3"))).toBe(true)
    expect(isCodeCapable(m("google", "gemini-3.1-pro-preview"))).toBe(true)
    // the same model through another provider is just as capable:
    expect(isCodeCapable(m("google", "gemini-3.5-flash"))).toBe(true)
    expect(isCodeCapable(m("github-copilot", "gemini-3.5-flash"))).toBe(true)
    expect(isCodeCapable(m("google-antigravity", "gemini-3.5-flash-low"))).toBe(true)
    expect(isCodeCapable(m("google-antigravity", "gemini-3-flash-agent"))).toBe(true)
    expect(isCodeCapable(m("google-antigravity", "gemini-pro-agent"))).toBe(true)
    expect(isCodeCapable(m("opencode-go", "kimi-k2.6"))).toBe(true)
    expect(isCodeCapable(m("opencode-go", "glm-5.1"))).toBe(true)
    expect(isCodeCapable(m("opencode-go", "minimax-m3"))).toBe(true)
    expect(isCodeCapable(m("opencode-go", "qwen3.7-max"))).toBe(true)
    expect(isCodeCapable(m("opencode-go", "mimo-v2.5-pro"))).toBe(true)
    expect(isCodeCapable(m("opencode-go", "deepseek-v4-pro"))).toBe(true)
    expect(isCodeCapable(m("opencode", "nemotron-3-ultra-free"))).toBe(true)
    expect(isCodeCapable(m("opencode", "north-mini-code-free"))).toBe(true)
  })

  test("floor: haiku, old mini, gemini ≤3.0/2.x, weak open-weights, unknown → not capable", () => {
    expect(isCodeCapable(m("github-copilot", "claude-haiku-4.5"))).toBe(false)
    expect(isCodeCapable(m("github-copilot", "gpt-5-mini"))).toBe(false) // pre-5.4 mini
    expect(isCodeCapable(m("google", "gemini-2.5-flash"))).toBe(false)
    expect(isCodeCapable(m("google", "gemini-2.5-pro"))).toBe(false)
    expect(isCodeCapable(m("google", "gemini-3-flash-preview"))).toBe(false) // only the -agent variant
    expect(isCodeCapable(m("google", "gemini-3-pro-image-preview"))).toBe(false) // image model
    expect(isCodeCapable(m("google", "gemini-3.1-flash-lite"))).toBe(false)
    expect(isCodeCapable(m("opencode-go", "minimax-m2.7"))).toBe(false)
    expect(isCodeCapable(m("opencode-go", "deepseek-v4-flash"))).toBe(false)
    expect(isCodeCapable(m("opencode-go", "qwen3.6-plus"))).toBe(false)
    expect(isCodeCapable(m("xai", "grok-4.3"))).toBe(false)
    expect(isCodeCapable(m("opencode", "big-pickle"))).toBe(false)
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
  const flash = m("google", "gemini-3.5-flash") // gemini-3 flash is now code-capable
  const weak = m("google", "gemini-2.5-flash") // older flash: still the declarative floor

  test("auto routes by capability", () => {
    expect(decideTier({ model: opus })).toBe("code")
    expect(decideTier({ model: flash })).toBe("code")
    expect(decideTier({ model: weak })).toBe("declarative")
  })

  test("explicit config flag wins over auto", () => {
    expect(decideTier({ config: "declarative", model: opus })).toBe("declarative")
    expect(decideTier({ config: "code", model: weak })).toBe("code") // forced even on a weak model
  })

  test("per-call override wins over config", () => {
    expect(decideTier({ override: "code", config: "declarative", model: weak })).toBe("code")
    expect(decideTier({ override: "declarative", config: "code", model: opus })).toBe("declarative")
    expect(decideTier({ override: "auto", config: "declarative", model: opus })).toBe("code")
  })

  test("default (nothing set) = auto", () => {
    expect(decideTier({ model: opus })).toBe("code")
    expect(decideTier({ model: weak })).toBe("declarative")
  })
})
