import type { VcsNestedRepositoryChanges } from "@t3tools/contracts";

const NESTED_REPOSITORY_ROW_LIMIT = 5;

/**
 * The thread details panel's rows for a folder of repositories: the most recently edited ones,
 * and how many more have changes.
 */
export function nestedRepositoryRows(changes: ReadonlyArray<VcsNestedRepositoryChanges>) {
  return {
    rows: changes.slice(0, NESTED_REPOSITORY_ROW_LIMIT),
    moreCount: Math.max(0, changes.length - NESTED_REPOSITORY_ROW_LIMIT),
  };
}

/** The only changed repository, which the Changes row names instead of listing it below. */
export function soleNestedRepository(
  changes: ReadonlyArray<VcsNestedRepositoryChanges> | undefined,
): VcsNestedRepositoryChanges | null {
  return changes?.length === 1 ? changes[0]! : null;
}

/** The picked repositories that still have changes. Empty means every repository. */
export function reconcileNestedRepositorySelection(
  selected: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
): string[] {
  const changed = new Set(available);
  return selected.filter((path) => changed.has(path));
}

/**
 * Picks or unpicks one repository in the diff panel's repository menu. Picking one while every
 * repository shows narrows the view to it, and picking the last one left shows them all again.
 */
export function toggleNestedRepository(
  selected: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
  path: string,
): string[] {
  if (selected.length === 0) return [path];
  const next = selected.includes(path)
    ? selected.filter((candidate) => candidate !== path)
    : [...selected, path];
  return available.every((candidate) => next.includes(candidate)) ? [] : next;
}

export function nestedRepositorySelectionLabel(selected: ReadonlyArray<string>): string {
  if (selected.length === 0) return "All repositories";
  if (selected.length === 1) return selected[0]!;
  return `${selected.length} repositories`;
}
