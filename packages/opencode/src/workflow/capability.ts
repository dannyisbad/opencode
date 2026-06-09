import type { ModelDesc } from "./resilience"

// Routing between the CODE tier (LLM writes an executable run(args,ctx) module)
// and the DECLARATIVE floor (LLM emits a structured plan a deterministic compiler
// turns into guaranteed-correct source). There is no runtime "can author correct
// orchestration JS" capability flag, so `auto` routes off a curated provider/model
// allowlist, overridable by config. A model that matches NONE routes to the
// declarative floor — the safe default for unknown / small / local / brand-new
// models. Code-gen failure additionally degrades to declarative downstream (the
// planner's cross-tier fallback), so a wrong guess here is never fatal.

export type GeneratorSetting = "code" | "declarative" | "auto"
export type GeneratorTier = "code" | "declarative"

// Built-in capable set (globs, `*` = any run of chars). anthropic opus/sonnet,
// openai gpt-5 / o3 / o4, google gemini-3 pro + flash. The gemini-3 flash tier is
// strong enough to author orchestration code by hand, and the code path has a
// gate + declarative fallback beneath it, so a rare bad module degrades safely
// rather than breaking. Still conservative for the rest — older/other small
// models (haiku, mini, gemini-2.x flash) and unknown ids fall through to
// declarative. Extend without a code change via dynamic_workflows.code_capable_models.
const DEFAULT_CODE_MODELS = [
  "anthropic/*opus*",
  "anthropic/*sonnet*",
  "openai/gpt-5*",
  "openai/o3*",
  "openai/o4*",
  "google/gemini-3*pro*",
  "google/gemini-3*flash*",
] as const

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
}

// Anchored, case-insensitive glob match where `*` matches any run of characters.
function matchGlob(value: string, glob: string): boolean {
  const pattern = "^" + glob.split("*").map(escapeRegex).join(".*") + "$"
  return new RegExp(pattern, "i").test(value)
}

export function isCodeCapable(model: ModelDesc, capableGlobs?: readonly string[]): boolean {
  const id = `${model.providerID}/${model.modelID}`
  const globs = capableGlobs && capableGlobs.length > 0 ? capableGlobs : DEFAULT_CODE_MODELS
  return globs.some((g) => matchGlob(id, g))
}

// Resolve the planner tier. Precedence: per-call override > config flag > "auto".
// "auto" routes by capability. "code" is honored even on a weak model (the gate +
// declarative fallback still sit beneath it).
export function decideTier(input: {
  override?: GeneratorSetting
  config?: GeneratorSetting
  model: ModelDesc
  capableGlobs?: readonly string[]
}): GeneratorTier {
  const setting: GeneratorSetting = input.override ?? input.config ?? "auto"
  if (setting === "declarative") return "declarative"
  if (setting === "code") return "code"
  return isCodeCapable(input.model, input.capableGlobs) ? "code" : "declarative"
}

export * as Capability from "./capability"
