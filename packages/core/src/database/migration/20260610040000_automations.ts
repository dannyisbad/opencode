import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Scheduled automations (backport of anomalyco/opencode#26916). Upstream shipped
// this as two drizzle SQL migrations (20260426 base + 20260428 directory scope);
// neither ever ran on this fork, so this single migration creates the final
// schema directly — directory columns included, no backfill needed.
export default {
  id: "20260610040000_automations",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE \`automation\` (
\t\`id\` text PRIMARY KEY,
\t\`project_id\` text NOT NULL,
\t\`directory\` text NOT NULL,
\t\`title\` text NOT NULL,
\t\`enabled\` integer NOT NULL,
\t\`kind\` text NOT NULL,
\t\`thread_id\` text,
\t\`prompt\` text NOT NULL,
\t\`schedule\` text NOT NULL,
\t\`execution_mode\` text NOT NULL,
\t\`model\` text NOT NULL,
\t\`reasoning_effort\` text,
\t\`permission_profile\` text NOT NULL,
\t\`notification_behavior\` text NOT NULL,
\t\`max_runtime_minutes\` integer,
\t\`starts_at\` integer,
\t\`ends_at\` integer,
\t\`last_run_at\` integer,
\t\`next_run_at\` integer,
\t\`time_created\` integer NOT NULL,
\t\`time_updated\` integer NOT NULL,
\tCONSTRAINT \`fk_automation_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
\tCONSTRAINT \`fk_automation_thread_id_session_id_fk\` FOREIGN KEY (\`thread_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
);`)
      yield* tx.run(`CREATE INDEX \`automation_project_idx\` ON \`automation\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`automation_directory_idx\` ON \`automation\` (\`directory\`);`)
      yield* tx.run(`CREATE INDEX \`automation_due_idx\` ON \`automation\` (\`enabled\`,\`next_run_at\`);`)
      yield* tx.run(`CREATE TABLE \`automation_run\` (
\t\`id\` text PRIMARY KEY,
\t\`automation_id\` text NOT NULL,
\t\`project_id\` text NOT NULL,
\t\`directory\` text NOT NULL,
\t\`session_id\` text,
\t\`status\` text NOT NULL,
\t\`prompt_snapshot\` text NOT NULL,
\t\`model_snapshot\` text NOT NULL,
\t\`execution_mode_snapshot\` text NOT NULL,
\t\`schedule_snapshot\` text NOT NULL,
\t\`worktree_path\` text,
\t\`branch_name\` text,
\t\`summary\` text,
\t\`result\` text,
\t\`findings_count\` integer NOT NULL,
\t\`diff_additions\` integer,
\t\`diff_deletions\` integer,
\t\`diff_files\` integer,
\t\`error\` text,
\t\`time_queued\` integer NOT NULL,
\t\`time_started\` integer,
\t\`time_completed\` integer,
\t\`time_read\` integer,
\t\`time_archived\` integer,
\t\`time_created\` integer NOT NULL,
\t\`time_updated\` integer NOT NULL,
\tCONSTRAINT \`fk_automation_run_automation_id_automation_id_fk\` FOREIGN KEY (\`automation_id\`) REFERENCES \`automation\`(\`id\`) ON DELETE CASCADE,
\tCONSTRAINT \`fk_automation_run_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
\tCONSTRAINT \`fk_automation_run_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
);`)
      yield* tx.run(`CREATE INDEX \`automation_run_automation_idx\` ON \`automation_run\` (\`automation_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`automation_run_project_status_idx\` ON \`automation_run\` (\`project_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`automation_run_project_time_idx\` ON \`automation_run\` (\`project_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`automation_run_directory_time_idx\` ON \`automation_run\` (\`directory\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE TABLE \`automation_finding\` (
\t\`id\` text PRIMARY KEY,
\t\`run_id\` text NOT NULL,
\t\`title\` text NOT NULL,
\t\`severity\` text NOT NULL,
\t\`details\` text NOT NULL,
\t\`files_changed\` text NOT NULL,
\t\`recommended_next_action\` text,
\t\`time_created\` integer NOT NULL,
\t\`time_updated\` integer NOT NULL,
\tCONSTRAINT \`fk_automation_finding_run_id_automation_run_id_fk\` FOREIGN KEY (\`run_id\`) REFERENCES \`automation_run\`(\`id\`) ON DELETE CASCADE
);`)
      yield* tx.run(`CREATE INDEX \`automation_finding_run_idx\` ON \`automation_finding\` (\`run_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
