import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { RunId, ScopedThreadRef, ThreadId, TurnItemId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
import { reconcileNestedRepositorySelection } from "./nestedRepositories.logic";

export interface ToolCallDiffTarget {
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
  readonly revision: string;
}

export type DiffPanelSelection =
  | ({ kind: "tool-call" } & ToolCallDiffTarget)
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | { kind: "commit"; sha: string; baseRef: string | null }
  | { kind: "turn"; turnId: RunId; filePath: string | null; revealRequestId: number };

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };
const ALL_NESTED_REPOSITORIES: ReadonlyArray<string> = [];

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  /**
   * For a folder of repositories, the ones its Changes view shows. Absent shows them all. Not
   * persisted: every generic opening of Changes shows them all again.
   */
  nestedRepositoriesByThreadKey: Record<string, ReadonlyArray<string>>;
  /** A link that selected a commit before opening the closed pane; opening keeps that selection. */
  keepSelectionOnOpenThreadKey: string | null;
  selectGitScope: (ref: ScopedThreadRef, scope: "branch" | "unstaged") => void;
  /** Shows only these nested repositories in the Changes view, or all of them when empty. */
  selectNestedRepositories: (ref: ScopedThreadRef, repositories: ReadonlyArray<string>) => void;
  /** Unpicks nested repositories that no longer have changes. */
  reconcileNestedRepositories: (ref: ScopedThreadRef, available: ReadonlyArray<string>) => void;
  selectBranchBaseRef: (ref: ScopedThreadRef, baseRef: string | null) => void;
  selectToolCall: (ref: ScopedThreadRef, target: ToolCallDiffTarget) => void;
  selectTurn: (ref: ScopedThreadRef, turnId: RunId, filePath?: string) => void;
  selectCommit: (ref: ScopedThreadRef, sha: string, keepOnOpen?: boolean) => void;
  consumeKeepSelectionOnOpen: (ref: ScopedThreadRef) => boolean;
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

function branchBaseRef(
  state: Pick<DiffPanelStoreState, "byThreadKey" | "branchBaseRefByThreadKey">,
  threadKey: string,
): string | null {
  const previous = state.byThreadKey[threadKey];
  return previous?.kind === "branch" || previous?.kind === "commit"
    ? previous.baseRef
    : (state.branchBaseRefByThreadKey[threadKey] ?? null);
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      nestedRepositoriesByThreadKey: {},
      keepSelectionOnOpenThreadKey: null,
      selectGitScope: (ref, scope) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const previousBaseRef = branchBaseRef(state, threadKey);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]:
                scope === "branch"
                  ? { kind: "branch", baseRef: previousBaseRef }
                  : { kind: "unstaged" },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch" || previous?.kind === "commit"
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
      // Both skip `set` when nothing changes, since every `set` rewrites the persisted state.
      selectNestedRepositories: (ref, repositories) => {
        const threadKey = scopedThreadKey(ref);
        const previous = get().nestedRepositoriesByThreadKey[threadKey] ?? [];
        if (
          previous.length === repositories.length &&
          previous.every((path, index) => repositories[index] === path)
        ) {
          return;
        }
        set((state) => ({
          nestedRepositoriesByThreadKey: withNestedRepositories(
            state.nestedRepositoriesByThreadKey,
            threadKey,
            repositories,
          ),
        }));
      },
      reconcileNestedRepositories: (ref, available) => {
        const threadKey = scopedThreadKey(ref);
        const previous = get().nestedRepositoriesByThreadKey[threadKey];
        if (!previous) return;
        const next = reconcileNestedRepositorySelection(previous, available);
        if (next.length === previous.length) return;
        set((state) => ({
          nestedRepositoriesByThreadKey: withNestedRepositories(
            state.nestedRepositoriesByThreadKey,
            threadKey,
            next,
          ),
        }));
      },
      selectToolCall: (ref, target) =>
        set((state) => ({
          byThreadKey: {
            ...state.byThreadKey,
            [scopedThreadKey(ref)]: { kind: "tool-call", ...target },
          },
        })),
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
      selectCommit: (ref, sha, keepOnOpen = false) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const baseRef = branchBaseRef(state, threadKey);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "commit", sha, baseRef },
            },
            branchBaseRefByThreadKey: { ...state.branchBaseRefByThreadKey, [threadKey]: baseRef },
            keepSelectionOnOpenThreadKey: keepOnOpen
              ? threadKey
              : state.keepSelectionOnOpenThreadKey,
          };
        }),
      consumeKeepSelectionOnOpen: (ref) => {
        if (get().keepSelectionOnOpenThreadKey !== scopedThreadKey(ref)) return false;
        set({ keepSelectionOnOpenThreadKey: null });
        return true;
      },
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
      }),
    },
  ),
);

interface DiffPanelSessionStoreState {
  collapsedFileKeysByScopeKey: Record<string, ReadonlySet<string>>;
  updateCollapsedFileKeys: (
    scopeKey: string,
    defaults: ReadonlySet<string>,
    update: (current: ReadonlySet<string>) => ReadonlySet<string>,
  ) => void;
}

// Session-only so folds survive right-panel switches without changing reload defaults.
export const useDiffPanelSessionStore = create<DiffPanelSessionStoreState>()((set) => ({
  collapsedFileKeysByScopeKey: {},
  updateCollapsedFileKeys: (scopeKey, defaults, update) =>
    set((state) => {
      const current = state.collapsedFileKeysByScopeKey[scopeKey] ?? defaults;
      const next = update(current);
      if (next === current) return state;
      return {
        collapsedFileKeysByScopeKey: { ...state.collapsedFileKeysByScopeKey, [scopeKey]: next },
      };
    }),
}));

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

export function selectThreadBranchBaseRef(
  state: Pick<DiffPanelStoreState, "byThreadKey" | "branchBaseRefByThreadKey">,
  ref: ScopedThreadRef | null | undefined,
): string | null {
  return ref ? branchBaseRef(state, scopedThreadKey(ref)) : null;
}

export function resolveToolCallDiffTarget(
  target: ToolCallDiffTarget,
  items: ReadonlyArray<ThreadStructureVisibleTurnItem>,
): ToolCallDiffTarget {
  const row = items.find(
    (row) => row.sourceThreadId === target.threadId && row.sourceItemId === target.itemId,
  );
  if (row?.item.type !== "file_change") return target;
  const revision = turnItemDetailRevision(row.item);
  return revision === target.revision ? target : { ...target, revision };
}
