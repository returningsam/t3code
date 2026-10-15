import { describe, expect, it } from "vite-plus/test";

import {
  nestedRepositoryRows,
  nestedRepositorySelectionLabel,
  reconcileNestedRepositorySelection,
  soleNestedRepository,
  toggleAllNestedRepositories,
  toggleNestedRepository,
} from "./nestedRepositories.logic";

const changes = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    path: `worktrees/wt-${index}`,
    totals: { insertions: index, deletions: 0 },
  }));

describe("nestedRepositoryRows", () => {
  it("lists the five most recently edited repositories in the server's order", () => {
    const { rows, moreCount } = nestedRepositoryRows(changes(8));

    expect(rows.map((row) => row.path)).toEqual([
      "worktrees/wt-0",
      "worktrees/wt-1",
      "worktrees/wt-2",
      "worktrees/wt-3",
      "worktrees/wt-4",
    ]);
    expect(moreCount).toBe(3);
  });

  it("has no more row when every repository fits", () => {
    expect(nestedRepositoryRows(changes(5)).moreCount).toBe(0);
    expect(nestedRepositoryRows(changes(2))).toEqual({ rows: changes(2), moreCount: 0 });
  });
});

describe("soleNestedRepository", () => {
  it("returns the repository when it is the only one with changes", () => {
    expect(soleNestedRepository(changes(1))).toEqual(changes(1)[0]);
  });

  it("returns null for none or several", () => {
    expect(soleNestedRepository(undefined)).toBeNull();
    expect(soleNestedRepository([])).toBeNull();
    expect(soleNestedRepository(changes(2))).toBeNull();
  });
});

describe("reconcileNestedRepositorySelection", () => {
  it("drops picked repositories that no longer have changes", () => {
    expect(reconcileNestedRepositorySelection(["b", "gone", "a"], ["a", "b", "c"])).toEqual([
      "b",
      "a",
    ]);
  });

  it("falls back to every repository when none of the picked ones remain", () => {
    expect(reconcileNestedRepositorySelection(["gone"], ["a", "b"])).toEqual([]);
  });

  it("shows every repository when the remaining picks cover all of them", () => {
    expect(reconcileNestedRepositorySelection(["a", "b"], ["a", "b"])).toEqual([]);
  });
});

describe("toggleNestedRepository", () => {
  it("unchecks one repository from all of them, leaving the others", () => {
    expect(toggleNestedRepository([], ["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("adds and removes picks", () => {
    expect(toggleNestedRepository(["b"], ["a", "b", "c"], "a")).toEqual(["b", "a"]);
    expect(toggleNestedRepository(["b", "a"], ["a", "b", "c"], "b")).toEqual(["a"]);
  });

  it("selects all once every repository is checked", () => {
    expect(toggleNestedRepository(["a", "b"], ["a", "b", "c"], "c")).toEqual([]);
  });

  it("falls back to the most recently edited repository when the last pick is removed", () => {
    expect(toggleNestedRepository(["b"], ["c", "a", "b"], "b")).toEqual(["c"]);
    expect(toggleNestedRepository(["c"], ["c", "a", "b"], "c")).toEqual(["c"]);
  });
});

describe("toggleAllNestedRepositories", () => {
  it("selects only the most recently edited repository when all are selected", () => {
    expect(toggleAllNestedRepositories([], ["c", "a", "b"])).toEqual(["c"]);
  });

  it("selects all from a partial selection", () => {
    expect(toggleAllNestedRepositories(["a"], ["c", "a", "b"])).toEqual([]);
  });
});

describe("nestedRepositorySelectionLabel", () => {
  it("names the picked repositories", () => {
    expect(nestedRepositorySelectionLabel([])).toBe("All repositories");
    expect(nestedRepositorySelectionLabel(["worktrees/wt-a"])).toBe("worktrees/wt-a");
    expect(nestedRepositorySelectionLabel(["main", "worktrees/wt-a"])).toBe("2 repositories");
  });
});
