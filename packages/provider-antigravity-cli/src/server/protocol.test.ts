import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  agyDeniedActionsNotice,
  agyLaunchArgs,
  agyUserMessageLine,
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
  it("runs agy's own model and rules in supervised mode", () => {
    assert.deepEqual(
      agyLaunchArgs({
        model: undefined,
        effort: undefined,
        runtimeMode: "approval-required",
        interactionMode: "default",
      }),
      ["--input-format", "stream-json", "--output-format", "stream-json", "-p="],
    );
  });

  it("resumes the conversation with the selected model in full access", () => {
    assert.deepEqual(
      agyLaunchArgs(
        {
          model: "opus-5.5",
          effort: "high",
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        "8959616d-63e2-4b3c-aea8-624c7e14633a",
      ),
      [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--conversation",
        "8959616d-63e2-4b3c-aea8-624c7e14633a",
        "--model",
        "opus-5.5",
        "--effort",
        "high",
        "--dangerously-skip-permissions",
        "-p=",
      ],
    );
  });

  it("keeps agy's permission rules in plan mode", () => {
    const args = agyLaunchArgs({
      model: undefined,
      effort: undefined,
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
    assert.includeMembers(args, ["--mode", "plan"]);
    assert.notInclude(args, "--dangerously-skip-permissions");
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
        resolveAgyLaunch({
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          models,
        });
      assert.deepInclude(launch(selection("opus-5.5", "max")), {
        model: "opus-5.5",
        effort: "max",
      });
      assert.deepInclude(launch(selection("opus-5.5")), { model: "opus-5.5", effort: "high" });
      assert.deepInclude(launch(selection("opus-5.5", "xhigh")), {
        model: "opus-5.5",
        effort: "high",
      });
      assert.deepInclude(launch(selection("gemini-3.5-flash-lite", "high")), {
        model: "gemini-3.5-flash-lite",
        effort: undefined,
      });
      assert.deepInclude(launch(selection("default")), { model: undefined, effort: undefined });
    }),
  );
});

describe("agy events", () => {
  it.effect("parses every line of a recorded turn", () =>
    Effect.gen(function* () {
      const lines = (yield* readFixture("full-access-command.ndjson")).trim().split("\n");
      const events = lines.map(parseAgyEvent);
      assert.deepEqual(
        events.map((event) => event?.event),
        [
          "init",
          "step_update",
          "step_update",
          "step_update",
          "step_update",
          "step_update",
          "step_update",
          "step_update",
          "step_update",
          "step_update",
          "result",
        ],
      );
      const tool = events.find(
        (event) =>
          event?.event === "step_update" &&
          event.step_update.state === "DONE" &&
          event.step_update.step_type === "tool",
      );
      assert.deepInclude(tool?.event === "step_update" ? tool.step_update.tool_info : undefined, {
        parameters: { CommandLine: "ls" },
        output: "a.txt\r\n",
      });
    }),
  );

  it("skips plain text and unknown events", () => {
    assert.isUndefined(parseAgyEvent("error: interrupted"));
    assert.isUndefined(parseAgyEvent('{"event":"heartbeat"}'));
  });

  it("writes the only user message shape agy accepts", () => {
    assert.equal(
      agyUserMessageLine("say ok"),
      '{"event":"user","message":{"role":"user","content":[{"type":"text","text":"say ok"}]}}\n',
    );
  });

  it.effect("names denied actions and when full access would allow them", () =>
    Effect.gen(function* () {
      const result = parseAgyEvent(
        (yield* readFixture("denied-command.ndjson")).trim().split("\n").at(-1) ?? "",
      );
      const denied = result?.event === "result" ? (result.result.denied_actions ?? []) : [];
      assert.equal(
        agyDeniedActionsNotice(denied, { suggestFullAccess: true }),
        "agy blocked RunCommand: it cannot ask for approval when T3 Code runs it. Full access allows these actions, or add allow rules to agy's settings.",
      );
      assert.equal(
        agyDeniedActionsNotice(denied, { suggestFullAccess: false }),
        "agy blocked RunCommand: it cannot ask for approval when T3 Code runs it.",
      );
      assert.isUndefined(agyDeniedActionsNotice([], { suggestFullAccess: true }));
    }),
  );

  it("recognizes agy's signed-out output", () => {
    assert.isTrue(
      isAgySignedOutOutput(
        "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.",
      ),
    );
    assert.isTrue(isAgySignedOutOutput("authentication failed or timed out"));
    assert.isFalse(isAgySignedOutOutput("invalid model selection"));
  });
});
