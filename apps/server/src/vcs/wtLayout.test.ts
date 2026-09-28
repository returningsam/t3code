import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { parseWtLayoutFile, resolveWtLayout } from "./wtLayout.ts";

describe("parseWtLayoutFile", () => {
  it("reads wt.name", () => {
    assert.deepEqual(parseWtLayoutFile("[wt]\n\tname = bk-rail\n\tproject = brooklynrail/1\n"), {
      name: "bk-rail",
    });
  });

  it("unquotes values and drops trailing comments", () => {
    assert.deepEqual(parseWtLayoutFile('[wt]\n\tname = "Newark Arts" # shown in T3\n'), {
      name: "Newark Arts",
    });
  });

  it("ignores name keys in other sections", () => {
    assert.deepEqual(parseWtLayoutFile("[other]\n\tname = nope\n[WT]\n\tNAME = yes\n"), {
      name: "yes",
    });
    assert.deepEqual(parseWtLayoutFile("[other]\n\tname = nope\n"), { name: null });
  });
});

describe("resolveWtLayout", () => {
  it.effect("finds the marker from the main checkout and from a worktree", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const container = yield* fileSystem.makeTempDirectoryScoped({ prefix: "wt-layout-" });
      yield* fileSystem.writeFileString(path.join(container, ".wt"), "[wt]\n\tname = demo\n");

      const expected = { container, name: "demo" };
      assert.deepEqual(
        yield* resolveWtLayout(fileSystem, path, path.join(container, "main")),
        expected,
      );
      assert.deepEqual(
        yield* resolveWtLayout(fileSystem, path, path.join(container, "worktrees", "wt-foo")),
        expected,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns null for a main folder without a marker", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const container = yield* fileSystem.makeTempDirectoryScoped({ prefix: "wt-layout-" });

      assert.equal(yield* resolveWtLayout(fileSystem, path, path.join(container, "main")), null);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
