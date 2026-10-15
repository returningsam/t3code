import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

function layer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
  readonly nestedRepositories?: ReadonlyArray<string>;
  readonly readNestedChangeTotals?: GitVcsDriver.GitVcsDriver["Service"]["readNestedChangeTotals"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        findNestedRepositories: () => Effect.succeed(input.nestedRepositories ?? []),
        readNestedChangeTotals: input.readNestedChangeTotals ?? (() => Effect.succeed([])),
      }),
    ),
    Layer.provide(
      Layer.mock(GitManager.GitManager)({
        invalidateLocalStatus: () => Effect.void,
        invalidateStatus: () => Effect.void,
      }),
    ),
  );
}

// Each read of the nested totals reports its call number, and totals that count the calls.
const countedNestedChangeTotals = Effect.gen(function* () {
  const calls = yield* Queue.unbounded<number>();
  let count = 0;
  const read: GitVcsDriver.GitVcsDriver["Service"]["readNestedChangeTotals"] = () =>
    Effect.sync(() => ++count).pipe(
      Effect.tap((call) => Queue.offer(calls, call)),
      Effect.map((call) => [{ path: "main", totals: { insertions: call, deletions: 0 } }]),
    );
  return { calls, read };
});

describe("GitWorkflowService", () => {
  it.effect("reports a non-Git VCS repository as not a Git repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const isRepository = yield* workflow.isRepository("/jj-repo");

      assert.equal(isRepository, false);
    }).pipe(
      Effect.provide(
        layer({
          detect: () =>
            Effect.succeed({
              kind: "jj",
              repository: {
                kind: "jj",
                rootPath: "/jj-repo",
                metadataPath: "/jj-repo/.jj",
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
    ),
  );

  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("reports nested repositories below a folder that is not a repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const local = yield* workflow.localStatus({ cwd: "/checkouts" });
      const full = yield* workflow.status({ cwd: "/checkouts" });

      assert.isFalse(local.isRepo);
      assert.isTrue(local.hasNestedRepositories);
      assert.isTrue(full.hasNestedRepositories);
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
          nestedRepositories: ["main", "worktrees/wt-a"],
        }),
      ),
    ),
  );

  it.effect("reuses the totals of nested repositories' edits across status reads", () => {
    const readNestedChangeTotals = vi.fn((cwd: string, repositories: ReadonlyArray<string>) =>
      Effect.succeed([
        { path: "main", totals: { insertions: cwd.length, deletions: repositories.length } },
      ]),
    );
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const local = yield* workflow.localStatus({ cwd: "/checkouts" });
      const full = yield* workflow.status({ cwd: "/checkouts" });

      const expected = { baseRef: null, insertions: "/checkouts".length, deletions: 2 };
      assert.deepStrictEqual(local.branchChanges, expected);
      assert.deepStrictEqual(full.branchChanges, expected);
      assert.equal(readNestedChangeTotals.mock.calls.length, 1);
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
          nestedRepositories: ["main", "worktrees/wt-a"],
          readNestedChangeTotals,
        }),
      ),
    );
  });

  it.effect("reports each nested repository's totals in the review's order with their sum", () => {
    const changes = [
      { path: "worktrees/wt-a", totals: { insertions: 3, deletions: 1 } },
      { path: "main", totals: { insertions: 2, deletions: 0 } },
    ];
    const readNestedChangeTotals = vi.fn(() => Effect.succeed(changes));
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const local = yield* workflow.localStatus({ cwd: "/checkouts" });
      const full = yield* workflow.status({ cwd: "/checkouts" });

      assert.deepStrictEqual(local.nestedRepositoryChanges, changes);
      assert.deepStrictEqual(full.nestedRepositoryChanges, changes);
      assert.deepStrictEqual(local.branchChanges, { baseRef: null, insertions: 5, deletions: 1 });
      assert.equal(readNestedChangeTotals.mock.calls.length, 1);
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
          nestedRepositories: ["main", "worktrees/wt-a"],
          readNestedChangeTotals,
        }),
      ),
    );
  });

  it.effect("keeps a nested repository too large to count but leaves out the sum", () => {
    const changes = [
      { path: "main", totals: null },
      { path: "worktrees/wt-a", totals: { insertions: 3, deletions: 1 } },
    ];
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const local = yield* workflow.localStatus({ cwd: "/checkouts" });

      assert.deepStrictEqual(local.nestedRepositoryChanges, changes);
      assert.isUndefined(local.branchChanges);
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
          nestedRepositories: ["main", "worktrees/wt-a"],
          readNestedChangeTotals: () => Effect.succeed(changes),
        }),
      ),
    );
  });

  it.effect("reads nested totals again after a status refresh invalidates them", () =>
    Effect.gen(function* () {
      const totals = yield* countedNestedChangeTotals;
      yield* Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const first = yield* workflow.localStatus({ cwd: "/checkouts" });
        yield* workflow.invalidateLocalStatus("/checkouts");
        const second = yield* workflow.localStatus({ cwd: "/checkouts" });

        assert.deepStrictEqual(first.branchChanges, { baseRef: null, insertions: 1, deletions: 0 });
        assert.deepStrictEqual(second.branchChanges, {
          baseRef: null,
          insertions: 2,
          deletions: 0,
        });
        assert.deepStrictEqual(second.nestedRepositoryChanges, [
          { path: "main", totals: { insertions: 2, deletions: 0 } },
        ]);
        assert.deepStrictEqual(
          [yield* Queue.take(totals.calls), yield* Queue.take(totals.calls)],
          [1, 2],
        );
      }).pipe(
        Effect.provide(
          layer({
            detect: () => Effect.succeed(null),
            nestedRepositories: ["main"],
            readNestedChangeTotals: totals.read,
          }),
        ),
      );
    }),
  );

  it.effect("shows the last nested totals while a refreshed read outlasts the wait", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      let calls = 0;
      const readNestedChangeTotals = vi.fn(() => {
        calls += 1;
        const changes = (insertions: number) => [
          { path: "main", totals: { insertions, deletions: 0 } },
        ];
        return calls === 1
          ? Effect.succeed(changes(1))
          : Deferred.await(gate).pipe(Effect.as(changes(2)));
      });
      yield* Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const first = yield* workflow.localStatus({ cwd: "/checkouts" });
        yield* workflow.invalidateLocalStatus("/checkouts");
        const slow = yield* workflow.localStatus({ cwd: "/checkouts" }).pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.seconds(2));
        const second = yield* Fiber.join(slow);

        assert.deepStrictEqual(second.branchChanges, first.branchChanges);
        assert.deepStrictEqual(second.nestedRepositoryChanges, first.nestedRepositoryChanges);
      }).pipe(
        Effect.provide(
          layer({
            detect: () => Effect.succeed(null),
            nestedRepositories: ["main"],
            readNestedChangeTotals,
          }),
        ),
      );
    }),
  );

  it.effect("reads nested totals again once they expire", () =>
    Effect.gen(function* () {
      const totals = yield* countedNestedChangeTotals;
      yield* Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.localStatus({ cwd: "/checkouts" });
        yield* TestClock.adjust(Duration.seconds(30));
        yield* workflow.localStatus({ cwd: "/checkouts" });

        assert.deepStrictEqual(
          [yield* Queue.take(totals.calls), yield* Queue.take(totals.calls)],
          [1, 2],
        );
      }).pipe(
        Effect.provide(
          layer({
            detect: () => Effect.succeed(null),
            nestedRepositories: ["main"],
            readNestedChangeTotals: totals.read,
          }),
        ),
      );
    }),
  );

  it.effect("keeps reading nested totals that outlast a status read", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const readNestedChangeTotals = vi.fn(() =>
        Deferred.await(gate).pipe(
          Effect.as([{ path: "main", totals: { insertions: 3, deletions: 1 } }]),
        ),
      );
      yield* Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const early = yield* workflow.localStatus({ cwd: "/checkouts" }).pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.seconds(2));
        const first = yield* Fiber.join(early);
        const late = yield* workflow.localStatus({ cwd: "/checkouts" }).pipe(Effect.forkChild);
        yield* Deferred.succeed(gate, undefined);
        const second = yield* Fiber.join(late);

        assert.isTrue(first.hasNestedRepositories);
        assert.isUndefined(first.branchChanges);
        assert.isUndefined(first.nestedRepositoryChanges);
        assert.deepStrictEqual(second.branchChanges, {
          baseRef: null,
          insertions: 3,
          deletions: 1,
        });
        assert.equal(readNestedChangeTotals.mock.calls.length, 1);
      }).pipe(
        Effect.provide(
          layer({
            detect: () => Effect.succeed(null),
            nestedRepositories: ["main"],
            readNestedChangeTotals,
          }),
        ),
      );
    }),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const layerTest = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          findNestedRepositories: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("rejects a stacked action outside a Git repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow
        .runStackedAction({ actionId: "action-1", cwd: "/not-a-repo", action: "commit" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.runStackedAction",
        cwd: "/not-a-repo",
        detail: "/not-a-repo is not a Git repository.",
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("rejects a Git command outside a Git repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.pullCurrentBranch("/not-a-repo").pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.pullCurrentBranch",
        command: "vcs-route",
        cwd: "/not-a-repo",
        reason: "not_a_repository",
        detail: "This directory is not a Git repository.",
      });
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        layer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              detect: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
