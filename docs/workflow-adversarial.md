# `ctx.adversarial()` — Usage, Constraints & Best Practices

The `adversarial` helper is a tiny, self-contained verifier living inside `createContext(...)`. It implements a "worker + independent judge" pattern: run a task, then ask a separate model/agent to rigorously judge the result against explicit criteria.

## Signature

```ts
ctx.adversarial(options: {
  worker:
    | { data: unknown; text: string }
    | Promise<{ data: unknown; text: string }>
    | (() => { data: unknown; text: string } | Promise<...>)
    | AgentInput                              // anything with a `prompt` field
    | (() => AgentInput | Promise<AgentInput>)
    | any
  rubric?: string | string[]
  verifierPrompt?: string
  verifierModel?: string
  verifierAgent?: string
}) => Promise<{
  worker: { data: unknown; text: string }
  verification: {
    pass: boolean
    confidence: number   // clamped [0,1], default 0.4
    issues: string[]
    evidence: string[]
  }
}>
```

## How It Works (Step-by-Step)

1. **Cancellation gate** — `checkpoint()` aborts immediately if the run fiber received a cancellation signal.
2. **Worker resolution** — Accepts a raw result, a promise, a thunk, or an `AgentInput`. If the worker is an `AgentInput`, it is executed via the same `input.agent` used by the rest of the workflow (budget, logging, child sessions, etc. all apply).
3. **Rubric → criteria** — Turns the optional `rubric` (string or string[]) into a bullet list. Falls back to a single generic criterion.
4. **Verifier prompt assembly** — Hard-codes a "skeptical verifier" persona + the criteria + the worker's text (truncated at 16 000 chars) + the caller's optional `verifierPrompt` override.
5. **Structured output via schema** — Passes a strict JSON schema (no extra properties, required fields) to `input.agent`. The downstream agent runner turns this into a structured-output request.
6. **Defensive normalization** — The returned `verification` object is always well-typed even if the model misbehaves:
   - `pass` is coerced to boolean
   - `confidence` is clamped to [0,1] (default 0.4 on missing/invalid)
   - `issues`/`evidence` are filtered to string arrays only

## Usage Examples

### Basic — verify an agent result

```ts
const result = await ctx.agent({ prompt: "Write a haiku about debugging" })

const check = await ctx.adversarial({
  worker: result,
  rubric: ["Exactly 3 lines", "Syllable counts 5-7-5", "Mentions debugging or code"],
})

if (!check.verification.pass) {
  ctx.log(`Issues: ${check.verification.issues.join("; ")}`)
}
```

### With a worker thunk (most common pattern)

```ts
const check = await ctx.adversarial({
  worker: async () => {
    const research = await ctx.agent({ prompt: "Research best practices for error handling in TypeScript" })
    const draft = await ctx.agent({ prompt: `Using this research, write a short guide:\n\n${research.text}` })
    return draft
  },
  rubric: [
    "Covers at least 4 distinct practices",
    "Each practice has a concrete code example",
    "No placeholder comments or TODOs",
    "Tone is professional and concise",
  ],
})
```

### Custom verifier prompt + different agent

```ts
const check = await ctx.adversarial({
  worker: myResult,
  rubric: ["Follows the company style guide exactly"],
  verifierAgent: "style-critic",
  verifierModel: "claude-3-5-sonnet-20241022",
  verifierPrompt:
    "You are a ruthless senior reviewer. Be extremely strict. Return pass ONLY if every single rule is satisfied.",
})
```

## Constraints & Gotchas

- **Never reference `verification.text`** — the verification result is always the structured object `{ pass, confidence, issues, evidence }`. There is no `.text` field.
- **Do not invent extra fields** — `adversarial` does not accept or return a `schema` field. Schemas are only for `ctx.agent` calls.
- **Rubrics must be strict** — the planner explicitly recommends constructing "extremely strict and comprehensive validation criteria" that check edge cases, style guides, completeness (no placeholders), and formatting.
- **Worker truncation** — only the first 16 000 characters of the worker output are sent to the verifier. Very long outputs are silently truncated.
- **Default verifier is the `general` agent** — chosen as a safe non-interactive default. (`plan` is *not* used as the default because it gates on interactive user confirmation, which would stall a headless run.) Override with `verifierAgent` if you need different behavior.
- **Cancellation is respected** — if the parent run is cancelled, `adversarial` throws `CancelledError` before doing any work.
- **Budget & logging apply** — the verifier call goes through the normal `agent` path, so token budget, cost tracking, and logging all work as expected.

## Best Practices

1. **Make rubrics explicit and exhaustive** — vague criteria produce vague verdicts. List every concrete requirement.
2. **Prefer false negatives** — the built-in prompt already biases the verifier toward rejecting unsupported claims. Embrace this; it is safer than accepting subtle errors.
3. **Use `worker` as a thunk for multi-step work** — this keeps the worker execution inside the same budget/session context and makes the verification step a natural "after the fact" check.
4. **Iterate on failure** — when `pass === false`, feed `verification.issues` and `verification.evidence` back into a refinement loop (see `ctx.loop` or the dynamic workflow patterns).
5. **Reserve adversarial verification for high-stakes outputs** — it adds latency and cost. Use it for final deliverables, security-sensitive code, or anything that will be shown to users.
6. **Combine with other primitives** — `adversarial` shines inside `pipeline`, `loop`, or `parallel` stages when you need an independent quality gate before proceeding.

## When to Use It

- Final quality gate before emitting a result to the user
- Validating generated code against style guides or security rules
- Cross-checking research summaries for unsupported claims
- Any situation where "trust but verify" is cheaper than cleaning up a bad output later

All done~ documentation complete ✨ (≧◡≦) ♡
