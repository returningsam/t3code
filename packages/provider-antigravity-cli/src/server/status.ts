/**
 * Antigravity CLI status: `agy --version` for the install and `agy models`
 * for the model list and sign-in. Neither opens a conversation.
 *
 * @module provider-antigravity-cli/server/status
 */
import type { ServerProviderModel } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { AntigravityCliSettings } from "../settings.ts";
import { resolveAgyCommand } from "./process.ts";
import {
  AGY_DEFAULT_MODEL,
  AGY_SIGNED_OUT_MESSAGE,
  EMPTY_AGY_MODEL_CAPABILITIES,
  isAgySignedOutOutput,
  parseAgyModels,
} from "./protocol.ts";

const PRESENTATION = {
  displayName: "Antigravity CLI",
  // In print mode agy approves its own plan and implements it, so T3 Code offers no plan mode.
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "full-access"],
  requiresNewThreadForModelChange: false,
  supportsConversationRollback: false,
} as const;

const VERSION_TIMEOUT_MS = 4_000;
const MODELS_TIMEOUT_MS = 15_000;

const AGY_DEFAULT_MODEL_ENTRY: ServerProviderModel = {
  slug: AGY_DEFAULT_MODEL,
  name: "agy default",
  isCustom: false,
  capabilities: EMPTY_AGY_MODEL_CAPABILITIES,
};

const modelsFromSettings = (
  settings: AntigravityCliSettings,
  discovered: ReadonlyArray<ServerProviderModel> = [],
) =>
  providerModelsFromSettings(
    [AGY_DEFAULT_MODEL_ENTRY, ...discovered],
    settings.customModels,
    EMPTY_AGY_MODEL_CAPABILITIES,
  );

const snapshot = (
  settings: AntigravityCliSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  discovered?: ReadonlyArray<ServerProviderModel>,
): ServerProviderDraft => ({
  ...buildServerProvider({
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: modelsFromSettings(settings, discovered),
    probe,
  }),
  supportsTextGeneration: false,
});

const runAgy = (command: string, args: ReadonlyArray<string>, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        extendEnv: false,
        shell: spawnCommand.shell,
      }),
    );
  });

export const buildInitialAntigravityCliSnapshot = (settings: AntigravityCliSettings) =>
  Effect.map(DateTime.now, (now) =>
    snapshot(settings, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking the Antigravity CLI..."
        : "Antigravity CLI is disabled in T3 Code settings.",
    }),
  );

export const checkAntigravityCliStatus = Effect.fn("checkAntigravityCliStatus")(function* (
  settings: AntigravityCliSettings,
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Antigravity CLI is disabled in T3 Code settings.",
    });
  }
  const command = yield* resolveAgyCommand(settings.binaryPath, environment);

  const versionResult = yield* runAgy(command, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "agy is not installed or not on PATH. Install the Antigravity CLI, or set its binary path."
        : "agy is installed but did not report its version.",
    });
  }
  const version = parseGenericCliVersion(versionResult.success.value.stdout);

  const modelsResult = yield* runAgy(command, ["models"], environment).pipe(
    Effect.timeoutOption(MODELS_TIMEOUT_MS),
    Effect.result,
  );
  const listed =
    Result.isSuccess(modelsResult) && Option.isSome(modelsResult.success)
      ? modelsResult.success.value
      : undefined;
  if (listed?.code === 0) {
    return snapshot(
      settings,
      checkedAt,
      {
        installed: true,
        version,
        status: "ready",
        auth: { status: "authenticated" },
      },
      parseAgyModels(listed.stdout),
    );
  }
  if (listed !== undefined && isAgySignedOutOutput(`${listed.stdout}\n${listed.stderr}`)) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: AGY_SIGNED_OUT_MESSAGE,
    });
  }
  return snapshot(settings, checkedAt, {
    installed: true,
    version,
    status: "warning",
    auth: { status: "unknown" },
    message: "agy is installed, but T3 Code could not list its models.",
  });
});
