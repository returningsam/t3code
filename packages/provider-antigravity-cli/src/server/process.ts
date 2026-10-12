/**
 * One running `agy` print-mode process: stdout parsed into events, a stdin
 * writer for turns, and termination through the spawned handle.
 *
 * @module provider-antigravity-cli/server/process
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isCommandAvailable, resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
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

/**
 * The command to run for `binaryPath`. agy installs to `~/.local/bin`, which
 * a desktop-launched server often lacks on PATH, so the default `agy` falls
 * back to that location.
 */
export const resolveAgyCommand = Effect.fn("resolveAgyCommand")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
) {
  if (binaryPath !== "agy" || (yield* isCommandAvailable(binaryPath, { env: environment }))) {
    return binaryPath;
  }
  const path = yield* Path.Path;
  const installed = path.join(yield* HostProcess.HomeDirectory, ".local", "bin", "agy");
  return (yield* isCommandAvailable(installed, { env: environment })) ? installed : binaryPath;
});

export interface AgyProcess {
  /** Stdout events in arrival order. Ends when stdout closes. */
  readonly events: Queue.Dequeue<AgyEvent, Cause.Done>;
  /** Starts a turn. */
  readonly send: (text: string) => Effect.Effect<void>;
  /** The exit code, or `null` when a signal ended the process. */
  readonly exitCode: Effect.Effect<number | null>;
  /** Terminates the process group this handle spawned. */
  readonly kill: Effect.Effect<void>;
}

const TERMINATION_GRACE = "2 seconds";

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

  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => {
      const event = parseAgyEvent(line);
      return event === undefined ? Effect.void : Queue.offer(events, event);
    }),
    Effect.ignore,
    Effect.ensuring(Queue.end(events)),
    Effect.forkScoped,
  );
  // agy prints diagnostics to stderr. They can carry prompt text, so only
  // their size is logged.
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Effect.logDebug("agy stderr", { stderrLength: chunk.length })),
    Effect.ignore,
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
  } satisfies AgyProcess;
});
