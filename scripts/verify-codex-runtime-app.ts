// Never sets the App's CODEX_HOME. UI mutations are performed through the App.
import { nativeRpc, responseStream } from "./testing/native-plugin-protocol.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPluginSourceServer } from "../server/testing/plugin-source.ts";
import { waitForExit } from "../server/testing/cleanup.ts";

const binary = resolve(process.argv[2] ?? "release/plugin-preview-20261018-v5/mac-arm64/OpenMausBot.app/Contents/MacOS/OpenMausBot");
assert.ok(existsSync(binary), "Build the preview App first");
const cli = execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim();
const personalCli = process.env.OMB_VERIFY_PERSONAL_CODEX_CLI || cli;
const personalCliVersion = execFileSync(personalCli, ["--version"], { encoding: "utf8" }).trim();
const root = mkdtempSync(join(tmpdir(), "omb-codex-runtime-app-"));
const home = join(root, "home"), dataDir = join(root, "data"), profile = join(root, "profile");
const personal = join(home, ".codex"), runtime = join(dataDir, "providers", "codex"), cwd = join(root, "workspace");
const evidence = resolve(process.env.OMB_VERIFY_APP_EVIDENCE ?? ".omb-scratch/verify-evidence/codex-runtime-app");
for (const dir of [personal, dataDir, profile, cwd, evidence]) mkdirSync(dir, { recursive: true });
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USERPROFILE: home,
  CFFIXED_USER_HOME: home,
  TMPDIR: root, LANG: "en_US.UTF-8", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  OMB_DATA_DIR: dataDir, CUA_DRIVER_RS_TELEMETRY_ENABLED: "0" };
// No CODEX_HOME in this environment. Even an inherited personal home is omitted.
const receipts: unknown[] = [];
const requests: unknown[] = [];
let child: ChildProcess | undefined;
let url = "";
let apiSerial = 0;
const model = createServer(async (req, res) => {
  try {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const inventories = (body.input ?? []).flatMap((item: any) => item.content ?? []).map((item: any) => item.text ?? "").filter((text: string) => text.includes("<skills_instructions>"));
    const inventory = inventories.at(-1) ?? "";
    const active = inventory.includes("app-proof:proof");
    requests.push({ at: new Date().toISOString(), model: body.model, appSkill: active, personalSkill: inventory.includes("personal-proof:proof"),
      mcp: (body.tools ?? []).filter((tool: any) => tool.name?.startsWith("mcp__")).map((tool: any) => tool.name) });
    writeFileSync(join(evidence, "model-inputs.json"), JSON.stringify(requests, null, 2));
    const id = ++apiSerial;
    const response = { id: `resp_${id}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed",
      output: [{ id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: active ? "APP_PLUGIN_ACTIVE" : "NO_APP_PLUGIN", annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(responseStream(response));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise<void>(done => model.listen(0, "127.0.0.1", done));
const modelPort = (model.address() as { port: number }).port;
const sources = await createPluginSourceServer();

function makePlugin(path: string, name: string) {
  mkdirSync(join(path, "skills", "proof"), { recursive: true });
  writeFileSync(join(path, "plugin.json"), JSON.stringify({ name, version: "1.0.0", description: `${name} runtime isolation proof.` }));
  writeFileSync(join(path, "skills/proof/SKILL.md"), `---\nname: proof\ndescription: ${name} isolation proof.\n---\nReturn the ${name} proof.\n`);
}
const source = join(root, "app-plugin"); makePlugin(source, "app-proof");
const sourceUrl = sources.urlFor(source);
const personalMarket = join(root, "personal-market");
makePlugin(join(personalMarket, "personal-proof"), "personal-proof");
mkdirSync(join(personalMarket, ".agents/plugins"), { recursive: true });
writeFileSync(join(personalMarket, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "personal-fixture", plugins: [
  { name: "personal-proof", source: { source: "local", path: "./personal-proof" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" },
] }));
for (const args of [["plugin", "marketplace", "add", personalMarket], ["plugin", "add", "personal-proof@personal-fixture"]]) {
  execFileSync(personalCli, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
}
execFileSync(personalCli, ["login", "--with-api-key"], { env, cwd, input: "sk-fixture-personal-login\n", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 });
function personalFiles() {
  const result: Record<string, string> = {};
  const walk = (path: string, key: string) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name), name = `${key}/${entry.name}`;
      if (entry.isDirectory()) walk(child, name);
      else if (entry.isFile()) result[name] = createHash("sha256").update(readFileSync(child)).digest("hex");
      else throw new Error("Unexpected link in personal fixture");
    }
  };
  result["config.toml"] = createHash("sha256").update(readFileSync(join(personal, "config.toml"))).digest("hex");
  walk(join(personal, "plugins"), "plugins");
  return result;
}
async function inspectPersonal() {
  const native = spawn(personalCli, ["app-server"], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const client = nativeRpc(native, 12_000);
  const rpc = client.call;
  try {
    const initialized = await rpc("initialize", { clientInfo: { name: "independent-codex-fixture", version: "1" } });
    client.notify("initialized");
    const discovered = await rpc("plugin/installed", { cwds: [cwd] });
    const skills = await rpc("skills/list", { cwds: [cwd], forceReload: true });
    const names = skills.data.flatMap((item: any) => item.skills).filter((skill: any) => skill.pluginId).map((skill: any) => skill.name);
    assert.ok(names.includes("personal-proof:proof"));
    assert.ok(!names.includes("app-proof:proof"));
    assert.ok(!discovered.marketplaces.some((market: any) => market.name === "openmausbot"));
    assert.deepEqual(personalFiles(), baseline);
    const result = { action: "independent-codex", cli: personalCli, version: personalCliVersion, codexHome: initialized.codexHome, skills: names, applicationPluginAbsent: true, personalUnchanged: true };
    receipts.push(result); console.log(JSON.stringify(result));
  } finally { await client.close(); }
}
const baseline = personalFiles();
writeFileSync(join(evidence, "personal-before.json"), JSON.stringify(baseline, null, 2));
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ language: "en", onboarding: { completedAt: new Date().toISOString(), version: 1, reelSeen: true },
  instances: { codex: { driver: "codex", displayName: "Native Codex fixture", config: { cli, managed: { url: `http://127.0.0.1:${modelPort}/v1`, models: ["fixture"] } },
    environment: { OPENMAUSBOT_COMPANY_API_KEY: "synthetic-fixture" } }, "external-login": { driver: "codex", displayName: "External login fixture", config: { cli } } },
  defaultModelSelection: { instanceId: "codex", model: "fixture" },
  newBotDefaults: { profile: { browser: false, computer: "off" }, memory: {}, skills: [], routines: [] },
}));
assert.equal(existsSync(runtime), false, "Fixture must not pre-create the application home");

function descendants(pid: number) {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([pid]);
  for (let changed = true; changed;) { changed = false; for (const [id, parent] of rows) if (owned.has(parent!) && !owned.has(id!)) { owned.add(id!); changed = true; } }
  return owned;
}
async function start(ambientPersonal = false) {
  assert.equal(env.CODEX_HOME, undefined);
  const launchEnv = { ...env, ...(ambientPersonal ? { CODEX_HOME: personal } : {}) };
  child = spawn(binary, [`--user-data-dir=${profile}`, "--lang=en-US", "--disable-background-networking", "--use-mock-keychain"], { env: launchEnv, stdio: ["ignore", "pipe", "pipe"] });
  const append = (chunk: Buffer) => {
    const path = join(evidence, "desktop.log");
    writeFileSync(path, chunk, { flag: "a" });
  };
  child.stdout!.on("data", append); child.stderr!.on("data", append);
  child.on("error", error => console.error(error));
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, "Packaged App exited before server readiness");
    const owned = descendants(child.pid!);
    for (const port of [8799, 18799, 28799]) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(400) });
        const health = await response.json() as { pid?: number };
        if (health.pid && owned.has(health.pid)) {
          url = `http://127.0.0.1:${port}`;
          receipts.push({ action: "packaged-boot", appPid: child.pid, serverPid: health.pid, url, ambientPersonal, applicationHomeExists: existsSync(runtime) });
          assert.ok(existsSync(runtime), "Real startup must create the application home");
          assert.deepEqual(personalFiles(), baseline);
          console.log(JSON.stringify({ ready: true, appPid: child.pid, serverPid: health.pid, url, sourceUrl, dataDir, home, runtime, personal, evidence, binary }));
          return;
        }
      } catch { /* another port is not this fixture */ }
    }
    await delay(250);
  }
  throw new Error("Packaged App readiness timed out");
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const owned = descendants(child.pid!);
  await waitForExit(child, { signal: "SIGTERM", graceMs: 20_000 });
  for (const pid of owned) {
    if (pid === child.pid) continue;
    try { process.kill(pid, 0); process.kill(pid, "SIGTERM"); } catch { /* exited */ }
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (![...owned].some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } })) return;
    await delay(100);
  }
  throw new Error("An owned App descendant did not exit");
}
function snapshot(label: string) {
  assert.deepEqual(personalFiles(), baseline, "Personal Codex config/cache changed");
  const bots = existsSync(join(dataDir, "bots.json")) ? JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")) : [];
  const plugins = existsSync(join(dataDir, "plugins")) ? readdirSync(join(dataDir, "plugins")).filter(name => !name.startsWith(".")) : [];
  const native = existsSync(join(dataDir, "native")) ? readdirSync(join(dataDir, "native")).flatMap(name => {
    const lines = readFileSync(join(dataDir, "native", name), "utf8").trim().split("\n");
    return lines.flatMap<Record<string, unknown>>(line => {
      try {
        const row = JSON.parse(line), msg = row.msg;
        if (msg?.result?.codexHome) return [{ file: name, codexHome: msg.result.codexHome }];
        const market = msg?.result?.marketplaces?.find((item: any) => item.name === "openmausbot");
        return market ? [{ file: name, plugins: market.plugins.map((item: any) => ({ id: item.id, installed: item.installed, enabled: item.enabled })) }] : [];
      } catch { return []; }
    });
  }) : [];
  const receipt = { action: "snapshot", label, bots: bots.map((bot: any) => ({ id: bot.id, name: bot.name, plugins: bot.plugins })), plugins, native, requests: [...requests], personalUnchanged: true };
  receipts.push(receipt);
  writeFileSync(join(evidence, "states.json"), JSON.stringify(receipts, null, 2));
  console.log(JSON.stringify(receipt));
}

try {
  await inspectPersonal();
  await start();
  const input = createInterface({ input: process.stdin });
  console.log("Commands: snapshot LABEL | personal | restart | redirect-restart | stop");
  for await (const line of input) {
    const [command, label = "state"] = line.trim().split(/\s+/);
    if (command === "snapshot") snapshot(label);
    if (command === "personal") await inspectPersonal();
    if (command === "restart" || command === "redirect-restart") {
      snapshot("before-restart"); await stop();
      if (command === "redirect-restart") {
        const file = join(dataDir, "config.json"), config = JSON.parse(readFileSync(file, "utf8"));
        config.instances.codex.environment.CODEX_HOME = personal;
        writeFileSync(file, JSON.stringify(config));
      }
      await start(command === "redirect-restart"); snapshot("after-restart");
    }
    if (command === "stop") { input.close(); break; }
  }
} finally {
  await stop();
  await inspectPersonal();
  snapshot("final");
  if (existsSync(join(dataDir, "native"))) for (const name of readdirSync(join(dataDir, "native"))) writeFileSync(join(evidence, basename(name)), readFileSync(join(dataDir, "native", name)));
  writeFileSync(join(evidence, "personal-after.json"), JSON.stringify(personalFiles(), null, 2));
  await sources.close();
  await new Promise<void>(done => model.close(() => done()));
  const desktopLog = join(home, "Library", "Logs", "openmausbot", "server.log");
  if (existsSync(desktopLog)) writeFileSync(join(evidence, "server.log"), readFileSync(desktopLog));
  rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ cleaned: root, evidence }));
}
