// Creates fixtures only. Installation, bot creation/selection and chat must be clicked in the UI.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { launchVerificationServer, verificationServerArgs, verificationServerEnvironment } from './control-omb.ts';
import { mountPreview, REPO_ROOT } from './testing/preview-fixture.ts';
import { createPluginSourceServer } from '../server/testing/plugin-source.ts';
import { waitForExit } from '../server/testing/cleanup.ts';
import type { WireBot } from '../shared/wire.ts';
import type { InstalledPlugin } from '../shared/plugins.ts';

const originalHome = homedir();
const cli = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
const electron = createRequire(import.meta.url)('electron') as string;
const fixture = await launchVerificationServer({});
const { dataDir, url, logPath } = fixture.info;
const evidenceDir = resolve(process.env.OMB_VERIFY_UI_EVIDENCE ?? '.omb-scratch/verify-evidence/native-plugins-ui');
mkdirSync(evidenceDir, { recursive: true });
const nativeHome = join(dataDir, 'providers', 'codex');
const source = join(dataDir, 'source', 'omb-ui-proof');
const profile = join(dataDir, 'electron-profile');
let sourceServer: Awaited<ReturnType<typeof createPluginSourceServer>> | undefined;
async function prepareFixture() {
  sourceServer = await createPluginSourceServer();
  for (const dir of [nativeHome, profile, join(source, '.cursor-plugin'), join(source, 'skills', 'proof')]) mkdirSync(dir, { recursive: true });
  const auth = join(originalHome, '.codex/auth.json');
  if (!existsSync(auth)) throw new Error('Native UI proof requires an existing Codex login; the fixture never performs sign-in.');
  mkdirSync(join(dataDir, '.codex'), { recursive: true });
  copyFileSync(auth, join(dataDir, '.codex', 'auth.json'));
  writeFileSync(join(source, '.cursor-plugin/plugin.json'), JSON.stringify({ name: 'omb-ui-proof', version: '1.0.0', description: 'Isolated App UI native plugin proof.', skills: './skills/' }));
  writeFileSync(join(source, 'skills/proof/SKILL.md'), '---\nname: proof\ndescription: Use for the App UI native plugin proof when explicitly requested.\n---\nReturn exactly OMB_APP_UI_NATIVE_731 and no other text.\n');
  await waitForExit(fixture.child, { signal: 'SIGTERM' });
  const configPath = join(dataDir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.language = 'en';
  config.instances['codex-native'] = { driver: 'codex', displayName: 'Native Codex UI fixture', config: { cli },
    environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:https?|all|no)_proxy$/i.test(key))) };
  config.defaultModelSelection = { instanceId: 'codex-native', model: 'gpt-6.1-sol' };
  config.newBotDefaults = { profile: { modelSelection: config.defaultModelSelection, browser: false, computer: 'off' }, memory: {}, skills: [], routines: [] };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}
let server: ChildProcess | undefined;
let desktop: ChildProcess | undefined;
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
const receipts: unknown[] = [];
const infoPath = join(evidenceDir, 'fixture.json');
async function startServer() {
  const env = verificationServerEnvironment({}, dataDir, Number(new URL(url).port));
  const fd = openSync(logPath, 'a');
  server = spawn(process.execPath, verificationServerArgs(env), { cwd: REPO_ROOT, env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Fixture server stopped; inspect ${logPath}`);
    try { if ((await fetch(`${url}/api/health`)).ok) break; } catch { /* startup */ }
    if (Date.now() > deadline) throw new Error('Fixture server startup timeout');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
// Native catalog probes run in detached CLI groups. Capture this server's
// descendants before shutdown so none can recreate the disposable home later.
async function stopServer() {
  const owned = new Set<number>();
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    owned.add(server.pid);
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    let added = true;
    while (added) {
      added = false;
      for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); added = true; }
    }
    owned.delete(server.pid);
  }
  await waitForExit(server, { signal: 'SIGTERM' });
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  };
  for (const pid of owned) {
    if (!alive(pid)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
  const deadline = Date.now() + 3_000;
  while ([...owned].some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  for (const pid of owned) if (alive(pid)) {
    process.kill(pid, 'SIGKILL');
    throw new Error(`Native fixture child ${pid} required SIGKILL; inspect cleanup before removing data`);
  }
}
async function startDesktop() {
  const env = { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_VERIFY_PROFILE: profile,
    OMB_VERIFY_PREVIEW: preview!.previewUrl, OMB_VERIFY_EVIDENCE: evidenceDir };
  const fd = openSync(join(evidenceDir, 'electron.log'), 'a');
  desktop = spawn(electron, [join(REPO_ROOT, 'scripts/testing/native-plugins-electron.cjs')], { cwd: REPO_ROOT, env, stdio: ['ignore', fd, fd, 'ipc'] });
  closeSync(fd);
  desktop.on('message', message => console.log(JSON.stringify(message)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated Electron startup timeout')), 30_000);
    desktop!.on('message', message => { if ((message as { ready?: boolean })?.ready) { clearTimeout(timer); resolve(); } });
    desktop!.on('exit', code => { clearTimeout(timer); reject(new Error(`Isolated Electron exited ${code}`)); });
  });
}
async function snapshot(label: string) {
  const bots = await fetch(`${url}/api/bots`).then(response => response.json()) as { bots: WireBot[] };
  const plugins = await fetch(`${url}/api/plugins`).then(response => response.json()) as { plugins: InstalledPlugin[] };
  const item = { label, at: new Date().toISOString(), bots, plugins, nativeHome, serverPid: server?.pid, desktopPid: desktop?.pid };
  receipts.push(item);
  writeFileSync(join(evidenceDir, 'states.json'), JSON.stringify(receipts, null, 2));
  console.log(JSON.stringify({ saved: label, bots: bots.bots?.map(bot => ({ id: bot.id, name: bot.name, plugins: bot.plugins, modelSelection: bot.modelSelection })), plugins: plugins.plugins?.map(plugin => plugin.id) }));
}
let stop!: () => void;
const stopped = new Promise<void>(resolve => stop = resolve);
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  await prepareFixture();
  await startServer();
  preview = await mountPreview(fixture, { entry: '/scripts/testing/threads-preview.tsx', route: '/__native_plugins.html', title: 'OpenMausBot Plugin Verification', logLevel: 'warn' });
  await startDesktop();
  const info = { url, previewUrl: preview.previewUrl, dataDir, logPath, source: sourceServer!.urlFor(source), sourcePath: source, nativeHome, profile, evidenceDir,
    cli, version: execFileSync(cli, ['--version'], { encoding: 'utf8' }).trim(), serverPid: server?.pid, desktopPid: desktop?.pid };
  writeFileSync(infoPath, JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info));
  const input = createInterface({ input: process.stdin });
  input.once('close', stop);
  let queue = Promise.resolve();
  input.on('line', line => {
    queue = queue.then(async () => {
      const [command, label = 'state'] = line.trim().split(/\s+/);
      if (command === 'snapshot') await snapshot(label);
      if (command === 'capture' && /^[a-z0-9-]+$/.test(label)) {
        const target = desktop;
        if (!target?.connected) throw new Error('Fixture desktop is not connected');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { target.off('message', captured); reject(new Error('Screenshot timeout')); }, 10_000);
          const captured = (message: unknown) => {
            if ((message as { captured?: string })?.captured !== join(evidenceDir, `${label}.png`)) return;
            clearTimeout(timer); target.off('message', captured); resolve();
          };
          target.on('message', captured); target.send({ command: 'capture', name: label });
        });
      }
      if (command === 'restart') {
        await snapshot('before-restart');
        desktop?.send({ command: 'stop' }); await waitForExit(desktop);
        await stopServer();
        await startServer(); await startDesktop();
        await snapshot('after-restart');
        console.log(JSON.stringify({ restarted: true, serverPid: server?.pid, desktopPid: desktop?.pid }));
      }
      if (command === 'stop') stop();
    }).catch(error => console.error(error));
  });
  await stopped;
  await queue; input.close();
} finally {
  if (desktop?.connected) desktop.send({ command: 'stop' });
  await waitForExit(desktop);
  await stopServer();
  if (existsSync(join(dataDir, 'native'))) cpSync(join(dataDir, 'native'), join(evidenceDir, 'native'), { recursive: true });
  const fd = openSync(join(evidenceDir, 'server.log'), 'w');
  if (existsSync(logPath)) writeFileSync(fd, readFileSync(logPath));
  closeSync(fd);
  await preview?.close(); await sourceServer?.close(); await fixture.close();
}
