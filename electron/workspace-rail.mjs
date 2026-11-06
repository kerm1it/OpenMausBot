import environments from "./environments.cjs";
import { placeLook, railPaint } from "./place-look.mjs";

export const isManagedCloudEnvironment = entry => Boolean(entry?.home || entry?.cloud || entry?.team);

export function visibleWorkspaceState(saved) {
  const visible = saved.environments.filter(entry => !isManagedCloudEnvironment(entry));
  return { ...saved, environments: visible,
    activeId: saved.activeId === environments.LOCAL_ID || visible.some(entry => entry.id === saved.activeId) ? saved.activeId : environments.LOCAL_ID };
}

export function workspacePlaces(saved, waiting = () => false) {
  const local = environments.savedPlace(saved, environments.LOCAL_ID);
  const entries = [local, ...saved.environments.filter(entry => entry.kind !== "local" && entry.origin && !isManagedCloudEnvironment(entry))];
  if (entries.length < 2) return [];
  return entries.map(entry => ({
    id: entry.id, name: entry.name, color: entry.color ?? null,
    kind: entry.id === environments.LOCAL_ID ? "computer" : "server", opens: true,
    paint: railPaint(placeLook(entry), entry.color ?? null),
    ...(entry.id === saved.activeId ? { active: true } : {}),
    ...(waiting(entry.id) ? { attention: true } : {}),
    ...(entry.id !== environments.LOCAL_ID ? { removable: true, forget: true } : {}),
  }));
}

/** Only the window's rail reads saved places; remote pages receive no server inventory. */
export function installWorkspaceRail({ ipcMain, guard, lists, beside, places, open, add, targets, forget }) {
  let sent = "";
  const choices = () => ({ cloud: false, organization: false, account: false, ...add.choices() });
  const listed = (channel, handler) => ipcMain.handle(channel, guard((event, ...args) => {
    if (!lists(event)) throw new Error(`${channel} is only available in the window's rail`);
    return handler(...args);
  }));
  ipcMain.handle("workspaces:places", guard(event => lists(event)
    ? { places: places(), add: choices() }
    : { places: [], add: { cloud: false, link: false, address: false, organization: false }, ...(beside() ? { beside: true } : {}) }));
  listed("workspaces:open", id => {
    const place = places().find(entry => entry.id === id && entry.opens);
    if (!place) throw new Error("That place is no longer available");
    return open(place.id);
  });
  listed("workspaces:remove", async id => {
    const place = places().find(entry => entry.id === id && entry.forget);
    if (!place) throw new Error("That server is no longer available");
    const result = await forget(place.id);
    return { outcome: result === false || result?.ok === false ? "failed" : "removed" };
  });
  listed("workspaces:add", (choice, link) => {
    if (!["link", "address"].includes(choice) || !add.choices()[choice]) throw new Error("Choose a server connection method");
    return add.run(choice, choice === "link" && typeof link === "string" ? link.trim().slice(0, 4096) : undefined);
  });
  return {
    changed() {
      const key = JSON.stringify([places(), choices(), beside()]);
      if (key === sent) return;
      sent = key;
      for (const target of targets()) if (target && !target.isDestroyed()) target.send("workspaces:changed");
    },
  };
}
