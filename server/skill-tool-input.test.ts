import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ATTACHMENTS_DIR } from "./attachments.ts";
import { parseSkillToolChanges, readSkillToolAttachment } from "./skill-tool-input.ts";
import { skillFileFromBytes } from "./skill-files.ts";
import type { Message } from "./store.ts";

const noAttachments = async () => { throw new Error("Attachment unavailable"); };

describe("Skill tool file changes", () => {
  it("separates empty writes, explicit removals and omitted content", async () => {
    expect(await parseSkillToolChanges({ files: [{ path: "scripts/__init__.py", content: "" }], remove_files: ["assets/old.csv"] }, noAttachments))
      .toEqual({ files: [{ path: "scripts/__init__.py", content: "" }], removeFiles: ["assets/old.csv"], patch: true });
  });

  it("resolves binary attachments with a controlled reader", async () => {
    const result = await parseSkillToolChanges({ files: [{ path: "assets/input.bin", attachment_id: "owned.bin" }] }, async (id, path, executable) => {
      expect(id).toBe("owned.bin");
      return skillFileFromBytes(path, Buffer.from([0, 255, 1]), executable);
    });
    expect(result).toMatchObject({ files: [{ path: "assets/input.bin", encoding: "base64", content: "AP8B" }], patch: true });
    expect(await parseSkillToolChanges({ files: [{ path: "assets/input.bin", attachment_id: "other.bin" }] }, noAttachments)).toEqual({ error: "Attachment unavailable" });
  });

  it("rejects ambiguous inputs and cross-root paths", async () => {
    for (const body of [
      { files: [{ path: "../secret", content: "x" }] },
      { files: [{ path: "safe", content: "x", attachment_id: "owned" }] },
      { files: [{ path: "safe", content: "x", encoding: "base64" }] },
      { files: [{ path: "same", content: "x" }], remove_files: ["same"] },
      { files: [], remove_files: ["SKILL.md"] },
      { files: [], references: [] },
    ]) expect(await parseSkillToolChanges(body, noAttachments)).toHaveProperty("error");
  });

  it("keeps legacy reference requests in their compatibility path", async () => {
    const result = await parseSkillToolChanges({ skill_md: "entry", references: [{ path: "references/topic.md", content: "" }] }, noAttachments);
    expect(result).toEqual({ files: [{ path: "SKILL.md", content: "entry" }, { path: "references/topic.md", content: "" }] });
    expect(await parseSkillToolChanges({ references: [{ path: "scripts/run.sh", content: "echo no" }] }, noAttachments)).toHaveProperty("error");
  });

  it("reads genuine conversation upload tags and refuses quoted or unrelated attachment paths", async () => {
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const id = `${randomUUID()}.bin`, path = join(ATTACHMENTS_DIR, id);
    writeFileSync(path, Buffer.from([0, 255, 1]));
    const messages = (text: string): Message[] => [{ id: "upload", role: "user", kind: "text", text, at: Date.now() } as Message];
    try {
      const tag = `<attached-file path="${path}" name="input.bin"/>`;
      expect(await readSkillToolAttachment(messages(tag), id, "assets/input.bin", false)).toMatchObject({ encoding: "base64", content: "AP8B" });
      for (const text of [`Example: ${tag}`, `\`\`\`xml\n${tag}\n\`\`\``, "An unrelated message"]) {
        await expect(readSkillToolAttachment(messages(text), id, "assets/input.bin", false)).rejects.toThrow("not in this conversation");
      }
    } finally { rmSync(path, { force: true }); }
  });
});
