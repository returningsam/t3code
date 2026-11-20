import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as AgentActivityReport from "./AgentActivityReport.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("AgentActivityReport.hasUnfinishedRun", (it) => {
  it.effect("counts working, waiting and startable queued runs", () =>
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
      const busyWith = (status: string, payload = "{}", threadId = "live") =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM orchestration_v2_projection_runs`;
          yield* sql`
            INSERT INTO orchestration_v2_projection_runs
              (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
            VALUES ('run', ${threadId}, 1, 'codex', ${status}, '2026-01-01', ${payload})
          `;
          return yield* AgentActivityReport.hasUnfinishedRun(sql);
        });

      for (const status of ["preparing", "starting", "running", "waiting", "queued"]) {
        assert.isTrue(yield* busyWith(status), status);
      }
      for (const status of ["completed", "interrupted", "failed", "cancelled", "rolled_back"]) {
        assert.isFalse(yield* busyWith(status), status);
      }
      assert.isFalse(yield* busyWith("queued", '{"queueHeld":true}'), "held queue");
      assert.isFalse(yield* busyWith("queued", "{}", "archived"), "archived thread");
    }),
  );
});
