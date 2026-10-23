// No provider credentials or user data are read. OMB_VERIFY_CODEX_CLI selects the installed binary.
import { createPluginSourceServer } from "../server/testing/plugin-source.ts";
import { responseStream } from "./testing/native-plugin-protocol.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderInstance } from "../server/contracts.ts";
import type { InstalledPlugin } from "../shared/plugins.ts";

const cli = process.env.OMB_VERIFY_CODEX_CLI ?? execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim();
const expectUnsupported = process.argv.includes("--expect-unsupported");
const fixture = mkdtempSync(join(tmpdir(), "omb-codex-shared-home-"));
const home = join(fixture, "home"), personalHome = join(home, ".codex"), cwd = join(fixture, "workspace");
const nativeHome = join(fixture, "data", "providers", "codex");
for (const dir of [personalHome, cwd]) mkdirSync(dir, { recursive: true });
const personalConfig = "# independent Codex sentinel\n";
writeFileSync(join(personalHome, "config.toml"), personalConfig);
process.env.OMB_DATA_DIR = join(fixture, "data");
mkdirSync(join(process.env.OMB_DATA_DIR, "native"), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.CODEX_HOME; // Runtime, not the fixture, must choose its own native home.
const evidenceDir = resolve(`.omb-scratch/verify-evidence/codex-shared-home${expectUnsupported ? "-unsupported" : ""}`);
mkdirSync(evidenceDir, { recursive: true });
const version = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
const { pluginLibrary } = await import("../server/plugins.ts");
const { CodexDriver } = await import("../server/drivers/codex.ts");
const { ProviderRegistry } = await import("../server/harness/registry.ts");
const registry = new ProviderRegistry([CodexDriver]);
const { recordEvents } = await import("../server/testing/events.ts");
const { redactSecretsInText } = await import("../server/redact.ts");
const requests: { label: string; skills: string[]; historicalSkills: string[]; mcp: string[]; body: unknown }[] = [];
const receipts: unknown[] = [];
let instance: ProviderInstance | undefined;
let latestLabel = "";
const api = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const text = JSON.stringify(body);
    const label = [...text.matchAll(/OMB_CASE_([a-z0-9-]+)/g)].at(-1)?.[1] ?? latestLabel;
    const inventories = (body.input ?? []).flatMap((message: any) => message.content ?? []).map((content: any) => content.text ?? "").filter((text: string) => text.includes("<skills_instructions>"));
    const active = inventories.at(-1) ?? "";
    requests.push({ label, skills: ["alpha", "beta"].filter(id => active.includes(`${id}:proof`)),
      historicalSkills: ["alpha", "beta"].filter(id => text.includes(`${id}:proof`)),
      mcp: (body.tools ?? []).filter((tool: any) => tool.name?.startsWith("mcp__")).map((tool: any) => tool.name).sort(), body });
    const response = { id: `resp_${requests.length}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", output: [
      { id: `msg_${requests.length}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] },
    ], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(responseStream(response));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
const port = (api.address() as { port: number }).port;
const mcpLog = join(fixture, "mcp.jsonl");

const sources = await createPluginSourceServer();
async function source(id: string) {
  const root = join(fixture, "sources", id);
  mkdirSync(join(root, ".codex-plugin"), { recursive: true });
  mkdirSync(join(root, "skills", "proof"), { recursive: true });
  writeFileSync(join(root, ".codex-plugin/plugin.json"), JSON.stringify({ name: id, version: "1.0.0", skills: "./skills/" }));
  writeFileSync(join(root, "skills/proof/SKILL.md"), `---\nname: proof\ndescription: Native ${id} fixture plugin proof skill.\n---\nReturn the ${id} proof.\n`);
  const server = join(root, "server.cjs");
  writeFileSync(server, `const {createInterface}=require('node:readline');const {appendFileSync}=require('node:fs');
appendFileSync(${JSON.stringify(mcpLog)},JSON.stringify({plugin:${JSON.stringify(id)},parent:process.ppid})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:${JSON.stringify(id)},version:'1'}};
if(m.method==='tools/list')result={tools:[{name:'proof',description:'Native fixture proof',inputSchema:{type:'object',properties:{}}}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { [id]: { command: process.execPath, args: [server] } } }));
  writeFileSync(join(root, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [id]: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.cjs"] } } }));
  return pluginLibrary.install(sources.urlFor(root));
}

try {
  const alpha = await source("alpha"), beta = await source("beta");
  assert.equal(existsSync(nativeHome), false, "Fixture must not create the application home");
  await registry.load({ "native-plugin-verification": { driver: "codex", displayName: "Native fixture", enabled: true,
    environment: { HOME: home, USERPROFILE: home, OPENMAUSBOT_COMPANY_API_KEY: "synthetic-fixture", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
    config: { cli, fullAuto: false, managed: { url: `http://127.0.0.1:${port}/v1`, models: ["fixture"] } },
  } });
  instance = registry.get("native-plugin-verification")!;
  assert.ok(instance);
  const recorder = recordEvents(instance.adapter);
  async function turn(label: string, plugins: InstalledPlugin[], resumeCursor?: string) {
    latestLabel = label;
    const starts = existsSync(mcpLog) ? readFileSync(mcpLog, "utf8").trim().split("\n").length : 0;
    const identity = label === "resumed" ? "alpha" : label;
    const { turnId } = await instance!.adapter.sendTurn({ threadId: identity, botId: identity, text: `Reply OK. OMB_CASE_${label}`, cwd, plugins, pluginLibrary: { root: pluginLibrary.root, installed: pluginLibrary.list() }, model: "fixture", resumeCursor });
    const completed = await recorder.until(event => event.type === "turn.completed" && event.turnId === turnId, 30_000);
    const events = recorder.events.filter(event => event.turnId === turnId);
    const sent = requests.filter(request => request.label === label);
    const started = existsSync(mcpLog) ? readFileSync(mcpLog, "utf8").trim().split("\n").slice(starts).map(line => JSON.parse(line)) : [];
    const session = events.find(event => event.type === "session.started");
    const receipt = { label, expected: plugins.map(plugin => plugin.id), completed, requests: sent.map(({ skills, historicalSkills, mcp }) => ({ skills, historicalSkills, mcp })), startedMcpDuringTurn: started,
      errors: events.filter(event => event.type === "runtime.error"), session, events };
    receipts.push(receipt);
    console.log(JSON.stringify(receipt));
    return { receipt, events, session, sent, completed, started };
  }
  const first = await turn("alpha", [alpha]);
  if (expectUnsupported) {
    assert.equal(first.completed.type === "turn.completed" && first.completed.ok, false);
    assert.equal(requests.length, 0);
    assert.ok(first.events.some(event => event.type === "runtime.error" && event.message.includes("shared CODEX_HOME")));
    receipts.push({ outcome: "unsupported-before-prompt", version });
  } else {
    if (first.completed.type !== "turn.completed" || !first.completed.ok) throw new Error("Native alpha turn failed");
    const configAfterInstall = readFileSync(join(nativeHome, "config.toml"), "utf8");
    const [again, second] = await Promise.all([turn("alpha-again", [alpha]), turn("beta", [beta])]);
    const none = await turn("none", []);
    for (const [result, expected] of [[first, ["alpha"]], [again, ["alpha"]], [second, ["beta"]], [none, []]] as const) {
      assert.equal(result.completed.type === "turn.completed" && result.completed.ok, true);
      assert.ok(result.sent.length > 0);
      for (const request of result.sent) {
        assert.deepEqual(request.skills, expected);
        assert.deepEqual(request.mcp, expected.map(id => `mcp__${id}`));
      }
    }
    // MCP starts are grouped by native parent PID: no process may start both plugins.
    const mcp = readFileSync(mcpLog, "utf8").trim().split("\n").map(line => JSON.parse(line) as { plugin: string; parent: number });
    assert.ok(mcp.some(item => item.plugin === "alpha") && mcp.some(item => item.plugin === "beta"));
    for (const parent of new Set(mcp.map(item => item.parent))) assert.equal(new Set(mcp.filter(item => item.parent === parent).map(item => item.plugin)).size, 1);
    const session = first.session;
    assert.ok(session?.type === "session.started" && typeof session.sessionId === "string");
    const resumed = await turn("resumed", [beta], session.sessionId);
    assert.equal(resumed.completed.type === "turn.completed" && resumed.completed.ok, true);
    assert.ok(resumed.events.some(event => event.type === "session.started" && event.sessionId === session.sessionId));
    assert.ok(resumed.sent.length > 0);
    for (const request of resumed.sent) {
      assert.deepEqual(request.skills, ["beta"]);
      assert.deepEqual(request.mcp, ["mcp__beta"]);
    }
    assert.deepEqual(none.started, []);
    assert.equal(readFileSync(join(nativeHome, "config.toml"), "utf8"), configAfterInstall);
    await pluginLibrary.uninstall(alpha.id);
    await pluginLibrary.uninstall(beta.id);
    const removed = await turn("removed", []);
    assert.equal(removed.completed.type === "turn.completed" && removed.completed.ok, true);
    assert.ok(removed.sent.length > 0);
    for (const request of removed.sent) { assert.deepEqual(request.skills, []); assert.deepEqual(request.mcp, []); }
    assert.equal(readFileSync(join(nativeHome, "plugins/omb-installed.json"), "utf8"), "[]");
    const afterRemoval = readFileSync(join(nativeHome, "config.toml"), "utf8");
    assert.ok(!afterRemoval.includes("alpha@openmausbot") && !afterRemoval.includes("beta@openmausbot"));
    assert.equal(existsSync(join(nativeHome, "bots")), false);
    assert.equal(lstatSync(join(nativeHome, "plugins/cache")).isSymbolicLink(), false);
    assert.equal(existsSync(join(process.env.OMB_DATA_DIR!, "providers/codex-plugins")), false);
    assert.equal(existsSync(join(nativeHome, "auth.json")), false);
    assert.equal(readFileSync(join(personalHome, "config.toml"), "utf8"), personalConfig);
    assert.equal(existsSync(join(personalHome, "plugins")), false);
  }
  recorder.stop();
} finally {
  await registry.disposeAll();
  await sources.close();
  await new Promise<void>(resolve => api.close(() => resolve()));
  for (const label of ["alpha", "alpha-again", "beta", "none", "resumed"]) {
    const path = join(process.env.OMB_DATA_DIR!, "native", `${label}.ndjson`);
    if (existsSync(path)) writeFileSync(join(evidenceDir, `${label}.ndjson`), readFileSync(path));
  }
  writeFileSync(join(evidenceDir, "results.json"), redactSecretsInText(JSON.stringify({ cli, version, nativeHome, cwd, receipts, requests }, null, 2)));
  rmSync(fixture, { recursive: true, force: true });
  console.log(`Shared-home Codex evidence: ${evidenceDir}`);
}
