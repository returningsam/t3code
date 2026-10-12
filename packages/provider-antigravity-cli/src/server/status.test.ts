import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { checkAntigravityCliStatus } from "./status.ts";

const encoder = new TextEncoder();

const settings = { enabled: true, binaryPath: "/fake/bin/agy", customModels: [] };

const readFixture = (name: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fileSystem.readFileString(
      yield* path.fromFileUrl(new URL(`./fixtures/${name}`, import.meta.url)),
    );
  });

const handle = (output: { stdout?: string; stderr?: string; exitCode?: number }) => {
  const bytes = (value: string | undefined) =>
    value === undefined ? Stream.empty : Stream.succeed(encoder.encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(999_999_998),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(output.stdout),
    stderr: bytes(output.stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
};

/** Answers `agy --version` and `agy models` with recorded output. */
const agySpawner = (models: { stdout?: string; stderr?: string; exitCode?: number }) =>
  ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    return Effect.succeed(
      args.includes("--version") ? handle({ stdout: "1.3.3\n" }) : handle(models),
    );
  });

const check = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  checkAntigravityCliStatus(settings, {}).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );

describe("checkAntigravityCliStatus", () => {
  it.effect("reports a signed-in agy with its models", () =>
    Effect.gen(function* () {
      const snapshot = yield* check(agySpawner({ stdout: yield* readFixture("models.txt") }));
      assert.deepInclude(snapshot, {
        status: "ready",
        installed: true,
        version: "1.3.3",
        supportsTextGeneration: false,
      });
      assert.equal(snapshot.auth.status, "authenticated");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default", "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-high", "opus-5.5"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([0, 1])("tells the user to sign in with agy itself (exit code %s)", (exitCode) =>
    Effect.gen(function* () {
      const snapshot = yield* check(
        agySpawner({
          stderr:
            "Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n",
          exitCode,
        }),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.include(snapshot.message ?? "", "Run `agy` in a terminal");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves sign-in unknown when agy lists no models", () =>
    Effect.gen(function* () {
      const snapshot = yield* check(agySpawner({ stdout: "" }));
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports agy as not installed when it cannot be spawned", () =>
    Effect.gen(function* () {
      const snapshot = yield* check(
        ChildProcessSpawner.make(() =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "spawn agy ENOENT",
            }),
          ),
        ),
      );
      assert.equal(snapshot.installed, false);
      assert.include(snapshot.message ?? "", "not installed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
