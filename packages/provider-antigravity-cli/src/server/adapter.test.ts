import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeAntigravityCliAdapterV2 } from "./adapter.ts";
import { parseAgyModels } from "./protocol.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const INSTANCE_ID = ProviderInstanceId.make("antigravityCli");
const THREAD_ID = ThreadId.make("thread-agy-test");
const SESSION_ID = ProviderSessionId.make("provider-session-agy-test");
const UNKNOWN_CONVERSATION = "00000000-0000-4000-8000-000000000000";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const decodeStdinLine = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
    }),
  ),
);

const readFixture = (name: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fileSystem.readFileString(
      yield* path.fromFileUrl(new URL(`./fixtures/${name}`, import.meta.url)),
    );
  });

/** A recorded agy stdout: its `init` line and each turn's lines through `result`. */
function splitTranscript(text: string) {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const init = lines[0]?.includes('"event":"init"') ? lines.shift() : undefined;
  const turns: Array<Array<string>> = [];
  let current: Array<string> = [];
  for (const line of lines) {
    current.push(line);
    if (line.includes('"event":"result"')) {
      turns.push(current);
      current = [];
    }
  }
  const conversationId =
    init === undefined ? undefined : /"conversation_id":"([^"]+)"/.exec(init)?.[1];
  return { init, conversationId, turns };
}

const flagValue = (args: ReadonlyArray<string> | undefined, flag: string) => {
  const index = args?.indexOf(flag) ?? -1;
  return index === -1 ? undefined : args?.[index + 1];
};

interface FakeAgyOptions {
  /** A stopped turn's result waits for the kill, as agy's does. */
  readonly resultOnKill?: boolean;
  /** After reporting a stopped turn, the process exits only on `allowExit`. */
  readonly slowExit?: boolean;
  /** The process exits in place of the turn's result, as a crash would. */
  readonly exitBeforeResult?: boolean;
  /** Every `--conversation` opens a new conversation, as when agy lost its history. */
  readonly forgetConversations?: boolean;
  /** A turn's lines from the first match on wait for `release`. */
  readonly holdFrom?: (line: string) => boolean;
  readonly stderr?: string;
}

/**
 * In-process agy that replays a recorded transcript: `init` at spawn, then one
 * recorded turn per stdin line. An unknown `--conversation` opens a new
 * conversation, as agy does.
 */
const makeFakeAgy = (transcript: string, options: FakeAgyOptions = {}) =>
  Effect.gen(function* () {
    const { init, conversationId, turns } = splitTranscript(transcript);
    const written = yield* Queue.unbounded<string>();
    const exitGate = yield* Deferred.make<void>();
    if (options.slowExit !== true) yield* Deferred.succeed(exitGate, undefined);
    const spawns: Array<ReadonlyArray<string>> = [];
    const stdin: Array<Array<string>> = [];
    let kills = 0;
    let releases = 0;
    let release: Effect.Effect<void> = Effect.void;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const args = ChildProcess.isStandardCommand(command) ? command.args : [];
        spawns.push(args);
        const received: Array<string> = [];
        stdin.push(received);
        yield* Effect.addFinalizer(() => Effect.sync(() => void (releases += 1)));
        const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const write = (line: string) => Queue.offer(stdout, encoder.encode(`${line}\n`));
        const close = Queue.end(stdout).pipe(
          Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(1))),
        );
        let heldResult: string | undefined;
        const play = (lines: ReadonlyArray<string>, mayHold: boolean): Effect.Effect<void> =>
          Effect.gen(function* () {
            for (const [index, line] of lines.entries()) {
              if (mayHold && options.holdFrom?.(line) === true) {
                release = play(lines.slice(index), false);
                return;
              }
              if (!line.includes('"event":"result"')) yield* write(line);
              else if (options.exitBeforeResult === true) yield* close;
              else if (options.resultOnKill === true) heldResult = line;
              else yield* write(line);
            }
          });
        if (init === undefined || conversationId === undefined) {
          yield* play(turns.shift() ?? [], false);
          yield* close;
        } else {
          const requested = flagValue(args, "--conversation");
          const kept =
            requested === undefined ||
            (requested === conversationId && options.forgetConversations !== true);
          yield* write(kept ? init : init.replace(conversationId, UNKNOWN_CONVERSATION));
        }
        let buffered = "";
        const onStdin = (chunk: Uint8Array) =>
          Effect.gen(function* () {
            buffered += decoder.decode(chunk);
            for (;;) {
              const newline = buffered.indexOf("\n");
              if (newline === -1) return;
              const text = decodeStdinLine(buffered.slice(0, newline))
                .message.content.map((block) => block.text)
                .join("");
              received.push(text);
              yield* Queue.offer(written, text);
              buffered = buffered.slice(newline + 1);
              yield* play(turns.shift() ?? [], true);
            }
          });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: Deferred.await(exit),
          isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
          kill: () =>
            Effect.gen(function* () {
              kills += 1;
              if (heldResult !== undefined) yield* write(heldResult);
              heldResult = undefined;
              yield* Deferred.await(exitGate);
              yield* close;
            }),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach(onStdin),
          stdout: Stream.fromQueue(stdout),
          stderr:
            options.stderr === undefined
              ? Stream.empty
              : Stream.succeed(encoder.encode(options.stderr)),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    return {
      spawner,
      spawns,
      stdin,
      /** Each turn message as agy reads it. */
      takeWritten: Queue.take(written),
      conversationId,
      kills: () => kills,
      releases: () => releases,
      allowExit: Deferred.succeed(exitGate, undefined),
      release: Effect.suspend(() => release),
    };
  });

type FakeAgy = Effect.Success<ReturnType<typeof makeFakeAgy>>;

const selection = (model = "default", effort?: string): ModelSelection => ({
  instanceId: INSTANCE_ID,
  model,
  ...(effort === undefined ? {} : { options: [{ id: "effort", value: effort }] }),
});

const policy = (runtimeMode: RuntimeMode = "approval-required", planMode = false) =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: planMode ? "plan" : "default",
    cwd: null,
  });

const makeAdapter = Effect.fnUntraced(function* (fake: FakeAgy) {
  const models = parseAgyModels(yield* readFixture("models.txt"));
  return yield* makeAntigravityCliAdapterV2({
    instanceId: INSTANCE_ID,
    settings: { enabled: true, binaryPath: "/fake/bin/agy", customModels: [] },
    environment: {},
    models: Effect.succeed(models),
    discoverSkills: () =>
      Effect.succeed([
        { name: "herd-review", path: "/skills/herd-review/SKILL.md", enabled: true },
      ]),
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
});

/** Opens a session in `sessionScope` when given; events are read in the caller's scope. */
const openRuntime = Effect.fnUntraced(function* (
  fake: FakeAgy,
  runtimeMode?: RuntimeMode,
  sessionScope?: Scope.Scope,
) {
  const adapter = yield* makeAdapter(fake);
  const open = adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: selection(),
    runtimePolicy: policy(runtimeMode),
  });
  const runtime = yield* sessionScope === undefined ? open : Scope.provide(sessionScope)(open);
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const ended = yield* Deferred.make<void>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.ensuring(Deferred.succeed(ended, undefined)),
    Effect.forkScoped,
  );
  /** Every event up to and including the first that matches. */
  const takeUntil = (match: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Effect.gen(function* () {
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(emitted);
        events.push(event);
        if (match(event)) return events;
      }
    });
  /** The events already emitted, without waiting for more. */
  const pollAll = Effect.gen(function* () {
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    while (true) {
      const next = yield* Queue.poll(emitted);
      if (Option.isNone(next)) return events;
      events.push(next.value);
    }
  });
  const untilTerminal = takeUntil((event) => event.type === "turn.terminal");
  const ensureThread = (runtimePolicy = policy(runtimeMode)) =>
    runtime.ensureThread({ threadId: THREAD_ID, modelSelection: selection(), runtimePolicy });
  return { runtime, takeUntil, pollAll, untilTerminal, ensureThread, ended: Deferred.await(ended) };
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  input: {
    readonly text: string;
    readonly runOrdinal?: number;
    readonly modelSelection?: ModelSelection;
    readonly runtimeMode?: RuntimeMode;
    readonly planMode?: boolean;
  },
) {
  const runOrdinal = input.runOrdinal ?? 1;
  const now = yield* DateTime.now;
  const runId = RunId.make(`run:${THREAD_ID}:${runOrdinal}`);
  const appThread = {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:fixture:agy" as OrchestrationV2AppThread["projectId"],
    title: "agy test thread",
    providerInstanceId: INSTANCE_ID,
    modelSelection: input.modelSelection ?? selection(),
    runtimeMode: input.runtimeMode ?? "approval-required",
    interactionMode: input.planMode === true ? "plan" : "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
  yield* runtime.startTurn({
    appThread,
    threadId: THREAD_ID,
    runId,
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
    rootNodeId: NodeId.make(`node:${runId}:root`),
    providerThread,
    message: {
      messageId: `message:${THREAD_ID}:${runOrdinal}` as never,
      text: input.text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: input.modelSelection ?? selection(),
    runtimePolicy: policy(input.runtimeMode, input.planMode),
  });
});

const turnItems = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
  const latest = new Map<
    string,
    Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>["turnItem"]
  >();
  for (const event of events) {
    if (event.type === "turn_item.updated") latest.set(event.turnItem.id, event.turnItem);
  }
  return [...latest.values()].toSorted((left, right) => left.ordinal - right.ordinal);
};

const terminalOf = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
  const terminal = events.at(-1);
  assert.equal(terminal?.type, "turn.terminal");
  return terminal?.type === "turn.terminal" ? terminal : undefined;
};

const settledUsage = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
  const settled = events.findLast((event) => event.type === "provider_turn.updated");
  return settled?.type === "provider_turn.updated"
    ? settled.providerTurn.turnTokenUsage
    : undefined;
};

describe("AntigravityCliAdapterV2", () => {
  it.effect("keeps one agy process open across turns and reports each turn's usage", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("two-turns.ndjson"));
      const { runtime, untilTerminal, ensureThread } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread();
      assert.equal(providerThread.nativeThreadRef?.nativeId, fake.conversationId);

      yield* startTurn(runtime, providerThread, { text: "Reply with exactly: ok" });
      const first = yield* untilTerminal;
      assert.deepEqual(
        turnItems(first).map((item) =>
          item.type === "assistant_message" ? [item.type, item.text, item.status] : [item.type],
        ),
        [["assistant_message", "ok\n", "completed"]],
      );
      assert.equal(terminalOf(first)?.status, "completed");
      assert.deepInclude(settledUsage(first), {
        usageStatus: "complete",
        inputTokens: 12330,
        outputTokens: 25,
        reasoningTokens: 20,
      });

      yield* startTurn(runtime, providerThread, { text: "Reply with exactly: two", runOrdinal: 2 });
      const second = yield* untilTerminal;
      assert.deepEqual(
        turnItems(second).map((item) =>
          item.type === "assistant_message" ? item.text : item.type,
        ),
        ["two\n"],
      );
      // agy's result reports the whole conversation; the turn counts only its own steps.
      assert.deepInclude(settledUsage(second), {
        inputTokens: 12416,
        cachedInputTokens: 10281,
        outputTokens: 25,
        reasoningTokens: 20,
      });
      assert.equal(fake.spawns.length, 1);
      assert.isUndefined(flagValue(fake.spawns[0], "--conversation"));
      assert.deepEqual(fake.stdin[0], ["Reply with exactly: ok", "Reply with exactly: two"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("sends skill mentions as the leading slash commands agy expands", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("two-turns.ndjson"));
      const { runtime, untilTerminal, ensureThread } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread();
      yield* startTurn(runtime, providerThread, { text: "$herd-review #12" });
      yield* untilTerminal;
      yield* startTurn(runtime, providerThread, {
        text: "Run $herd-review then echo $HOME",
        runOrdinal: 2,
      });
      yield* untilTerminal;
      assert.deepEqual(fake.stdin[0], [
        "/herd-review #12",
        "/herd-review Run /herd-review then echo $HOME",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("shows a denied command and what would allow it", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("denied-command.ndjson"));
      const { runtime, untilTerminal, ensureThread } = yield* openRuntime(fake);
      yield* startTurn(runtime, yield* ensureThread(), { text: "Run ls" });
      const events = yield* untilTerminal;
      const items = turnItems(events);
      const command = items.find((item) => item.type === "command_execution");
      assert.deepInclude(command, { input: "ls", status: "failed", title: "run_command" });
      assert.include(command?.type === "command_execution" ? command.output : "", "user denied");
      const notice = items.find((item) => item.type === "system_notice");
      assert.include(notice?.type === "system_notice" ? notice.message : "", "RunCommand");
      assert.include(notice?.type === "system_notice" ? notice.message : "", "Full access");
      assert.equal(terminalOf(events)?.status, "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("runs full access with agy's skip-permissions flag and shows command output", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("full-access-command.ndjson"));
      const { runtime, untilTerminal, ensureThread } = yield* openRuntime(fake, "full-access");
      yield* startTurn(runtime, yield* ensureThread(), {
        text: "Run ls",
        runtimeMode: "full-access",
      });
      const items = turnItems(yield* untilTerminal);
      assert.deepEqual(
        items.map((item) => item.type),
        ["command_execution", "assistant_message"],
      );
      assert.deepInclude(items[0], { input: "ls", output: "a.txt\r\n", status: "completed" });
      assert.include(fake.spawns[0] ?? [], "--dangerously-skip-permissions");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("restarts agy on the same conversation when the model changes", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("two-turns.ndjson"));
      const { runtime, untilTerminal, ensureThread } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread();
      yield* startTurn(runtime, providerThread, { text: "one" });
      yield* untilTerminal;
      yield* startTurn(runtime, providerThread, {
        text: "two",
        runOrdinal: 2,
        modelSelection: selection("opus-5.5", "max"),
      });
      assert.equal(terminalOf(yield* untilTerminal)?.status, "completed");
      assert.equal(fake.spawns.length, 2);
      assert.equal(fake.releases(), 1);
      assert.equal(flagValue(fake.spawns[1], "--conversation"), fake.conversationId);
      assert.equal(flagValue(fake.spawns[1], "--model"), "opus-5.5");
      assert.equal(flagValue(fake.spawns[1], "--effort"), "max");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("drops agy's skip-permissions flag when a thread leaves full access", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("two-turns.ndjson"));
      const { runtime, untilTerminal, ensureThread } = yield* openRuntime(fake, "full-access");
      const providerThread = yield* ensureThread();
      yield* startTurn(runtime, providerThread, { text: "one", runtimeMode: "full-access" });
      yield* untilTerminal;
      yield* startTurn(runtime, providerThread, { text: "two", runOrdinal: 2 });
      yield* untilTerminal;
      assert.equal(fake.spawns.length, 2);
      assert.include(fake.spawns[0] ?? [], "--dangerously-skip-permissions");
      assert.notInclude(fake.spawns[1] ?? [], "--dangerously-skip-permissions");
      assert.equal(flagValue(fake.spawns[1], "--conversation"), fake.conversationId);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("stops a turn by terminating the agy process it spawned", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("interrupted.ndjson"), {
        resultOnKill: true,
      });
      const { runtime, takeUntil, untilTerminal, ensureThread } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread();
      yield* startTurn(runtime, providerThread, { text: "Count slowly" });
      const started = (yield* takeUntil((event) => event.type === "provider_turn.updated")).at(-1);
      if (started?.type !== "provider_turn.updated") return assert.fail("turn did not start");
      yield* runtime.interruptTurn({ providerThread, providerTurnId: started.providerTurn.id });
      assert.equal(terminalOf(yield* untilTerminal)?.status, "interrupted");
      assert.equal(fake.kills(), 1);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("runs a turn queued behind Stop on a new process", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("interrupted.ndjson"), {
        resultOnKill: true,
        slowExit: true,
      });
      const { runtime, takeUntil, untilTerminal, ensureThread } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread();
      yield* startTurn(runtime, providerThread, { text: "Count slowly" });
      const started = (yield* takeUntil((event) => event.type === "provider_turn.updated")).at(-1);
      if (started?.type !== "provider_turn.updated") return assert.fail("turn did not start");
      const stopping = yield* runtime
        .interruptTurn({ providerThread, providerTurnId: started.providerTurn.id })
        .pipe(Effect.forkScoped);
      // The stopped turn has ended while the old process is still exiting.
      assert.equal(terminalOf(yield* untilTerminal)?.status, "interrupted");
      yield* startTurn(runtime, providerThread, { text: "Continue", runOrdinal: 2 });
      yield* fake.allowExit;
      yield* Fiber.join(stopping);
      assert.equal(yield* fake.takeWritten, "Count slowly");
      assert.equal(yield* fake.takeWritten, "Continue");
      assert.equal(fake.spawns.length, 2);
      assert.equal(flagValue(fake.spawns[1], "--conversation"), fake.conversationId);
      assert.deepEqual(fake.stdin, [["Count slowly"], ["Continue"]]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("fails the turn with agy's error when a turn ends in an error", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("interrupted.ndjson"));
      const { runtime, untilTerminal, ensureThread } = yield* openRuntime(fake);
      yield* startTurn(runtime, yield* ensureThread(), { text: "Count slowly" });
      const terminal = terminalOf(yield* untilTerminal);
      assert.equal(terminal?.status, "failed");
      assert.equal(terminal?.failure?.message, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("fails the turn with agy's output when it exits before reporting a result", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("full-access-command.ndjson"), {
        exitBeforeResult: true,
        stderr: "error: connection reset\n",
      });
      const { runtime, untilTerminal, ensureThread } = yield* openRuntime(fake);
      yield* startTurn(runtime, yield* ensureThread(), { text: "Run ls" });
      const events = yield* untilTerminal;
      assert.equal(terminalOf(events)?.status, "failed");
      assert.equal(
        terminalOf(events)?.failure?.message,
        "agy exited before the turn finished (exit code 1): error: connection reset",
      );
      assert.isTrue(turnItems(events).every((item) => item.status !== "running"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("shows agy's own error when it exits before opening a conversation", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy("", {
        stderr: "flags provided but not defined: -bogus\nUsage of agy:\n",
      });
      const { ensureThread } = yield* openRuntime(fake);
      const error = yield* ensureThread().pipe(Effect.flip);
      assert.include(String(error.cause), "flags provided but not defined: -bogus");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("cancels the running turn and releases agy when the session closes", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("interrupted.ndjson"), {
        resultOnKill: true,
      });
      const sessionScope = yield* Scope.make();
      const { runtime, takeUntil, untilTerminal, ensureThread } = yield* openRuntime(
        fake,
        "approval-required",
        sessionScope,
      );
      yield* startTurn(runtime, yield* ensureThread(), { text: "Count slowly" });
      yield* takeUntil((event) => event.type === "provider_turn.updated");
      yield* Scope.close(sessionScope, Exit.void);
      assert.equal(terminalOf(yield* untilTerminal)?.status, "cancelled");
      assert.equal(fake.releases(), fake.spawns.length);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("fails the thread with a sign-in hint when agy is signed out", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("signed-out.ndjson"));
      const { ensureThread } = yield* openRuntime(fake);
      const error = yield* ensureThread().pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterEnsureThreadError");
      assert.include(String(error.cause), "Run `agy` in a terminal");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("refuses to resume or attach a conversation agy no longer has", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("two-turns.ndjson"), {
        forgetConversations: true,
      });
      const providerThread = yield* (yield* openRuntime(fake)).ensureThread();
      // A new session has no agy process on the conversation yet.
      const { runtime } = yield* openRuntime(fake);
      const resumeError = yield* runtime.resumeThread({ providerThread }).pipe(Effect.flip);
      assert.equal(resumeError._tag, "ProviderAdapterResumeThreadError");
      const ensureError = yield* runtime
        .ensureThread({
          threadId: THREAD_ID,
          modelSelection: selection(),
          runtimePolicy: policy(),
          existingProviderThread: providerThread,
        })
        .pipe(Effect.flip);
      assert.equal(ensureError._tag, "ProviderAdapterEnsureThreadError");
      // Both refused processes are gone; the first session still holds its own.
      assert.equal(fake.spawns.length, 3);
      assert.equal(fake.releases(), 2);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("ends the session when a restart cannot reopen the thread's conversation", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("two-turns.ndjson"), {
        forgetConversations: true,
      });
      const { runtime, takeUntil, untilTerminal, ensureThread, ended } = yield* openRuntime(fake);
      const providerThread = yield* ensureThread();
      yield* startTurn(runtime, providerThread, { text: "one" });
      yield* untilTerminal;
      const error = yield* startTurn(runtime, providerThread, {
        text: "two",
        runOrdinal: 2,
        modelSelection: selection("opus-5.5"),
      }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterTurnStartError");
      yield* takeUntil(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "stopped",
      );
      yield* ended;
      assert.equal(fake.releases(), fake.spawns.length);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("refuses Plan mode", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("two-turns.ndjson"));
      const adapter = yield* makeAdapter(fake);
      const openError = yield* adapter
        .openSession({
          threadId: THREAD_ID,
          providerSessionId: SESSION_ID,
          modelSelection: selection(),
          runtimePolicy: policy("approval-required", true),
        })
        .pipe(Effect.flip);
      assert.include(String(openError), "does not support Plan mode");

      const { runtime, ensureThread } = yield* openRuntime(fake);
      const ensureError = yield* ensureThread(policy("approval-required", true)).pipe(Effect.flip);
      assert.include(String(ensureError.cause), "does not support Plan mode");
      const turnError = yield* startTurn(runtime, yield* ensureThread(), {
        text: "Plan it",
        planMode: true,
      }).pipe(Effect.flip);
      assert.include(String(turnError.cause), "does not support Plan mode");
      assert.deepEqual(fake.stdin, [[]]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("publishes streaming text every 50 ms and nothing after the turn ends", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("full-access-command.ndjson"), {
        holdFrom: (line) => line.includes('"text_delta":".txt](file:/"'),
      });
      const { runtime, pollAll, untilTerminal, ensureThread } = yield* openRuntime(fake);
      yield* startTurn(runtime, yield* ensureThread(), { text: "Run ls" });
      let streamed: string | undefined;
      for (let attempt = 0; attempt < 20 && streamed === undefined; attempt++) {
        yield* TestClock.adjust("50 millis");
        for (const event of yield* pollAll) {
          if (event.type === "message.updated" && event.message.streaming) {
            streamed = event.message.text;
          }
        }
      }
      assert.equal(streamed, "The output of `ls` is [a");

      yield* fake.release;
      const rest = yield* untilTerminal;
      const final = rest.findLast((event) => event.type === "message.updated");
      assert.deepInclude(final?.type === "message.updated" ? final.message : undefined, {
        streaming: false,
        text: "The output of `ls` is [a.txt](file:///tmp/agy-probe/ws/a.txt).\n",
      });
      yield* TestClock.adjust("100 millis");
      assert.deepEqual(yield* pollAll, []);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
