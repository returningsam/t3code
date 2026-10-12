/**
 * Antigravity CLI instance settings. Shared by the server driver and the
 * client settings form, so it holds only browser-safe schema code.
 *
 * @module provider-antigravity-cli/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const AntigravityCliSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("agy").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the agy binary.",
        providerSettingsForm: { placeholder: "agy", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["binaryPath"] },
);
export type AntigravityCliSettings = typeof AntigravityCliSettings.Type;
