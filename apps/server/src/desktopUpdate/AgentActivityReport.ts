import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { readOnEvents, RUN_EVENTS, withReleaseGrace } from "../background/KeepAwake.ts";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import { forkParked } from "../serverActivation.ts";

const ACTIVITY_EVENTS: ReadonlySet<string> = new Set([
  ...RUN_EVENTS,
  "provider-thread.updated",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
]);

/**
 * A queued run counts only where it could start: an unheld queue on a live thread whose last run
 * did not fail, since a failure such as a usage limit holds the queue for the user. Background work
 * counts when it holds its run's completion, as in `backgroundWorkHoldsCompletion`.
 */
export const hasUnfinishedWork = (sql: SqlClient.SqlClient) =>
  sql<{ readonly busy: number }>`
    -- CASE stops at the indexed run check; the roster check parses every provider thread.
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs AS run
      WHERE run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
        AND (run.status <> 'queued' OR (
          CASE WHEN json_valid(run.payload_json)
            THEN json_extract(run.payload_json, '$.queueHeld') IS NOT 1 ELSE 1 END
          AND EXISTS (
            SELECT 1 FROM orchestration_v2_projection_threads AS thread
            WHERE thread.thread_id = run.thread_id
              AND thread.archived_at IS NULL AND thread.deleted_at IS NULL
          )
          AND (
            SELECT latest.status FROM orchestration_v2_projection_runs AS latest
            WHERE latest.thread_id = run.thread_id AND latest.status <> 'queued'
              AND NOT (latest.status = 'cancelled' AND CASE WHEN json_valid(latest.payload_json)
                THEN json_type(latest.payload_json, '$.startedAt') IS NOT 'text' ELSE 0 END)
            ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC, latest.ordinal DESC
            LIMIT 1
          ) IS NOT 'failed'
        ))
    ) THEN 1 WHEN EXISTS (
      SELECT 1 FROM orchestration_v2_projection_provider_threads AS provider_thread,
        json_each(
          CASE WHEN json_valid(provider_thread.payload_json)
            THEN provider_thread.payload_json ELSE '{}' END,
          '$.pendingBackgroundTasks'
        ) AS task
      WHERE json_extract(task.value, '$.awaited') IS 1
        OR json_extract(task.value, '$.kind') NOT IN ('command', 'monitor')
    ) THEN 1 ELSE 0 END AS busy
  `.pipe(Effect.map((rows) => rows[0]?.busy === 1));

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (config.desktopTelemetryControlFd === undefined) return;
    const receiver = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const sql = yield* SqlClient.SqlClient;

    yield* forkParked(
      withReleaseGrace(
        readOnEvents(events, ACTIVITY_EVENTS, hasUnfinishedWork(sql), "agent activity"),
      ).pipe(
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
