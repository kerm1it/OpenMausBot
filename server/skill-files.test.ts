import { expect, it, vi } from "vitest";
import { prepareSkillFiles, skillDirectorySha256 } from "./skill-files.ts";

it("normalizes unsupported executable bits before a Windows directory revision is hashed", () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  try {
    const files = [
      { path: "SKILL.md", content: "---\nname: portable\ndescription: Portable fixture\n---\nRun scripts/check.py.\n" },
      { path: "scripts/check.py", content: "print('portable')\n", executable: true },
    ];
    const prepared = prepareSkillFiles(files);
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.files[1]).toEqual({ path: "scripts/check.py", content: "print('portable')\n" });
    expect(skillDirectorySha256(prepared.files)).toBe(skillDirectorySha256(files.map(({ executable: _executable, ...file }) => file)));
  } finally { vi.unstubAllGlobals(); }
});
