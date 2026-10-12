/**
 * One running `agy` print-mode process: stdout parsed into events, a stdin
 * writer for turns, and termination through the spawned handle.
 *
 * @module provider-antigravity-cli/server/process
 */
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { agyUserMessageLine, parseAgyEvent, type AgyEvent } from "./protocol.ts";

export class AgyProcessError extends Schema.TaggedError<AgyProcessError>()("AgyProcessError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `agy ${this.operation} failed.`;
  }
}

export interface AgyProcess {
  /** Stdout events in arrival order. Ends when stdout closes. */
  readonly events: Queue.Dequeue<AgyEvent, Cause.Done>;
  /** Starts a turn. */
  readonly send: (text: string) => Effect.Effect<void>;
  /** The exit code, or `null` when a signal ended the process. */
  readonly exitCode: Effect.Effect<number | null>;
  /** Terminates the process group this handle spawned. */
  readonly kill: Effect.Effect<void>;
  /**
   * The end of agy's plain-text output (stderr and non-event stdout lines),
   * which holds its reason for a failed launch. It can quote the prompt, so it
   * goes into the user's failure message and never into logs.
   */
  readonly diagnostics: Effect.Effect<string>;
}

const TERMINATION_GRACE = "2 seconds";
const DIAGNOSTICS_MAX_CHARS = 2_000;

/** Spawns agy in the current scope; closing the scope terminates it. */
export const spawnAgy = Effect.fnUntraced(function* (options: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const spawnCommand = yield* resolveSpawnCommand(options.command, options.args, {
    env: options.env,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: options.cwd,
        env: options.env,
        extendEnv: false,
        shell: spawnCommand.shell,
        forceKillAfter: TERMINATION_GRACE,
      }),
    )
    .pipe(Effect.mapError((cause) => new AgyProcessError({ operation: "spawn", cause })));

  const events = yield* Queue.unbounded<AgyEvent, Cause.Done>();
  const outgoing = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  let diagnostics = "";
  const keepDiagnostics = (text: string) => {
    diagnostics = `${diagnostics}${text}`.slice(-DIAGNOSTICS_MAX_CHARS);
  };

  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      const event = parseAgyEvent(line);
      if (event !== undefined) return Queue.offer(events, event);
      if (line.trim().length > 0) keepDiagnostics(`${line}\n`);
      return Effect.void;
    }),
    Effect.ignore,
    Effect.ensuring(Queue.end(events)),
    Effect.forkScoped,
  );
  const stderrDone = yield* Deferred.make<void>();
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Effect.sync(() => keepDiagnostics(chunk))),
    Effect.ignore,
    Effect.ensuring(Deferred.succeed(stderrDone, undefined)),
    Effect.forkScoped,
  );
  yield* Stream.fromQueue(outgoing).pipe(Stream.run(child.stdin), Effect.ignore, Effect.forkScoped);

  return {
    events,
    send: (text) =>
      Queue.offer(outgoing, new TextEncoder().encode(agyUserMessageLine(text))).pipe(Effect.asVoid),
    exitCode: child.exitCode.pipe(
      Effect.map((code): number | null => Number(code)),
      Effect.orElseSucceed(() => null),
    ),
    kill: child.kill({ forceKillAfter: TERMINATION_GRACE }).pipe(Effect.ignore),
    diagnostics: Deferred.await(stderrDone).pipe(
      Effect.timeoutOption("1 second"),
      Effect.map(() => diagnostics.trim()),
    ),
  } satisfies AgyProcess;
});
