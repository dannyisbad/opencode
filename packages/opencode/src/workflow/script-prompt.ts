// Authoring guide for the `workflow action=run` path — opencode's adaptation of
// Claude Code's `Workflow` tool description. The calling agent reads this (it is
// embedded in the tool DESCRIPTION) and authors a self-contained script inline; the
// loader's transform wraps it into the engine's run(args, ctx) module. Kept close to
// Claude's prose, adapted to opencode: global hooks (no ctx), agent types
// build/general/explore, USD budget, and no nested-workflow/worktree/resume.

export const SCRIPT_AUTHORING_GUIDE = [
  "AUTHORING A WORKFLOW SCRIPT (action=run):",
  "You write a self-contained orchestration script and it runs as a background multi-agent workflow. Reach for this to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives + adversarial checks before committing), or to take on scale one context can't hold.",
  "",
  "SHAPE — a literal `meta` followed by a free top-level body:",
  "    export const meta = {",
  "      name: 'find-flaky-tests',",
  "      description: 'Find flaky tests and propose fixes',",
  "      phases: ['scan', 'fix'],          // optional; labels must match phase() calls",
  "    } as const",
  "",
  "    phase('scan')",
  "    const flaky = await agent('Grep the CI logs for retry markers and list flaky tests.', { schema: FLAKY_SCHEMA })",
  "    const fixes = await pipeline(flaky.tests, t => agent(`Propose a fix for ${t.name}.`, { agentType: 'build' }))",
  "    return { fixes: fixes.filter(Boolean) }",
  "",
  "`meta` MUST be a pure literal (no variables, calls, spreads, or template interpolation) — it is read statically without running your code. `as const` is fine. The body runs AS the workflow: top-level `await` and `return` work; the returned value is the workflow result.",
  "",
  "GLOBALS available in the body — do NOT import anything, and there is no `ctx`; you may not touch `process`/`fs`/`fetch`/`eval`/`Bun`/`globalThis`:",
  "- agent(prompt, opts?) -> Promise<string>. Spawns ONE AGENTIC subagent — a full tool-using agent that can read/write files, run commands, and ITERATE until the task is done; NOT a single completion. It is expected to PERSIST and self-correct: if its work breaks (code won't compile, a command fails, a test is red) it debugs and fixes rather than returning 'it's broken'. Returns its final text. opts = { agentType?: 'build'|'general'|'explore', model?: string, schema?: object }. With `schema` (a JSON Schema) it FORCES structured output and returns the validated OBJECT instead of text (a missing structured result fails the step). agentType: 'build' = writing/code, 'general' = synthesis/judging, 'explore' = research/finding files; omit for the default agent. NEVER use 'plan' (interactive — it stalls a headless run).",
  "- parallel(thunks) -> Promise<(T|null)[]>. Run thunks `() => Promise<T>` concurrently and await ALL (a BARRIER). A failed arm resolves to `null`, never throws — `.filter(Boolean)` before use.",
  "- pipeline(items, stage1, stage2, ...) -> Promise<(Last|null)[]>. Each item flows through ALL stages independently with NO barrier between stages (item B can be in stage 3 while item A is still in stage 1). Each stage is `(prev, item, index) => Promise`. At most 4 stages. A stage that throws drops THAT item to `null`. THIS IS THE DEFAULT for multi-stage work.",
  "- phase(label) / log(message) -> progress UI. `label` should be one of meta.phases.",
  "- args -> the workflow's input arguments object.",
  "- budget -> { total, spent(), remaining() } in USD (total is null when unbudgeted). The next agent() throws once the cap is hit. Budget-scaled loop: `while (budget.total && budget.remaining() > 0.5) { … }`.",
  "- Also available (opencode helpers): synthesize, adversarial, loop, forEach. Nested workflow() is NOT supported — author a single workflow.",
  "",
  "DEFAULT TO pipeline(). Use a barrier (parallel between stages) ONLY when stage N genuinely needs ALL of stage N-1 — dedup/merge across the full result set, early-exit when the count is zero, or cross-item comparison. 'I need to flatten/map/filter first' is NOT a barrier reason; do it inside a pipeline stage.",
  "",
  "BE MINIMAL — the most important rule. A trivial ask -> ONE agent(). Don't fan out work that doesn't decompose. Scale to the request: 'find any bugs' -> a few finders + a single verify; 'thoroughly audit this' -> a larger finder pool, a 3-5 vote adversarial pass, then a synthesis step.",
  "",
  "PATTERNS (compose from the primitives):",
  "- Adversarial verify: spawn N independent skeptics per finding, each prompted to REFUTE; drop the finding if a majority refute. Stops plausible-but-wrong findings surviving.",
  "- Judge panel: generate N independent attempts from different angles, score with parallel judges, synthesize from the winner.",
  "- Loop-until-dry: keep spawning finders until K consecutive rounds surface nothing new.",
  "- Multi-modal sweep: parallel agents each searching a different way (by name, by content, by usage).",
  "",
  "Canonical multi-stage shape — each dimension verifies as soon as its review lands:",
  "    const results = await pipeline(",
  "      DIMENSIONS,",
  "      d => agent(d.prompt, { schema: FINDINGS }),",
  "      review => parallel(review.findings.map(f => () =>",
  "        agent(`Adversarially verify: ${f.title}`, { schema: VERDICT }).then(v => ({ ...f, verdict: v })))),",
  "    )",
  "    return results.flat().filter(Boolean).filter(f => f.verdict?.isReal)",
  "",
  "The script runs in the BACKGROUND — `run` returns immediately and a completion bubble + result are injected when it finishes (watch live with /workflows). Author the script yourself; do not call `generate` unless you specifically want the deterministic planner.",
].join("\n")

export * as ScriptPrompt from "./script-prompt"
