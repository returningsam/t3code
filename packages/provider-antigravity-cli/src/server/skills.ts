/**
 * Skill discovery and invocation for the `agy` CLI.
 *
 * agy has no command that lists skills, so T3 scans the folders agy loads
 * them from. Each root holds one folder per skill with a `SKILL.md`. Plugin
 * skills live under `~/.gemini/config/plugins/<plugin>/skills` and are
 * invoked as `<plugin>:<skill>`.
 *
 * @module provider-antigravity-cli/server/skills
 */
import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
/** The `$name` token composers insert, matching `packages/shared/src/inlineSkills.ts`. */
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;
const LEADING_COMMANDS_PATTERN = /^(?:\/[a-zA-Z0-9][a-zA-Z0-9:_-]*(?:\s+|$))+/u;
const MAX_SKILL_BYTES = 1_000_000;

const decodePluginManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.optionalKey(Schema.String) })),
);
/** The enabled state `agy plugin enable/disable` writes. A plugin it never saw is enabled. */
const decodeAgyConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      plugins: Schema.optionalKey(
        Schema.Record(
          Schema.String,
          Schema.Struct({ enabled: Schema.optionalKey(Schema.Unknown) }),
        ),
      ),
    }),
  ),
);

const orUndefined = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.catch(() => Effect.undefined));

function parseFrontmatter(contents: string) {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return {};
  try {
    const parsed: unknown = parseYamlDocument(match[1] ?? "");
    if (typeof parsed !== "object" || parsed === null) return {};
    const { name, description } = parsed as Record<string, unknown>;
    return {
      ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
      ...(typeof description === "string" && description.trim()
        ? { description: description.trim() }
        : {}),
    };
  } catch {
    return {};
  }
}

export const discoverAgySkills = Effect.fn("discoverAgySkills")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const geminiHome = path.join(
    environment.HOME?.trim() || (yield* HostProcess.HomeDirectory),
    ".gemini",
  );
  const skillsByName = new Map<string, ServerProviderSkill>();

  const scanRoot = Effect.fn("scanAgySkillRoot")(function* (
    directory: string,
    scope: "user" | "project",
    namePrefix = "",
  ) {
    const entries = yield* orUndefined(fileSystem.readDirectory(directory));
    for (const entry of (entries ?? []).toSorted()) {
      const skillPath = path.join(directory, entry, "SKILL.md");
      const info = yield* orUndefined(fileSystem.stat(skillPath));
      if (info?.type !== "File" || info.size > MAX_SKILL_BYTES) continue;
      const contents = yield* orUndefined(fileSystem.readFileString(skillPath));
      if (contents === undefined) continue;
      const frontmatter = parseFrontmatter(contents);
      const name = `${namePrefix}${frontmatter.name ?? entry}`;
      if (skillsByName.has(name)) continue;
      skillsByName.set(name, {
        name,
        path: skillPath,
        scope,
        enabled: true,
        ...(frontmatter.description ? { description: frontmatter.description } : {}),
      });
    }
  });

  yield* scanRoot(path.join(geminiHome, "config", "skills"), "user");
  yield* scanRoot(path.resolve(cwd, ".gemini", "skills"), "project");
  yield* scanRoot(path.join(geminiHome, "antigravity-cli", "skills"), "user");
  yield* scanRoot(path.resolve(cwd, ".agents", "skills"), "project");
  yield* scanRoot(path.resolve(cwd, ".agent", "skills"), "project");

  const pluginsDirectory = path.join(geminiHome, "config", "plugins");
  const config = yield* orUndefined(
    fileSystem
      .readFileString(path.join(geminiHome, "config", "config.json"))
      .pipe(Effect.flatMap(decodeAgyConfig)),
  );
  const pluginFolders = yield* orUndefined(fileSystem.readDirectory(pluginsDirectory));
  for (const folder of (pluginFolders ?? []).toSorted()) {
    const manifest = yield* orUndefined(
      fileSystem
        .readFileString(path.join(pluginsDirectory, folder, "plugin.json"))
        .pipe(Effect.flatMap(decodePluginManifest)),
    );
    if (manifest === undefined) continue;
    const pluginName = manifest.name?.trim() || folder;
    if (config?.plugins?.[pluginName]?.enabled === false) continue;
    yield* scanRoot(path.join(pluginsDirectory, folder, "skills"), "user", `${pluginName}:`);
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});

/**
 * agy expands only the `/name` tokens that open a prompt, and treats `$name`
 * as prose. Rewrite each mention of a known skill to `/name` and put any that
 * do not already open the prompt in front, so agy loads them all.
 */
export function rewriteAgySkillMentions(prompt: string, skillNames: ReadonlySet<string>): string {
  const mentioned: string[] = [];
  const rewritten = prompt.replace(SKILL_MENTION_PATTERN, (match, prefix: string, name: string) => {
    if (!skillNames.has(name)) return match;
    if (!mentioned.includes(name)) mentioned.push(name);
    return `${prefix}/${name}`;
  });
  const leading = new Set(
    (LEADING_COMMANDS_PATTERN.exec(rewritten)?.[0] ?? "")
      .split(/\s+/u)
      .filter(Boolean)
      .map((command) => command.slice(1)),
  );
  const missing = mentioned.filter((name) => !leading.has(name));
  return missing.length === 0
    ? rewritten
    : `${missing.map((name) => `/${name}`).join(" ")} ${rewritten}`;
}
