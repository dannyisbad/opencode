import { describe, test, expect } from "bun:test"
import { isTransientError, modelChain, parseModelString } from "@/workflow/resilience"

describe("workflow resilience", () => {
  test("isTransientError: rate limits / overload / 5xx / structured-miss are transient", () => {
    expect(isTransientError(new Error("Rate limit exceeded, please retry"))).toBe(true)
    expect(isTransientError(new Error("429 Too Many Requests"))).toBe(true)
    expect(isTransientError(new Error("The model is overloaded right now"))).toBe(true)
    expect(isTransientError(new Error("503 Service Unavailable"))).toBe(true)
    expect(isTransientError(new Error("Agent was asked for structured output but produced none"))).toBe(true)
    expect(isTransientError(new Error("quota exhausted for this project"))).toBe(true)
  })

  test("isTransientError: genuine/non-transient errors are NOT retried on another model", () => {
    expect(isTransientError(new Error("no valid plan after 3 attempts: duplicate step id"))).toBe(false)
    expect(isTransientError(new Error("401 Unauthorized"))).toBe(false)
    expect(isTransientError(new Error("bad request: missing required field"))).toBe(false)
    expect(isTransientError(undefined)).toBe(false)
  })

  test("modelChain: primary first, fallbacks parsed in order, duplicates collapsed", () => {
    const primary = { providerID: "google", modelID: "gemini-3.1-pro-preview" } as Parameters<typeof modelChain>[0]
    const chain = modelChain(primary, [
      "google/gemini-3.5-flash",
      "google/gemini-3.1-pro-preview", // duplicate of primary -> collapsed
      "xai/grok-4.3",
    ])
    expect(chain.map((m) => `${m.providerID}/${m.modelID}`)).toEqual([
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.5-flash",
      "xai/grok-4.3",
    ])
  })

  test("parseModelString: parses provider/model; blank -> undefined", () => {
    expect(parseModelString(undefined)).toBeUndefined()
    expect(parseModelString("")).toBeUndefined()
    expect(parseModelString("google/gemini-3.5-flash")).toEqual({
      providerID: "google",
      modelID: "gemini-3.5-flash",
    } as ReturnType<typeof parseModelString>)
  })
})
