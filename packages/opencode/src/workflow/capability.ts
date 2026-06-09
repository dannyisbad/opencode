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

// Built-in capable set (globs, `*` = any run of chars), curated from hands-on
// authoring results across the fleet. Provider-agnostic (`*/model`): the same
// model is offered through several providers (google / github-copilot /
// google-antigravity / opencode-go / openai) and capability follows the MODEL,
// not the route. Variant suffixes (-preview, -low, -fast, -mini of a capable
// version, -free, -thinking) inherit their base model's capability.
//
// Deliberately NOT capable (fall through to the declarative floor): haiku,
// gpt-5-mini (the pre-5.4 mini), gemini ≤3.0 pro / non-agent 3.0 flash / all
// 2.x, flash-lite, image/tts/video/embedding models, minimax ≤m2.x,
// deepseek-v4-flash, qwen ≤3.6, grok, gemma, big-pickle, and anything unknown.
// Extend without a code change via dynamic_workflows.code_capable_models.
const DEFAULT_CODE_MODELS = [
  // anthropic family (any provider)
  "*/claude-opus*",
  "*/claude-sonnet*",
  // openai family
  "*/gpt-5.3-codex*",
  "*/gpt-5.4*",
  "*/gpt-5.5*",
  "openai/o3*",
  "openai/o4*",
  // gemini family
  "*/gemini-3.1-pro*",
  "*/gemini-3.5-flash*",
  "*/gemini-3-flash-agent*",
  "*/gemini-pro-agent*",
  // open-weights / aggregator models
  "*/kimi-k2.5*",
  "*/kimi-k2.6*",
  "*/glm-5*",
  "*/minimax-m3*",
  "*/qwen3.7*",
  "*/mimo-v2.5*",
  "*/deepseek-v4-pro*",
  "*/nemotron-3-ultra*",
  "*/north-mini-code*",
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
