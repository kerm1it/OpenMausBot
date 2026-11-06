import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStore, type Bot } from "@/state/store";
import { EXTENSION_EXPORT_EVENT, EXTENSION_IMPORT_EVENT, EXTENSION_INSTALLED_EVENT, type ExtensionInput } from "@/lib/extension-events";
import type { ExtensionImportResult } from "../../shared/extension-import";
import { ExtensionImportDialog } from "./ExtensionImportDialog";
import { BotTemplateExportDialog } from "./BotTemplateExportDialog";
import { t } from "@/lib/i18n";

export function ExtensionHost({ disabled, onLegacyPackage }: { disabled: boolean; onLegacyPackage: (url: string) => void }) {
  const { state, dispatch } = useStore();
  const [importing, setImporting] = useState<{ input?: ExtensionInput } | null>(null);
  const [exportId, setExportId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const legacy = useRef(onLegacyPackage); legacy.current = onLegacyPackage;
  const pending = useRef<ExtensionInput[]>([]);
  const currentInput = useRef<ExtensionInput | undefined>(undefined);
  const active = useRef(false);
  active.current = importing !== null || exportId !== null;
  useEffect(() => {
    if (disabled) return;
    const openImport = (event: Event) => {
      const input = (event as CustomEvent<ExtensionInput | undefined>).detail ?? undefined;
      if (active.current) { if (input && JSON.stringify(input) !== JSON.stringify(currentInput.current) && !pending.current.some(value => JSON.stringify(value) === JSON.stringify(input))) pending.current.push(input); return; }
      active.current = true;
      currentInput.current = input;
      setImporting({ input });
    };
    const openExport = (event: Event) => {
      if (active.current) return;
      const value: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof value === "string") { active.current = true; setExportId(value); }
    };
    const dispose = window.ogb?.onPackageInstall?.(input => {
      if (typeof input === "string") legacy.current(input);
      else openImport(new window.CustomEvent(EXTENSION_IMPORT_EVENT, { detail: input }));
    });
    window.addEventListener(EXTENSION_IMPORT_EVENT, openImport);
    window.addEventListener(EXTENSION_EXPORT_EVENT, openExport);
    return () => { dispose?.(); window.removeEventListener(EXTENSION_IMPORT_EVENT, openImport); window.removeEventListener(EXTENSION_EXPORT_EVENT, openExport); };
  }, [disabled]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 12_000); return () => window.clearTimeout(timer); }, [notice]);
  const close = () => {
    setExportId(null);
    const next = pending.current.shift();
    active.current = Boolean(next);
    currentInput.current = next;
    setImporting(next ? { input: next } : null);
  };
  const imported = (result: ExtensionImportResult) => {
    close();
    if (result.bot) {
      const bot: Bot = { ...result.bot, messages: [] };
      dispatch({ type: "botAdded", bot });
    } else if (result.botId) dispatch({ type: "select", id: result.botId });
    window.dispatchEvent(new window.Event(EXTENSION_INSTALLED_EVENT));
    setNotice([t(result.pluginId ? "extension.pluginInstalled" : "extension.botCreated"), ...result.warnings].join(" · "));
  };
  const bot = state.bots.find(value => value.id === exportId);
  return <>
    {importing && <ExtensionImportDialog key={JSON.stringify(importing.input) ?? "manual"} initialInput={importing.input} onClose={close} onImported={imported} />}
    {bot && <BotTemplateExportDialog bot={bot} onClose={close} />}
    {notice && createPortal(<div role="status" className="fixed bottom-4 left-4 z-[90] max-w-md rounded-xl border border-hairline bg-card p-4 text-[13px] text-ink shadow-xl">{notice}</div>, document.body)}
  </>;
}
