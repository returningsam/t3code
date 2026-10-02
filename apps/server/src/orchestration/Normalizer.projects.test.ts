// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CommandId, ProjectId, type ClientOrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const testLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-projects-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

function makeWtContainer(wtFile: string | null): string {
  const container = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wt-")));
  NodeFS.mkdirSync(NodePath.join(container, "main"));
  if (wtFile !== null) NodeFS.writeFileSync(NodePath.join(container, ".wt"), wtFile);
  return container;
}

function projectCreate(workspaceRoot: string, title: string): ClientOrchestrationCommand {
  return {
    type: "project.create",
    commandId: CommandId.make("command-1"),
    projectId: ProjectId.make("project-1"),
    title,
    workspaceRoot,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

const titleFor = (workspaceRoot: string, title: string) =>
  normalizeDispatchCommand(projectCreate(workspaceRoot, title)).pipe(
    Effect.map((command) => (command.type === "project.create" ? command.title : null)),
  );

describe("normalizeDispatchCommand project.create", () => {
  it.effect("titles a wt layout project after its .wt name instead of its folder", () =>
    Effect.gen(function* () {
      const container = makeWtContainer("[wt]\n\tname = bk-rail\n");
      expect(yield* titleFor(NodePath.join(container, "main"), "main")).toBe("bk-rail");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a title the user typed", () =>
    Effect.gen(function* () {
      const container = makeWtContainer("[wt]\n\tname = bk-rail\n");
      expect(yield* titleFor(NodePath.join(container, "main"), "Brooklyn Rail")).toBe(
        "Brooklyn Rail",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps the folder title without a .wt marker", () =>
    Effect.gen(function* () {
      const container = makeWtContainer(null);
      expect(yield* titleFor(NodePath.join(container, "main"), "main")).toBe("main");
    }).pipe(Effect.provide(testLayer)),
  );
});
