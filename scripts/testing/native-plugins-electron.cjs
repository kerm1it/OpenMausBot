const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
app.setName('OpenMausBot Plugin Verification');
app.setPath('userData', process.env.OMB_VERIFY_PROFILE);
app.setPath('home', process.env.HOME);
app.commandLine.appendSwitch('disable-background-networking');
let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 1280, height: 900, show: true, title: 'OpenMausBot — Isolated Plugin Verification',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  window.webContents.on('console-message', details => {
    if (details.level === 'warning' || details.level === 'error') console.error('[renderer]', details.message);
  });
  window.webContents.on('render-process-gone', (_event, detail) => console.error('[renderer-gone]', JSON.stringify(detail)));
  await window.loadURL(process.env.OMB_VERIFY_PREVIEW);
  window.setTitle('OpenMausBot — Isolated Plugin Verification');
  if (process.send) process.send({ ready: true, pid: process.pid });
});
app.on('window-all-closed', () => app.quit());
process.on('message', async message => {
  if (message?.command === 'capture' && window && !window.isDestroyed()) {
    const path = join(process.env.OMB_VERIFY_EVIDENCE, `${message.name}.png`);
    writeFileSync(path, (await window.webContents.capturePage()).toPNG());
    if (process.send) process.send({ captured: path });
  }
  if (message?.command === 'stop') app.quit();
});
