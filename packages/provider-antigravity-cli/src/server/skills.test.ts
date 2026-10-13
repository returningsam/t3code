import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverAgySkills, rewriteAgySkillMentions } from "./skills.ts";

const writeSkill = Effect.fnUntraced(function* (directory: string, frontmatter: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(directory, "SKILL.md"),
    `---\n${frontmatter}\n---\n\nBody.\n`,
  );
});

describe("discoverAgySkills", () => {
  it.effect("finds user, project, and plugin skills the way agy names them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const cwd = yield* fileSystem.makeTempDirectoryScoped();
      const config = path.join(home, ".gemini", "config");

      yield* writeSkill(
        path.join(config, "skills", "herd-review"),
        "name: herd-review\ndescription: >\n  Review a change\n  with subagents.",
      );
      yield* writeSkill(path.join(cwd, ".agents", "skills", "herd-review"), "name: herd-review");
      yield* writeSkill(path.join(cwd, ".agents", "skills", "release"), "description: Ship it");
      yield* fileSystem.makeDirectory(path.join(cwd, ".agents", "skills", "notes"));

      const wt = path.join(config, "plugins", "wt-folder");
      yield* writeSkill(path.join(wt, "skills", "setup"), "name: setup");
      yield* fileSystem.writeFileString(path.join(wt, "plugin.json"), '{"name":"wt"}');
      const off = path.join(config, "plugins", "off");
      yield* writeSkill(path.join(off, "skills", "hidden"), "name: hidden");
      yield* fileSystem.writeFileString(path.join(off, "plugin.json"), '{"name":"off"}');
      yield* fileSystem.writeFileString(
        path.join(config, "config.json"),
        '{"plugins":{"off":{"enabled":false},"wt":{"enabled":true}}}',
      );

      const skills = yield* discoverAgySkills(cwd, { HOME: home });
      assert.deepEqual(
        skills.map((skill) => [skill.name, skill.scope, skill.description]),
        [
          ["herd-review", "user", "Review a change with subagents."],
          ["release", "project", "Ship it"],
          ["wt:setup", "user", undefined],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns nothing when agy has no skill folders", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      assert.deepEqual(yield* discoverAgySkills(home, { HOME: home }), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("rewriteAgySkillMentions", () => {
  const skills = new Set(["herd-review", "wt:pr", "unslop"]);

  it("leaves a prompt without known skills unchanged", () => {
    assert.equal(rewriteAgySkillMentions("costs $5 and $HOME", skills), "costs $5 and $HOME");
  });

  it("puts every mentioned skill at the front once", () => {
    assert.equal(rewriteAgySkillMentions("$wt:pr fix the bug", skills), "/wt:pr fix the bug");
    assert.equal(
      rewriteAgySkillMentions("$unslop then $herd-review and $unslop", skills),
      "/herd-review /unslop then /herd-review and /unslop",
    );
  });
});
