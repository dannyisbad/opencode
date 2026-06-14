# Dynamic Workflow Instructions

Use this skill when the user asks to create, run, or modify a dynamic workflow,
or when a task would benefit from multi-agent orchestration.

## When To Use Dynamic Workflows

Dynamic workflows are ideal for:

- Complex tasks requiring multiple perspectives or parallel fan-out
- Tasks needing verification, review, judging, or adversarial checks
- Iterative refinement or loop-until-dry searches
- Batch processing across files, topics, issues, or test failures
- Multi-phase projects with clear sequential stages

Trigger keywords: "ultracode", "workflow", "workflows", "multi-agent",
"parallel", "batch", "orchestrate".

## Preferred Path: action="run"

Author the workflow yourself and pass a complete script to the workflow tool with
`action: "run"`. This is the headline path.

Writing the full script is expected. Do not choose `action: "generate"` because
the script seems long, quoting seems tedious, or TypeScript feels heavy. Write a
simple valid script, run it, and fix gate/runtime errors if they happen.

When the user asks for a workflow, default to real multi-agent orchestration:
parallel investigators, staged pipelines, independent reviewers, synthesis,
adversarial checks, or iteration. Do not create a one-agent workflow unless the
user explicitly asks for a single-step workflow.

Never set the workflow tool's `budget` field unless the user explicitly asks for
a dollar/cost cap. No budget means unlimited; do not invent one to save tokens.

Do not use `schema` by default, and never claim a schema is needed merely because
outputs should be structured. Prefer plain text or explicit JSON-in-text
instructions; use schema only when later workflow code truly requires validated
fields and the model route supports forced structured output.

After a workflow run starts, times out, finishes, or sends a completion bubble,
read the workflow source file that actually ran before interpreting the result or
replying to the user. Use the run summary `<path>` or inspect the run with
`view: "all"` if needed.

```json
{
  "action": "run",
  "script": "export const meta = { name: 'audit', description: 'Audit auth risks', phases: ['scan', 'review'] } as const\nphase('scan')\nconst scans = await parallel(['auth', 'sessions'].map(scope => () => agent(`Find risks in ${scope}. Return concise bullets.`, { agentType: 'explore' })))\nphase('review')\nreturn await agent(`Synthesize and prioritize these findings:\n${scans.filter(Boolean).join('\\n\\n')}`, { agentType: 'general' })"
}
```

Use `action: "generate"` only as a fallback when you specifically want the
separate planner model to author the workflow, or when hand-authored scripts fail
the gate repeatedly.

## Script Shape

A run script is a literal `meta` export followed by a free top-level body:

```ts
export const meta = {
  name: "research-audit",
  description: "Research and verify a topic",
  phases: ["research", "synthesis"],
} as const

phase("research")
const findings = await parallel(
  ["angle A", "angle B"].map((topic) => () =>
    agent(`Research ${topic}. Return 3-5 concise bullets. Do not create files.`, { agentType: "general" }),
  ),
)

phase("synthesis")
return await agent(`Write a concise final report:\n${findings.filter(Boolean).join("\n\n")}`, { agentType: "general" })
```

Rules:

- `meta` must be a pure literal. No variables, calls, spreads, or template interpolation.
- The body can use top-level `await` and `return`.
- Do not import anything or access `process`, `fs`, `fetch`, `eval`, `Bun`, or `globalThis`.
- Use only the globals provided by the workflow runtime.

## Globals

- `agent(prompt, opts?)` spawns one full autonomous OpenCode subagent. It can use tools, run commands, iterate, and edit files if permissions allow. It is not a cheap completion.
- `parallel(thunks, opts?)` runs independent thunks concurrently and returns `(T | null)[]`; failed arms become `null`.
- `pipeline(items, stage1, stage2, ..., opts?)` runs each item through every stage with no barrier between stages.
- `synthesize({ agents, prompt?, model?, agent? })` combines prior `{ data, text }` results. Runtime clips oversized input blocks before synthesis.
- `adversarial(...)`, `loop(...)`, and `forEach(...)` are available for verification, iteration, and batching.
- `phase(label)` and `log(message)` update workflow progress.
- `args` contains workflow arguments.
- `budget` exposes read-only `{ total, spent(), remaining() }` telemetry in USD. `total` is `null` when no budget cap was set. Only branch on it when the user explicitly requested a dollar/cost cap.

## Token And Scale Stance

Do not be timid about useful fan-out, review, or synthesis solely to conserve
tokens. If the user did not set a budget cap, optimize for correctness, coverage,
and independent verification.

Workflows are for orchestration. Decompose the task into independent angles,
files, components, hypotheses, failures, or candidate fixes; run those tracks in
parallel or through a pipeline; then reconcile them with separate review and
synthesis agents.

Still keep agent prompts bounded. Bounds are for quality, context safety, and
avoiding noisy autonomous loops, not because tokens are scarce.

Good large workflow shape:

- Researchers produce compact, source-aware notes.
- Theme leads synthesize small groups.
- Reviewers check factuality, coverage, and usefulness.
- Finalists draft competing outputs when style matters.
- A judge/editor reconciles into the final result.

For large fan-in with more than 8 substantive outputs, prefer a synthesis tree:

```text
researchers -> group summaries -> reviewers/judges -> final editor
```

Do not dump dozens of raw agent outputs into one final synthesizer unless each
input is already compact.

## Agent Prompt Discipline

Because `agent()` is autonomous, every agent prompt should say what success looks
like and what not to do.

Use constraints like:

- "Return 3-5 concise bullets."
- "Use at most 3 source lookups."
- "Do not browse broadly."
- "Do not create or edit files."
- "Do not ask the user clarifying questions; choose reasonable assumptions and continue."
- "If evidence is weak, say so."
- "Stop after answering this subtask."

These are prompt-level constraints, not hard runtime caps. Use tree structure and
smaller subtasks when the workflow must stay compact.

If a subtask is truly impossible without missing user input, the subagent should
return `BLOCKED:` plus the exact missing information. It should not ask a
conversational question that leaves the workflow waiting.

## Structured Output Caveat

`schema` forces structured output. It is not the default way to make outputs
organized. Use plain text or explicit JSON-in-text instructions unless later
workflow code truly needs validated fields. Schema can fail on thinking-enabled
model routes that reject forced tool use.

If a schema step fails with a provider/tool-choice compatibility error, remove the
schema or route that step to a compatible model.

## Agent Selection

- Use `explore` for codebase/file discovery.
- Use `general` for research, judging, review, and synthesis.
- Use `build` for writing or changing code.
- Never use `plan` inside a headless workflow; it is interactive and can stall.

## Failure Handling

- Always `.filter(Boolean)` after `parallel`, `pipeline`, and `forEach` fan-out.
- If a `run` script fails, inspect the error, fix the script, and run it again.
- Do not abandon the workflow and complete the objective by hand unless the user explicitly redirects.
- Return useful data from the workflow, not just logs.

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

- `enabled` turns dynamic workflow generation on or off.
- `max_agents` limits generated workflow scale; default is 16, maximum is 1000.
- `max_concurrency` limits concurrent agents; default is 4, maximum is 16.
- `require_approval` asks before generating and running workflows.
