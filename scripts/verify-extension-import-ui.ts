import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer as createSocketServer } from "node:net";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createServer as createViteServer } from "vite";
import { zipSync, strToU8, unzipSync } from "fflate";
import { launchVerificationServer } from "./control-omb.ts";
import { createPluginSourceServer } from "../server/testing/plugin-source.ts";
import { waitForExit } from "../server/testing/cleanup.ts";

const repository = resolve(".");
const notices = [...readFileSync(join(repository, "src/lib/notices.ts"), "utf8").matchAll(/export const \w+ = "([^"]+)"/g)].map(match => match[1]!);
const tourHints = [...readFileSync(join(repository, "src/lib/guided-tour.ts"), "utf8").matchAll(/id: "(tour\.[^"]+)"/g)].map(match => match[1]!);
const root = mkdtempSync("/tmp/omb-extension-ui-");
const evidence = resolve(".omb-scratch/extension-ui");
const home = join(root, "home"), profile = join(root, "profile"), downloads = join(root, "downloads");
for (const directory of [home, profile, downloads, evidence]) mkdirSync(directory, { recursive: true });
for (const name of ["failure.png", "failure.txt", "console-errors.json", "electron.log"]) rmSync(join(evidence, name), { force: true });
const receipts: unknown[] = [];
const errors: unknown[] = [];
const record = (action: string, details: Record<string, unknown> = {}) => {
  const receipt = { action, at: new Date().toISOString(), ...details }; receipts.push(receipt);
  writeFileSync(join(evidence, "results.json"), JSON.stringify({ receipts, errors }, null, 2)); console.log(JSON.stringify(receipt));
};
const require = createRequire(import.meta.url);
const electron: string = require("electron");
let child: ChildProcess | undefined;
let cdp: Awaited<ReturnType<typeof connect>> | undefined;
let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
const sources = await createPluginSourceServer();
const socketPath = join(home, "Library/Caches/cua-driver/cua-driver.sock");
mkdirSync(join(home, "Library/Caches/cua-driver"), { recursive: true });
const computerSocket = createSocketServer(socket => socket.end());
await new Promise<void>(done => computerSocket.listen(socketPath, done));

async function freePort() {
  const server = createSocketServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port; await new Promise<void>(done => server.close(() => done())); return port;
}
async function connect(url: string) {
  const socket = new WebSocket(url);
  let serial = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      errors.push({ console: message.params.args, stack: message.params.stackTrace });
      writeFileSync(join(evidence, "console-errors.json"), JSON.stringify(errors, null, 2));
    }
    const promise = pending.get(message.id); if (!promise) return;
    pending.delete(message.id);
    if (message.error) promise.reject(new Error(message.error.message)); else promise.resolve(message.result);
  });
  await new Promise<void>((done, reject) => { socket.addEventListener("open", () => done(), { once: true }); socket.addEventListener("error", () => reject(new Error("Fixture DevTools connection failed")), { once: true }); });
  return {
    call(method: string, params: unknown = {}): Promise<any> {
      const id = ++serial;
      return new Promise((done, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools ${method} timed out`)); }, 30_000);
        pending.set(id, { resolve: value => { clearTimeout(timer); done(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}
async function evaluate<T = any>(expression: string): Promise<T> {
  const response = await cdp!.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value as T;
}
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string, timeout = 45_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < deadline) {
    try { last = await read(); if (accepts(last)) return last; } catch { /* The fixture may be navigating. */ }
    await delay(120);
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}
async function text() { return evaluate<string>("document.body.innerText"); }
async function waitText(value: string) { await until(text, body => body.includes(value), value); }
async function point(expression: string, button: "left" | "right" = "left") {
  const rect = await evaluate<{ x: number; y: number }>(`(() => { const element = ${expression}; if (!element) throw new Error('Missing click target'); element.scrollIntoView({block:'center'}); const r=element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  await cdp!.call("Input.dispatchMouseEvent", { type: "mousePressed", ...rect, button, clickCount: 1 });
  await cdp!.call("Input.dispatchMouseEvent", { type: "mouseReleased", ...rect, button, clickCount: 1 });
}
async function button(label: string) { await point(`Array.from(document.querySelectorAll('button')).find(e => e.textContent.trim() === ${JSON.stringify(label)} && e.getBoundingClientRect().width)`); }
async function fill(selector: string, value: string) {
  await evaluate(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); if(!input) throw new Error('Missing field'); const setter=Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,'value').set; setter.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
}
async function openManual() {
  await point("document.querySelector('[aria-label=\"New or share\"]')");
  await button("Import bot or plugin"); await waitText("Choose ZIP or JSON file");
}
async function chooseFile(path: string) {
  await cdp!.call("Page.setInterceptFileChooserDialog", { enabled: true });
  await point("Array.from(document.querySelectorAll('label')).find(e=>e.textContent.includes('Choose ZIP or JSON file'))");
  const documentNode = await cdp!.call("DOM.getDocument");
  const fileNode = await cdp!.call("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: '[role=dialog][aria-label="Import bot or plugin"] input[type=file]' });
  await cdp!.call("DOM.setFileInputFiles", { nodeId: fileNode.nodeId, files: [path] });
}
async function closeDialog() { await point("document.querySelector('[role=dialog][aria-label=\"Import bot or plugin\"] [aria-label=\"Close\"]')"); }
async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  assert.ok(fixture); const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result as T;
}
let uiUrl = "";
async function start(link?: string) {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CFFIXED_USER_HOME: home, TMPDIR: root,
    LANG: "en_US.UTF-8", OMB_DATA_DIR: fixture!.info.dataDir, ELECTRON_START_URL: uiUrl, CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" };
  child = spawn(electron, [repository, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", "--lang=en-US", "--use-mock-keychain", ...(link ? [link] : [])], { env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream!.on("data", chunk => writeFileSync(join(evidence, "electron.log"), chunk, { flag: "a" }));
  const targets = await until(async () => {
    assert.equal(child!.exitCode, null, "Fixture Electron exited");
    return fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Promise<Array<{ url: string; webSocketDebuggerUrl: string }>>;
  }, rows => rows.some(row => row.url.startsWith(uiUrl)), "production renderer target", 90_000);
  cdp = await connect(targets.find(row => row.url.startsWith(uiUrl))!.webSocketDebuggerUrl);
  await cdp.call("Runtime.enable"); await cdp.call("Page.enable"); await cdp.call("DOM.enable");
  await cdp.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await until(() => evaluate(`!!document.querySelector('[aria-label="New or share"]')`), Boolean, "sidebar mounted");
  record("production-app-start", { pid: child.pid, url: uiUrl, coldLink: link ?? null, dataDir: fixture!.info.dataDir, home, userData: profile, packaged: false, debugPort: port });
}
async function stop() {
  cdp?.close(); cdp = undefined;
  if (child && child.exitCode === null) await waitForExit(child, { signal: "SIGTERM", graceMs: 15_000 });
  child = undefined;
}
function writeArchive(name: string, files: Record<string, string | Uint8Array>) {
  const path = join(root, name);
  writeFileSync(path, zipSync(Object.fromEntries(Object.entries(files).map(([key, data]) => [key, typeof data === "string" ? strToU8(data) : data]))));
  return path;
}
try {
  fixture = await launchVerificationServer();
  for (const bot of (await api("/api/bots?messages=0")).bots) await api(`/api/bots/${bot.id}`, "PATCH", { welcomed: true });
  await api("/api/config", "PUT", { language: "en", onboarding: { completedAt: new Date().toISOString(), version: 1, reelSeen: true, hintsSeen: [...tourHints, "spot.composer", "spot.model", "spot.approval", "spot.connector", ...notices, "onboarding-cloud-v1"] } });
  vite = await createViteServer({ root: repository, cacheDir: join(root, "vite-cache"), server: { host: "127.0.0.1", port: 0, proxy: {
    "/api": { target: fixture.info.url, ws: true }, "/.well-known/openmausbot/environment": { target: fixture.info.url },
  } }, plugins: [{ name: "fixture-preferences", transformIndexHtml: html => html.replace("<head>", `<head><script>localStorage.setItem('omb-email-gate','skipped');localStorage.setItem('omb-advanced-mode','0');localStorage.setItem('omb-analytics-opt-out','1');for(const id of ${JSON.stringify(notices)})localStorage.setItem(id,'1');</script>`) }] });
  await vite.listen(); uiUrl = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  const plugin = writeArchive("ui-plugin.zip", { "plugin.json": JSON.stringify({ name: "ui-proof", version: "1.0.0", description: "UI proof" }), "skills/proof/SKILL.md": "---\nname: proof\ndescription: UI proof\n---\nReturn UI_PLUGIN_LOADED.\n" });
  const pluginUrl = sources.urlFor(plugin);
  const bot = writeArchive("ui-bot.zip", {
    "extension.json": JSON.stringify({ schemaVersion: 1, id: "ui-report", name: { en: "UI Report Bot" }, summary: { en: "Complete directory import" }, publisher: { name: "UI fixture" }, category: "productivity", tags: [], plugins: [{ id: "ui-proof", optional: false, source: pluginUrl }], entrypoints: { profile: { path: "profile.json" }, skills: [{ path: "skills/report/SKILL.md" }], memory: [{ path: "memory/notes.md" }], routines: [{ path: "routines/report.json" }] } }),
    "profile.json": JSON.stringify({ schemaVersion: 1, profile: { name: "UI Report Bot", soul: "Use the report skill for reports." } }),
    "skills/report/SKILL.md": "---\nname: report\ndescription: UI report\n---\nUse scripts/report.py and assets/report.bin.\n",
    "skills/report/scripts/report.py": "print('UI_DIRECTORY_PROOF')\n", "skills/report/assets/report.bin": new Uint8Array([0, 255, 12, 99]),
    "memory/notes.md": "PRIVATE_MEMORY_PROOF", "routines/report.json": JSON.stringify({ schemaVersion: 1, name: "Report routine", prompt: "Make a report", schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] } }),
  });
  const botUrl = sources.urlFor(bot);
  const grokRecipe = { name: "Grok UI Bot", instructions: "Use CreateAgent only after adapting the Grok API.", description: "Grok source proof", skills: [{ name: "grok-proof", description: "Grok Skill", body: "Use assets/proof.bin and scripts/proof.sh.", files: [{ path: "assets/proof.bin", content: "AP8MYw==", encoding: "base64" }, { path: "scripts/proof.sh", content: "echo GROK_DIRECTORY_PROOF", executable: true }] }], memories: ["GROK_PRIVATE_NOTE"] };
  const grokFile = join(root, "recipe.json"); writeFileSync(grokFile, JSON.stringify(grokRecipe));
  const grokBotUrl = sources.urlFor(writeArchive("grok-bot.zip", { "recipe.json": JSON.stringify(grokRecipe) }));
  const grokPlugin = { id: "123", name: "UI Grok plugin", sourceDownload: { url: pluginUrl } };
  const grokPluginFile = join(root, "grok-plugin.json"); writeFileSync(grokPluginFile, JSON.stringify(grokPlugin));
  const grokPluginUrl = sources.urlFor(writeArchive("grok-plugin.zip", { "plugin.json": JSON.stringify(grokPlugin) }));
  await start();
  await openManual();
  await chooseFile(bot);
  await waitText("scripts/report.py");
  assert.ok((await text()).includes("assets/report.bin"));
  const unchecked = await evaluate("Array.from(document.querySelectorAll('label')).filter(e=>e.textContent.includes('Include memory') || e.textContent.includes('Include routines')).every(e=>!e.querySelector('input').checked)");
  assert.equal(unchecked, true);
  record("file-preview", { fullSkillDirectory: true, memoryDefaultOff: true, routinesDefaultOff: true });
  await point("Array.from(document.querySelectorAll('label')).find(e=>e.textContent.includes('Include routines')).querySelector('input')");
  await button("Create bot");
  await until(() => api("/api/bots?messages=0"), data => data.bots.some((value: any) => value.name === "UI Report Bot"), "imported bot");
  const imported = (await api("/api/bots?messages=0")).bots.find((value: any) => value.name === "UI Report Bot");
  await until(() => evaluate(`document.querySelector('[data-sidebar-bot-row="${imported.id}"]')?.getAttribute('aria-current')`), value => value === "page", "import opens new bot");
  assert.deepEqual(imported.plugins, ["ui-proof"]);
  const importedRoutine = (await api("/api/routines")).routines.find((value: any) => value.botId === imported.id);
  assert.ok(importedRoutine); assert.equal(importedRoutine.enabled, false);
  record("file-import-confirmed", { botId: imported.id, plugins: imported.plugins, opened: true, selectedRoutineCreatedPaused: true });
  await point(`document.querySelector('[data-sidebar-bot-row="${imported.id}"]')`, "right");
  await button("Export bot template"); await button("Preview"); await waitText("skills/report/scripts/report.py");
  assert.ok((await text()).includes("skills/report/assets/report.bin"));
  assert.ok(!(await text()).includes("memory/notes.md"));
  await button("Save ZIP");
  await until(async () => readdirSync(downloads), names => names.some(name => name.endsWith(".zip")), "export ZIP download");
  const exportedPath = join(downloads, readdirSync(downloads).find(name => name.endsWith(".zip"))!);
  const exported = unzipSync(readFileSync(exportedPath));
  assert.deepEqual([...exported["skills/report/assets/report.bin"]!], [0, 255, 12, 99]);
  copyFileSync(exportedPath, join(evidence, "ui-report-bot.zip"));
  record("context-menu-export", { archive: join(evidence, "ui-report-bot.zip"), files: Object.keys(exported), binaryPreserved: true });
  await openManual(); await fill("[aria-label='Import source']", pluginUrl); await button("Preview"); await waitText("ui-proof");
  await button("Install plugin"); await waitText("Plugin installed");
  assert.equal((await api("/api/plugins")).plugins.filter((value: any) => value.id === "ui-proof").length, 1);
  record("plugin-url-install", { libraryOnly: true, idempotent: true });
  await openManual(); await chooseFile(grokFile); await waitText("scripts/proof.sh"); await waitText("Grok-specific APIs");
  await button("Create bot"); await waitText("Bot created");
  assert.ok((await api("/api/bots?messages=0")).bots.some((value: any) => value.name === "Grok UI Bot"));
  record("grok-bot-file-import", { fullDirectory: true, adaptationWarningVisible: true });
  await openManual(); await chooseFile(grokPluginFile); await waitText("Install plugin"); await button("Install plugin"); await waitText("Plugin installed");
  record("grok-plugin-file-import", { implementationDownloaded: true, sharedLibraryOnly: true });
  await openManual(); await fill("[aria-label='Import source']", botUrl); await button("Preview"); await waitText("scripts/report.py");
  await point("Array.from(document.querySelectorAll('label')).find(e=>e.textContent.includes('Include memory')).querySelector('input')");
  await point("Array.from(document.querySelectorAll('label')).find(e=>e.textContent.includes('Include routines')).querySelector('input')");
  await button("Back"); await button("Preview"); await waitText("scripts/report.py");
  assert.equal(await evaluate("Array.from(document.querySelectorAll('label')).filter(e=>e.textContent.includes('Include memory') || e.textContent.includes('Include routines')).every(e=>!e.querySelector('input').checked)"), true);
  record("new-preview-options-reset", { memoryDefaultOff: true, routinesDefaultOff: true });
  await closeDialog();
  assert.equal((await api("/api/bots?messages=0")).bots.filter((value: any) => value.name === "UI Report Bot").length, 1);
  record("cancel-preview", { createdAdditionalBot: false });
  await openManual(); await fill("[aria-label='Import source']", pluginUrl.replace(/plugin-\d+\.zip$/, "missing.zip")); await button("Preview"); await waitText("Resource download failed");
  await closeDialog(); record("source-error", { shown: true, falseSuccess: false });
  await stop();
  const coldLink = `openmausbot://app/v1/import?${new URLSearchParams({ type: "bot", source: "openmausbot", url: botUrl })}`;
  await start(coldLink); await waitText("scripts/report.py");
  await closeDialog(); record("cold-scheme-preview", { canonical: true, fullDirectory: true });
  assert.equal(await evaluate(`!!document.querySelector('[data-sidebar-bot-row="${imported.id}"]')`), true);
  record("restart-persistence", { botVisible: true, pluginInstalled: (await api("/api/plugins")).plugins.some((value: any) => value.id === "ui-proof") });
  for (const request of [
    { type: "plugin", source: "openmausbot", url: pluginUrl },
    { type: "bot", source: "grok-bot", url: grokBotUrl },
    { type: "plugin", source: "grok-bot", url: grokPluginUrl },
  ]) {
    const warmLink = `openmausbot://app/v1/import?${new URLSearchParams(request)}`;
    const second = spawn(electron, [repository, `--user-data-dir=${profile}`, warmLink], { env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CFFIXED_USER_HOME: home, OMB_DATA_DIR: fixture.info.dataDir, ELECTRON_START_URL: uiUrl }, stdio: "ignore" });
    await waitForExit(second, { graceMs: 15_000 });
    await waitText(request.type === "bot" ? "scripts/proof.sh" : "Install plugin"); await closeDialog();
    record("warm-scheme-preview", { type: request.type, source: request.source, secondProcessExited: true, sameConfirmationEntry: true });
  }
  const screenshot = await cdp!.call("Page.captureScreenshot", { format: "png" }); writeFileSync(join(evidence, "app.png"), Buffer.from(screenshot.data, "base64"));
  assert.deepEqual(errors, []); record("complete", { success: true, runtimeErrors: errors.length });
} catch (error) {
  record("failure", { error: error instanceof Error ? error.stack : String(error) });
  if (cdp) { writeFileSync(join(evidence, "failure.txt"), await text().catch(() => "Page unavailable")); const shot = await cdp.call("Page.captureScreenshot", { format: "png" }).catch(() => null); if (shot) writeFileSync(join(evidence, "failure.png"), Buffer.from(shot.data, "base64")); }
  process.exitCode = 1;
} finally {
  await stop(); await vite?.close(); await sources.close();
  await new Promise<void>(done => computerSocket.close(() => done()));
  await fixture?.close(); rmSync(root, { recursive: true, force: true });
}
