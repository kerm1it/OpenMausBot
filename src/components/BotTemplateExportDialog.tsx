import { useState } from "react";
import { unzipSync } from "fflate";
import type { Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { exportBotTemplate, saveExtensionArchive } from "@/lib/extension-client";
import { ExtensionDialogShell, extensionButtonClass, extensionFieldClass } from "./ExtensionDialogShell";

export function BotTemplateExportDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [name, setName] = useState(bot.name);
  const [id, setId] = useState(bot.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bot-template");
  const [summary, setSummary] = useState(bot.description);
  const [publisher, setPublisher] = useState("");
  const [memory, setMemory] = useState(false);
  const [routines, setRoutines] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [archive, setArchive] = useState<{ blob: Blob; files: Array<{ path: string; size: number }> } | null>(null);
  const prepare = async () => {
    setBusy(true); setError("");
    try {
      const blob = await exportBotTemplate(bot.id, { id, name, summary, publisher: publisher || undefined, includeMemory: memory, includeRoutines: routines });
      const files = Object.entries(unzipSync(new Uint8Array(await blob.arrayBuffer()))).map(([path, data]) => ({ path, size: data.length })).sort((a, b) => a.path.localeCompare(b.path));
      setArchive({ blob, files });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <ExtensionDialogShell title={t("extension.exportTitle")} busy={busy} onClose={onClose}>
    <div className="space-y-4 text-[13px]">
      <p className="text-ink-secondary">{t("extension.exportHelp")}</p>
      {!archive ? <>
        <label className="block">{t("extension.botName")}<input className={extensionFieldClass} value={name} onChange={event => setName(event.target.value)} /></label>
        <label className="block">{t("extension.templateId")}<input className={extensionFieldClass} value={id} onChange={event => setId(event.target.value)} /></label>
        <label className="block">{t("extension.summary")}<textarea className={extensionFieldClass} value={summary} onChange={event => setSummary(event.target.value)} /></label>
        <label className="block">{t("extension.publisher")}<input className={extensionFieldClass} value={publisher} onChange={event => setPublisher(event.target.value)} /></label>
        <label className="flex gap-2"><input type="checkbox" checked={memory} onChange={event => setMemory(event.target.checked)} />{t("extension.includeMemory")}</label>
        <label className="flex gap-2"><input type="checkbox" checked={routines} onChange={event => setRoutines(event.target.checked)} />{t("extension.includeRoutines")}</label>
        <button className={extensionButtonClass} disabled={busy || !name.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)} onClick={() => void prepare()}>{busy ? t("extension.preparing") : t("extension.preview")}</button>
      </> : <>
        <h3 className="font-semibold">{name}</h3><p>{summary}</p>
        <p className="text-ink-secondary">{t("extension.exportReview")}</p>
        <div className="max-h-72 overflow-y-auto rounded-lg border border-hairline p-3">{archive.files.map(file => <p key={file.path} className="break-all py-1">{file.path} <span className="text-ink-secondary">({file.size} B)</span></p>)}</div>
        <div className="flex justify-between"><button onClick={() => setArchive(null)}>{t("extension.back")}</button><button className={extensionButtonClass} onClick={() => { saveExtensionArchive(archive.blob, `${id}.zip`); onClose(); }}>{t("extension.saveArchive")}</button></div>
      </>}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>
  </ExtensionDialogShell>;
}
