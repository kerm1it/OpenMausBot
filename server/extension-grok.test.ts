import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, expect, it } from "vitest";
import { parseSkillMd } from "../shared/skill-md.ts";
import { prepareGrokRecipe } from "./extension-grok.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const directory = mkdtempSync(join(tmpdir(), "omb-grok-skills-")); roots.push(directory); return directory; };
const body = "# Design a Grok Bot\n\nRead `assets/example.bin` and run `scripts/check.sh`.\n";
const frontmatter = "name: Design a Grok Bot\ndescription: >-\n  Design a focused bot,\n  then verify its configuration.\nlicense: MIT\nmetadata:\n  author: Example\n";
const content = `---\n${frontmatter}---\n${body}`;

it("normalizes Grok display names and folded descriptions while retaining the complete Skill", async () => {
  const draft = await prepareGrokRecipe({ name: "Grok fixture", skills: [{ name: "Design a Grok Bot", content, files: [
    { path: "assets/example.bin", content: "AP8D", encoding: "base64" },
    { path: "scripts/check.sh", content: "#!/bin/sh\necho checked\n", executable: true },
  ] }] }, root(), "grok-bot");
  expect(draft.skills).toHaveLength(1);
  const skill = draft.skills[0]!;
  expect(skill).toMatchObject({ name: "design-a-grok-bot", description: "Design a focused bot, then verify its configuration.", path: "skills/design-a-grok-bot/SKILL.md" });
  const md = readFileSync(join(skill.directory, "SKILL.md"), "utf8");
  expect(parseSkillMd(md)).toMatchObject({ name: skill.name, description: skill.description, license: "MIT", body });
  expect(md).toContain("author: Example");
  expect(readFileSync(join(skill.directory, "assets/example.bin"))).toEqual(Buffer.from([0, 255, 3]));
  expect(readFileSync(join(skill.directory, "scripts/check.sh"), "utf8")).toBe("#!/bin/sh\necho checked\n");
});

it("normalizes downloaded Grok Skill frontmatter without changing its body", async () => {
  const archive = zipSync({"repo-main/design/SKILL.md": strToU8(content)});
  const fetcher: typeof fetch = async input => {
    if (String(input) !== "https://codeload.github.com/fixture/skills/zip/main") throw new Error(`Unexpected request ${input}`);
    return new Response(archive);
  };
  const draft = await prepareGrokRecipe({ name: "Remote Grok fixture", skills: [{ name: "Design a Grok Bot", sourceUrl: "https://github.com/fixture/skills/tree/main/design" }] }, root(), "grok-bot", fetcher);
  expect(draft.skills[0]).toMatchObject({ name: "design-a-grok-bot", description: "Design a focused bot, then verify its configuration." });
  expect(parseSkillMd(readFileSync(join(draft.skills[0]!.directory, "SKILL.md"), "utf8"))).toMatchObject({ body });
});

it("preserves already portable Skill markdown byte for byte", async () => {
  const content = `---\nname: portable\ndescription: Portable Skill\nlicense: MIT\n---\n${body}`;
  const draft = await prepareGrokRecipe({ name: "Grok fixture", skills: [{ name: "portable", content }] }, root(), "grok-bot");
  expect(readFileSync(join(draft.skills[0]!.directory, "SKILL.md"), "utf8")).toBe(content);
});

it("rejects malformed Skill YAML instead of discarding its metadata", async () => {
  await expect(prepareGrokRecipe({ name: "Grok fixture", skills: [{ name: "broken", content: "---\nname: [broken\ndescription: invalid YAML\n---\nBody\n" }] }, root(), "grok-bot")).rejects.toThrow("Grok skill broken");
});
