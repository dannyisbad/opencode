import { describe, expect } from "bun:test"
import { Workflow } from "@/workflow/workflow"
import type { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { WorkflowRunTable, type WorkflowAgentRow } from "@opencode-ai/core/workflow/sql"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { MessageID, PartID } from "@opencode-ai/core/v1/session"
import { eq } from "drizzle-orm"
import { requireInstance, TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { Deferred, Effect, Layer } from "effect"
import path from "path"

// Database.defaultLayer is merged so the orphan-sweep tests can seed a row
// directly through the same in-memory SQLite connection the engine uses.
const it = testEffect(Layer.mergeAll(Workflow.defaultLayer, Database.defaultLayer))

const HELLO_FIXTURE = "hello"

// Seeds a workflow_run row in status="running" with NO live registry entry,
// the exact shape an orphaned (crashed/restarted) run leaves behind. `directory`
// scopes the row to a project: omitted = legacy pre-migration row (NULL).
function seedRunningRow(id: string, directory?: string, agents: WorkflowAgentRow[] = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(WorkflowRunTable)
      .values({
        id,
        directory,
        workflow: HELLO_FIXTURE,
        status: "running",
        started_at: Date.now(),
        logs: [],
        agents,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function fetchRunRow(id: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db
      .select()
      .from(WorkflowRunTable)
      .where(eq(WorkflowRunTable.id, id))
      .get()
      .pipe(Effect.orDie)
    return row ?? (yield* Effect.fail(new Error(`row ${id} not found`)))
  })
}

function seedSession(id: SessionID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const instance = yield* requireInstance
    const now = Date.now()
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: instance.project.id,
        slug: id,
        directory: instance.directory,
        title: "completed child",
        version: "0.0.0-test",
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

// Seeds a fully finished run (with log + agent telemetry) straight into the DB.
// Because it never went through start(), it has NO live registry entry, so
// get() is forced through the DB->fromRow path — no test-only seam required.
function seedCompletedRow(id: string) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    yield* db
      .insert(WorkflowRunTable)
      .values({
        id,
        workflow: HELLO_FIXTURE,
        status: "completed",
        started_at: now,
        completed_at: now,
        current_phase: "run",
        logs: [{ time: now, phase: "run", message: "running" }],
        agents: [
          {
            id: "1",
            status: "completed",
            started_at: now,
            completed_at: now,
            phase: "run",
            prompt: "do the thing",
            output: "did the thing",
          },
        ],
        result: { ok: true },
      })
      .run()
      .pipe(Effect.orDie)
  })
}

async function writeWorkflow(dir: string, name: string, body: string, ext = "js") {
  await Bun.write(path.join(dir, ".opencode", "workflows", `${name}.${ext}`), body)
}

const STEP2_MARKER = "step-2-reached"
const SLOW_FIXTURE = "slow"

// Fixture-Workflow: ein absichtlich blockierender Agent-Schritt, danach ein
// zweiter Schritt (STEP2_MARKER), der bei korrekter Cancellation NIE läuft.
const SLOW_WORKFLOW = `export const meta = { name: "${SLOW_FIXTURE}", phases: ["agent", "after"] }
export async function run(args, ctx) {
  ctx.setPhase("agent")
  ctx.log("step-1-started")
  await ctx.agent({ prompt: "hang" })
  ctx.setPhase("after")
  ctx.log("${STEP2_MARKER}")
  return { ok: true }
}
`

function assistantReply(): SessionV1.WithParts {
  return { info: { role: "assistant" }, parts: [] } as unknown as SessionV1.WithParts
}

// Test-Prompt-Ops, die das echte Session-Abort-Verhalten nachbilden:
// - die initiale "Workflow started"-Nachricht (noReply) wird sofort beantwortet,
//   damit start() zurückkehrt;
// - jeder Agent-Prompt blockiert (langer, unterbrechbarer Lauf), bis cancel()
//   die Session abbricht; cancel() protokolliert die abgebrochene Child-Session
//   und unterbricht den laufenden Prompt (wie SessionPrompt.cancel -> Abort).
function hangingPromptOps() {
  const aborted = new Set<string>()
  const started = new Set<string>()
  const gates = new Map<string, Deferred.Deferred<void>>()
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        const gate = yield* Deferred.make<void>()
        gates.set(input.sessionID, gate)
        started.add(input.sessionID)
        // Läuft, bis die Session per cancel() abgebrochen wird (Gate -> Interrupt)
        // oder der lange Lauf endet. Der Timer hält die Suspension unterbrechbar.
        yield* Effect.race(
          Effect.sleep("30 seconds"),
          Deferred.await(gate).pipe(Effect.flatMap(() => Effect.interrupt)),
        )
        return assistantReply()
      }),
    cancel: (sessionID) =>
      Effect.gen(function* () {
        aborted.add(sessionID)
        const gate = gates.get(sessionID)
        if (gate) yield* Deferred.succeed(gate, undefined)
      }),
  }
  return { ops, aborted, started }
}

// Schema-Fixtures: Workflows, deren run(ctx) den Agenten MIT Schema aufruft
// (strukturierte Ausgabe angefordert). Der Promtp-Ops-Fake (unten) steuert, ob
// die Session strukturierte Daten, undefined oder einen StructuredOutputError
// liefert. Jeder gibt das geparste Objekt im Ergebnis zurück, damit der
// Positivpfad das Objekt durchreichen kann.
const SCHEMA_SUCCESS_FIXTURE = "schema-success"
const SCHEMA_UNDEFINED_FIXTURE = "schema-undefined"
const SCHEMA_FAILING_FIXTURE = "schema-failing"
const SCHEMA_OBJECT = { value: 123 }

function schemaWorkflow(name: string) {
  return `export const meta = { name: "${name}", phases: ["agent"] }
export async function run(args, ctx) {
  ctx.setPhase("agent")
  const result = await ctx.agent({ prompt: "produce structured", schema: { type: "object" } })
  return { data: result.data }
}
`
}

// Prompt-Ops-Fake, der die SESSION-Schicht nachbildet (nicht die Engine): die
// initiale noReply-Nachricht wird sofort beantwortet; der Agent-Prompt liefert
// eine Assistant-Nachricht, deren `structured`/`error`-Feld der Modus bestimmt:
// - "structured": message.info.structured ist gesetzt (Erfolgspfad);
// - "undefined": structured fehlt trotz angefordertem Schema (stiller Fallback,
//   der jetzt scheitern muss);
// - "error": die Session hat einen StructuredOutputError auf message.info.error
//   gesetzt (genau wie packages/opencode/src/session/prompt.ts es tut), gibt aber
//   weiterhin erfolgreich eine WithParts zurück.
// `cost` mirrors the real telemetry (`message.info.cost`, USD) so a step that
// FAILS structured-output can still report what it actually cost — exactly the
// failed-but-paid case the budget must charge for. Defaults to 0 to leave the
// existing structured-output callers unchanged.
type AssistantTurn = {
  cost: number
  tokens?: { total?: number; input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  structured?: unknown
  error?: unknown
}

// Mirror the production session layer: SessionPrompt.runLoop persists ONE
// assistant message per turn (queryable via sessions.messages) and RETURNS only
// the last. These fakes write each turn into the SAME MessageTable the engine's
// all-turns cost/token sum reads from (the threaded `db` is the same in-memory
// connection the engine uses), then resolve with the LAST turn's info (the engine
// still uses that single message for message_id / output / structured-output
// detection). A single-turn fake persists exactly one row ⇒ the summed result
// equals it, identical to the previous single-message behaviour. `db` is threaded
// (not resolved via Database.Service inside) so the fake's Effect keeps the
// `R = never` shape SessionPrompt.Interface["prompt"] requires.
function persistTurns(db: Database.Interface["db"], sessionID: string, turns: AssistantTurn[]) {
  return Effect.gen(function* () {
    let last: SessionV1.WithParts | undefined
    for (const turn of turns) {
      const id = MessageID.ascending()
      const now = Date.now()
      const data: Record<string, unknown> = {
        role: "assistant",
        providerID: "test",
        modelID: "test-model",
        finish: "stop",
        cost: turn.cost,
        tokens: turn.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, completed: now },
        ...("structured" in turn ? { structured: turn.structured } : {}),
        ...(turn.error ? { error: turn.error } : {}),
      }
      yield* db
        .insert(MessageTable)
        .values({
          id,
          session_id: sessionID,
          time_created: now,
          time_updated: now,
          data,
        } as unknown as typeof MessageTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      const partID = PartID.ascending()
      yield* db
        .insert(PartTable)
        .values({
          id: partID,
          message_id: id,
          session_id: sessionID,
          time_created: now,
          time_updated: now,
          data: { type: "text", text: "ok" },
        } as unknown as typeof PartTable.$inferInsert)
        .run()
        .pipe(Effect.orDie)
      last = { info: { id, sessionID, ...data }, parts: [{ type: "text", text: "ok" }] } as unknown as SessionV1.WithParts
    }
    return last!
  })
}

function structuredPromptOps(db: Database.Interface["db"], mode: "structured" | "undefined" | "error", cost = 0) {
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        const turn: AssistantTurn = {
          cost,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }
        if (mode === "structured") turn.structured = SCHEMA_OBJECT
        if (mode === "error")
          turn.error = {
            name: "StructuredOutputError",
            data: { message: "Model did not produce structured output", retries: 0 },
          }
        const last = yield* persistTurns(db, input.sessionID, [turn])
        const parts =
          mode === "undefined" || mode === "error" ? [{ type: "text", text: "here is some plaintext" }] : []
        return { info: last.info, parts } as unknown as SessionV1.WithParts
      }),
    cancel: () => Effect.void,
  }
  return ops
}

// Budget-Fixtures. Der Engine liest die Agent-Kosten aus `message.info.cost`
// (USD) — exakt wie der echte Session-Pfad und das TUI-Dashboard. Dieser Fake
// bildet GENAU diese Telemetrie-Form nach: jede beantwortete Agent-Nachricht
// trägt `cost` (und `tokens`, wie die echte Session), sodass der Engine pro
// Step das Restbudget korrekt dekrementieren kann.
function costPromptOps(db: Database.Interface["db"], cost: number, turns?: number) {
  const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
    prompt: (input) =>
      Effect.gen(function* () {
        if (input.noReply) return assistantReply()
        // `turns` (default 1) lets a test simulate a multi-turn agent: each turn
        // persists its own `cost`, exactly the case the all-turns budget sum must
        // capture (a single-turn fake stays identical to the old behaviour).
        const perTurn: AssistantTurn = { cost, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
        return yield* persistTurns(db, input.sessionID, Array.from({ length: turns ?? 1 }, () => perTurn))
      }),
    cancel: () => Effect.void,
  }
  return ops
}

// Zwei sequentielle ctx.agent-Aufrufe; bei kleinem Budget muss der zweite
// Aufruf am Budget-Gate scheitern (Restbudget <= 0 nach dem ersten Step).
const BUDGET_FIXTURE = "budget-two-steps"
const BUDGET_WORKFLOW = `export const meta = { name: "${BUDGET_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "step one" })
  await ctx.agent({ prompt: "step two" })
  return { ok: true }
}
`

// Schreibt ctx.budgetRemaining vor und nach einem Agent-Step ins Resultat,
// damit der Test die Live-Dekrementierung beobachten kann.
const BUDGET_REMAINING_FIXTURE = "budget-remaining"
const BUDGET_REMAINING_WORKFLOW = `export const meta = { name: "${BUDGET_REMAINING_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const before = ctx.budgetRemaining
  await ctx.agent({ prompt: "spend" })
  const after = ctx.budgetRemaining
  return { before, after }
}
`

// Liest ctx.budgetRemaining OHNE gesetztes Budget — muss Infinity sein.
// Multi-turn fixture: a single ctx.agent step whose child session runs several
// assistant turns. The all-turns budget sum must charge the TOTAL of every turn,
// not just the last one the prompt loop returns.
const BUDGET_MULTITURN_FIXTURE = "budget-multiturn"
const BUDGET_MULTITURN_WORKFLOW = `export const meta = { name: "${BUDGET_MULTITURN_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  await ctx.agent({ prompt: "do a multi-turn task" })
  return { budgetRemaining: ctx.budgetRemaining }
}
`

const BUDGET_UNLIMITED_FIXTURE = "budget-unlimited"
const BUDGET_UNLIMITED_WORKFLOW = `export const meta = { name: "${BUDGET_UNLIMITED_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const remaining = ctx.budgetRemaining
  await ctx.agent({ prompt: "spend" })
  return { unlimited: remaining === Infinity }
}
`

// Failed-but-paid-Fixture: ein Agent MIT Schema, der scheitert (kein
// strukturiertes Ergebnis), aber laut Telemetrie echte Kosten verursacht hat.
// Der Workflow fängt den Fehler ab und gibt das Restbudget zurück, damit der
// Test beweisen kann, dass das Budget TROTZ des Fehlers belastet wurde.
const BUDGET_FAILED_PAID_FIXTURE = "budget-failed-paid"
const BUDGET_FAILED_PAID_WORKFLOW = `export const meta = { name: "${BUDGET_FAILED_PAID_FIXTURE}", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  let failed = false
  try {
    await ctx.agent({ prompt: "produce structured", schema: { type: "object" } })
  } catch (e) {
    failed = true
  }
  return { failed, remaining: ctx.budgetRemaining }
}
`

// Pipeline-Fixture: zwei Items ("A","B"), zwei Stages. Stage 2 ändert den Typ
// (string -> { a, b }). Item A wird in Stage 1 künstlich verlangsamt, damit Item
// B Stage 2 erreichen kann, BEVOR Item A Stage 1 verlässt — der Nachweis, dass
// es KEINE Barriere zwischen den Stages gibt (Items laufen unabhängig durch die
// Stage-Sequenz). Reihenfolge-Marker und Ergebnis werden über ctx.log bzw. das
// Workflow-Resultat beobachtbar gemacht; das Resultat enthält die Marker-Folge
// und das Stage-2-Resultat in Item-Reihenfolge.
const PIPELINE_FIXTURE = "pipeline"
const PIPELINE_WORKFLOW = `export const meta = { name: "${PIPELINE_FIXTURE}", phases: ["pipeline"] }
export async function run(args, ctx) {
  ctx.setPhase("pipeline")
  const order = []
  const slow = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const result = await ctx.pipeline(
    ["A", "B"],
    async (item) => {
      order.push(item + ":stage1:start")
      // Item A trödelt in Stage 1, damit B in Stage 2 vorrückt.
      if (item === "A") await slow(80)
      order.push(item + ":stage1:done")
      return { item, n: item === "A" ? 1 : 2 }
    },
    async (prev, item) => {
      order.push(item + ":stage2")
      return { a: prev.n, b: prev.item === "A" ? "x" : "y" }
    },
  )
  for (const marker of order) ctx.log(marker)
  return { order, result }
}
`

// Parallel-Fixture: sechs Tasks à ~40ms, concurrencyLimit aus den args. Jede
// Task meldet Start/Ende über zwei globale Zähler (auf globalThis, weil das
// Workflow-Modul in seinem eigenen ESM-Realm läuft); der Workflow gibt die
// beobachtete Spitzen-Parallelität und die Task-Resultate zurück.
const PARALLEL_FIXTURE = "parallel-limit"
const PARALLEL_WORKFLOW = `export const meta = { name: "${PARALLEL_FIXTURE}", phases: ["parallel"] }
export async function run(args, ctx) {
  ctx.setPhase("parallel")
  let active = 0
  let peak = 0
  const slow = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const tasks = Array.from({ length: 6 }, (_, i) => async () => {
    active++
    peak = Math.max(peak, active)
    await slow(40)
    active--
    return i
  })
  const result = await ctx.parallel(tasks, { concurrencyLimit: args.concurrencyLimit })
  return { peak, result }
}
`

// Isolation-Fixture: je ein fan-out-Arm wirft. parallel degradiert den Arm zu
// null, pipeline lässt das werfende Item fallen (Stage 2 übersprungen) — der Run
// läuft trotzdem bis completed und liefert die übrigen Resultate.
const ISOLATION_FIXTURE = "isolation"
const ISOLATION_WORKFLOW = `export const meta = { name: "${ISOLATION_FIXTURE}", phases: ["isolate"] }
export async function run(args, ctx) {
  ctx.setPhase("isolate")
  const par = await ctx.parallel([
    async () => "ok-1",
    async () => { throw new Error("boom-arm") },
    async () => "ok-3",
  ])
  const pipe = await ctx.pipeline(
    ["good", "bad"],
    async (item) => { if (item === "bad") throw new Error("boom-stage"); return item.toUpperCase() },
    async (prev) => prev + "!",
  )
  return { par, pipe }
}
`

// Declared-args-Fixture: meta.arguments deklariert number/boolean/string mit
// Defaults. Der Workflow gibt die Args zurück, die run() tatsächlich empfängt —
// nach Coercion + Default-Anwendung an der Engine-Grenze.
const ARGS_FIXTURE = "declared-args"
const ARGS_WORKFLOW = `export const meta = {
  name: "${ARGS_FIXTURE}",
  phases: ["args"],
  arguments: {
    count: { type: "number" },
    flag: { type: "boolean", default: false },
    label: { type: "string", default: "hi" },
  },
}
export async function run(args, ctx) {
  ctx.setPhase("args")
  return { received: args }
}
`

describe("Workflow", () => {
  it.instance("pipeline runs stages per item without a barrier and supports heterogeneous types", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PIPELINE_FIXTURE, PIPELINE_WORKFLOW))
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: PIPELINE_FIXTURE, args: {} })
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("pipeline did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as { order: string[]; result: Array<{ a: number; b: string }> }
      // Kein Barrier: Item B erreicht Stage 2, bevor Item A Stage 1 verlässt.
      expect(result.order.indexOf("B:stage2")).toBeLessThan(result.order.indexOf("A:stage1:done"))
      // Stage 2 ändert den Typ; Ergebnis in Item-Reihenfolge.
      expect(result.result).toEqual([
        { a: 1, b: "x" },
        { a: 2, b: "y" },
      ])
    }),
  )

  it.instance("parallel respects concurrencyLimit", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, PARALLEL_FIXTURE, PARALLEL_WORKFLOW))
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: PARALLEL_FIXTURE, args: { concurrencyLimit: 2 } })
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("parallel did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as { peak: number; result: number[] }
      expect(result.result).toHaveLength(6)
      expect(result.peak).toBeLessThanOrEqual(2)
      // Untergrenze: 6 Tasks à ~40ms bei Limit 2 erreichen zuverlässig peak 2 —
      // schützt gegen versehentliches Über-Clamping des Limits auf 1.
      expect(result.peak).toBeGreaterThanOrEqual(2)
    }),
  )

  it.instance("parallel & pipeline isolate a thrown arm to null; the run still completes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, ISOLATION_FIXTURE, ISOLATION_WORKFLOW))
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: ISOLATION_FIXTURE, args: {} })
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("isolation workflow did not finish")))
      // A failed fan-out arm no longer aborts the whole run.
      expect(done.status).toBe("completed")
      const result = done.result as { par: (string | null)[]; pipe: (string | null)[] }
      // The thrown parallel arm is null; its siblings are unaffected, in order.
      expect(result.par).toEqual(["ok-1", null, "ok-3"])
      // The thrown pipeline item is null (its stage 2 is skipped); the good item
      // flows through both stages.
      expect(result.pipe).toEqual(["GOOD!", null])
      // Both isolated failures are recorded on the run for visibility.
      expect(done.logs.filter((l) => l.message.includes("isolated"))).toHaveLength(2)
    }),
  )

  it.instance("start coerces declared arguments and applies defaults at the boundary", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, ARGS_FIXTURE, ARGS_WORKFLOW))
      const workflow = yield* Workflow.Service
      // count supplied as a string → coerced to number; flag "true" → boolean;
      // label omitted → declared default applied.
      const run = yield* workflow.start({ name: ARGS_FIXTURE, args: { count: "3", flag: "true" } })
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("args workflow did not finish")))
      expect(done.status).toBe("completed")
      const result = done.result as { received: Record<string, unknown> }
      expect(result.received).toEqual({ count: 3, flag: true, label: "hi" })
      // The persisted row reflects the coerced args, not the raw input.
      expect(done.args).toEqual({ count: 3, flag: true, label: "hi" })
    }),
  )

  it.instance("start rejects a non-finite number argument with a precise InvalidError", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, ARGS_FIXTURE, ARGS_WORKFLOW))
      const workflow = yield* Workflow.Service
      const failed = yield* workflow.start({ name: ARGS_FIXTURE, args: { count: "notanumber" } }).pipe(Effect.flip)
      expect(failed._tag).toBe("WorkflowInvalidError")
      // The error names the offending argument so the failure is actionable.
      if (failed._tag === "WorkflowInvalidError") expect(failed.message).toContain("count")
    }),
  )

  it.instance("discovers workflow files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "hello",
          `export const meta = { name: "Hello", description: "Test workflow", phases: ["start"] }
export async function run(args, ctx) { ctx.setPhase("start"); ctx.log("hello"); return { ok: true } }
`,
        ),
      )
      const workflow = yield* Workflow.Service
      const list = yield* workflow.list()
      expect(list.map((item) => item.name)).toContain("hello")
      expect(list.find((item) => item.name === "hello")?.meta.name).toBe("Hello")
    }),
  )

  it.instance("a broken workflow file does not break list(); it is reported invalid", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          HELLO_FIXTURE,
          `export const meta = { name: "Hello", description: "Test workflow", phases: ["start"] }
export async function run(args, ctx) { ctx.setPhase("start"); ctx.log("hello"); return { ok: true } }
`,
        ),
      )
      // Syntaxfehler: unvollständiges Objektliteral -> Modul-Load schlägt fehl.
      yield* Effect.promise(() => writeWorkflow(test.directory, "broken", "export const meta = {"))
      const workflow = yield* Workflow.Service

      const all = yield* workflow.list()
      const broken = all.find((item) => item.name === "broken")
      expect(broken?.valid).toBe(false)
      expect(broken?.error).toBeTruthy()
      // Die gute Datei bleibt trotz der kaputten weiterhin gelistet und gültig.
      expect(all.some((item) => item.name === HELLO_FIXTURE && item.valid !== false)).toBe(true)
    }),
  )

  it.instance("start loads only the target module and fails precisely for broken target", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          HELLO_FIXTURE,
          `export const meta = { name: "Hello" }
export async function run(args, ctx) { ctx.setPhase("run"); ctx.log("running"); return { ok: true } }
`,
        ),
      )
      yield* Effect.promise(() => writeWorkflow(test.directory, "broken", "export const meta = {"))
      const workflow = yield* Workflow.Service

      // Ein kaputtes Ziel scheitert präzise (InvalidError, der die Datei/den Namen nennt).
      const failed = yield* workflow.start({ name: "broken", args: {} }).pipe(Effect.flip)
      expect(failed._tag).toBe("WorkflowInvalidError")
      // Narrow the start() error union (InvalidError | NotFoundError) to the
      // precise InvalidError so its `path` is accessible and typed.
      const invalid =
        failed instanceof Workflow.InvalidError ? failed : (yield* Effect.fail(new Error("expected InvalidError")))
      expect(invalid.path).toContain("broken")

      // Die gültige Datei ist trotz broken.ts startbar (kein voller list()-Abbruch).
      const ok = yield* workflow.start({ name: HELLO_FIXTURE, args: {} })
      expect(ok.id).toBeTruthy()
    }),
  )

  it.instance("starts and records a workflow run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "hello",
          `export const meta = { name: "Hello" }
export async function run(args, ctx) { ctx.setPhase("run"); ctx.log("running"); return { value: args.value } }
`,
        ),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: "hello", args: { value: 42 } })
      expect(run.status).toBe("running")
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("workflow did not finish")))
      expect(done.current_phase).toBe("run")
      expect(done.logs.map((item) => item.message)).toContain("running")
      expect(done.args).toEqual({ value: 42 })
      expect(done.definition?.name).toBe("hello")
      expect(done.definition?.path.endsWith("hello.js")).toBe(true)
      expect(done.result).toEqual({ value: 42 })
    }),
  )

  it.instance("workflow agent prompts cap session retries", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "retry-cap",
          `export const meta = { name: "retry-cap", phases: ["agent"] }
export async function run(args, ctx) {
  ctx.setPhase("agent")
  const result = await ctx.agent({ prompt: "reply" })
  return result.text
}
`,
        ),
      )
      const workflow = yield* Workflow.Service
      const retries: Array<number | undefined> = []
      const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
        prompt: (input) =>
          Effect.gen(function* () {
            if (input.noReply) return assistantReply()
            retries.push(input.retries)
            return {
              info: {
                role: "assistant",
                providerID: "test",
                modelID: "test-model",
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              },
              parts: [{ type: "text", text: "ok" }],
            } as unknown as SessionV1.WithParts
          }),
        cancel: () => Effect.void,
      }

      const run = yield* workflow.start({ name: "retry-cap", prompt: ops })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      expect(retries).toEqual([0])
    }),
  )

  it.instance("preserves temporary workflow source in run definition", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const source = `export const meta = { name: "Temporary" }
export async function run(args, ctx) { ctx.setPhase("run"); return { value: args.value } }
`
      yield* Effect.promise(() => writeWorkflow(test.directory, "temporary", source))
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: "temporary", args: { value: 99 }, source, temporary: true })
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("workflow did not finish")))
      expect(done.definition?.temporary).toBe(true)
      expect(done.definition?.source).toBe(source)
      expect(done.result).toEqual({ value: 99 })
    }),
  )

  it.instance("runs a free-body (Claude-style) script through the loader transform", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // A literal `meta` + a FREE top-level body using global hooks (phase/parallel/
      // log/args) and top-level `await`/`return` — no `run` export. The loader's
      // transform wraps it into run(args, ctx). Uses non-agent thunks so it needs no
      // prompt-ops.
      const source = `export const meta = { name: "freebody", phases: ["go"] } as const
phase("go")
const xs = (await parallel([() => Promise.resolve(2), () => Promise.resolve(3)])).filter(Boolean)
log("collected " + xs.length)
return { sum: xs.reduce((a, b) => a + b, 0), arg: args.value }
`
      yield* Effect.promise(() => writeWorkflow(test.directory, "freebody", source, "ts"))
      const workflow = yield* Workflow.Service
      // Discoverable by the static meta-reader without executing the body.
      const list = yield* workflow.list()
      expect(list.map((item) => item.name)).toContain("freebody")
      const run = yield* workflow.start({ name: "freebody", args: { value: 10 } })
      const waited = yield* workflow.wait({ id: run.id })
      const done = waited.run ?? (yield* Effect.fail(new Error("free-body workflow did not finish")))
      expect(done.status).toBe("completed")
      expect(done.result).toEqual({ sum: 5, arg: 10 })
    }),
  )

  it.instance("loads TypeScript workflow default exports", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "typed",
          `export default {
  meta: { name: "Typed Workflow", phases: ["run"] },
  async run(args, ctx) { ctx.setPhase("run"); ctx.log("typed"); return { value: args.value } }
}
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const list = yield* workflow.list()
      expect(list.map((item) => item.name)).toContain("typed")
      const run = yield* workflow.start({ name: "typed", args: { value: 7 } })

      const done = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current?.status === "completed" ? current : undefined
        }),
        "workflow never completed",
      )
      expect(done.result).toEqual({ value: 7 })
    }),
  )

  it.instance("cancel interrupts a running workflow and aborts its agent sessions", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SLOW_FIXTURE, SLOW_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, aborted, started } = hangingPromptOps()

      const run = yield* workflow.start({ name: SLOW_FIXTURE, args: {}, prompt: ops })

      // Warten bis der erste Agent läuft und seine Child-Session erzeugt hat.
      const live = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current && current.agents.some((a) => a.status === "running" && a.session_id) ? current : undefined
        }),
        "agent never started",
      )
      expect(live.agents.some((a) => a.status === "running")).toBe(true)

      yield* workflow.cancel(run.id)

      const after = yield* workflow.get(run.id)
      const done = after ?? (yield* Effect.fail(new Error("run vanished")))
      expect(done.status).toBe("cancelled")
      // Kein Agent darf nach Cancel noch laufen.
      expect(done.agents.every((a) => a.status !== "running")).toBe(true)
      // Folge-Step darf nie gestartet sein.
      expect(done.logs.some((l) => l.message?.includes(STEP2_MARKER))).toBe(false)
      // Kern-Assertion: die Child-Session wurde echt abgebrochen.
      const childSession = done.agents[0]?.session_id
      expect(childSession).toBeDefined()
      expect(started.has(childSession!)).toBe(true)
      expect(aborted.has(childSession!)).toBe(true)
    }),
  )

  it.instance("remove on a running run cancels it first, then deletes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, SLOW_FIXTURE, SLOW_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { ops, aborted } = hangingPromptOps()

      const run = yield* workflow.start({ name: SLOW_FIXTURE, args: {}, prompt: ops })

      const live = yield* pollWithTimeout(
        Effect.gen(function* () {
          const current = yield* workflow.get(run.id)
          return current && current.agents.some((a) => a.status === "running" && a.session_id) ? current : undefined
        }),
        "agent never started",
      )
      const childSession = live.agents[0]?.session_id
      expect(childSession).toBeDefined()

      yield* workflow.remove(run.id)

      // Run ist gelöscht.
      const gone = yield* workflow.get(run.id)
      expect(gone).toBeUndefined()
      // Und die Child-Session wurde vor dem Löschen abgebrochen.
      expect(aborted.has(childSession!)).toBe(true)
    }),
  )

  // Orphan-Mechanismus: Die In-Memory-Test-DB (OPENCODE_DB=:memory:) überlebt
  // keine frische Layer-Instanz, daher wird der Orphan simuliert, indem wir eine
  // running-Zeile OHNE Registry-Eintrag direkt über die SQL-Schicht einfügen und
  // anschließend NUR den Sweep auslösen (engine.sweep()), so wie er beim
  // Service-Start läuft (leere Registry -> alle running-Zeilen werden gefegt).
  it.instance("orphaned running rows are marked interrupted on service start", () =>
    Effect.gen(function* () {
      const workflow = yield* Workflow.Service
      const orphanId = "job_orphan_sweep"
      yield* seedRunningRow(orphanId)

      yield* workflow.sweep()

      const row = yield* fetchRunRow(orphanId)
      expect(row.status).toBe("interrupted")
      expect(row.completed_at).toBeGreaterThan(0)
    }),
  )

  it.instance("runs() sweeps orphaned rows and closes running agent nodes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const workflow = yield* Workflow.Service
      const orphanId = Workflow.RunID.make("job_orphan_runs_agents")
      yield* seedRunningRow(orphanId, test.directory, [
        {
          id: "1",
          status: "running",
          started_at: Date.now(),
          prompt: "stale agent",
          session_id: "ses_stale_agent",
        },
      ])

      const runs = yield* workflow.runs()
      const run = runs.find((item) => item.id === orphanId)
      expect(run?.status).toBe("interrupted")
      expect(run?.agents[0]?.status).toBe("failed")
      expect(run?.agents[0]?.completed_at).toBeGreaterThan(0)
      expect(run?.agents[0]?.error).toContain("interrupted")
    }),
  )

  it.instance("orphan sweep promotes completed child sessions before interrupting the run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const orphanId = Workflow.RunID.make("job_orphan_promote_child")
      const childSessionID = SessionID.make("ses_completed_agent")
      yield* seedSession(childSessionID)
      yield* persistTurns(db, childSessionID, [
        {
          cost: 0.25,
          tokens: { total: 11, input: 5, output: 6, reasoning: 0, cache: { read: 1, write: 2 } },
        },
      ])
      yield* seedRunningRow(orphanId, test.directory, [
        {
          id: "1",
          status: "running",
          started_at: Date.now(),
          prompt: "completed agent",
          session_id: childSessionID,
        },
      ])

      const runs = yield* workflow.runs()
      const run = runs.find((item) => item.id === orphanId)
      expect(run?.status).toBe("interrupted")
      expect(run?.agents[0]?.status).toBe("completed")
      expect(run?.agents[0]?.output).toBe("ok")
      expect(run?.agents[0]?.cost).toBe(0.25)
      expect(run?.agents[0]?.tokens?.input).toBe(5)
    }),
  )

  it.instance("runs() and the sweep are scoped to this project's directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          HELLO_FIXTURE,
          `export const meta = { name: "Hello" }
export async function run(args, ctx) { return "ok" }
`,
        ),
      )
      const workflow = yield* Workflow.Service

      // A row owned by ANOTHER project sharing the same DB: it must neither show
      // up in this project's history nor be touched by this project's sweep —
      // it may belong to a LIVE fiber in a different process.
      const foreignId = "job_foreign_project"
      yield* seedRunningRow(foreignId, "C:\\somewhere\\else")
      // A legacy pre-migration row (NULL directory): healed by the sweep once.
      const legacyId = "job_legacy_null_dir"
      yield* seedRunningRow(legacyId)

      const run = yield* workflow.start({ name: HELLO_FIXTURE, args: {} })
      yield* workflow.wait({ id: run.id })

      // This project's run row carries the project root.
      const ownRow = yield* fetchRunRow(run.id)
      expect(ownRow.directory).toBeTruthy()

      const listed = yield* workflow.runs()
      const ids = listed.map((item) => item.id)
      expect(ids).toContain(run.id)
      expect(ids).not.toContain(foreignId)

      yield* workflow.sweep()
      // Foreign live row untouched; legacy row honestly interrupted.
      expect((yield* fetchRunRow(foreignId)).status).toBe("running")
      expect((yield* fetchRunRow(legacyId)).status).toBe("interrupted")
    }),
  )

  it.instance("persisted run round-trips through fromRow", () =>
    Effect.gen(function* () {
      const workflow = yield* Workflow.Service
      const persistedId = Workflow.RunID.make("job_roundtrip")
      // Persist a finished run directly via the SQL layer (no live registry
      // entry), so get() must read it back through DB->fromRow.
      yield* seedCompletedRow(persistedId)

      const viaDb = yield* workflow.get(persistedId)
      const persisted = viaDb ?? (yield* Effect.fail(new Error("run not persisted")))
      expect(persisted).toMatchObject({ id: persistedId, status: "completed" })
      // Telemetrie überlebt den Roundtrip durch fromRow.
      expect(persisted.logs.map((item) => item.message)).toContain("running")
      expect(persisted.agents.length).toBeGreaterThan(0)
      expect(persisted.agents[0]?.output).toBe("did the thing")
    }),
  )

  it.instance("wait on interrupted run resolves immediately as interrupted (not timedOut)", () =>
    Effect.gen(function* () {
      const workflow = yield* Workflow.Service
      const orphanId = Workflow.RunID.make("job_orphan_wait")
      yield* seedRunningRow(orphanId)
      yield* workflow.sweep()

      const res = yield* workflow.wait({ id: orphanId, timeout: 50 })
      expect(res.run?.status).toBe("interrupted")
      expect(res.timedOut).not.toBe(true)
    }),
  )

  it.instance("schema agent failure is recorded as failed, never silently completed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, SCHEMA_FAILING_FIXTURE, schemaWorkflow(SCHEMA_FAILING_FIXTURE)),
      )
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: SCHEMA_FAILING_FIXTURE,
        args: {},
        prompt: structuredPromptOps(db, "error"),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("failed")
      expect(done.run?.agents.some((a) => a.status === "failed")).toBe(true)
      // Kein stiller Plaintext-Fallback: der Agent darf NICHT completed sein.
      expect(done.run?.agents.some((a) => a.status === "completed")).toBe(false)
    }),
  )

  it.instance("schema agent with undefined structured result fails instead of plaintext fallback", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, SCHEMA_UNDEFINED_FIXTURE, schemaWorkflow(SCHEMA_UNDEFINED_FIXTURE)),
      )
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: SCHEMA_UNDEFINED_FIXTURE,
        args: {},
        prompt: structuredPromptOps(db, "undefined"),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("failed")
      expect(done.run?.agents.some((a) => a.status === "failed")).toBe(true)
    }),
  )

  it.instance("schema agent success returns the parsed object and completes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, SCHEMA_SUCCESS_FIXTURE, schemaWorkflow(SCHEMA_SUCCESS_FIXTURE)),
      )
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: SCHEMA_SUCCESS_FIXTURE,
        args: {},
        prompt: structuredPromptOps(db, "structured"),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      // Positivpfad: das geparste Objekt wird durch ctx.agent (result.data) und
      // damit das Workflow-Resultat hindurchgereicht.
      expect(done.run?.result).toEqual({ data: SCHEMA_OBJECT })
      expect(done.run?.agents.every((a) => a.status === "completed")).toBe(true)
    }),
  )

  it.instance("agent calls beyond exhausted budget fail the run with a budget error", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, BUDGET_FIXTURE, BUDGET_WORKFLOW))
      const workflow = yield* Workflow.Service
      // Budget 1.0 USD, jeder Step kostet 1.0 — nach Step 1 ist das Budget
      // erschöpft (Rest 0), also scheitert der zweite ctx.agent am Gate.
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: BUDGET_FIXTURE,
        args: {},
        prompt: costPromptOps(db, 1),
        budget: 1,
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("failed")
      expect(done.run?.error ?? "").toMatch(/budget/i)
      // Das Gate verhindert, dass der zweite Step überhaupt STARTET: nur der
      // erste Agent läuft (und wird completed); für den geblockten zweiten Step
      // wird kein Node angelegt — die Engine weigert sich, weiter zu spenden.
      expect(done.run?.agents.filter((a) => a.status === "completed").length).toBe(1)
      expect(done.run?.agents.length).toBe(1)
    }),
  )

  it.instance("budgetRemaining reflects real spend during the run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, BUDGET_REMAINING_FIXTURE, BUDGET_REMAINING_WORKFLOW),
      )
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: BUDGET_REMAINING_FIXTURE,
        args: {},
        prompt: costPromptOps(db, 0.25),
        budget: 1,
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      const result = done.run?.result as { before: number; after: number }
      expect(result.before).toBe(1)
      // Nach einem Step à 0.25 USD bleibt 0.75 übrig.
      expect(result.after).toBe(0.75)
      expect(result.after).toBeLessThan(result.before)
    }),
  )

  it.instance("budget sums cost across ALL of a sub-agent's turns, not just the last", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => writeWorkflow(test.directory, BUDGET_MULTITURN_FIXTURE, BUDGET_MULTITURN_WORKFLOW))
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      // The single ctx.agent step runs 3 turns à 0.40 USD. The engine must charge
      // the SUM (1.20), not just the last turn's 0.40 (the pre-fix behaviour).
      const run = yield* workflow.start({
        name: BUDGET_MULTITURN_FIXTURE,
        args: {},
        prompt: costPromptOps(db, 0.4, 3),
        budget: 2,
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      // The agent node records the all-turns sum, not the last turn.
      expect(done.run?.agents[0]?.cost).toBeCloseTo(1.2, 5)
      // budgetRemaining = 2 − 1.2 = 0.8 (would wrongly read 1.6 if only the last
      // 0.40 turn were charged).
      const result = done.run?.result as { budgetRemaining: number }
      expect(result.budgetRemaining).toBeCloseTo(0.8, 5)
    }),
  )

  it.instance("no budget set means unlimited (Infinity) — unchanged default", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, BUDGET_UNLIMITED_FIXTURE, BUDGET_UNLIMITED_WORKFLOW),
      )
      const workflow = yield* Workflow.Service
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: BUDGET_UNLIMITED_FIXTURE,
        args: {},
        prompt: costPromptOps(db, 5),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      expect((done.run?.result as { unlimited: boolean }).unlimited).toBe(true)
    }),
  )

  it.instance("a failed-but-paid step still charges the budget by its actual cost", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(test.directory, BUDGET_FAILED_PAID_FIXTURE, BUDGET_FAILED_PAID_WORKFLOW),
      )
      const workflow = yield* Workflow.Service
      // Schema-Agent scheitert (kein strukturiertes Ergebnis), hat aber 0.3 USD
      // gekostet. Der Workflow fängt den Fehler ab und läuft weiter.
      const { db } = yield* Database.Service
      const run = yield* workflow.start({
        name: BUDGET_FAILED_PAID_FIXTURE,
        args: {},
        prompt: structuredPromptOps(db, "error", 0.3),
        budget: 1,
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      const result = done.run?.result as { failed: boolean; remaining: number }
      // Der Step ist wirklich gescheitert ...
      expect(result.failed).toBe(true)
      // ... wurde aber trotzdem mit seinen echten Kosten (0.3) belastet.
      expect(result.remaining).toBe(0.7)
      // Und der Agent-Node ist als failed verbucht.
      expect(done.run?.agents.some((a) => a.status === "failed")).toBe(true)
    }),
  )

  it.instance("reloads workflow implementation after file changes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "reload",
          `export const meta = { name: "Reload One" }
export async function run() { return { value: "one" } }
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const first = yield* workflow.start({ name: "reload" })
      const firstWaited = yield* workflow.wait({ id: first.id })
      const firstDone = firstWaited.run ?? (yield* Effect.fail(new Error("first workflow did not finish")))
      expect(firstDone.definition?.meta.name).toBe("Reload One")
      expect(firstDone.result).toEqual({ value: "one" })

      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "reload",
          `export const meta = { name: "Reload Two" }
export async function run() { return { value: "two" } }
`,
          "ts",
        ),
      )

      const second = yield* workflow.start({ name: "reload" })
      const secondWaited = yield* workflow.wait({ id: second.id })
      const secondDone = secondWaited.run ?? (yield* Effect.fail(new Error("second workflow did not finish")))
      expect(secondDone.definition?.meta.name).toBe("Reload Two")
      expect(secondDone.result).toEqual({ value: "two" })
    }),
  )

  it.instance("forEach supports async callbacks and non-AgentInput return values", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "foreach-async",
          `export const meta = { name: "foreach-async", phases: ["run"] }
export async function run(args, ctx) {
  const items = [1, 2, 3]
  const results = await ctx.forEach(items, async (item) => {
    return item * 2
  })
  return { results }
}
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({ name: "foreach-async" })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      expect(done.run?.result).toEqual({ results: [2, 4, 6] })
    }),
  )

  it.instance("forEach supports traditional callbacks returning AgentInput", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "foreach-agent",
          `export const meta = { name: "foreach-agent", phases: ["run"] }
export async function run(args, ctx) {
  const items = ["a", "b"]
  const results = await ctx.forEach(items, (item) => {
    return { prompt: "run on " + item }
  })
  return { results: results.map(r => r.text) }
}
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const echoPromptOps = () => {
        const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
          prompt: (input) =>
            Effect.gen(function* () {
              if (input.noReply) return assistantReply()
              const text = input.parts.find((p) => p.type === "text")?.text ?? ""
              return {
                info: {
                  id: "msg_test",
                  role: "assistant",
                  providerID: "test",
                  modelID: "test-model",
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                },
                parts: [{ type: "text", text: "replied to " + text }],
              } as unknown as SessionV1.WithParts
            }),
          cancel: () => Effect.void,
        }
        return ops
      }
      const run = yield* workflow.start({
        name: "foreach-agent",
        prompt: echoPromptOps(),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      expect(done.run?.result).toEqual({ results: ["replied to run on a", "replied to run on b"] })
    }),
  )

  it.instance("loop supports async fn callbacks and async until checks", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "loop-async",
          `export const meta = { name: "loop-async", phases: ["run"] }
export async function run(args, ctx) {
  const results = await ctx.loop({
    fn: async (i, prev) => {
      if (prev) {
        return { prompt: "run on " + prev.text + " loop " + i }
      }
      return { prompt: "initial loop " + i }
    },
    until: async (result, i) => {
      return i >= 2
    },
    maxIterations: 5
  })
  return { results: results.map(r => r.text) }
}
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const echoPromptOps = () => {
        const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
          prompt: (input) =>
            Effect.gen(function* () {
              if (input.noReply) return assistantReply()
              const text = input.parts.find((p) => p.type === "text")?.text ?? ""
              return {
                info: {
                  id: "msg_test",
                  role: "assistant",
                  providerID: "test",
                  modelID: "test-model",
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                },
                parts: [{ type: "text", text: "replied to " + text }],
              } as unknown as SessionV1.WithParts
            }),
          cancel: () => Effect.void,
        }
        return ops
      }
      const run = yield* workflow.start({
        name: "loop-async",
        prompt: echoPromptOps(),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      expect(done.run?.result).toEqual({
        results: [
          "replied to initial loop 0",
          "replied to run on replied to initial loop 0 loop 1",
          "replied to run on replied to run on replied to initial loop 0 loop 1 loop 2",
        ],
      })
    }),
  )

  it.instance("adversarial supports async worker and passes verification", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "adversarial-async",
          `export const meta = { name: "adversarial-async", phases: ["run"] }
export async function run(args, ctx) {
  const result = await ctx.adversarial({
    worker: async () => {
      const step = await ctx.agent({ prompt: "do worker task" })
      return step
    },
    rubric: ["correct text"]
  })
  return { result }
}
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const echoPromptOps = () => {
        const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
          prompt: (input) =>
            Effect.gen(function* () {
              if (input.noReply) return assistantReply()
              if (input.format) {
                const structuredData = {
                  pass: true,
                  confidence: 0.95,
                  issues: [],
                  evidence: ["verified correct text"]
                }
                return {
                  info: {
                    id: "msg_verifier",
                    role: "assistant",
                    providerID: "test",
                    modelID: "test-model",
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    structured: structuredData,
                  },
                  parts: [{
                    type: "text",
                    text: JSON.stringify(structuredData)
                  }],
                } as unknown as SessionV1.WithParts
              }
              const text = input.parts.find((p) => p.type === "text")?.text ?? ""
              return {
                info: {
                  id: "msg_test",
                  role: "assistant",
                  providerID: "test",
                  modelID: "test-model",
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                },
                parts: [{ type: "text", text: "worker response to " + text }],
              } as unknown as SessionV1.WithParts
            }),
          cancel: () => Effect.void,
        }
        return ops
      }
      const run = yield* workflow.start({
        name: "adversarial-async",
        prompt: echoPromptOps(),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      expect(done.run?.result).toEqual({
        result: {
          worker: {
            data: "worker response to do worker task",
            text: "worker response to do worker task",
          },
          verification: {
            pass: true,
            confidence: 0.95,
            issues: [],
            evidence: ["verified correct text"],
          },
        },
      })
    }),
  )

  it.instance("adversarial coerces a non-array rubric instead of crashing on .map", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "adversarial-rubric",
          `export const meta = { name: "adversarial-rubric", phases: ["run"] }
export async function run(args, ctx) {
  // A non-array, non-string rubric (the kind a generated workflow can emit) used
  // to throw "rubric.map is not a function" and fail the whole run.
  const result = await ctx.adversarial({
    worker: async () => await ctx.agent({ prompt: "do worker task" }),
    rubric: 5,
  })
  return { pass: result.verification.pass }
}
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
        prompt: (input) =>
          Effect.gen(function* () {
            if (input.noReply) return assistantReply()
            if (input.format) {
              const structured = { pass: true, confidence: 0.9, issues: [], evidence: [] }
              return {
                info: {
                  id: "msg_v",
                  role: "assistant",
                  providerID: "test",
                  modelID: "test-model",
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  structured,
                },
                parts: [{ type: "text", text: JSON.stringify(structured) }],
              } as unknown as SessionV1.WithParts
            }
            return {
              info: {
                id: "msg_w",
                role: "assistant",
                providerID: "test",
                modelID: "test-model",
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              },
              parts: [{ type: "text", text: "worker output" }],
            } as unknown as SessionV1.WithParts
          }),
        cancel: () => Effect.void,
      }
      const run = yield* workflow.start({ name: "adversarial-rubric", prompt: ops })
      const done = yield* workflow.wait({ id: run.id })
      // Before the fix this run FAILED ("rubric.map is not a function"); now it
      // completes, the number rubric coerced to ["5"].
      expect(done.run?.status).toBe("completed")
      expect(done.run?.result).toEqual({ pass: true })
    }),
  )

  function errorPromptOps(errorName: string, errorMessage: string) {
    const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
      prompt: (input) =>
        Effect.gen(function* () {
          if (input.noReply) return assistantReply()
          const info = {
            id: "msg_test_err",
            role: "assistant",
            providerID: "test",
            modelID: "test-model",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            error: {
              name: errorName,
              data: { message: errorMessage },
            },
          }
          return { info, parts: [] } as unknown as SessionV1.WithParts
        }),
      cancel: () => Effect.void,
    }
    return ops
  }

  it.instance("agent step with a provider error fails the workflow run", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "agent-error",
          `export const meta = { name: "agent-error", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const result = await ctx.agent({ prompt: "do agent prompt" })
  return { result }
}
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const run = yield* workflow.start({
        name: "agent-error",
        prompt: errorPromptOps("APIError", "Rate limit exceeded"),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("failed")
      expect(done.run?.error).toContain("Rate limit exceeded")
      expect(done.run?.agents.some((a) => a.status === "failed")).toBe(true)
    }),
  )

  it.instance("agent coordination test: research, loop refinement with feedback, adversarial verification, and synthesis", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "coordination-test",
          `export const meta = { name: "coordination-test", phases: ["research", "refinement", "verification", "synthesis"] }
export async function run(args, ctx) {
  ctx.setPhase("research")
  const research = await ctx.agent({ prompt: "conduct research on task" })

  ctx.setPhase("refinement")
  const draft = await ctx.agent({ prompt: "draft solution based on research: " + research.text })

  ctx.setPhase("verification")
  const verified = await ctx.adversarial({
    worker: draft,
    rubric: ["must be accurate", "must be complete"]
  })

  ctx.setPhase("synthesis")
  const report = await ctx.synthesize({
    agents: [research, draft, { text: "Verification status: " + verified.verification.pass + ", evidence: " + verified.verification.evidence.join(", "), data: null }],
    prompt: "Synthesize the coordination results into a final report."
  })

  return { report: report.text, verified }
}
`,
          "ts",
        ),
      )

      const promptsReceived: string[] = []
      const workflow = yield* Workflow.Service
      const coordinationPromptOps = () => {
        const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
          prompt: (input) =>
            Effect.gen(function* () {
              if (input.noReply) return assistantReply()
              const promptText = input.parts.find((p) => p.type === "text")?.text ?? ""
              promptsReceived.push(promptText)

              if (input.format) {
                // Verifier agent call
                const structuredData = {
                  pass: true,
                  confidence: 0.98,
                  issues: [],
                  evidence: ["accurate and complete"]
                }
                return {
                  info: {
                    id: "msg_verifier",
                    role: "assistant",
                    providerID: "test",
                    modelID: "test-model",
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                    structured: structuredData,
                  },
                  parts: [{
                    type: "text",
                    text: JSON.stringify(structuredData)
                  }],
                } as unknown as SessionV1.WithParts
              }

              if (promptText.includes("conduct research")) {
                return {
                  info: {
                    id: "msg_research",
                    role: "assistant",
                    providerID: "test",
                    modelID: "test-model",
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  },
                  parts: [{ type: "text", text: "Research Output: Codebase uses Effect TS extensively." }],
                } as unknown as SessionV1.WithParts
              }

              if (promptText.includes("draft solution")) {
                return {
                  info: {
                    id: "msg_draft",
                    role: "assistant",
                    providerID: "test",
                    modelID: "test-model",
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  },
                  parts: [{ type: "text", text: "Draft Output: Implement workflow E2E testing." }],
                } as unknown as SessionV1.WithParts
              }

              if (promptText.includes("Synthesize")) {
                return {
                  info: {
                    id: "msg_synthesis",
                    role: "assistant",
                    providerID: "test",
                    modelID: "test-model",
                    cost: 0,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  },
                  parts: [{ type: "text", text: "Synthesis Output: Final verified report on Effect TS workflow testing." }],
                } as unknown as SessionV1.WithParts
              }

              return {
                info: {
                  id: "msg_default",
                  role: "assistant",
                  providerID: "test",
                  modelID: "test-model",
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                },
                parts: [{ type: "text", text: "default response" }],
              } as unknown as SessionV1.WithParts
            }),
          cancel: () => Effect.void,
        }
        return ops
      }

      const run = yield* workflow.start({
        name: "coordination-test",
        prompt: coordinationPromptOps(),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")

      // Verification of Quality & Coordination Flow:
      
      // 1. Verify that Agent 2's prompt successfully received Agent 1's research output (context flow)
      const draftPrompt = promptsReceived.find(p => p.includes("draft solution"))
      expect(draftPrompt).toContain("Research Output: Codebase uses Effect TS extensively.")

      // 2. Verify that Verifier Agent's prompt contains the draft solution
      const verifierPrompt = promptsReceived.find(p => p.includes("Judge the worker output"))
      expect(verifierPrompt).toContain("Draft Output: Implement workflow E2E testing.")
      expect(verifierPrompt).toContain("must be accurate")
      expect(verifierPrompt).toContain("must be complete")

      // 3. Verify that Synthesis Agent's prompt receives outputs from all previous stages
      const synthesisPrompt = promptsReceived.find(p => p.includes("Synthesize"))
      expect(synthesisPrompt).toContain("Research Output: Codebase uses Effect TS extensively.")
      expect(synthesisPrompt).toContain("Draft Output: Implement workflow E2E testing.")
      expect(synthesisPrompt).toContain("Verification status: true")

      // 4. Verify the final result quality
      const result = done.run?.result as { report: string }
      expect(result.report).toBe("Synthesis Output: Final verified report on Effect TS workflow testing.")
    }),
  )

  it.instance("agent coordination test: loop refinement with verifier feedback", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "loop-refinement",
          `export const meta = { name: "loop-refinement", phases: ["run"] }
export async function run(args, ctx) {
  const loopResult = await ctx.loop({
    fn: async (i, prev) => {
      if (prev) {
        return { prompt: "improve draft based on feedback: " + prev.text }
      }
      return { prompt: "create initial draft" }
    },
    until: async (result, i) => {
      // Run a verifier agent on the result
      const verification = await ctx.agent({
        prompt: "Verify draft quality: " + result.text
      })
      ctx.log("Iteration " + i + " verification: " + verification.text)
      return verification.text.includes("PASS") || i >= 2
    },
    maxIterations: 3
  })
  return { loopResult: loopResult.map(r => r.text) }
}
`,
          "ts",
        ),
      )

      const promptsReceived: string[] = []
      const workflow = yield* Workflow.Service
      const loopPromptOps = () => {
        const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
          prompt: (input) =>
            Effect.gen(function* () {
              if (input.noReply) return assistantReply()
              const promptText = input.parts.find((p) => p.type === "text")?.text ?? ""
              promptsReceived.push(promptText)

              if (promptText.includes("create initial draft")) {
                return {
                  info: { id: "msg_d1", role: "assistant", providerID: "test", modelID: "test", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
                  parts: [{ type: "text", text: "Draft V1" }],
                } as unknown as SessionV1.WithParts
              }

              if (promptText.includes("Verify draft quality: Draft V1")) {
                return {
                  info: { id: "msg_v1", role: "assistant", providerID: "test", modelID: "test", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
                  parts: [{ type: "text", text: "FAIL: Missing parameters" }],
                } as unknown as SessionV1.WithParts
              }

              if (promptText.includes("improve draft based on feedback: Draft V1")) {
                return {
                  info: { id: "msg_d2", role: "assistant", providerID: "test", modelID: "test", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
                  parts: [{ type: "text", text: "Draft V2 with parameters" }],
                } as unknown as SessionV1.WithParts
              }

              if (promptText.includes("Verify draft quality: Draft V2")) {
                return {
                  info: { id: "msg_v2", role: "assistant", providerID: "test", modelID: "test", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
                  parts: [{ type: "text", text: "PASS: Excellent quality" }],
                } as unknown as SessionV1.WithParts
              }

              return {
                info: { id: "msg_def", role: "assistant", providerID: "test", modelID: "test", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
                parts: [{ type: "text", text: "default" }],
              } as unknown as SessionV1.WithParts
            }),
          cancel: () => Effect.void,
        }
        return ops
      }

      const run = yield* workflow.start({
        name: "loop-refinement",
        prompt: loopPromptOps(),
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")

      // Verification of Quality Loop Coordination:
      
      // 1. Verify we looped because of the verifier feedback
      expect(promptsReceived).toContain("improve draft based on feedback: Draft V1")
      
      // 2. Verify that iteration 2 was run with Draft V2 and passed
      expect(promptsReceived).toContain("Verify draft quality: Draft V2 with parameters")
      
      // 3. Verify that the loop exited on PASS and did not run the 3rd iteration
      expect(promptsReceived.filter(p => p.includes("improve draft")).length).toBe(1)
      
      const result = done.run?.result as { loopResult: string[] }
      expect(result.loopResult).toEqual(["Draft V1", "Draft V2 with parameters"])
    }),
  )

  // Captures the resolved per-agent model (the `modelInfo` the engine passes to
  // prompt.prompt) so the model-resolution precedence can be asserted directly.
  function captureModelPromptOps(seen: Array<{ providerID: string; modelID: string } | undefined>) {
    const ops: { prompt: SessionPrompt.Interface["prompt"]; cancel: SessionPrompt.Interface["cancel"] } = {
      prompt: (input) =>
        Effect.gen(function* () {
          if (input.noReply) return assistantReply()
          seen.push(input.model as { providerID: string; modelID: string } | undefined)
          return {
            info: {
              id: "msg_test",
              role: "assistant",
              providerID: "test",
              modelID: "test-model",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            parts: [{ type: "text", text: "ok" }],
          } as unknown as SessionV1.WithParts
        }),
      cancel: () => Effect.void,
    }
    return ops
  }

  it.instance("per-run model param steers an agent step that requests no model of its own", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "model-override",
          `export const meta = { name: "model-override", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const result = await ctx.agent({ prompt: "do the thing" })
  return { result }
}
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const seen: Array<{ providerID: string; modelID: string } | undefined> = []
      const run = yield* workflow.start({
        name: "model-override",
        prompt: captureModelPromptOps(seen),
        model: "google/gemini-3.5-flash",
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      expect(seen).toEqual([{ providerID: "google", modelID: "gemini-3.5-flash" }])
    }),
  )

  it.instance("a step's own model beats the per-run model override", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "model-precedence",
          `export const meta = { name: "model-precedence", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const result = await ctx.agent({ prompt: "do the thing", model: "openai/gpt-step" })
  return { result }
}
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const seen: Array<{ providerID: string; modelID: string } | undefined> = []
      const run = yield* workflow.start({
        name: "model-precedence",
        prompt: captureModelPromptOps(seen),
        model: "google/gemini-3.5-flash",
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      expect(seen).toEqual([{ providerID: "openai", modelID: "gpt-step" }])
    }),
  )

  it.instance("a malformed per-run model degrades to the default (does not fail the run)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        writeWorkflow(
          test.directory,
          "model-malformed",
          `export const meta = { name: "model-malformed", phases: ["run"] }
export async function run(args, ctx) {
  ctx.setPhase("run")
  const result = await ctx.agent({ prompt: "do the thing" })
  return { result }
}
`,
          "ts",
        ),
      )
      const workflow = yield* Workflow.Service
      const seen: Array<{ providerID: string; modelID: string } | undefined> = []
      // An empty string is unparseable → parseModelString returns undefined →
      // active.model is undefined → resolution falls through to config/default.
      // The run must still complete rather than erroring on a bad override.
      const run = yield* workflow.start({
        name: "model-malformed",
        prompt: captureModelPromptOps(seen),
        model: "",
      })
      const done = yield* workflow.wait({ id: run.id })
      expect(done.run?.status).toBe("completed")
      expect(seen.length).toBe(1)
    }),
  )
})
