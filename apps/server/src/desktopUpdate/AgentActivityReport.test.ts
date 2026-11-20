import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as AgentActivityReport from "./AgentActivityReport.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

interface RunRow {
  readonly status: string;
  readonly payload?: string;
  readonly threadId?: string;
  readonly completedAt?: string;
}

layer("AgentActivityReport.hasUnfinishedWork", (it) => {
  it.effect("counts working, waiting, startable queued runs and held background work", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
           created_at, updated_at, archived_at, payload_json)
        VALUES
          ('live', 'project', 'Live', 'codex', 'full-access', 'default', '2026-01-01', '2026-01-01', NULL, '{}'),
          ('archived', 'project', 'Archived', 'codex', 'full-access', 'default', '2026-01-01', '2026-01-01', '2026-01-02', '{}')
      `;
      const busyWith = (runs: ReadonlyArray<RunRow>, pendingBackgroundTasks: unknown[] = []) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
          for (const [ordinal, run] of runs.entries()) {
            yield* sql`
              INSERT INTO orchestration_v2_projection_runs
                (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
              VALUES (${`run-${ordinal}`}, ${run.threadId ?? "live"}, ${ordinal}, 'codex', ${run.status},
                '2026-01-01', ${run.completedAt ?? null}, ${run.payload ?? "{}"})
            `;
          }
          yield* sql`
            INSERT INTO orchestration_v2_projection_provider_threads
              (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
            VALUES ('provider-thread', 'live', 'codex', 'active', '2026-01-01',
              ${JSON.stringify({ pendingBackgroundTasks })})
          `;
          return yield* AgentActivityReport.hasUnfinishedWork(sql);
        });

      for (const status of ["preparing", "starting", "running", "waiting", "queued"]) {
        assert.isTrue(yield* busyWith([{ status }]), status);
      }
      for (const status of ["completed", "interrupted", "failed", "cancelled", "rolled_back"]) {
        assert.isFalse(yield* busyWith([{ status }]), status);
      }
      assert.isFalse(yield* busyWith([{ status: "queued", payload: '{"queueHeld":true}' }]));
      assert.isFalse(yield* busyWith([{ status: "queued", threadId: "archived" }]));
      const failed = { status: "failed", completedAt: "2026-01-01T00:00:00Z" };
      assert.isFalse(yield* busyWith([failed, { status: "queued" }]), "queue behind a failure");
      assert.isFalse(
        yield* busyWith([failed, { status: "cancelled" }, { status: "queued" }]),
        "a cancel that never started is not the last run",
      );
      assert.isTrue(
        yield* busyWith([{ ...failed, status: "completed" }, { status: "queued" }]),
        "queue behind a completed run",
      );

      const task = (kind: string, awaited?: true) => ({ taskId: kind, kind, awaited });
      for (const kind of ["subagent", "background_task"]) {
        assert.isTrue(yield* busyWith([{ status: "completed" }], [task(kind)]), kind);
      }
      for (const kind of ["command", "monitor"]) {
        assert.isFalse(yield* busyWith([{ status: "completed" }], [task(kind)]), kind);
        assert.isTrue(
          yield* busyWith([{ status: "completed" }], [task(kind, true)]),
          `awaited ${kind}`,
        );
      }
    }),
  );
});
