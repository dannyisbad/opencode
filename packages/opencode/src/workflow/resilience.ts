import { APICallError } from "ai"
import { Provider } from "@/provider/provider"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import type { ModelV2 } from "@opencode-ai/core/model"

// Model resilience for dynamic workflows: both the planner's generation and every
// agent step walk an ordered model chain (primary + configured fallbacks), moving
// to the next model on a TRANSIENT failure. This is what makes a rate-limited
// primary (the failure that made the planner give up and the agent hand-do the
// task) recover instead of aborting.

export type ModelDesc = { providerID: ProviderV2.ID; modelID: ModelV2.ID }

// A transient failure is worth retrying on a DIFFERENT model: rate limits,
// provider overload / 5xx, timeouts, capacity/quota exhaustion, and the
// workflow's own structured-output miss (the model produced no valid object).
// A non-transient error (malformed request, auth, a genuine logic bug) is NOT
// transient — retrying it on another model just burns calls, so callers re-throw.
export function isTransientError(error: unknown): boolean {
  if (error instanceof APICallError) {
    const s = error.statusCode
    if (s === 429 || (typeof s === "number" && s >= 500)) return true
    if (error.isRetryable) return true
  }
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase()
  return /rate.?limit|\b429\b|too many requests|overload|\b50[0-9]\b|timeout|timed out|unavailable|capacity|quota|exhaust|structured output/.test(
    msg,
  )
}

// Ordered, de-duplicated model chain: the primary first, then each parseable
// fallback string. Unparseable fallback entries are skipped (a typo in config
// must never break generation). Identical entries collapse so a fallback that
// equals the primary is not tried twice.
export function modelChain(primary: ModelDesc, fallbacks: readonly string[] = []): ModelDesc[] {
  const seen = new Set<string>()
  const out: ModelDesc[] = []
  const add = (m: ModelDesc | undefined) => {
    if (!m) return
    const key = `${m.providerID}/${m.modelID}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(m)
  }
  add(primary)
  for (const raw of fallbacks) {
    try {
      const parsed = Provider.parseModel(raw)
      if (parsed) add({ providerID: parsed.providerID, modelID: parsed.modelID })
    } catch {
      // skip a malformed "provider/model" string rather than fail the run
    }
  }
  return out
}

// Parse a "provider/model" config string into a ModelDesc, or undefined if blank
// or malformed. Used to resolve `dynamic_workflows.model` and a generate-action
// `model` param.
export function parseModelString(value: string | undefined): ModelDesc | undefined {
  if (!value) return undefined
  try {
    const parsed = Provider.parseModel(value)
    return parsed ? { providerID: parsed.providerID, modelID: parsed.modelID } : undefined
  } catch {
    return undefined
  }
}
