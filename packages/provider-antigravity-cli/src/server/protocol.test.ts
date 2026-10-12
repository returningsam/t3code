import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  agyDeniedActionsNotice,
  agyLaunchArgs,
  isAgySignedOutOutput,
  parseAgyEvent,
  parseAgyModels,
  resolveAgyLaunch,
} from "./protocol.ts";

const readFixture = (name: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fileSystem.readFileString(
      yield* path.fromFileUrl(new URL(`./fixtures/${name}`, import.meta.url)),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const selection = (model: string, effort?: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("antigravityCli"),
  model,
  ...(effort === undefined ? {} : { options: [{ id: "effort", value: effort }] }),
});

describe("agy launch arguments", () => {
  it("skips agy's permission checks only in full access", () => {
    const launch = { model: undefined, effort: undefined } as const;
    assert.notInclude(
      agyLaunchArgs({ ...launch, runtimeMode: "approval-required" }),
      "--dangerously-skip-permissions",
    );
    assert.include(
      agyLaunchArgs({ ...launch, runtimeMode: "full-access" }),
      "--dangerously-skip-permissions",
    );
  });

  it("reads turns from stdin rather than taking a flag as the prompt", () => {
    const args = agyLaunchArgs(
      { model: "opus-5.5", effort: "high", runtimeMode: "approval-required" },
      "8959616d-63e2-4b3c-aea8-624c7e14633a",
    );
    assert.include(args, "-p=");
    assert.notInclude(args, "-p");
    assert.equal(args[args.indexOf("--conversation") + 1], "8959616d-63e2-4b3c-aea8-624c7e14633a");
  });
});

describe("agy models", () => {
  it.effect("groups effort variants into one model with an effort option", () =>
    Effect.gen(function* () {
      const models = parseAgyModels(yield* readFixture("models.txt"));
      assert.deepEqual(
        models.map((model) => [model.slug, model.name]),
        [
          ["gemini-3.8-flash", "Gemini 3.8 Flash"],
          ["gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"],
          ["gemini-3.1-pro-high", "Gemini 3.1 Pro"],
          ["opus-5.5", "Claude Opus 5.5"],
        ],
      );
      const effort = (slug: string) => {
        const descriptor = models
          .find((model) => model.slug === slug)
          ?.capabilities?.optionDescriptors?.find((candidate) => candidate.id === "effort");
        return descriptor?.type === "select"
          ? descriptor.options.map((option) => `${option.id}${option.isDefault ? "*" : ""}`)
          : [];
      };
      assert.deepEqual(effort("gemini-3.8-flash"), ["low", "medium", "high*"]);
      assert.deepEqual(effort("opus-5.5"), ["low", "medium", "high*", "max"]);
      assert.deepEqual(effort("gemini-3.1-pro-high"), []);
    }),
  );

  it.effect("passes the selected effort, or the model's default", () =>
    Effect.gen(function* () {
      const models = parseAgyModels(yield* readFixture("models.txt"));
      const launch = (modelSelection: ModelSelection) =>
        resolveAgyLaunch({ modelSelection, runtimeMode: "full-access", models });
      assert.deepInclude(launch(selection("opus-5.5", "max")), {
        model: "opus-5.5",
        effort: "max",
      });
      assert.deepInclude(launch(selection("opus-5.5")), { model: "opus-5.5", effort: "high" });
      assert.deepInclude(launch(selection("opus-5.5", "xhigh")), {
        model: "opus-5.5",
        effort: "high",
      });
      assert.deepInclude(launch(selection("gemini-3.1-pro-high", "high")), {
        model: "gemini-3.1-pro-high",
        effort: undefined,
      });
      assert.deepInclude(launch(selection("default")), { model: undefined, effort: undefined });
    }),
  );

  it("keeps a valid selected effort before agy's models load", () => {
    const launch = (modelSelection: ModelSelection) =>
      resolveAgyLaunch({ modelSelection, runtimeMode: "full-access", models: [] });
    assert.deepInclude(launch(selection("opus-5.5", "max")), { model: "opus-5.5", effort: "max" });
    assert.deepInclude(launch(selection("opus-5.5", "turbo")), { effort: undefined });
  });
});

describe("agy events", () => {
  it.effect("parses every line of a recorded turn", () =>
    Effect.gen(function* () {
      const lines = (yield* readFixture("full-access-command.ndjson")).trim().split("\n");
      const events = lines.map(parseAgyEvent);
      assert.isTrue(events.every((event) => event !== undefined));
      assert.equal(events[0]?.event, "init");
      assert.equal(events.at(-1)?.event, "result");
    }),
  );

  it("skips plain text and unknown events", () => {
    assert.isUndefined(parseAgyEvent("error: interrupted"));
    assert.isUndefined(parseAgyEvent('{"event":"heartbeat"}'));
  });

  it("suggests full access only where it would allow the denied action", () => {
    const denied = [{ action: "command", display_name: "RunCommand" }];
    const suggesting = agyDeniedActionsNotice(denied, { suggestFullAccess: true });
    const plain = agyDeniedActionsNotice(denied, { suggestFullAccess: false });
    assert.include(suggesting, "RunCommand");
    assert.include(suggesting, "Full access");
    assert.include(plain, "RunCommand");
    assert.notInclude(plain, "Full access");
    assert.isUndefined(agyDeniedActionsNotice([], { suggestFullAccess: true }));
  });

  it("recognizes agy's signed-out output", () => {
    assert.isTrue(
      isAgySignedOutOutput(
        "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.",
      ),
    );
    assert.isTrue(isAgySignedOutOutput("authentication failed or timed out"));
    assert.isFalse(isAgySignedOutOutput("invalid model selection"));
    assert.isFalse(isAgySignedOutOutput("Add a step to sign in the user"));
  });
});
