import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { readOnRunChanges, withReleaseGrace } from "../background/KeepAwake.ts";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import { forkParked } from "../serverActivation.ts";

/** A queued run counts only where it could start: an unheld queue on a live thread. */
export const hasUnfinishedRun = (sql: SqlClient.SqlClient) =>
  sql<{ readonly busy: number }>`
    SELECT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs AS run
      WHERE run.status IN ('preparing', 'starting', 'running', 'waiting')
        OR (run.status = 'queued'
          AND json_extract(run.payload_json, '$.queueHeld') IS NOT 1
          AND EXISTS (SELECT 1 FROM orchestration_v2_projection_threads AS thread
            WHERE thread.thread_id = run.thread_id
              AND thread.archived_at IS NULL AND thread.deleted_at IS NULL))
    ) AS busy
  `.pipe(Effect.map((rows) => rows[0]?.busy === 1));

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (config.desktopTelemetryControlFd === undefined) return;
    const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;

    yield* forkParked(
      withReleaseGrace(readOnRunChanges(events, hasUnfinishedRun(sql), "agent activity")).pipe(
        Stream.runForEach((busy) =>
          receiver.reportAgentActivity(busy).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to report agent activity to the desktop app", {
                error: error.message,
              }),
            ),
          ),
        ),
        Effect.catchCause((cause) => Effect.logWarning("agent activity report stopped", { cause })),
      ),
    );
  }),
);
