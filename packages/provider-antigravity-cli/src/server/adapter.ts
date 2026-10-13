/**
 * AntigravityCliAdapterV2 drives the user's `agy` binary in print mode.
 *
 * A session keeps one agy process open on its conversation and writes one
 * stdin line per turn. The `init` conversation ID is the thread's resume
 * handle. A process is fixed to the model, effort, and permission flags it was
 * launched with, so a turn that needs different ones restarts it on the same
 * conversation with `--conversation`. Stop terminates the process; the next
 * turn resumes the conversation.
 *
 * Print mode cannot ask for approval: agy denies actions its own rules do not
 * allow and lists them on the turn's result, which becomes a notice.
 *
 * @module provider-antigravity-cli/server/adapter
 */
import {
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type OrchestrationV2TurnItemStatus,
  type ProviderInstanceId,
  type ServerProviderModel,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import type { AntigravityCliSettings } from "../settings.ts";
import { spawnAgy, type AgyProcess } from "./process.ts";
import {
  AGY_SIGNED_OUT_MESSAGE,
  agyDeniedActionsNotice,
  agyLaunchArgs,
  agyLaunchKey,
  isAgySignedOutOutput,
  resolveAgyLaunch,
  type AgyEvent,
  type AgyLaunch,
  type AgyResult,
  type AgyStepUpdate,
} from "./protocol.ts";
import { rewriteAgySkillMentions } from "./skills.ts";

export const ANTIGRAVITY_CLI_PROVIDER = ProviderDriverKind.make("antigravityCli");
const DRIVER = ANTIGRAVITY_CLI_PROVIDER;

const STREAM_FLUSH_MS = 50;
const START_TIMEOUT = "60 seconds";
const STOP_TIMEOUT = "5 seconds";

const AntigravityCliCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    // A model change restarts agy on the same conversation at the next turn.
    supportsModelSwitchInSession: true,
    // A permission change reopens the session, which stops an unrestricted agy mid-turn.
    supportsRuntimeModeSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface AntigravityCliAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly settings: AntigravityCliSettings;
  readonly environment: NodeJS.ProcessEnv;
  /** The provider's current models, which carry each model's default effort. */
  readonly models: Effect.Effect<ReadonlyArray<ServerProviderModel>>;
  /** Re-read on every send, since skills change mid-session. */
  readonly discoverSkills: (cwd: string) => Effect.Effect<ReadonlyArray<ServerProviderSkill>>;
}

interface LiveProcess {
  readonly scope: Scope.Closeable;
  readonly agy: AgyProcess;
  readonly launch: AgyLaunch;
  readonly conversationId: string;
}

/** One agy step shown as a turn item: an assistant response or a tool call. */
interface StepItem {
  readonly nativeItemId: string;
  readonly kind: "assistant" | "tool";
  readonly startedAt: DateTime.Utc;
  status: OrchestrationV2TurnItemStatus;
  text: string;
  toolName: string;
  parameters: unknown;
  output: string | undefined;
  flushScheduled: boolean;
}

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly process: LiveProcess;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly steps: Map<number, StepItem>;
  readonly ordinals: Map<string, number>;
  nextOrdinal: number;
  usage: { input: number; cached: number; output: number; reasoning: number } | undefined;
  interruptRequested: boolean;
  readonly done: Deferred.Deferred<void>;
}

const nativeRef = (nativeId: string, strength: "strong" | "weak" = "strong") => ({
  driver: DRIVER,
  nativeId,
  strength,
});

const agyFailureText = (error: string | undefined) =>
  error === undefined || error.trim().length === 0
    ? "agy reported an error."
    : isAgySignedOutOutput(error)
      ? AGY_SIGNED_OUT_MESSAGE
      : error.trim();

export const makeAntigravityCliAdapterV2 = Effect.fn("makeAntigravityCliAdapterV2")(function* (
  options: AntigravityCliAdapterOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const host = yield* ProviderHost.ProviderHost;
  const agentScope = yield* AgentScope;

  const protocolError = (detail: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({ driver: DRIVER, detail });
  const refusePlanMode = (policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy | undefined) =>
    policy?.interactionMode === "plan"
      ? Effect.fail(protocolError("Antigravity CLI does not support Plan mode"))
      : Effect.void;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: DRIVER,
    getCapabilities: () => Effect.succeed(AntigravityCliCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("AntigravityCliAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      if (!options.settings.enabled) return yield* protocolError("Antigravity CLI is disabled");
      yield* refusePlanMode(input.runtimePolicy);
      // Holds agy processes and their readers. The session finalizer below is
      // added later, so it settles the active turn before this scope closes.
      const workScope = yield* Scope.fork(yield* Effect.scope);
      const cwd = input.runtimePolicy.cwd ?? host.paths.cwd;
      const openedAt = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: DRIVER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd,
        model: input.modelSelection.model,
        capabilities: AntigravityCliCapabilitiesV2,
        createdAt: openedAt,
        updatedAt: openedAt,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      // Serializes agy events, turn lifecycle, and process replacement.
      const permit = yield* Semaphore.make(1);
      let thread: OrchestrationV2ProviderThread | undefined;
      let live: LiveProcess | undefined;
      let active: ActiveTurn | undefined;
      let closed = false;

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_session.updated", driver: DRIVER, providerSession: session });
      });

      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (thread === undefined) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({ type: "provider_thread.updated", driver: DRIVER, providerThread: thread });
      });

      const ordinalFor = (turn: ActiveTurn, nativeItemId: string) => {
        const existing = turn.ordinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextOrdinal++;
        turn.ordinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const baseItem = (
        turn: ActiveTurn,
        nativeItemId: string,
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
      ) => ({
        id: IdAllocator.derive.turnItemFromProviderItem({ driver: DRIVER, nativeItemId }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: IdAllocator.derive.nodeFromProviderItem({ driver: DRIVER, nativeItemId }),
        providerThreadId: turn.input.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: nativeRef(nativeItemId, "weak"),
        parentItemId: null,
        ordinal: ordinalFor(turn, nativeItemId),
        startedAt,
        updatedAt,
      });

      const publishStep = Effect.fnUntraced(function* (turn: ActiveTurn, item: StepItem) {
        if (item.kind === "assistant" && item.text.trim().length === 0) return;
        const now = yield* DateTime.now;
        const running = item.status === "running";
        const base = baseItem(turn, item.nativeItemId, item.startedAt, now);
        const completedAt = running ? null : now;
        yield* emit({
          type: "node.updated",
          driver: DRIVER,
          node: {
            id: base.nodeId,
            threadId: base.threadId,
            runId: base.runId,
            parentNodeId: turn.input.rootNodeId,
            rootNodeId: turn.input.rootNodeId,
            kind: item.kind === "assistant" ? "assistant_message" : "tool_call",
            status: item.status,
            countsForRun: false,
            providerThreadId: base.providerThreadId,
            providerTurnId: base.providerTurnId,
            nativeItemRef: base.nativeItemRef,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: item.startedAt,
            completedAt,
          },
        });
        let turnItem: OrchestrationV2TurnItem;
        if (item.kind === "assistant") {
          const messageId = IdAllocator.derive.messageFromProviderItem({
            driver: DRIVER,
            nativeItemId: item.nativeItemId,
          });
          yield* emit({
            type: "message.updated",
            driver: DRIVER,
            message: {
              id: messageId,
              threadId: base.threadId,
              runId: base.runId,
              nodeId: base.nodeId,
              role: "assistant",
              text: item.text,
              attachments: [],
              streaming: running,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: item.startedAt,
              updatedAt: now,
            },
          });
          turnItem = {
            ...base,
            status: item.status,
            title: null,
            completedAt,
            type: "assistant_message",
            messageId,
            text: item.text,
            streaming: running,
          };
        } else {
          const command =
            item.toolName === "run_command" && typeof item.parameters === "object"
              ? (item.parameters as { readonly CommandLine?: unknown }).CommandLine
              : undefined;
          turnItem =
            typeof command === "string"
              ? {
                  ...base,
                  status: item.status,
                  title: item.toolName,
                  completedAt,
                  type: "command_execution",
                  input: command,
                  ...(item.output === undefined ? {} : { output: item.output }),
                }
              : {
                  ...base,
                  status: item.status,
                  title: item.toolName,
                  completedAt,
                  type: "dynamic_tool",
                  toolName: item.toolName,
                  input: item.parameters ?? {},
                  ...(item.output === undefined ? {} : { output: item.output }),
                };
        }
        yield* emit({ type: "turn_item.updated", driver: DRIVER, turnItem });
      });

      const scheduleFlush = (turn: ActiveTurn, item: StepItem) =>
        Effect.suspend(() => {
          if (item.flushScheduled) return Effect.void;
          item.flushScheduled = true;
          return Effect.sleep(STREAM_FLUSH_MS).pipe(
            Effect.andThen(
              permit.withPermits(1)(
                Effect.suspend(() => {
                  item.flushScheduled = false;
                  return active === turn && item.status === "running"
                    ? publishStep(turn, item)
                    : Effect.void;
                }),
              ),
            ),
            Effect.forkIn(workScope),
            Effect.asVoid,
          );
        });

      const emitNotice = Effect.fnUntraced(function* (turn: ActiveTurn, message: string) {
        const now = yield* DateTime.now;
        yield* emit({
          type: "turn_item.updated",
          driver: DRIVER,
          turnItem: {
            ...baseItem(turn, `${turn.providerTurn.id}:denied`, now, now),
            nodeId: turn.input.rootNodeId,
            status: "completed",
            title: null,
            completedAt: now,
            type: "system_notice",
            message,
          },
        });
      });

      const finish = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: "completed" | "interrupted" | "failed" | "cancelled",
        detail?: string,
      ) {
        if (active !== turn) return;
        active = undefined;
        for (const item of turn.steps.values()) {
          if (item.status !== "running") continue;
          item.status = item.kind === "assistant" || status === "completed" ? "completed" : status;
          yield* publishStep(turn, item);
        }
        const completedAt = yield* DateTime.now;
        const usage = turn.usage;
        turn.providerTurn = {
          ...turn.providerTurn,
          status,
          completedAt,
          ...(usage === undefined
            ? {}
            : {
                turnTokenUsage: {
                  usageScope: "main_agent",
                  usageStatus: status === "completed" ? "complete" : "partial",
                  hasSubagents: false,
                  inputTokens: usage.input,
                  outputTokens: usage.output,
                  cachedInputTokens: usage.cached,
                  reasoningTokens: usage.reasoning,
                },
              }),
        };
        yield* emit({
          type: "provider_turn.updated",
          driver: DRIVER,
          threadId: turn.input.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateThread({ status: "idle" });
        yield* updateSession("ready", status === "failed" ? (detail ?? null) : null);
        if (status === "failed") {
          const failure = makeProviderFailure({
            class: "provider_error",
            message: detail ?? "agy turn failed.",
          });
          const failureItem = makeProviderFailureTurnItem({
            driver: DRIVER,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: turn.input.rootNodeId,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            itemOrdinal: turn.nextOrdinal++,
            failure,
            occurredAt: completedAt,
          });
          yield* emit({ type: "turn_item.updated", driver: DRIVER, turnItem: failureItem });
          yield* emit({
            type: "turn.terminal",
            driver: DRIVER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status: "failed",
            failure,
            failureItemOrdinal: failureItem.ordinal,
            threadDisposition: "reusable",
          });
        } else {
          yield* emit({
            type: "turn.terminal",
            driver: DRIVER,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            status,
            failure: null,
            threadDisposition: "reusable",
          });
        }
        yield* Deferred.succeed(turn.done, undefined);
      });

      const onStep = Effect.fnUntraced(function* (turn: ActiveTurn, step: AgyStepUpdate) {
        const kind =
          step.step_type === "agent_response"
            ? "assistant"
            : step.step_type === "tool"
              ? "tool"
              : undefined;
        if (kind === undefined) return;
        let item = turn.steps.get(step.step_index);
        if (item === undefined) {
          item = {
            nativeItemId: `${turn.providerTurn.id}:step:${step.step_index}`,
            kind,
            startedAt: yield* DateTime.now,
            status: "running",
            text: "",
            toolName: step.tool_name ?? "tool",
            parameters: undefined,
            output: undefined,
            flushScheduled: false,
          };
          turn.steps.set(step.step_index, item);
          // Reserve the ordinal now so items keep agy's step order.
          ordinalFor(turn, item.nativeItemId);
        }
        if (item.status !== "running") return;
        if (step.text_delta !== undefined) item.text += step.text_delta;
        if (step.tool_info?.parameters !== undefined) item.parameters = step.tool_info.parameters;
        const output = step.tool_info?.output ?? step.tool_info?.error?.message;
        if (output !== undefined) item.output = output;
        if (step.state !== "DONE" && step.state !== "ERROR") {
          return yield* kind === "assistant" ? scheduleFlush(turn, item) : publishStep(turn, item);
        }
        item.status = step.state === "DONE" ? "completed" : "failed";
        if (kind === "assistant" && step.usage !== undefined) {
          const usage = turn.usage ?? { input: 0, cached: 0, output: 0, reasoning: 0 };
          const cached = step.usage.cache_read_tokens ?? 0;
          turn.usage = {
            input: usage.input + (step.usage.input_tokens ?? 0) + cached,
            cached: usage.cached + cached,
            output: usage.output + (step.usage.output_tokens ?? 0),
            reasoning: usage.reasoning + (step.usage.thinking_tokens ?? 0),
          };
        }
        yield* publishStep(turn, item);
      });

      const onResult = Effect.fnUntraced(function* (turn: ActiveTurn, result: AgyResult) {
        const notice = agyDeniedActionsNotice(result.denied_actions ?? [], {
          suggestFullAccess: turn.process.launch.runtimeMode !== "full-access",
        });
        if (notice !== undefined) yield* emitNotice(turn, notice);
        if (result.status === "SUCCESS") return yield* finish(turn, "completed");
        if (turn.interruptRequested) return yield* finish(turn, "interrupted");
        yield* finish(turn, "failed", agyFailureText(result.error));
      });

      const onEvent = (process: LiveProcess, event: AgyEvent) =>
        Effect.suspend(() => {
          const turn = active;
          // Print mode only acts on a stdin message, so nothing arrives between turns.
          if (closed || turn === undefined || turn.process !== process) return Effect.void;
          if (event.event === "step_update") return onStep(turn, event.step_update);
          if (event.event === "result") return onResult(turn, event.result);
          return Effect.void;
        });

      /** Why agy exited, with the end of its own output when it printed any. */
      const exitDetail = Effect.fnUntraced(function* (agy: AgyProcess, what: string) {
        const code = Option.getOrNull(yield* agy.exitCode.pipe(Effect.timeoutOption("1 second")));
        const output = yield* agy.diagnostics;
        return `${what}${code === null ? "" : ` (exit code ${code})`}${output ? `: ${output}` : ""}`;
      });

      const onExit = Effect.fnUntraced(function* (process: LiveProcess) {
        if (live === process) live = undefined;
        const turn = active;
        const failed =
          !closed && turn?.process === process && !turn.interruptRequested
            ? yield* exitDetail(process.agy, "agy exited before the turn finished")
            : undefined;
        yield* Scope.close(process.scope, Exit.void);
        if (closed || turn === undefined || turn.process !== process) return;
        yield* failed === undefined ? finish(turn, "interrupted") : finish(turn, "failed", failed);
      });

      const stopProcess = (process: LiveProcess) =>
        Effect.suspend(() => {
          if (live === process) live = undefined;
          return Scope.close(process.scope, Exit.void);
        });

      /** Waits for `init` and returns its conversation ID. */
      const awaitConversation = Effect.fnUntraced(function* (agy: AgyProcess) {
        while (true) {
          const event = yield* Queue.take(agy.events).pipe(Effect.orElseSucceed(() => undefined));
          if (event === undefined) {
            return yield* protocolError(
              yield* exitDetail(agy, "agy exited before opening a conversation"),
            );
          }
          if (event.event === "init") return event.conversation_id;
          if (event.event === "result" && event.result.status !== "SUCCESS") {
            return yield* protocolError(agyFailureText(event.result.error));
          }
        }
      });

      const startProcess = Effect.fnUntraced(function* (
        launch: AgyLaunch,
        conversationId: string | undefined,
      ) {
        if (live !== undefined) yield* stopProcess(live);
        const processScope = yield* Scope.fork(workScope);
        return yield* Effect.gen(function* () {
          const command = options.settings.binaryPath;
          const wrapped = yield* agentScope.wrap({
            command,
            args: agyLaunchArgs(launch, conversationId),
            name: "agy",
            threadId: input.threadId,
            env: options.environment,
          });
          const agy = yield* spawnAgy({
            command: wrapped.command,
            args: wrapped.args,
            cwd,
            env: options.environment,
          }).pipe(
            Scope.provide(processScope),
            Effect.mapError(() =>
              protocolError(`Could not start ${command}. Check the agy binary path in settings.`),
            ),
          );
          const startedId = yield* awaitConversation(agy).pipe(
            Effect.timeoutOrElse({
              duration: START_TIMEOUT,
              orElse: () => Effect.fail(protocolError("agy did not open a conversation in time")),
            }),
          );
          const process: LiveProcess = {
            scope: processScope,
            agy,
            launch,
            conversationId: startedId,
          };
          live = process;
          yield* Stream.fromQueue(agy.events).pipe(
            Stream.runForEach((event) => permit.withPermits(1)(onEvent(process, event))),
            Effect.onExit((exit) =>
              Exit.hasInterrupts(exit) ? Effect.void : permit.withPermits(1)(onExit(process)),
            ),
            Effect.forkIn(workScope),
          );
          return process;
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.onError(() => Scope.close(processScope, Exit.void)),
        );
      });

      const launchFor = (
        modelSelection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"],
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
      ) =>
        options.models.pipe(
          Effect.map((models) =>
            resolveAgyLaunch({
              modelSelection,
              runtimeMode: runtimePolicy.runtimeMode,
              models,
            }),
          ),
        );

      const bindThread = Effect.fnUntraced(function* (
        conversationId: string,
        appThreadId: OrchestrationV2ProviderThread["appThreadId"],
        existing: OrchestrationV2ProviderThread | undefined,
      ) {
        const now = yield* DateTime.now;
        thread =
          existing === undefined
            ? {
                id: IdAllocator.derive.providerThread({
                  driver: DRIVER,
                  providerInstanceId: options.instanceId,
                  nativeThreadId: conversationId,
                }),
                driver: DRIVER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId,
                ownerNodeId: null,
                nativeThreadRef: nativeRef(conversationId),
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }
            : {
                ...existing,
                providerSessionId: input.providerSessionId,
                nativeThreadRef: nativeRef(conversationId),
                status: "idle",
                updatedAt: now,
              };
        yield* emit({ type: "provider_thread.updated", driver: DRIVER, providerThread: thread });
        return thread;
      });

      /** Starts agy on a conversation. agy opens a new one when it no longer has it. */
      const resumeConversation = Effect.fnUntraced(function* (
        launch: AgyLaunch,
        conversationId: string,
      ) {
        const process = yield* startProcess(launch, conversationId);
        if (process.conversationId === conversationId) return process;
        yield* stopProcess(process);
        return yield* protocolError(`agy could not resume conversation ${conversationId}`);
      });

      /** Ends the session so the session manager reopens it and resumes the thread. */
      const endSession = Effect.fnUntraced(function* (detail: string) {
        closed = true;
        yield* updateSession("stopped", detail);
        yield* Queue.end(events);
      });

      yield* Effect.addFinalizer(() =>
        permit.withPermits(1)(
          Effect.gen(function* () {
            if (active !== undefined) yield* finish(active, "cancelled");
            closed = true;
            yield* Queue.end(events);
          }),
        ),
      );

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: DRIVER,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
        ensureThread: (args) =>
          permit
            .withPermits(1)(
              Effect.gen(function* () {
                if (closed) return yield* protocolError("The Antigravity CLI session is closed");
                yield* refusePlanMode(args.runtimePolicy);
                if (active !== undefined) {
                  return yield* protocolError("Cannot change threads during an agy turn");
                }
                const existing = args.existingProviderThread;
                const current = thread;
                if (
                  current !== undefined &&
                  current.appThreadId === args.threadId &&
                  (existing === undefined || existing.id === current.id) &&
                  live?.conversationId === current.nativeThreadRef?.nativeId
                ) {
                  return current;
                }
                const launch = yield* launchFor(args.modelSelection, args.runtimePolicy);
                const requested = existing?.nativeThreadRef?.nativeId ?? undefined;
                const process =
                  requested === undefined
                    ? yield* startProcess(launch, undefined)
                    : yield* resumeConversation(launch, requested);
                return yield* bindThread(process.conversationId, args.threadId, existing);
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver: DRIVER,
                    threadId: args.threadId,
                    cause,
                  }),
              ),
            ),
        resumeThread: (args) =>
          permit
            .withPermits(1)(
              Effect.gen(function* () {
                if (closed) return yield* protocolError("The Antigravity CLI session is closed");
                yield* refusePlanMode(args.runtimePolicy);
                if (active !== undefined) {
                  return yield* protocolError("Cannot resume a thread during an agy turn");
                }
                const conversationId = args.providerThread.nativeThreadRef?.nativeId;
                if (conversationId == null) {
                  return yield* protocolError("The thread has no agy conversation to resume");
                }
                const launch = yield* launchFor(
                  args.modelSelection ?? input.modelSelection,
                  args.runtimePolicy ?? input.runtimePolicy,
                );
                if (live?.conversationId !== conversationId) {
                  yield* resumeConversation(launch, conversationId);
                }
                return yield* bindThread(
                  conversationId,
                  args.threadId ?? args.providerThread.appThreadId,
                  args.providerThread,
                );
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterResumeThreadError({
                    driver: DRIVER,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: args.providerThread.id,
                    cause,
                  }),
              ),
            ),
        startTurn: (turnInput) =>
          permit
            .withPermits(1)(
              Effect.gen(function* () {
                if (closed) return yield* protocolError("The Antigravity CLI session is closed");
                yield* refusePlanMode(turnInput.runtimePolicy);
                const conversationId = thread?.nativeThreadRef?.nativeId;
                if (
                  thread === undefined ||
                  conversationId == null ||
                  turnInput.providerThread.nativeThreadRef?.nativeId !== conversationId
                ) {
                  return yield* protocolError("The thread is not attached to this agy session");
                }
                if (active !== undefined) {
                  return yield* protocolError("agy already has an active turn");
                }
                const skills = yield* options.discoverSkills(cwd);
                const text = providerMessageTextWithAttachmentPaths({
                  text: rewriteAgySkillMentions(
                    turnInput.message.text,
                    new Set(skills.map((skill) => skill.name)),
                  ),
                  attachments: turnInput.message.attachments,
                  resolveAttachmentPath: host.resolveAttachmentPath,
                });
                if (text.trim().length === 0) return yield* protocolError("agy needs a message");
                const launch = yield* launchFor(turnInput.modelSelection, turnInput.runtimePolicy);
                let process = live;
                if (
                  process === undefined ||
                  agyLaunchKey(process.launch) !== agyLaunchKey(launch)
                ) {
                  process = yield* startProcess(launch, conversationId);
                  if (process.conversationId !== conversationId) {
                    yield* stopProcess(process);
                    const detail = `agy could not resume conversation ${conversationId}`;
                    // Reopening the session fails the resume, which falls back to a new
                    // conversation that receives the thread's history.
                    yield* endSession(detail);
                    return yield* protocolError(detail);
                  }
                }
                const startedAt = yield* DateTime.now;
                const nativeTurnId = `${thread.id}:attempt:${turnInput.attemptId}`;
                const turn: ActiveTurn = {
                  input: turnInput,
                  process,
                  providerTurn: {
                    id: IdAllocator.derive.providerTurn({ driver: DRIVER, nativeTurnId }),
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: nativeRef(nativeTurnId, "weak"),
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "running",
                    startedAt,
                    completedAt: null,
                  },
                  steps: new Map(),
                  ordinals: new Map(),
                  nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
                  usage: undefined,
                  interruptRequested: false,
                  done: yield* Deferred.make<void>(),
                };
                thread = turnInput.providerThread;
                active = turn;
                session = { ...session, model: turnInput.modelSelection.model };
                yield* emit({
                  type: "provider_turn.updated",
                  driver: DRIVER,
                  threadId: turnInput.threadId,
                  providerTurn: turn.providerTurn,
                });
                yield* updateThread({
                  status: "active",
                  firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal,
                  lastRunOrdinal: turnInput.runOrdinal,
                });
                yield* updateSession("running");
                yield* process.agy.send(text);
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: DRIVER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        steerTurn: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver: DRIVER,
              providerThreadId: args.providerThread.id,
            }),
          ),
        interruptTurn: (args) =>
          Effect.gen(function* () {
            const turn = active;
            // A settled turn has nothing left to stop.
            if (turn === undefined && args.requestRuntimeRestart === true) return;
            if (turn === undefined || turn.providerTurn.id !== args.providerTurnId) {
              return yield* protocolError("This agy turn is no longer active");
            }
            turn.interruptRequested = true;
            // Retired before the kill, so a turn queued behind this one starts a new
            // process on the same conversation instead of writing to the dying one.
            if (live === turn.process) live = undefined;
            yield* turn.process.agy.kill;
            const stopped = yield* Deferred.await(turn.done).pipe(
              Effect.timeoutOption(STOP_TIMEOUT),
            );
            if (Option.isNone(stopped)) {
              yield* permit.withPermits(1)(
                stopProcess(turn.process).pipe(Effect.andThen(finish(turn, "interrupted"))),
              );
            }
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterInterruptError({
                  driver: DRIVER,
                  providerThreadId: args.providerThread.id,
                  providerTurnId: args.providerTurnId,
                  cause,
                }),
            ),
          ),
        respondToRuntimeRequest: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
              driver: DRIVER,
              requestId: args.requestId,
              cause: protocolError("agy print mode has no approval requests"),
            }),
          ),
        readThreadSnapshot: (args) =>
          Effect.succeed({
            providerThread: args.providerThread,
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          }),
        rollbackThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: DRIVER,
              providerThreadId: args.providerThread.id,
              checkpointId: args.target.checkpointId,
              cause: "agy cannot rewind a conversation.",
            }),
          ),
        forkThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: DRIVER,
              providerThreadId: args.sourceProviderThread.id,
              cause: "agy cannot fork a conversation.",
            }),
          ),
      };
      return runtime;
    }),
  });
});
