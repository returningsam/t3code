import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { reconcileNestedRepositorySelection } from "./nestedRepositories.logic";

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | { kind: "turn"; turnId: RunId; filePath: string | null; revealRequestId: number };

// "branch" is the Changes view: everything this checkout changed since its base.
const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };
const ALL_NESTED_REPOSITORIES: ReadonlyArray<string> = [];

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  /** For a folder of repositories, the ones its Changes view shows. Absent shows them all. */
  nestedRepositoriesByThreadKey: Record<string, ReadonlyArray<string>>;
  selectGitScope: (ref: ScopedThreadRef, scope: "branch" | "unstaged") => void;
  /** Shows only these nested repositories in the Changes view, or all of them when empty. */
  selectNestedRepositories: (ref: ScopedThreadRef, repositories: ReadonlyArray<string>) => void;
  /** Unpicks nested repositories that no longer have changes. */
  reconcileNestedRepositories: (ref: ScopedThreadRef, available: ReadonlyArray<string>) => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: RunId, filePath?: string) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<RunId>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

function withNestedRepositories(
  byThreadKey: Record<string, ReadonlyArray<string>>,
  threadKey: string,
  repositories: ReadonlyArray<string>,
): Record<string, ReadonlyArray<string>> {
  const { [threadKey]: _previous, ...rest } = byThreadKey;
  return repositories.length === 0 ? rest : { ...rest, [threadKey]: [...repositories] };
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      nestedRepositoriesByThreadKey: {},
      selectGitScope: (ref, scope) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[threadKey] ?? null);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]:
                scope === "branch"
                  ? { kind: "branch", baseRef: previousBaseRef }
                  : { kind: "unstaged" },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectBranchBaseRef: (ref, baseRef) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "branch", baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectNestedRepositories: (ref, repositories) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (repositories.length === 0 && !(threadKey in state.nestedRepositoriesByThreadKey)) {
            return state;
          }
          return {
            nestedRepositoriesByThreadKey: withNestedRepositories(
              state.nestedRepositoriesByThreadKey,
              threadKey,
              repositories,
            ),
          };
        }),
      reconcileNestedRepositories: (ref, available) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.nestedRepositoriesByThreadKey[threadKey];
          if (!previous) return state;
          const next = reconcileNestedRepositorySelection(previous, available);
          if (next.length === previous.length) return state;
          return {
            nestedRepositoriesByThreadKey: withNestedRepositories(
              state.nestedRepositoriesByThreadKey,
              threadKey,
              next,
            ),
          };
        }),
      selectTurn: (ref, turnId, filePath) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
              },
            },
          };
        }),
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (
            previous?.kind !== "turn" ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...previous, turnId: latestTurnId },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (
            !(threadKey in state.byThreadKey) &&
            !(threadKey in state.branchBaseRefByThreadKey) &&
            !(threadKey in state.nestedRepositoriesByThreadKey)
          ) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey;
          return {
            byThreadKey,
            branchBaseRefByThreadKey,
            nestedRepositoriesByThreadKey: withNestedRepositories(
              state.nestedRepositoriesByThreadKey,
              threadKey,
              [],
            ),
          };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
        nestedRepositoriesByThreadKey: state.nestedRepositoriesByThreadKey,
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return byThreadKey[scopedThreadKey(ref)] ?? DEFAULT_SELECTION;
}

export function selectThreadNestedRepositories(
  byThreadKey: Record<string, ReadonlyArray<string>>,
  ref: ScopedThreadRef | null | undefined,
): ReadonlyArray<string> {
  if (!ref) return ALL_NESTED_REPOSITORIES;
  return byThreadKey[scopedThreadKey(ref)] ?? ALL_NESTED_REPOSITORIES;
}
