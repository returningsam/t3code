/**
 * AntigravityCliDriver runs the user's installed, signed-in `agy` binary.
 * agy owns its login and conversation history, so T3 Code has no sign-in
 * flow and continuation identity uses the default instance grouping.
 *
 * @module provider-antigravity-cli/server/driver
 */
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { AntigravityCliSettings } from "../settings.ts";
import { ANTIGRAVITY_CLI_PROVIDER, makeAntigravityCliAdapterV2 } from "./adapter.ts";
import { discoverAgySkills } from "./skills.ts";
import { buildInitialAntigravityCliSnapshot, checkAntigravityCliStatus } from "./status.ts";

const DRIVER = ANTIGRAVITY_CLI_PROVIDER;
const decodeSettings = Schema.decodeSync(AntigravityCliSettings);
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER,
  packageName: null,
});

export type AntigravityCliDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ProviderHost.ProviderHost;

const unsupportedTextGeneration: ProviderTextGeneration = (() => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Antigravity CLI instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
})();

export const AntigravityCliDriver: ProviderDriver<AntigravityCliSettings, AntigravityCliDriverEnv> =
  {
    driverKind: DRIVER,
    metadata: { displayName: "Antigravity CLI", supportsMultipleInstances: true },
    configSchema: AntigravityCliSettings,
    defaultConfig: () => decodeSettings({}),
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const processEnvironment = yield* mergeProviderInstanceEnvironment(environment);
        const discoverSkills = (cwd: string) =>
          discoverAgySkills(cwd, processEnvironment).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
        const settings = { ...config, enabled } satisfies AntigravityCliSettings;
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: DRIVER,
          instanceId,
        });
        const stampIdentity = withInstanceIdentity({
          instanceId,
          driverKind: DRIVER,
          displayName,
          accentColor,
          continuationGroupKey: continuationIdentity.continuationKey,
        });

        const snapshotSettings = yield* makeProviderSnapshotSettingsSource(settings);
        const snapshot = yield* makeManagedServerProvider<
          ProviderSnapshotSettings<AntigravityCliSettings>
        >({
          resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (current) =>
            buildInitialAntigravityCliSnapshot(current.provider).pipe(Effect.map(stampIdentity)),
          checkProvider: checkAntigravityCliStatus(settings, processEnvironment).pipe(
            Effect.map(stampIdentity),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER,
                instanceId,
                detail: "Failed to build the Antigravity CLI snapshot.",
                cause,
              }),
          ),
        );

        const orchestrationAdapter = yield* makeAntigravityCliAdapterV2({
          instanceId,
          settings,
          environment: processEnvironment,
          models: snapshot.getSnapshot.pipe(Effect.map((current) => current.models)),
          discoverSkills,
        });

        return {
          instanceId,
          driverKind: DRIVER,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot,
          snapshotForCwd: (cwd: string) =>
            enabled
              ? Effect.all([snapshot.getSnapshot, discoverSkills(cwd)]).pipe(
                  Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
                )
              : snapshot.getSnapshot,
          orchestrationAdapter,
          textGeneration: unsupportedTextGeneration,
        } satisfies ProviderInstance;
      }),
  };
