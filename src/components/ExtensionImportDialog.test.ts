import { act, createElement, StrictMode } from "react";
import type { Root } from "react-dom/client";
import { Window } from "happy-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExtensionImportPreview } from "../../shared/extension-import";

const { prepare, importPrepared, discard } = vi.hoisted(() => ({ prepare: vi.fn(), importPrepared: vi.fn(), discard: vi.fn() }));
vi.mock("@/lib/extension-client", () => ({ prepareExtension: prepare, prepareExtensionFile: prepare, importExtension: importPrepared, discardExtension: discard }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { sections: ["Research"], instances: [] } }) }));
import { ExtensionImportDialog } from "./ExtensionImportDialog";

const preview: ExtensionImportPreview = {
  id: "snapshot", type: "bot", source: "openmausbot", name: "Research bot", description: "Research reports",
  requirements: [], skills: [{ name: "report", description: "", path: "skills/report/SKILL.md", files: [
    { path: "skills/report/SKILL.md", size: 20, executable: false, text: "# Report" },
    { path: "skills/report/scripts/report.py", size: 10, executable: true, text: "print('report')" },
  ] }], plugins: [], memory: [{ path: "notes.md", text: "Private note" }], routines: [{ name: "Report", schedule: "daily" }], files: [], warnings: [],
};
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  const browser = new Window();
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Event", "File", "AbortController"] as const) vi.stubGlobal(key, key === "window" ? browser : browser[key]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  prepare.mockReset(); importPrepared.mockReset(); discard.mockReset(); discard.mockResolvedValue(undefined);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const click = async (text: string) => {
  const button = Array.from(document.querySelectorAll("button")).find(value => value.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
};
it("previews complete Skill files and creates a bot with memory and routines excluded by default", async () => {
  prepare.mockResolvedValue(preview);
  importPrepared.mockResolvedValue({ botId: "new-bot", warnings: [] });
  const imported = vi.fn();
  await act(async () => root.render(createElement(ExtensionImportDialog, { initialInput: "https://example.test/bot.zip", onClose: vi.fn(), onImported: imported })));
  expect(document.body.textContent).toContain("scripts/report.py");
  expect(document.body.textContent).toContain("executable");
  expect(document.body.textContent).toContain("created paused");
  await click("Create bot");
  expect(importPrepared).toHaveBeenCalledWith("snapshot", expect.objectContaining({ name: "Research bot", includeMemory: false, includeRoutines: false, omitSkills: [], omitPlugins: [] }));
  expect(imported).toHaveBeenCalledWith({ botId: "new-bot", warnings: [] });
  await act(async () => root.unmount());
  expect(discard).toHaveBeenCalledTimes(1);
});
it("requires explicit missing-plugin omission and installed-version reuse before confirmation", async () => {
  prepare.mockResolvedValue({ ...preview, plugins: [
    { id: "missing", name: "Missing plugin", optional: false, state: "unavailable", error: "Not in marketplace" },
    { id: "different", name: "Different plugin", optional: true, state: "different", version: "2.0", installedVersion: "1.0" },
  ] });
  importPrepared.mockResolvedValue({ botId: "new-bot", warnings: [] });
  await act(async () => root.render(createElement(ExtensionImportDialog, { initialInput: "{}", onClose: vi.fn(), onImported: vi.fn() })));
  expect(Array.from(document.querySelectorAll("button")).find(value => value.textContent === "Create bot")!.disabled).toBe(true);
  const labels = Array.from(document.querySelectorAll("label"));
  await act(async () => labels.find(value => value.textContent?.includes("Missing plugin"))!.querySelector("input")!.click());
  expect(document.body.textContent).toContain("some capabilities may be unavailable");
  await act(async () => labels.find(value => value.textContent?.includes("Use the version already installed"))!.querySelector("input")!.click());
  await click("Create bot");
  expect(importPrepared).toHaveBeenCalledWith("snapshot", expect.objectContaining({ omitPlugins: ["missing"], reusePlugins: ["different"] }));
});
it("keeps source failures visible and never calls import", async () => {
  prepare.mockRejectedValue(new Error("Marketplace resource not found"));
  await act(async () => root.render(createElement(ExtensionImportDialog, { initialInput: "bad-link", onClose: vi.fn(), onImported: vi.fn() })));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Marketplace resource not found");
  expect(importPrepared).not.toHaveBeenCalled();
});
it("shows a readable timeout and allows retrying the source", async () => {
  prepare.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError")).mockResolvedValueOnce(preview);
  await act(async () => root.render(createElement(ExtensionImportDialog, { initialInput: "https://fixture.test/recipe.json", onClose: vi.fn(), onImported: vi.fn() })));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("That took too long. Try again.");
  await click("Preview");
  expect(document.body.textContent).toContain(preview.name);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
it("shows the active plugin, actual bytes and retry state while preparing", async () => {
  prepare.mockImplementation((_input, _signal, progress) => {
    progress({ stage: "plugin", name: "pstack", receivedBytes: 2048, totalBytes: 4096, attempt: 2 });
    return new Promise(() => {});
  });
  await act(async () => root.render(createElement(ExtensionImportDialog, { initialInput: "https://fixture.test/recipe.json", onClose: vi.fn(), onImported: vi.fn() })));
  const status = document.querySelector('[role="status"]')!;
  expect(status.textContent).toContain("Preparing plugin: pstack");
  expect(status.textContent).toContain("2 KB / 4 KB");
  expect(status.textContent).toContain("Retrying download (attempt 2)");
  expect(status.querySelector("progress")?.value).toBe(2048);
  expect(status.querySelector("progress")?.max).toBe(4096);
});
it("discards abandoned snapshots and survives StrictMode effect replay", async () => {
  prepare.mockResolvedValue(preview);
  await act(async () => root.render(createElement(StrictMode, null, createElement(ExtensionImportDialog, { initialInput: "{}", onClose: vi.fn(), onImported: vi.fn() }))));
  expect(document.body.textContent).toContain("Research bot");
  await act(async () => root.unmount());
  expect(discard).toHaveBeenCalledWith("snapshot");
});

it("allows closing a pending preparation and discards a late snapshot", async () => {
  let finish!: (value: ExtensionImportPreview) => void;
  prepare.mockImplementation(() => new Promise<ExtensionImportPreview>(resolve => { finish = resolve; }));
  const closed = vi.fn();
  await act(async () => root.render(createElement(ExtensionImportDialog, { initialInput: "https://example.test/bot.zip", onClose: closed, onImported: vi.fn() })));
  await act(async () => (document.querySelector('[aria-label="Close"]') as HTMLButtonElement).click());
  expect(closed).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  expect(prepare.mock.calls[0]![1].aborted).toBe(true);
  await act(async () => finish(preview));
  expect(discard).toHaveBeenCalledWith("snapshot");
});

it("starts every newly prepared template with memory and routines excluded", async () => {
  prepare.mockResolvedValueOnce(preview).mockResolvedValueOnce({ ...preview, id: "second-snapshot", name: "Second bot" });
  await act(async () => root.render(createElement(ExtensionImportDialog, { initialInput: "first", onClose: vi.fn(), onImported: vi.fn() })));
  const optionalInputs = () => Array.from(document.querySelectorAll("label")).filter(label => label.textContent?.includes("Include memory") || label.textContent?.includes("Include routines")).map(label => label.querySelector("input")!);
  await act(async () => { for (const input of optionalInputs()) input.click(); });
  expect(optionalInputs().every(input => input.checked)).toBe(true);
  await click("Back");
  const source = document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(source, "second");
    source.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Preview");
  expect(document.body.textContent).toContain("Second bot");
  expect(optionalInputs()).toHaveLength(2);
  expect(optionalInputs().every(input => !input.checked)).toBe(true);
});
