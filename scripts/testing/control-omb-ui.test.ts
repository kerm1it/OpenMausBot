import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { removeTempDir } from "../../server/testing/cleanup.ts";
import { resolveUiBrowserBinary } from "./control-omb-ui.ts";

const scratch: string[] = [];
afterAll(async () => { await Promise.all(scratch.map(removeTempDir)); });

it("uses only the pinned or explicit browser engine in forced UI verification", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-ui-engine-"));
  scratch.push(root);
  const pathDir = join(root, "path");
  const pathBinary = join(pathDir, process.platform === "win32" ? "agent-browser.exe" : "agent-browser");
  mkdirSync(pathDir);
  writeFileSync(pathBinary, "fixture");
  chmodSync(pathBinary, 0o700);
  const toolsDir = join(root, "tools");

  expect(resolveUiBrowserBinary({ PATH: pathDir }, toolsDir)).toBe(pathBinary);
  expect(resolveUiBrowserBinary({ PATH: pathDir, OMB_UI_E2E: "1" }, toolsDir)).toBeNull();
  expect(resolveUiBrowserBinary({ PATH: pathDir, OMB_UI_E2E: "1", OMB_AGENT_BROWSER_PATH: pathBinary }, toolsDir)).toBe(pathBinary);
});
