import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SkillRequestPreview } from "./SkillRequestPreview";
import type { SkillRequestCardData } from "../../shared/skill-request";

const request = (extra: Partial<SkillRequestCardData> = {}): SkillRequestCardData => ({
  version: 1,
  requestId: "request",
  botId: "bot",
  threadId: "thread",
  stagedId: "staged",
  action: "update",
  name: "expense-rules",
  gist: "Moves rules out",
  source: "learn:conversation",
  preview: "---\nname: expense-rules\n---\n\nFor edge cases, read references/edge-cases.md.\n",
  sha256: "a".repeat(64),
  warnings: [],
  createdAt: 0,
  ...extra,
});

describe("SkillRequestPreview", () => {
  it("shows every reference file in full beside SKILL.md", () => {
    const html = renderToStaticMarkup(createElement(SkillRequestPreview, {
      request: request({
        references: [{ path: "references/edge-cases.md", content: "# Edge cases\n\n- Receipts over 50 need a manager." }],
        referencesSha256: "b".repeat(64),
      }),
    }));
    expect(html).toContain("Review the complete SKILL.md and its supporting files");
    expect(html).toContain("references/edge-cases.md");
    expect(html).toContain("Receipts over 50 need a manager.");
  });

  it("keeps the SKILL.md-only card unchanged", () => {
    const html = renderToStaticMarkup(createElement(SkillRequestPreview, { request: request() }));
    expect(html).toContain("Review the complete SKILL.md before");
    expect(html).not.toContain("reference files");
  });
  it("shows every binary and executable file with its byte hash and scoped download", () => {
    const html = renderToStaticMarkup(createElement(SkillRequestPreview, { request: request({ directorySha256: "d".repeat(64),
      files: [
        { path: "scripts/run.sh", size: 23, sha256: "b".repeat(64), executable: true, binary: false },
        { path: "assets/data.bin", size: 4, sha256: "c".repeat(64), executable: false, binary: true },
      ], references: [{ path: "scripts/run.sh", content: "<script>untrusted()</script>" }],
    }) }));
    expect(html).toContain("assets/data.bin");
    expect(html).toContain("4 bytes");
    expect(html).toContain("binary");
    expect(html).toContain("executable");
    expect(html).toContain("c".repeat(64));
    expect(html).toContain("/api/bots/bot/staged-skills/staged/files?path=assets%2Fdata.bin");
    expect(html).toContain("&lt;script&gt;untrusted()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

});
