import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SkillCatalog, parseSkillDocument } from "../../src/skill/catalog.ts";

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

test("catalog exposes metadata without score routing and verifies the discovered digest before reading", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-catalog-"));
  try {
    const skillDir = path.join(root, ".codex", "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    const content = "---\nname: demo-skill\ndescription: Demo workflow\ntriggers:\n  - demo\ntags:\n  - test\n---\n# Demo\n";
    await fs.writeFile(path.join(skillDir, "SKILL.md"), content);
    const catalog = new SkillCatalog({ workspaceRoot: root, userRoot: path.join(root, "missing-user") });
    await catalog.refresh();
    const descriptor = catalog.list()[0];
    assert.ok(descriptor);
    assert.equal("match" in catalog, false);
    assert.equal((await catalog.verify("demo-skill")).matchesCatalogDigest, true);
    await fs.appendFile(path.join(skillDir, "SKILL.md"), "changed\n");
    assert.equal((await catalog.verify("demo-skill")).matchesCatalogDigest, false);
    await assert.rejects(() => catalog.read("demo-skill"), /digest changed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
