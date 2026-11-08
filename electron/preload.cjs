// contextIsolation stays on: the renderer sees only window.ogb, never Node or ipcRenderer.
const { contextBridge, ipcRenderer, webFrame, webUtils } = require("electron");

// Sandboxed preloads get Electron's restricted `require`, which cannot load sibling CommonJS files.
const desktopRemoteClient = process.argv.includes("--openmausbot-remote-client");

let pendingPackageInstall = null;
const packageInstallListeners = new Set();
ipcRenderer.on("package:install", (_event, input) => {
  if (typeof input !== "string" && (!input || typeof input !== "object" || !["bot", "plugin"].includes(input.type) || !["openmausbot", "grok-bot"].includes(input.source))) return;
  pendingPackageInstall = packageInstallListeners.size ? null : input;
  for (const listener of packageInstallListeners) listener(input);
});

let pendingChatLink = null;
const chatLinkListeners = new Set();
ipcRenderer.on("chat:open", (_event, link) => {
  if (typeof link !== "string") return;
  if (!chatLinkListeners.size) {
    pendingChatLink = link;
    return;
  }
  for (const listener of chatLinkListeners) listener(link);
});

let pendingNotificationOpen = null;
const notificationOpenListeners = new Set();
ipcRenderer.on("desktop-notifications:open", (_event, target) => {
  if (!notificationOpenListeners.size) {
    pendingNotificationOpen = target;
    return;
  }
  for (const listener of notificationOpenListeners) listener(target);
});

// Only fixed actions are retained, never a destination supplied by a renderer.
const FIXED_SETTINGS_ACTIONS = new Set(["workspaces"]);
let pendingSettingsAction = null;
const appSettingsListeners = new Set();
ipcRenderer.on("app:open-settings", (_event, section) => {
  const fixedSection = FIXED_SETTINGS_ACTIONS.has(section) ? section : undefined;
  if (fixedSection && !appSettingsListeners.size) pendingSettingsAction = fixedSection;
  if (!appSettingsListeners.size) return;
  pendingSettingsAction = null;
  for (const listener of appSettingsListeners) listener(fixedSection);
});

// The full bridge goes only to the local server's UI; a remote page gets the safe subset, and main enforces the same rule.
const localOrigin = process.argv.find((arg) => arg.startsWith("--omb-local-origin="))?.slice("--omb-local-origin=".length) ?? null;
const isLocalPage = !localOrigin || location.origin === localOrigin;

// The window's own rail of places stands at its left edge (electron/chrome-rail.mjs): main says how wide, and every page
// beside it, whatever server it comes from, moves over by that much, at any zoom (a zoom change resizes the page). The
// page reads how far in `--rail-beside`, which changes with the move itself.
let railBeside = 0, railRoom = null;
function leaveRailRoom() {
  if (typeof document === "undefined" || !document.documentElement) return;
  const zoom = Number(webFrame?.getZoomFactor?.()) || 1;
  if (!railBeside) { railRoom?.remove(); railRoom = null; return; }
  railRoom ??= document.createElement("style");
  const room = `${Math.round((railBeside / zoom) * 100) / 100}px`;
  railRoom.textContent = `html { box-sizing: border-box !important; padding-left: ${room} !important; --rail-beside: ${room}; }`;
  if (!railRoom.isConnected) (document.head ?? document.documentElement).append(railRoom);
}
const railState = (state) => ({ available: state?.available === true, hidden: state?.hidden === true });
ipcRenderer.on("rail:beside", (_event, width) => { railBeside = Math.max(0, Math.min(200, Number(width) || 0)); leaveRailRoom(); });
// The rail's own page keeps its size whatever the zoom of this app's page: Chromium gives every page of a host the same
// zoom, the rail's included, so the rail takes it back out and stays as wide as its strip.
function railKeepsItsSize() {
  if (!isLocalPage || location.pathname !== "/rail" || typeof document === "undefined" || !document.documentElement) return;
  const zoom = Number(webFrame?.getZoomFactor?.()) || 1;
  document.documentElement.style.zoom = zoom === 1 ? "" : String(Math.round((1 / zoom) * 10000) / 10000);
}
if (typeof window !== "undefined") {
  for (const type of ["resize", "DOMContentLoaded"]) window.addEventListener(type, () => { leaveRailRoom(); railKeepsItsSize(); });
}
const REMOTE_SAFE = new Set(["platform", "app", "getCapabilities", "onCapabilitiesChanged", "applySkin", "setUnreadCount", "permStatus", "workspaces", "rail", "desktopNotifications", "desktopLanguage", "windowControls", "onOpenAppSettings", "windowFrame"]);
/** My Cloud's own page once it is the person's home (main checks the sender again): it is this app's page then. */


function savedLanguageChoice() {
  try { const saved = ipcRenderer.sendSync("desktop-language:read"); return typeof saved === "string" ? saved : null; } catch { return null; }
}
let languageChoice;
const languageListeners = new Set();
ipcRenderer.on("desktop-language:changed", (_event, language) => {
  if (typeof language !== "string") return;
  languageChoice = language;
  for (const listener of languageListeners) listener(language);
});
const remoteKeys = REMOTE_SAFE;

// main passes app.getVersion(): a server's page carries that server's version, so About asks this for the app's own.
const appVersion = (process.argv.find((arg) => arg.startsWith("--omb-app-version="))?.slice("--omb-app-version=".length) ?? "").slice(0, 64);

/** ipcRenderer wraps a main-process throw in "Error invoking remote method"; the page shows the text verbatim. */
function invokeWithPlainError(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args).catch((error) => {
    const message = String(error?.message ?? error);
    throw new Error(message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
  });
}

const bridge = {
  platform: process.platform,
  /** This app's version, and whether this page is this app's own (served by this computer, not a server from the Server menu). */
  app: { version: appVersion, ownPage: isLocalPage },
  // Safe on a cloud page: the person chooses in a native menu, or a circle of the rail main listed (only for this app's
  // page and a hosted Cloud's, never addresses), and only from their click; no saved-list reads, host files or secrets.
  workspaces: {
    state: () => ipcRenderer.invoke("workspaces:state"),
    menu: (options) => ipcRenderer.invoke("workspaces:menu", ...(options?.from === "howto" ? ["howto"] : [])),
    places: () => ipcRenderer.invoke("workspaces:places"),
    open: (id) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:open", String(id)) : Promise.reject(new Error("Choose a place to open it.")),
    add: (choice, link, code) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:add", String(choice), ...(typeof link === "string" ? [link, ...(typeof code === "string" ? [code] : [])] : [])) : Promise.reject(new Error("Choose what to add.")),
    probe: (address, code) => ipcRenderer.invoke("workspaces:probe", String(address ?? ""), String(code ?? "")),
    // The colour of the place this page is (never another's): read, and changed only from the person's click.
    look: () => ipcRenderer.invoke("workspaces:look"),
    color: (swatch) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:color", swatch === null ? null : String(swatch)) : Promise.reject(new Error("Choose a color.")),
    // The colour of a place the window's rail lists, from a click on the rail's own page (main refuses any other page).
    recolor: (id, swatch) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:recolor", String(id), swatch === null ? null : String(swatch)) : Promise.reject(new Error("Choose a color.")),
    // Remove from list, for a Cloud the window's rail lists as removable, from a click on the rail's own page (main refuses any other page).
    remove: (id) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("workspaces:remove", String(id)) : Promise.reject(new Error("Choose Remove from list.")),
    onChanged: (cb) => {
      const handler = () => cb();
      ipcRenderer.on("workspaces:changed", handler);
      return () => ipcRenderer.removeListener("workspaces:changed", handler);
    },
    // A workspace of this computer's own, from a click on the rail's page or this computer's own page (main refuses any
    // other): a new one by its name and colour, and a name, colour or removal for one the rail lists.
    local: {
      create: (name, color) => isLocalPage || navigator.userActivation?.isActive === true
        ? ipcRenderer.invoke("workspaces:local-new", String(name), color === null || color === undefined ? null : String(color)) : Promise.reject(new Error("Choose a name.")),
      edit: (id, changes) => isLocalPage || navigator.userActivation?.isActive === true
        ? ipcRenderer.invoke("workspaces:local-edit", String(id), typeof changes?.name === "string" ? { name: changes.name } : { color: changes?.color === null || changes?.color === undefined ? null : String(changes.color) })
        : Promise.reject(new Error("Choose a change.")),
      remove: (id) => isLocalPage || navigator.userActivation?.isActive === true
        ? ipcRenderer.invoke("workspaces:local-remove", String(id)) : Promise.reject(new Error("Choose Remove.")),
    },
    // The Server menu's New workspace on this computer, for this computer's own page to ask its name.
    onNewLocal: (cb) => {
      const handler = () => cb();
      ipcRenderer.on("workspaces:new-local", handler);
      return () => ipcRenderer.removeListener("workspaces:new-local", handler);
    },
  },
  // The window's own rail (this app's page at /rail, beside every place's page): while a sheet of its own is open it
  // covers the window; the skin of the page beside it comes from main, and whether that page draws the window's frame.
  // The page beside it, from whichever server, offers the button that hides and shows it, and learns only whether there
  // is one to hide, never its places; it says when it draws the frame, so main puts the traffic lights in its top bar.
  rail: {
    state: () => ipcRenderer.invoke("rail:offer").then(railState),
    drawsFrame: (drawn) => ipcRenderer.invoke("rail:draws-frame", drawn !== false),
    setHidden: (hidden) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("rail:hide", hidden === true).then(railState) : Promise.reject(new Error("Choose to hide or show your computers.")),
    onState: (cb) => {
      const handler = (_event, state) => cb(railState(state));
      ipcRenderer.on("rail:state", handler);
      return () => ipcRenderer.removeListener("rail:state", handler);
    },
    ...(isLocalPage ? {
      expand: (on) => ipcRenderer.invoke("rail:expand", on === true),
      onSkin: (cb) => {
        const handler = (_event, skin) => cb(String(skin));
        ipcRenderer.on("rail:skin", handler);
        return () => ipcRenderer.removeListener("rail:skin", handler);
      },
      onFramed: (cb) => {
        const handler = (_event, framed) => cb(framed === true);
        ipcRenderer.on("rail:framed", handler);
        return () => ipcRenderer.removeListener("rail:framed", handler);
      },
    } : {}),
  },
  // The window's own frame, this desktop's choice for every page of its window; a server's page changes it only from the
  // person's click.
  windowFrame: {
    state: () => ipcRenderer.invoke("window-frame:state"),
    set: (on) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("window-frame:set", on === true) : Promise.reject(new Error("Choose to turn the window frame on or off.")),
  },
  getCapabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  onCapabilitiesChanged: (cb) => {
    const handler = (_event, capabilities) => cb(capabilities);
    ipcRenderer.on("desktop:capabilities-changed", handler);
    return () => ipcRenderer.removeListener("desktop:capabilities-changed", handler);
  },
  /** The bearer stays in the main process and is never returned over this bridge. */
  remoteClient: {
    active: desktopRemoteClient,
    state: () => ipcRenderer.invoke("desktop-remote:state"),
    pair: (endpoint, code) => ipcRenderer.invoke("desktop-remote:pair", endpoint, code),
    disconnect: () => ipcRenderer.invoke("desktop-remote:disconnect"),
  },
  companion: {
    state: () => ipcRenderer.invoke("companion:state"),
    start: (routes) => ipcRenderer.invoke("companion:start", Array.isArray(routes) ? routes.filter((route) => typeof route === "string") : undefined),
    stop: () => ipcRenderer.invoke("companion:stop"),
    keepAwake: (enabled) => ipcRenderer.invoke("companion:keep-awake", enabled),
    refreshTailscale: () => ipcRenderer.invoke("companion:refresh-tailscale"),
    setTailscale: (on) => ipcRenderer.invoke("companion:tailscale", on === true),
    setRoute: (route, on) => ipcRenderer.invoke("companion:route", String(route), on === true),
    dismissNotice: (route) => ipcRenderer.invoke("companion:notice-dismiss", String(route)),
    pairing: (open, expectedToken) => ipcRenderer.invoke("companion:pairing", open, expectedToken),
    cloudDesktop: (deviceId, allowed) => ipcRenderer.invoke("companion:cloud-desktop", deviceId, allowed),
    browserControl: (deviceId, allowed) => ipcRenderer.invoke("companion:browser-control", deviceId, allowed),
    revoke: (deviceId) => ipcRenderer.invoke("companion:revoke", deviceId),
    renewPairing: () => ipcRenderer.invoke("companion:pairing-renew"),
    routes: (deviceId, routes) => ipcRenderer.invoke("companion:routes", deviceId, routes),
  },
  routines: {
    wakeState: () => ipcRenderer.invoke("routines:wake-state"),
    keepAwake: (enabled) => ipcRenderer.invoke("routines:keep-awake", enabled),
  },
  /** Secrets stay in the main process; the renderer sees only status and narrow actions. */
  companionAccount: {
    state: () => ipcRenderer.invoke("companion-account:state"),
    requestCode: (email) => ipcRenderer.invoke("companion-account:request-code", email),
    verifyCode: (email, code) => ipcRenderer.invoke("companion-account:verify-code", email, code),
    retry: () => ipcRenderer.invoke("companion-account:retry"),
    prepare: () => ipcRenderer.invoke("companion-account:prepare"),
    signOut: () => ipcRenderer.invoke("companion-account:sign-out"),
  },
  /** Full/Custom never go through the loopback API, only the embedded server's private utilityProcess port. */
  approvals: {
    setMode: (botId, mode, options) => ipcRenderer.invoke("approvals:set-trusted-mode", botId, mode, options),
  },
  localControl: {
    status: () => ipcRenderer.invoke("cua:linux-status"),
    enable: () => ipcRenderer.invoke("cua:linux-enable"),
    disable: () => ipcRenderer.invoke("cua:linux-disable"),
    retry: () => ipcRenderer.invoke("cua:linux-retry"),
  },
  /** Arms exactly one display-media request from the current renderer frame. */
  beginScreenPreviewIntent: () => ipcRenderer.sendSync("screen:preview-intent"),
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  /** Physical USB devices only; network ADB is deliberately excluded. */
  androidDevice: {
    status: () => ipcRenderer.invoke("android-device:status"),
    frame: (serial) => ipcRenderer.invoke("android-device:frame", serial),
    input: (serial, payload) =>
      ipcRenderer.invoke("android-device:input", serial, payload).then(() => undefined),
  },
  speechStart: (options) => ipcRenderer.invoke("speech:start", options),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  speechFinish: () => ipcRenderer.invoke("speech:finish"),
  onSpeechTranscript: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on("speech:transcript", handler);
    return () => ipcRenderer.removeListener("speech:transcript", handler);
  },
  onSpeechEnd: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("speech:end", handler);
    return () => ipcRenderer.removeListener("speech:end", handler);
  },
  talkShortcut: {
    state: () => ipcRenderer.invoke("talk-shortcut:state"),
    set: (change) => ipcRenderer.invoke("talk-shortcut:set", {
      ...(typeof change?.enabled === "boolean" ? { enabled: change.enabled } : {}),
      ...(typeof change?.key === "string" ? { key: change.key } : {}),
    }),
  },
  callActive: (active) => ipcRenderer.invoke("call:active", active === true).then(() => undefined),
  onOpenAppSettings: (cb) => {
    appSettingsListeners.add(cb);
    queueMicrotask(() => {
      const section = pendingSettingsAction;
      if (!section || !appSettingsListeners.size) return;
      pendingSettingsAction = null;
      for (const listener of appSettingsListeners) listener(section);
    });
    return () => appSettingsListeners.delete(cb);
  },
  /** Electron 32 removed File.path, and only the preload can ask. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** No screen field: macOS 15+ caches that status per process, so it would lie after a grant. */
  permStatus: () => ipcRenderer.invoke("perm:status"),
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),
  relaunch: () => ipcRenderer.invoke("desktop:relaunch"),

  openInstallTerminal: (command) => ipcRenderer.invoke("engine:open-terminal", command),
  copyText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  /** Unlike window.open, this still works after an asynchronous API request. */
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  applySkin: (skin) => ipcRenderer.invoke("desktop:skin", skin),
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    state: () => ipcRenderer.invoke("window:state"),
    onMaximizedChanged: (cb) => {
      const handler = (_event, maximized) => cb(maximized);
      ipcRenderer.on("window:maximized-changed", handler);
      return () => ipcRenderer.removeListener("window:maximized-changed", handler);
    },
  },
  onPackageInstall: (cb) => {
    packageInstallListeners.add(cb);
    queueMicrotask(() => {
      if (!pendingPackageInstall || !packageInstallListeners.size) return;
      const input = pendingPackageInstall;
      pendingPackageInstall = null;
      for (const listener of packageInstallListeners) listener(input);
    });
    return () => packageInstallListeners.delete(cb);
  },
  onChatLink: (cb) => {
    chatLinkListeners.add(cb);
    if (pendingChatLink) {
      const link = pendingChatLink;
      pendingChatLink = null;
      cb(link);
    }
    return () => chatLinkListeners.delete(cb);
  },
  setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),
  desktopViewer: {
    open: (url, title, contextId) => ipcRenderer.invoke("desktop-viewer:open", url, title, contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-viewer:close", contextId),
    currentState: () => ipcRenderer.invoke("desktop-viewer:state-now"),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-viewer:state", handler);
      return () => ipcRenderer.removeListener("desktop-viewer:state", handler);
    },
  },
  desktopWorkspace: {
    open: (input) => ipcRenderer.invoke("desktop-workspace:open", input),
    layout: (items) => ipcRenderer.invoke("desktop-workspace:layout", items),
    setInteractive: (contextId) => ipcRenderer.invoke("desktop-workspace:set-interactive", contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-workspace:close", contextId),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-workspace:state", handler);
      return () => ipcRenderer.removeListener("desktop-workspace:state", handler);
    },
  },
  pickFolder: (current) => ipcRenderer.invoke("desktop:pick-folder", current),
  exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics"),
  saveFile: (filePath) => invokeWithPlainError("desktop:save-file", filePath),
  revealInFolder: (filePath) => ipcRenderer.invoke("desktop:reveal-file", filePath),
  openHtmlInBrowser: (source, name) => invokeWithPlainError("desktop:open-html", source, name),
  // This app's own logs folder (server.log, desktop-crashes.log, updater.log); the page names no path.
  openLogsFolder: () => ipcRenderer.invoke("desktop:open-logs"),
  openAtLogin: {
    state: () => ipcRenderer.invoke("open-at-login:state"),
    set: on => on !== true || isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("open-at-login:set", on === true) : Promise.reject(new Error("Turn on the switch to open OpenMausBot at login.")),
  },
  setCredential: (name, value) => ipcRenderer.invoke("credential:set", name, value),

  /** A remote page may read the list but never change where this window goes. */
  environments: {
    state: () => ipcRenderer.invoke("environments:state"),
    switch: (id) => ipcRenderer.invoke("environments:switch", id),
    addFromLink: (link, name) => ipcRenderer.invoke("environments:add-from-link", link, name),
    create: (name, dataDir) => ipcRenderer.invoke("environments:create", name, dataDir),
    pickDir: () => ipcRenderer.invoke("environments:pick-dir"),
    forget: (id, purge) => ipcRenderer.invoke("environments:forget", id, purge === true),
    status: () => ipcRenderer.invoke("environments:status"),
    retry: (id) => ipcRenderer.invoke("environments:retry", ...(typeof id === "string" ? [id] : [])),
    onStatus: (cb) => {
      const handler = () => cb();
      ipcRenderer.on("environments:status-changed", handler);
      return () => ipcRenderer.removeListener("environments:status-changed", handler);
    },
    onOpenSettings: (cb) => {
      const handler = (_event, computerId) => cb(computerId);
      ipcRenderer.on("workspaces:open-settings", handler);
      return () => ipcRenderer.removeListener("workspaces:open-settings", handler);
    },
  },
  computerSharing: {
    state: id => ipcRenderer.invoke("sharing:state", id),
    chooseFolder: () => ipcRenderer.invoke("sharing:folder"),
    save: (id, grant) => ipcRenderer.invoke("sharing:save", id, grant),
    revoke: id => ipcRenderer.invoke("sharing:revoke", id),
    activity: id => ipcRenderer.invoke("sharing:activity", id),
    servers: () => ipcRenderer.invoke("sharing:servers"),
    allow: id => ipcRenderer.invoke("sharing:allow", id),
    pause: () => ipcRenderer.invoke("sharing:pause"),
    resume: () => ipcRenderer.invoke("sharing:resume"),
  },
  confirm: message => ipcRenderer.invoke("dialog:confirm", message),
  desktopProfile: {
    systemName: () => ipcRenderer.invoke("desktop-profile:system-name"),
  },
  // A bot's notification, shown by main so its click outlives this page; older apps have no such key and the page shows its own.
  desktopNotifications: {
    show: (note) => ipcRenderer.invoke("desktop-notifications:show", note),
    onOpen: (cb) => {
      notificationOpenListeners.add(cb);
      if (pendingNotificationOpen) {
        const target = pendingNotificationOpen;
        pendingNotificationOpen = null;
        cb(target);
      }
      return () => notificationOpenListeners.delete(cb);
    },
  },
  desktopLanguage: {
    choice: () => {
      if (languageChoice === undefined) languageChoice = savedLanguageChoice();
      return languageChoice;
    },
    set: language => {
      languageChoice = String(language);
      return ipcRenderer.invoke("desktop-language:set", languageChoice);
    },
    onChange: listener => {
      languageListeners.add(listener);
      return () => { languageListeners.delete(listener); };
    },
    shown: language => { ipcRenderer.send("desktop-language:shown", String(language)); },
  },
};

contextBridge.exposeInMainWorld(
  "ogb",
  isLocalPage ? bridge : Object.fromEntries(Object.entries(bridge).filter(([key]) => remoteKeys.has(key))),
);
