import { nativeRpc } from "./testing/native-plugin-protocol.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, lstatSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createServer } from "node:http";

const log = process.argv[2];
assert.ok(log, "Pass the running verify-codex-runtime-app fixture's log");
const fixture = readFileSync(log, "utf8").split("\n").filter(line => line.startsWith('{"ready":')).map(line => JSON.parse(line)).at(-1);
assert.ok(fixture && basename(dirname(fixture.home)).startsWith("omb-codex-runtime-app-"));
assert.equal(fixture.personal, join(fixture.home, ".codex"));
assert.equal(fixture.runtime, join(fixture.dataDir, "providers/codex"));
const source = join(fixture.personal, "auth.json"), target = join(fixture.runtime, "auth.json");
assert.ok(lstatSync(target).isSymbolicLink(), "Production startup must establish the link first");
assert.equal(realpathSync(target), realpathSync(source));
const original = readFileSync(source);
assert.equal(JSON.parse(original.toString()).OPENAI_API_KEY, "sk-fixture-personal-login", "Refuse non-synthetic credentials");
const personalConfig = readFileSync(join(fixture.personal, "config.toml"));
const runtimeConfig = readFileSync(join(fixture.runtime, "config.toml"));
const cli = execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim();
const env = { PATH: process.env.PATH, HOME: fixture.home, USERPROFILE: fixture.home, CODEX_HOME: fixture.runtime };
// Native ChatGPT account inspection can request account policy at startup.
// Keep those synthetic requests local as well; no real account is contacted.
const backend = createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  const accounts = ["account-one", "account-two"].map(id => ({ id, name: id, plan_type: "plus", structure: "personal", workspace_backend_origin: "https://synthetic.example.test", account_routing_override: "NO_CONSTRAINT" }));
  response.end(JSON.stringify(request.url === "/api/codex/accounts/check" ? { accounts, account_ordering: accounts.map(account => account.id) } : {}));
});
await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
const backendUrl = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
async function account() {
  const child = spawn(cli, ["-c", `chatgpt_base_url="${backendUrl}"`, "app-server"], { env, cwd: dirname(fixture.home), stdio: ["pipe", "pipe", "pipe"] });
  const client = nativeRpc(child, 10_000);
  const rpc = client.call;
  try {
    await rpc("initialize", { clientInfo: { name: "auth-reuse-fixture", version: "1" } });
    client.notify("initialized");
    return (await rpc("account/read", { refreshToken: false })).account;
  } finally { await client.close(); }
}
function replace(bytes: Buffer | string) {
  const staged = `${source}.fixture-new`;
  writeFileSync(staged, bytes, { mode: 0o600 }); renameSync(staged, source);
}
const checks: unknown[] = [];
try {
  for (const [email, accountId] of [["first@example.test", "account-one"], ["second@example.test", "account-two"]]) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "none" })}.${encode({ email, "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" } })}.fixture`;
    replace(JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: token, access_token: "synthetic-access", refresh_token: "synthetic-refresh", account_id: accountId }, last_refresh: new Date().toISOString() }));
    const observed = await account(); assert.equal(observed?.email, email);
    checks.push({ externalEmail: email, nativeRuntimeEmail: observed.email });
  }
  unlinkSync(source); assert.equal(await account(), null); checks.push({ externalLogoutFollowed: true });
  const login = (home: string, key: string) => execFileSync(cli, ["login", "--with-api-key"], { env: { ...env, CODEX_HOME: home }, input: key + "\n", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
  login(fixture.personal, "sk-fixture-relogin"); assert.equal((await account())?.type, "apiKey");
  checks.push({ externalReloginFollowed: true });
  login(fixture.runtime, "sk-fixture-write-through");
  assert.ok(lstatSync(target).isSymbolicLink());
  assert.equal(JSON.parse(readFileSync(source, "utf8")).OPENAI_API_KEY, "sk-fixture-write-through");
  checks.push({ nativeWriteThroughPreservesLink: true });
  assert.deepEqual(readFileSync(join(fixture.personal, "config.toml")), personalConfig);
  assert.deepEqual(readFileSync(join(fixture.runtime, "config.toml")), runtimeConfig);
  const result = { checks, personalConfigUnchanged: true, runtimeConfigUnchanged: true };
  writeFileSync(join(fixture.evidence, "auth-reuse.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { replace(original); await new Promise<void>(resolve => backend.close(() => resolve())); }
