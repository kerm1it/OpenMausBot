import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWindowStatePersistence } from "./window-state-main.mjs";

const require = createRequire(import.meta.url);
const { normalizeUnreadCount, parseWindowState, resolveWindowState } = require("./window-state.cjs");

const primary = { x: 0, y: 0, width: 1920, height: 1080 };
const left = { x: -1600, y: 0, width: 1600, height: 900 };

describe("desktop window state", () => {
  it("persists window events and flushes pending bounds on close", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omb-window-state-"));
    const file = path.join(dir, "profile", "window-state.json");
    const log = vi.fn();
    const persistence = createWindowStatePersistence({ file: () => file, log });
    const win = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      getNormalBounds: () => ({ x: 40, y: 50, width: 1200, height: 800 }),
      isMaximized: () => false,
      webContents: { send: vi.fn() },
    });
    vi.useFakeTimers();
    try {
      expect(persistence.read()).toBeNull();
      persistence.install(win);
      win.emit("resize");
      vi.advanceTimersByTime(250);
      expect(persistence.read()).toEqual({
        bounds: { x: 40, y: 50, width: 1200, height: 800 }, maximized: false,
      });
      win.getNormalBounds = () => ({ x: 60, y: 70, width: 1300, height: 900 });
      win.emit("move");
      win.emit("close");
      expect(persistence.read()).toEqual({
        bounds: { x: 60, y: 70, width: 1300, height: 900 }, maximized: false,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(log).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects corrupt and incomplete saved state", () => {
    expect(parseWindowState("not json")).toBeNull();
    expect(parseWindowState({ bounds: { x: 1, y: 2, width: 0, height: 700 } })).toBeNull();
    expect(parseWindowState({ bounds: { x: 1, y: 2, width: 1000 } })).toBeNull();
  });

  it("restores a reachable window on the display where it was saved", () => {
    expect(
      resolveWindowState(
        { bounds: { x: -1500, y: 40, width: 1200, height: 760 }, maximized: true },
        [primary, left],
      ),
    ).toEqual({ bounds: { x: -1500, y: 40, width: 1200, height: 760 }, maximized: true });
  });

  it("centers an off-screen window on the primary display and clamps its size", () => {
    expect(
      resolveWindowState(
        { bounds: { x: 7000, y: 7000, width: 4000, height: 200 }, maximized: false },
        [primary, left],
      ),
    ).toEqual({ bounds: { x: 0, y: 230, width: 1920, height: 620 }, maximized: false });
  });

  it("uses safe default dimensions when there is no saved state", () => {
    expect(resolveWindowState(null, [primary])).toEqual({
      bounds: { width: 1100, height: 780 },
      maximized: false,
    });
  });

  it("bounds native unread counts", () => {
    expect(normalizeUnreadCount(-4)).toBe(0);
    expect(normalizeUnreadCount(3.9)).toBe(3);
    expect(normalizeUnreadCount(10_000)).toBe(999);
    expect(normalizeUnreadCount("3")).toBe(0);
  });
});
