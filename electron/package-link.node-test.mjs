import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { packageInstallFromCommandLine, packageInstallFromDeepLink, packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";
import { extensionImportFromLink, isExtensionImportRequest } from "../shared/extension-link.mjs";

describe("BotMRR package deep links", () => {
  it("accepts a public GitHub package URL", () => {
    const target = "https://raw.githubusercontent.com/acme/bots/main/reddit-lead-miner.md";
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent(target)}`), target);
    assert.equal(packageUrlFromCommandLine(["OpenMausBot", "--flag", `openmausbot://install?url=${encodeURIComponent(target)}`]), target);
  });

  it("accepts a Grok Bot share link as its canonical x.ai address", () => {
    const share = "https://x.ai/bot/d8OshqLZvtcKDcNluPuyo";
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent(share)}`), share);
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent("https://www.x.ai/bot/d8OshqLZvtcKDcNluPuyo/?ref=x")}`), share);
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent("http://x.ai/bot/d8OshqLZvtcKDcNluPuyo")}`), null);
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent("https://x.ai.evil.example/bot/d8OshqLZvtcKDcNluPuyo")}`), null);
    assert.equal(packageUrlFromDeepLink(`openmausbot://install?url=${encodeURIComponent("https://x.ai/bot/marketplace")}`), null);
  });

  it("rejects other commands, hosts, protocols, credentials, and unsupported file types", () => {
    assert.equal(packageUrlFromDeepLink("openmausbot://settings"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://evil.example/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=http://raw.githubusercontent.com/a/b/main/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://user@example.com/bot.json"), null);
    assert.equal(packageUrlFromDeepLink("openmausbot://install?url=https://github.com/acme/bot/run.sh"), null);
  });
});

describe("extension import links", () => {
  it("delivers all four marketplace resource types as complete requests", () => {
    const cases = [
      { type: "bot", source: "openmausbot", id: "research-assistant" },
      { type: "plugin", source: "openmausbot", id: "pstack" },
      { type: "bot", source: "grok-bot", id: "d8OshqLZvtcKDcNluPuyo" },
      { type: "plugin", source: "grok-bot", id: "9717366" },
    ];
    for (const expected of cases) {
      const link = `openmausbot://app/v1/import?${new URLSearchParams(expected)}`;
      assert.deepEqual(packageInstallFromDeepLink(link), expected);
      assert.deepEqual(packageInstallFromCommandLine(["OpenMausBot", "--flag", link]), expected);
    }
  });

  it("preserves an encoded download URL without requiring a marketplace address", () => {
    const url = "https://github.com/acme/bots/tree/feature/report?view=source";
    const expected = { type: "bot", source: "openmausbot", url };
    assert.deepEqual(extensionImportFromLink(`openmausbot://app/v1/import?${new URLSearchParams(expected)}`), expected);
    assert.equal(isExtensionImportRequest(expected), true);
  });

  it("recognizes original Grok bot and plugin links without copying Slack context", () => {
    assert.deepEqual(extensionImportFromLink("grokbot://app/v1/bot-template?id=d8OshqLZvtcKDcNluPuyo&open=1"), { type: "bot", source: "grok-bot", id: "d8OshqLZvtcKDcNluPuyo" });
    assert.deepEqual(extensionImportFromLink("grokbot://app/v1/plugin/add?id=9717366&team=T1&channel=C1&threadTs=1.1"), { type: "plugin", source: "grok-bot", id: "9717366" });
    assert.deepEqual(extensionImportFromLink("https://x.ai/bot/plugin/9717366"), { type: "plugin", source: "grok-bot", id: "9717366" });
  });

  it("rejects ambiguous or malformed requests and preserves the legacy package delivery", () => {
    for (const query of [
      "type=bot&source=openmausbot", "type=bot&source=openmausbot&id=a&url=https://example.test/a.zip",
      "type=plugin&source=grok-bot&id=pstack", "type=bot&source=openmausbot&id=../a",
      "type=bot&source=openmausbot&id=a&id=b", "type=bot&source=unknown&id=a",
      "type=plugin&source=openmausbot&url=file:///tmp/plugin", "type=bot&source=openmausbot&id=a&execute=1",
    ]) assert.equal(extensionImportFromLink(`openmausbot://app/v1/import?${query}`), null);
    const url = "https://raw.githubusercontent.com/acme/bots/main/team.json";
    assert.equal(packageInstallFromDeepLink(`openmausbot://install?url=${encodeURIComponent(url)}`), url);
  });
});
