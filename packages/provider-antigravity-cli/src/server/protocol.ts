/**
 * The agy print-mode protocol: launch arguments, the stdin message, stdout
 * events, and the `agy models` listing.
 *
 * agy runs as `agy --input-format stream-json --output-format stream-json -p=`.
 * Each stdin line starts one turn. Stdout is NDJSON: `init` once the
 * conversation is open, `step_update` for each user input, response, and tool
 * step, and `result` when the turn ends. Lines that are not JSON events (agy
 * prints some errors as plain text) are skipped.
 *
 * @module provider-antigravity-cli/server/protocol
 */
import {
  type ModelCapabilities,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Runs the model configured in agy itself. Never passed to `--model`. */
export const AGY_DEFAULT_MODEL = "default";
const AGY_EFFORT_OPTION = "effort";

const AgyUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  thinking_tokens: Schema.optional(Schema.Number),
  cache_read_tokens: Schema.optional(Schema.Number),
});
export type AgyUsage = typeof AgyUsage.Type;

const AgyInitEvent = Schema.Struct({
  event: Schema.Literal("init"),
  conversation_id: Schema.String,
});

const AgyStepUpdateEvent = Schema.Struct({
  event: Schema.Literal("step_update"),
  step_update: Schema.Struct({
    step_index: Schema.Number,
    state: Schema.String,
    step_type: Schema.String,
    text_delta: Schema.optional(Schema.String),
    tool_name: Schema.optional(Schema.String),
    tool_info: Schema.optional(
      Schema.Struct({
        parameters: Schema.optional(Schema.Unknown),
        output: Schema.optional(Schema.String),
        error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
      }),
    ),
    usage: Schema.optional(AgyUsage),
  }),
});
export type AgyStepUpdate = (typeof AgyStepUpdateEvent.Type)["step_update"];

const AgyDeniedAction = Schema.Struct({
  action: Schema.optional(Schema.String),
  display_name: Schema.optional(Schema.String),
});
export type AgyDeniedAction = typeof AgyDeniedAction.Type;

const AgyResultEvent = Schema.Struct({
  event: Schema.Literal("result"),
  result: Schema.Struct({
    conversation_id: Schema.optional(Schema.String),
    status: Schema.String,
    error: Schema.optional(Schema.String),
    denied_actions: Schema.optional(Schema.Array(AgyDeniedAction)),
  }),
});
export type AgyResult = (typeof AgyResultEvent.Type)["result"];

export const AgyEvent = Schema.Union([AgyInitEvent, AgyStepUpdateEvent, AgyResultEvent]);
export type AgyEvent = typeof AgyEvent.Type;

const decodeAgyEventLine = Schema.decodeUnknownOption(Schema.fromJsonString(AgyEvent));

/** One stdout line as an agy event, or `undefined` for plain text and unknown events. */
export const parseAgyEvent = (line: string): AgyEvent | undefined =>
  Option.getOrUndefined(decodeAgyEventLine(line));

const AgyUserInput = Schema.Struct({
  event: Schema.Literal("user"),
  message: Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  }),
});
const encodeAgyUserInput = Schema.encodeSync(Schema.fromJsonString(AgyUserInput));

/** The stdin line that starts a turn. agy accepts only text content blocks. */
export const agyUserMessageLine = (text: string): string =>
  `${encodeAgyUserInput({
    event: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;

/** Everything about a process that is fixed at launch, apart from the conversation. */
export interface AgyLaunch {
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export const agyLaunchKey = (launch: AgyLaunch): string =>
  [launch.model ?? "", launch.effort ?? "", launch.runtimeMode, launch.interactionMode].join("\0");

export function agyLaunchArgs(launch: AgyLaunch, conversationId?: string): Array<string> {
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    ...(conversationId === undefined ? [] : ["--conversation", conversationId]),
    ...(launch.model === undefined ? [] : ["--model", launch.model]),
    ...(launch.effort === undefined ? [] : ["--effort", launch.effort]),
    // In print mode agy approves its own plan and goes on to implement it, so
    // plan turns keep agy's permission rules even in full access.
    ...(launch.interactionMode === "plan"
      ? ["--mode", "plan"]
      : launch.runtimeMode === "full-access"
        ? ["--dangerously-skip-permissions"]
        : []),
    // A bare `-p` takes the next flag as the prompt. `-p=` leaves the prompt
    // empty so turns come from stdin.
    "-p=",
  ];
}

export function resolveAgyLaunch(input: {
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly models: ReadonlyArray<ServerProviderModel>;
}): AgyLaunch {
  const model =
    input.modelSelection.model === AGY_DEFAULT_MODEL ? undefined : input.modelSelection.model;
  const capabilities = input.models.find((entry) => entry.slug === model)?.capabilities;
  return {
    model,
    effort: model === undefined ? undefined : resolveAgyEffort(capabilities, input.modelSelection),
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
  };
}

/** The selected effort when the model offers it, else the model's default effort. */
function resolveAgyEffort(
  capabilities: ModelCapabilities | null | undefined,
  modelSelection: ModelSelection,
): string | undefined {
  const descriptor = capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === AGY_EFFORT_OPTION,
  );
  if (descriptor?.type !== "select") return undefined;
  const selected = getModelSelectionStringOptionValue(modelSelection, AGY_EFFORT_OPTION);
  return (
    descriptor.options.find((option) => option.id === selected)?.id ??
    descriptor.options.find((option) => option.isDefault)?.id ??
    descriptor.options[0]?.id
  );
}

const AGY_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type AgyEffortLevel = (typeof AGY_EFFORT_LEVELS)[number];
const AGY_EFFORT_LABELS: Record<AgyEffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export const EMPTY_AGY_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/**
 * agy lists each effort of a model as its own entry, such as
 * `opus-5.5-high` named `Claude Opus 5.5 (High)`, and runs it as
 * `--model opus-5.5 --effort high`. An entry is an effort variant only when
 * both its slug and its name carry the same level.
 */
function agyEffortVariant(slug: string, name: string) {
  const [, baseName = "", label = ""] = /^(.*\S)\s+\(([^)]+)\)$/.exec(name) ?? [];
  const normalized = label.toLowerCase().replace(/[\s_-]/g, "");
  const level = AGY_EFFORT_LEVELS.find(
    (candidate) =>
      candidate === normalized || (candidate === "xhigh" && normalized === "extrahigh"),
  );
  if (level === undefined || !slug.endsWith(`-${level}`)) return undefined;
  const base = slug.slice(0, -(level.length + 1));
  return base.length === 0 ? undefined : { base, name: baseName, level };
}

/** Models from `agy models`, which prints one `slug<TAB>name` line per model. */
export function parseAgyModels(output: string): ReadonlyArray<ServerProviderModel> {
  const entries: Array<
    | { readonly slug: string; readonly name: string }
    | { readonly slug: string; readonly name: string; readonly levels: Array<AgyEffortLevel> }
  > = [];
  const groups = new Map<string, { readonly levels: Array<AgyEffortLevel> }>();
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const slug = line.slice(0, tab).trim();
    const name = line.slice(tab + 1).trim() || slug;
    if (slug.length === 0) continue;
    const variant = agyEffortVariant(slug, name);
    if (variant === undefined) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      entries.push({ slug, name });
      continue;
    }
    const group = groups.get(variant.base);
    if (group !== undefined) {
      if (!group.levels.includes(variant.level)) group.levels.push(variant.level);
      continue;
    }
    if (seen.has(variant.base)) continue;
    seen.add(variant.base);
    const levels = [variant.level];
    groups.set(variant.base, { levels });
    entries.push({ slug: variant.base, name: variant.name, levels });
  }
  return entries.map((entry): ServerProviderModel => {
    if (!("levels" in entry)) {
      return {
        slug: entry.slug,
        name: entry.name,
        isCustom: false,
        capabilities: EMPTY_AGY_MODEL_CAPABILITIES,
      };
    }
    const levels = AGY_EFFORT_LEVELS.filter((level) => entry.levels.includes(level));
    const defaultLevel = levels.includes("high") ? "high" : entry.levels[0];
    return {
      slug: entry.slug,
      name: entry.name,
      isCustom: false,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          {
            id: AGY_EFFORT_OPTION,
            label: "Effort",
            type: "select",
            options: levels.map((level) => ({
              id: level,
              label: AGY_EFFORT_LABELS[level],
              ...(level === defaultLevel ? { isDefault: true } : {}),
            })),
          },
        ],
      }),
    };
  });
}

export const AGY_SIGNED_OUT_MESSAGE =
  "agy is not signed in. Run `agy` in a terminal on this machine to sign in.";

/** Whether agy output says it has no signed-in account. */
export const isAgySignedOutOutput = (output: string): boolean =>
  /\bsign in\b|\blog in\b|authentication (?:required|failed)/i.test(output);

/** Tells the user what agy blocked, since print mode cannot ask for approval. */
export function agyDeniedActionsNotice(
  actions: ReadonlyArray<AgyDeniedAction>,
  options: { readonly suggestFullAccess: boolean },
): string | undefined {
  const names = [
    ...new Set(
      actions.flatMap((action) => {
        const name = action.display_name?.trim() || action.action?.trim();
        return name ? [name] : [];
      }),
    ),
  ];
  if (names.length === 0) return undefined;
  const blocked = `agy blocked ${names.join(", ")}: it cannot ask for approval when T3 Code runs it.`;
  return options.suggestFullAccess
    ? `${blocked} Full access allows these actions, or add allow rules to agy's settings.`
    : blocked;
}
