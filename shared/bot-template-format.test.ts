import { describe, expect, it } from "vitest";
import { botExtensionSchema, botTemplateProfileSchema, botTemplateRoutineSchema, templatePathSchema } from "./bot-template-format.ts";

const manifest = {
  schemaVersion: 1, id: "research", name: { en: "Research" }, summary: { en: "Research help" },
  publisher: { name: "Example" }, category: "research", tags: [], plugins: [],
  entrypoints: { profile: { path: "profile.json" }, memory: [], routines: [], skills: [{ path: "skills/research/SKILL.md" }] },
};

describe("portable bot extension contracts", () => {
  it("accepts entry points without requiring an inventory of supporting files", () => {
    expect(botExtensionSchema.parse(manifest).entrypoints.skills[0]!.path).toBe("skills/research/SKILL.md");
    expect(botExtensionSchema.safeParse({ ...manifest, files: [] }).success).toBe(false);
  });

  it("requires explicit HTTP sources and preserves the plugin identity", () => {
    const dependency = { id: "pstack", optional: false, source: "https://github.com/cursor/plugins/tree/main/pstack" };
    expect(botExtensionSchema.parse({ ...manifest, plugins: [dependency] }).plugins).toEqual([dependency]);
    for (const source of ["/tmp/pstack", "file:///tmp/pstack", "https://user:secret@example.test/plugin.zip"]) {
      expect(botExtensionSchema.safeParse({ ...manifest, plugins: [{ ...dependency, source }] }).success).toBe(false);
    }
  });

  it("only accepts paths within the resource root", () => {
    for (const path of ["../secret", "/tmp/key", "C:/Users/key", "assets/../../key", "assets\\key", "assets//key"]) {
      expect(templatePathSchema.safeParse(path).success, path).toBe(false);
    }
    expect(templatePathSchema.parse("skills/research/assets/input.docx")).toBe("skills/research/assets/input.docx");
  });

  it("rejects runtime identities and grants in a portable profile", () => {
    const profile = { schemaVersion: 1, profile: { name: "Research", soul: "Read references first." } };
    expect(botTemplateProfileSchema.parse(profile).profile.name).toBe("Research");
    for (const forbidden of [{ id: "old-bot" }, { cwd: "/Users/example" }, { approvalMode: "full" }, { modelSelection: { instanceId: "codex" } }]) {
      expect(botTemplateProfileSchema.safeParse({ ...profile, profile: { ...profile.profile, ...forbidden } }).success).toBe(false);
    }
    expect(botTemplateProfileSchema.safeParse({ schemaVersion: 1, profile: { name: "Research", soul: "界".repeat(8001) } }).success).toBe(false);
  });

  it("keeps routine attachment paths portable and never carries live enablement", () => {
    const routine = {
      schemaVersion: 1, name: "Report", prompt: "Read the input and prepare a report.",
      schedule: { type: "cron", expression: "0 9 * * 1-5", timeZone: "Asia/Shanghai" },
      attachments: [{ path: "assets/routines/input.csv", name: "input.csv", kind: "file" }],
    };
    expect(botTemplateRoutineSchema.parse(routine).attachments?.[0]!.path).toBe("assets/routines/input.csv");
    expect(botTemplateRoutineSchema.safeParse({ ...routine, enabled: true }).success).toBe(false);
    expect(botTemplateRoutineSchema.safeParse({ ...routine, botId: "existing" }).success).toBe(false);
    expect(botTemplateRoutineSchema.safeParse({ ...routine, attachments: [{ ...routine.attachments[0], path: "/tmp/private.csv" }] }).success).toBe(false);
  });
});
