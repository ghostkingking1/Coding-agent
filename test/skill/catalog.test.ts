import assert from "node:assert/strict";
import test from "node:test";
import { parseSkillDocument } from "../../src/skill/catalog.ts";

test("skill parser uses gray-matter for the document split and yaml for nested front matter", () => {
  const parsed = parseSkillDocument(`---\nname: nested-skill\ndescription: A skill with nested YAML\nversion: 1.2.3\ntriggers:\n  - nested input\ntags: [yaml, workflow]\ninput:\n  type: object\n  properties:\n    path:\n      type: string\n---\n# Instructions\n\nUse the provided path.\n`);

  assert.deepEqual(parsed.diagnostics, []);
  assert.equal(parsed.frontmatter.name, "nested-skill");
  assert.deepEqual(parsed.frontmatter.triggers, ["nested input"]);
  assert.deepEqual(parsed.frontmatter.tags, ["yaml", "workflow"]);
  assert.deepEqual(parsed.frontmatter.input, {
    type: "object",
    properties: { path: { type: "string" } },
  });
  assert.equal(parsed.content, "# Instructions\n\nUse the provided path.\n");
});
test("skill parser reports missing or malformed front matter without throwing", () => {
  const missing = parseSkillDocument("# Instructions\n");
  assert.deepEqual(missing.frontmatter, {});
  assert.equal(missing.content, "# Instructions\n");
  assert.deepEqual(missing.diagnostics, ["SKILL.md must start with YAML frontmatter"]);

  const unterminated = parseSkillDocument("---\nname: broken\n# body\n");
  assert.deepEqual(unterminated.diagnostics, ["YAML frontmatter is not terminated"]);

  const malformed = parseSkillDocument("---\nname: broken\ndescription: [not closed\n---\nbody\n");
  assert.equal(malformed.frontmatter.name, undefined);
  assert.match(malformed.diagnostics[0] ?? "", /^invalid YAML frontmatter:/);
  assert.equal(malformed.content, "---\nname: broken\ndescription: [not closed\n---\nbody\n");
});
