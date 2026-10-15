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

/**
 * The picked repositories that still have changes. Empty means every repository, including when
 * the remaining picks cover all of them.
 */
export function reconcileNestedRepositorySelection(
  selected: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
): string[] {
  const changed = new Set(available);
  const next = selected.filter((path) => changed.has(path));
  return available.every((path) => next.includes(path)) ? [] : next;
}

/**
 * Settles a menu pick: picking every repository means all of them (`[]`), and picking none falls
 * back to the most recently edited one. `available` is in the status's recency order.
 */
function settleNestedRepositoryPicks(
  picked: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
): string[] {
  const next = picked.length > 0 ? [...picked] : available.slice(0, 1);
  return available.every((candidate) => next.includes(candidate)) ? [] : next;
}

/**
 * Picks or unpicks one repository in the diff panel's repository menu, where every repository
 * shows checked while all of them are selected. `available` is in the status's recency order.
 */
export function toggleNestedRepository(
  selected: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
  path: string,
): string[] {
  const current = selected.length === 0 ? available : selected;
  const next = current.includes(path)
    ? current.filter((candidate) => candidate !== path)
    : [...current, path];
  return settleNestedRepositoryPicks(next, available);
}

/**
 * The repository menu's "All repositories" item: selects every repository, or when they already
 * are, only the most recently edited one. `available` is in the status's recency order.
 */
export function toggleAllNestedRepositories(
  selected: ReadonlyArray<string>,
  available: ReadonlyArray<string>,
): string[] {
  return selected.length === 0 ? settleNestedRepositoryPicks([], available) : [];
}

export function nestedRepositorySelectionLabel(selected: ReadonlyArray<string>): string {
  if (selected.length === 0) return "All repositories";
  if (selected.length === 1) return selected[0]!;
  return `${selected.length} repositories`;
}
