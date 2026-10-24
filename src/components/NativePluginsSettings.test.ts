import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { Window } from "happy-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/state/store", () => ({ api: request }));
import { NativePluginsSettings } from "./NativePluginsSettings";
import type { Bot } from "@/state/store";

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  const browser = new Window();
  for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Event"] as const) vi.stubGlobal(name, name === "window" ? browser : browser[name]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  request.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("installs from the form and refreshes the global library without enabling a bot", async () => {
  const plugin = { id: "proof", version: "1.0.0", path: "/plugins/proof/package", source: "https://example.test/proof.zip", installedAt: 1 };
  request.mockResolvedValueOnce({ plugins: [] }).mockResolvedValueOnce({ ...plugin, status: "installed" }).mockResolvedValueOnce({ plugins: [plugin] });
  await act(async () => root.render(createElement(NativePluginsSettings)));
  const input = host.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, plugin.source);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(request).toHaveBeenCalledWith("/api/plugins/install", { method: "POST", body: JSON.stringify({ source: plugin.source }) });
  expect(host.textContent).toContain("proof");
  expect(host.textContent).toContain("1.0.0");
  expect(host.querySelector('[role="switch"]')).toBeNull();
});

it("changes only the plugins array and lets a missing reference be removed", async () => {
  request.mockResolvedValue({ plugins: [{ id: "proof", version: "1.0.0" }] });
  const patch = vi.fn();
  const bot = { id: "test-bot", plugins: ["missing"] } as Bot;
  await act(async () => root.render(createElement(NativePluginsSettings, { bot, patch })));
  await act(async () => (host.querySelector('[aria-label="Use proof"]') as HTMLButtonElement).click());
  expect(patch).toHaveBeenLastCalledWith({ plugins: ["missing", "proof"] });
  await act(async () => (host.querySelector('[aria-label="Use missing"]') as HTMLButtonElement).click());
  expect(patch).toHaveBeenLastCalledWith({ plugins: [] });
  expect(request).toHaveBeenCalledTimes(1);
});


it("rejects a local source in the form without calling the install API", async () => {
  request.mockResolvedValue({ plugins: [] });
  await act(async () => root.render(createElement(NativePluginsSettings)));
  const input = host.querySelector("input")!;
  expect(input.placeholder).toBe("HTTP or HTTPS plugin URL");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "/tmp/local-plugin");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("local paths are not supported");
  expect(request).toHaveBeenCalledTimes(1);
});

it("allows cancellation, preserves a busy plugin, and refreshes after a successful uninstall", async () => {
  const plugin = { id: "proof", version: "1.0.0" };
  request.mockResolvedValueOnce({ plugins: [plugin] });
  await act(async () => root.render(createElement(NativePluginsSettings)));
  const open = async () => act(async () => (host.querySelector('[aria-label="Uninstall proof"]') as HTMLButtonElement).click());
  const choose = async (label: string) => act(async () => {
    const dialog = document.querySelector('[role="alertdialog"]')!;
    (Array.from(dialog.querySelectorAll("button")).find(button => button.textContent === label) as HTMLButtonElement).click();
  });
  await open();
  await choose("Cancel");
  expect(request).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  request.mockRejectedValueOnce(new Error("Plugin is in use by a running turn."));
  await open(); await choose("Uninstall");
  expect(host.textContent).toContain("proof");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("running turn");
  request.mockResolvedValueOnce({ removed: true }).mockResolvedValueOnce({ plugins: [] });
  await open(); await choose("Uninstall");
  expect(request).toHaveBeenCalledWith("/api/plugins/uninstall", { method: "POST", body: JSON.stringify({ plugin_id: "proof" }) });
  expect(host.textContent).toContain("No plugins installed.");
});
