import { createRequire } from "node:module";
import { expect, it } from "vitest";

it("allows only the fixed local settings action through the remote-safe preload bridge", () => {
  const require = createRequire(import.meta.url);
  const handlers = new Map<string, (event: unknown, section: unknown) => void>();
  const reached: unknown[] = [];
  const electron = require.resolve("electron");
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
    ipcRenderer: { on: (channel: string, handler: (event: unknown, section: unknown) => void) => handlers.set(channel, handler), removeListener: () => {}, invoke: async () => {}, send: () => {} },
    contextBridge: { exposeInMainWorld: (_name: string, api: { onOpenAppSettings: (cb: (section: unknown) => void) => void }) => api.onOpenAppSettings((section) => reached.push(section)) },
    webUtils: { getPathForFile: () => "" },
  } } as unknown as NodeJS.Module;
  require("../../../electron/preload.cjs");
  for (const section of ["phone", "workspaces", "organization", "__proto__"]) handlers.get("app:open-settings")?.({}, section);
  expect(reached).toEqual([undefined, "workspaces", undefined, undefined]);
});
