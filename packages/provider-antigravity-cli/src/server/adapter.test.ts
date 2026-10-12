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
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
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

const flagValue = (args: ReadonlyArray<string>, flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

/**
 * In-process agy that replays a recorded transcript: `init` at spawn, then one
 * recorded turn per stdin line. An unknown `--conversation` opens a new
 * conversation, as agy does. With `resultOnKill`, a turn's result waits for
 * the process to be killed, as a stopped turn's does. With `exitBeforeResult`,
 * the process exits in place of the result, as a crash would.
 */
const makeFakeAgy = (
  transcript: string,
  options: { readonly resultOnKill?: boolean; readonly exitBeforeResult?: boolean } = {},
) =>
  Effect.sync(() => {
    const { init, conversationId, turns } = splitTranscript(transcript);
    const spawns: Array<ReadonlyArray<string>> = [];
    const messages: Array<string> = [];
    let kills = 0;
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const args = ChildProcess.isStandardCommand(command) ? command.args : [];
        spawns.push(args);
        const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const write = (line: string) => Queue.offer(stdout, encoder.encode(`${line}\n`));
        const close = Queue.end(stdout).pipe(
          Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(1))),
        );
        let held: string | undefined;
        if (init === undefined || conversationId === undefined) {
          for (const line of turns.shift() ?? []) yield* write(line);
          yield* close;
        } else {
          const requested = flagValue(args, "--conversation");
          yield* write(
            requested === undefined || requested === conversationId
              ? init
              : init.replace(conversationId, UNKNOWN_CONVERSATION),
          );
        }
        let buffered = "";
        const onStdin = (chunk: Uint8Array) =>
          Effect.gen(function* () {
            buffered += decoder.decode(chunk);
            for (;;) {
              const newline = buffered.indexOf("\n");
              if (newline === -1) return;
              messages.push(buffered.slice(0, newline));
              buffered = buffered.slice(newline + 1);
              for (const line of turns.shift() ?? []) {
                if (!line.includes('"event":"result"')) yield* write(line);
                else if (options.exitBeforeResult === true) yield* close;
                else if (options.resultOnKill === true) held = line;
                else yield* write(line);
              }
            }
          });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: Deferred.await(exit),
          isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
          kill: () =>
            Effect.gen(function* () {
              kills += 1;
              if (held !== undefined) yield* write(held);
              held = undefined;
              yield* close;
            }),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach(onStdin),
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    return { spawner, spawns, messages, conversationId, kills: () => kills };
  });

type FakeAgy = Effect.Success<ReturnType<typeof makeFakeAgy>>;

const selection = (model = "default", effort?: string): ModelSelection => ({
  instanceId: INSTANCE_ID,
  model,
  ...(effort === undefined ? {} : { options: [{ id: "effort", value: effort }] }),
});

const policy = (runtimeMode: RuntimeMode = "approval-required") =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
  });

/** Opens a session in `sessionScope` when given; events are read in the caller's scope. */
const openRuntime = Effect.fnUntraced(function* (
  fake: FakeAgy,
  runtimeMode?: RuntimeMode,
  sessionScope?: Scope.Scope,
) {
  const models = parseAgyModels(yield* readFixture("models.txt"));
  const adapter = yield* makeAntigravityCliAdapterV2({
    instanceId: INSTANCE_ID,
    settings: { enabled: true, binaryPath: "/fake/bin/agy", customModels: [] },
    environment: {},
    models: Effect.succeed(models),
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));
  const open = adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: selection(),
    runtimePolicy: policy(runtimeMode),
  });
  const runtime = yield* sessionScope === undefined ? open : Scope.provide(sessionScope)(open);
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
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
  const untilTerminal = takeUntil((event) => event.type === "turn.terminal");
  return { runtime, takeUntil, untilTerminal };
});

const startTurn = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  input: {
    readonly text: string;
    readonly runOrdinal?: number;
    readonly modelSelection?: ModelSelection;
    readonly runtimeMode?: RuntimeMode;
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
    interactionMode: "default",
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
  const turnInput: ProviderAdapter.ProviderAdapterV2TurnInput = {
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
    runtimePolicy: policy(input.runtimeMode),
  };
  yield* runtime.startTurn(turnInput);
  return turnInput;
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

describe("AntigravityCliAdapterV2", () => {
  it.effect("keeps one agy process open across turns and maps responses and usage", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("two-turns.ndjson"));
      const { runtime, untilTerminal } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: selection(),
        runtimePolicy: policy(),
      });
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
      const settled = first.findLast((event) => event.type === "provider_turn.updated");
      assert.deepInclude(
        settled?.type === "provider_turn.updated" ? settled.providerTurn.turnTokenUsage : undefined,
        { usageStatus: "complete", inputTokens: 12330, outputTokens: 25, reasoningTokens: 20 },
      );

      yield* startTurn(runtime, providerThread, { text: "Reply with exactly: two", runOrdinal: 2 });
      const second = yield* untilTerminal;
      assert.deepEqual(
        turnItems(second).map((item) =>
          item.type === "assistant_message" ? item.text : item.type,
        ),
        ["two\n"],
      );
      assert.equal(fake.spawns.length, 1);
      assert.deepEqual(fake.spawns[0], [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "-p=",
      ]);
      assert.deepEqual(fake.messages, [
        '{"event":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: ok"}]}}',
        '{"event":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: two"}]}}',
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("shows a denied command and what would allow it", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("denied-command.ndjson"));
      const { runtime, untilTerminal } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: selection(),
        runtimePolicy: policy(),
      });
      yield* startTurn(runtime, providerThread, { text: "Run ls" });
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
      const { runtime, untilTerminal } = yield* openRuntime(fake, "full-access");
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: selection(),
        runtimePolicy: policy("full-access"),
      });
      yield* startTurn(runtime, providerThread, { text: "Run ls", runtimeMode: "full-access" });
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
      const { runtime, untilTerminal } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: selection(),
        runtimePolicy: policy(),
      });
      yield* startTurn(runtime, providerThread, { text: "one" });
      yield* untilTerminal;
      yield* startTurn(runtime, providerThread, {
        text: "two",
        runOrdinal: 2,
        modelSelection: selection("opus-5.5", "max"),
      });
      assert.equal(terminalOf(yield* untilTerminal)?.status, "completed");
      assert.equal(fake.spawns.length, 2);
      assert.deepEqual(fake.spawns[1], [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--conversation",
        fake.conversationId ?? "",
        "--model",
        "opus-5.5",
        "--effort",
        "max",
        "-p=",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("stops a turn by terminating the agy process it spawned", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("interrupted.ndjson"), {
        resultOnKill: true,
      });
      const { runtime, takeUntil, untilTerminal } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: selection(),
        runtimePolicy: policy(),
      });
      yield* startTurn(runtime, providerThread, { text: "Count slowly" });
      const started = (yield* takeUntil((event) => event.type === "provider_turn.updated")).at(-1);
      if (started?.type !== "provider_turn.updated") return assert.fail("turn did not start");
      yield* runtime.interruptTurn({ providerThread, providerTurnId: started.providerTurn.id });
      assert.equal(terminalOf(yield* untilTerminal)?.status, "interrupted");
      assert.equal(fake.kills(), 1);

      yield* startTurn(runtime, providerThread, { text: "Continue", runOrdinal: 2 });
      assert.deepEqual(fake.spawns[1]?.slice(4, 6), ["--conversation", fake.conversationId]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("fails the turn with agy's error when a turn ends in an error", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("interrupted.ndjson"));
      const { runtime, untilTerminal } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: selection(),
        runtimePolicy: policy(),
      });
      yield* startTurn(runtime, providerThread, { text: "Count slowly" });
      const terminal = terminalOf(yield* untilTerminal);
      assert.equal(terminal?.status, "failed");
      assert.equal(terminal?.failure?.message, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("fails the turn when agy exits before reporting a result", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("full-access-command.ndjson"), {
        exitBeforeResult: true,
      });
      const { runtime, untilTerminal } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: selection(),
        runtimePolicy: policy(),
      });
      yield* startTurn(runtime, providerThread, { text: "Run ls" });
      const events = yield* untilTerminal;
      assert.equal(terminalOf(events)?.status, "failed");
      assert.equal(
        terminalOf(events)?.failure?.message,
        "agy exited before the turn finished (exit code 1).",
      );
      assert.isTrue(turnItems(events).every((item) => item.status !== "running"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("cancels the running turn when the session closes", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("interrupted.ndjson"), {
        resultOnKill: true,
      });
      const sessionScope = yield* Scope.make();
      const { runtime, takeUntil, untilTerminal } = yield* openRuntime(
        fake,
        "approval-required",
        sessionScope,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: selection(),
        runtimePolicy: policy(),
      });
      yield* startTurn(runtime, providerThread, { text: "Count slowly" });
      yield* takeUntil((event) => event.type === "provider_turn.updated");
      yield* Scope.close(sessionScope, Exit.void);
      assert.equal(terminalOf(yield* untilTerminal)?.status, "cancelled");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("fails the thread with a sign-in hint when agy is signed out", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("signed-out.ndjson"));
      const { runtime } = yield* openRuntime(fake);
      const error = yield* runtime
        .ensureThread({ threadId: THREAD_ID, modelSelection: selection(), runtimePolicy: policy() })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterEnsureThreadError");
      assert.include(String(error.cause), "Run `agy` in a terminal");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("refuses to resume a conversation agy no longer has", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeAgy(yield* readFixture("two-turns.ndjson"));
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: selection(),
        runtimePolicy: policy(),
      });
      const error = yield* runtime
        .resumeThread({
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver: providerThread.driver,
              nativeId: "lost-conversation",
              strength: "strong",
            },
          },
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterResumeThreadError");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
