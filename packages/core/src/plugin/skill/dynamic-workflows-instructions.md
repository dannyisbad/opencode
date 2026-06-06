<!--
  Built-in skill. Name and description are registered in code at
  packages/opencode/src/skill/index.ts.
-->

# Dynamic Workflow Instructions

Use this skill when the user asks to create, run, or modify a dynamic workflow,
or when a task would benefit from multi-agent orchestration.

## When to Use Dynamic Workflows

Dynamic workflows are generated on-the-fly by a planner LLM and executed through
the native workflow engine. They are ideal for:

- Complex tasks requiring multiple perspectives (parallel agent fan-out)
- Tasks needing verification or review (adversarial verification)
- Iterative refinement (loop until condition met)
- Batch processing (forEach over multiple items)
- Multi-phase projects with clear sequential stages

**Trigger keywords:** "ultracode", "workflow", "workflows", "multi-agent",
"parallel", "batch", "orchestrate"

## How to Generate a Dynamic Workflow

Use the `workflow` tool with `action: "generate"`:

```json
{
  "action": "generate",
  "objective": "Refactor the auth layer to use JWT tokens with refresh rotation",
  "args": { "scope": "auth" },
  "budget": 2.0
}
```

The planner will:
1. Analyze the objective
2. Generate a TypeScript workflow with appropriate phases
3. Write it to a temporary file
4. Start execution immediately in the background

Because it runs in the background by default, you can continue chatting with the user or working on other tasks while the workflow orchestrates the subagents. When it finishes, it will automatically inject a completion message with the final synthesized result back into your session.

## Available Primitives

Dynamic workflows have access to all native workflow primitives:

- `ctx.agent({ prompt, agent?, model?, schema? })` — Run a single agent step
- `ctx.parallel(tasks, { concurrencyLimit? })` — Run independent agents concurrently
- `ctx.pipeline(items, stage1, stage2, ...)` — Sequential multi-stage processing
- `ctx.synthesize({ agents, prompt?, model?, agent? })` — Combine multiple outputs
- `ctx.adversarial({ worker, rubric?, verifierPrompt?, verifierModel?, verifierAgent? })` — Verify output quality
- `ctx.loop({ fn, until, maxIterations? })` — Iterative refinement
- `ctx.forEach(items, fn, { concurrencyLimit? })` — Batch process items
- `ctx.setPhase(phase)` — Update progress tracking
- `ctx.log(message)` — Record progress logs

## Patterns

### Fan-Out and Synthesize

```typescript
ctx.setPhase("research")
const findings = await ctx.parallel([
  () => ctx.agent({ prompt: "Research approach A" }),
  () => ctx.agent({ prompt: "Research approach B" }),
])

ctx.setPhase("synthesize")
const summary = await ctx.synthesize({
  agents: findings,
  prompt: "Combine these findings into a coherent recommendation",
})
```

### Adversarial Verification

```typescript
ctx.setPhase("implement")
const worker = await ctx.agent({ prompt: "Implement the feature" })

ctx.setPhase("verify")
const { verification } = await ctx.adversarial({
  worker,
  rubric: ["Handles edge cases", "No security issues", "Tests pass"],
})

if (!verification.pass) {
  ctx.log(`Issues found: ${verification.issues.join(", ")}`)
}
```

### Iterative Refinement

```typescript
const results = await ctx.loop({
  fn: (i, prev) => ({
    prompt: prev
      ? `Previous attempt had issues. Refine: ${prev.text}`
      : "Initial implementation",
  }),
  until: (result) => result.text.includes("VERIFIED"),
  maxIterations: 5,
})
```

### Batch Processing

```typescript
const files = ["src/auth.ts", "src/user.ts", "src/session.ts"]
const results = await ctx.forEach(
  files,
  (file) => ({ prompt: `Add logging to ${file}` }),
  { concurrencyLimit: 3 },
)
```

## Best Practices

1. **Log before expensive steps** — Use `ctx.log()` before calling agents so the dashboard shows progress
2. **Set phases** — Call `ctx.setPhase()` before each major step for clear progress tracking
3. **Use structured output** — Pass `schema` to `ctx.agent()` when later steps need reliable fields
4. **Cap concurrency** — Use `concurrencyLimit` for large fan-outs to avoid overwhelming the system
5. **Budget awareness** — Check `ctx.budgetRemaining` before spawning many agents
6. **Handle failures** — Catch errors from agent steps; don't let one failed agent crash the workflow
7. **Return useful data** — Return structured results, not just logs

## Configuration

Dynamic workflows are controlled by `opencode.json`:

```json
{
  "dynamic_workflows": {
    "enabled": true,
    "max_agents": 16,
    "max_concurrency": 4,
    "require_approval": true
  }
}
```

- `enabled` — Turn dynamic workflow generation on/off
- `max_agents` — Maximum total agents per workflow (default: 16)
- `max_concurrency` — Maximum concurrent agents (default: 4)
- `require_approval` — Ask user before generating (default: true)
