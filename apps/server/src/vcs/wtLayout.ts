import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

/**
 * Marker file for the wt layout: `<container>/.wt` next to the main checkout at
 * `<container>/main` and worktrees under `<container>/worktrees`. Written by the wt
 * plugin's `/wt:setup` in git-config format.
 */
export const WT_LAYOUT_FILE_NAME = ".wt";

export interface WtLayout {
  readonly container: string;
  readonly name: string | null;
}

function parseGitConfigValue(raw: string): string {
  let value = "";
  let quoted = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (char === "\\" && index + 1 < raw.length) {
      index += 1;
      const escaped = raw[index]!;
      value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === "#" || char === ";")) {
      break;
    } else {
      value += char;
    }
  }
  return value.trim();
}

/** Reads `wt.name` from the contents of a `.wt` file. */
export function parseWtLayoutFile(contents: string): Pick<WtLayout, "name"> {
  let section = "";
  let name: string | null = null;
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[\s*([A-Za-z0-9.-]+)\s*\]/.exec(line);
    if (header) {
      section = header[1]!.toLowerCase();
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*=(.*)$/.exec(line);
    if (section === "wt" && entry && entry[1]!.toLowerCase() === "name") {
      const value = parseGitConfigValue(entry[2]!);
      name = value.length > 0 ? value : null;
    }
  }
  return { name };
}

/**
 * The wt layout containing `checkoutRoot`, which is either the main checkout
 * (`<container>/<dir>`) or a worktree (`<container>/worktrees/<dir>`). Null when the
 * container has no `.wt` file.
 */
export const resolveWtLayout = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  checkoutRoot: string,
): Effect.Effect<WtLayout | null> =>
  Effect.gen(function* () {
    const parent = path.dirname(checkoutRoot);
    const container = path.basename(parent) === "worktrees" ? path.dirname(parent) : parent;
    const contents = yield* fileSystem
      .readFileString(path.join(container, WT_LAYOUT_FILE_NAME))
      .pipe(Effect.option);
    if (Option.isNone(contents)) return null;
    return { container, ...parseWtLayoutFile(contents.value) };
  });
