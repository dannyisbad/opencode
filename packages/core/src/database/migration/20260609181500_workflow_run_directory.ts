import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260609181500_workflow_run_directory",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`workflow_run\` ADD \`directory\` text;`)
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`workflow_run_directory_started_at_idx\` ON \`workflow_run\` (\`directory\`, \`started_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
