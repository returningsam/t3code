/**
 * Antigravity CLI's client definition: settings form, label, and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-antigravity-cli/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { AntigravityCliSettings } from "./settings.ts";

export const antigravityCliClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("antigravityCli"),
  label: "Antigravity CLI",
  settingsSchema: AntigravityCliSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#5B87BF", dark: "#7FA6D6" },
    paths: [
      {
        d: "M4.29 6.29a1 1 0 0 1 1.42 0l5 5a1 1 0 0 1 0 1.42l-5 5a1 1 0 0 1-1.42-1.42L8.59 12 4.29 7.71a1 1 0 0 1 0-1.42Z",
      },
      { d: "M12 16h7a1 1 0 1 1 0 2h-7a1 1 0 1 1 0-2Z" },
    ],
  },
});
