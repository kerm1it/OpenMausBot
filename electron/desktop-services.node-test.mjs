import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const local = "http://127.0.0.1:18799";
const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const removed = ["cloudAccount", "cloudPlan", "cloudAdd", "cloudSendPage", "cloudSync", "home", "organization", "companyBackups", "twoPlaces", "desktopAnalytics", "desktopNotices", "updatesConsent", "updater"];

function preload(origin) {
  let bridge;
  const requests = [];
  vm.runInNewContext(source, {
    process: { platform: "darwin", argv: [`--omb-local-origin=${local}`, "--omb-company-desktop=1"] },
    location: { origin }, navigator: { userActivation: { isActive: true } }, TextEncoder,
    localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {},
        sendSync: channel => { requests.push(channel); }, invoke: channel => { requests.push(channel); return Promise.resolve(null); } } }),
  });
  return { bridge, requests };
}

test("desktop pages expose no official Cloud, marketing, telemetry or update service", () => {
  for (const origin of [local, "https://bots.example.test", "https://omb-u-example.fly.dev"]) {
    const { bridge, requests } = preload(origin);
    for (const key of removed) assert.equal(bridge[key], undefined, `${origin}: ${key}`);
    assert.deepEqual(requests, []);
    assert.equal(typeof bridge.desktopLanguage.choice, "function");
    assert.equal(typeof bridge.windowFrame.state, "function");
  }
});

test("local desktop retains self-hosted connection, pairing and computer sharing controls", () => {
  const { bridge } = preload(local);
  for (const [key, method] of [["remoteClient", "pair"], ["companion", "pairing"], ["companion", "refreshTailscale"],
    ["environments", "addFromLink"], ["computerSharing", "save"], ["desktopWorkspace", "open"]]) {
    assert.equal(typeof bridge[key]?.[method], "function", `${key}.${method}`);
  }
});

test("main does not register removed services or start their clients", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const channels = [...main.matchAll(/ipcMain\.(?:handle|on)\("([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(channels.filter(channel => /^(?:cloud-account|cloud-plan|cloud-add|cloud-send|files|organization|company-backups|updates-consent|desktop-analytics|desktop-notices|updater):/.test(channel)), []);
  assert.doesNotMatch(main, /\b(?:createCloudAccountClient|installCloudFiles|installOneHome|installHomeWindowIpc|registerUpdaterIpc|createManagedDesktopClient)\s*\(/);
});
