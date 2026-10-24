import { useEffect, useState } from "react";
import { api, type Bot } from "@/state/store";
import { pluginSourceSchema, PLUGIN_SOURCE_ERROR, type InstalledPlugin } from "../../shared/plugins";
import { t } from "@/lib/i18n";
import { Switch } from "./SettingsPrimitives";
import { ConfirmDialog } from "./ConfirmDialog";

export function NativePluginsSettings({ bot, patch }: { bot?: Bot; patch?: (value: { plugins: string[] }) => void }) {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [revision, setRevision] = useState(0);
  const [uninstallId, setUninstallId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api<{ plugins: InstalledPlugin[] }>("/api/plugins").then(result => {
      if (!cancelled) { setPlugins(result.plugins); setError(""); }
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [revision, bot?.id]);
  const install = async () => {
    if (!source.trim() || working) return;
    const parsed = pluginSourceSchema.safeParse(source);
    if (!parsed.success) { setError(PLUGIN_SOURCE_ERROR); return; }
    setWorking(true); setError("");
    try {
      await api("/api/plugins/install", { method: "POST", body: JSON.stringify({ source: parsed.data }) });
      setSource(""); setRevision(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  };
  const ids = [...new Set([...plugins.map(plugin => plugin.id), ...(bot?.plugins ?? [])])];
  const uninstall = async () => {
    if (!uninstallId || working) return;
    setWorking(true); setError("");
    try {
      await api("/api/plugins/uninstall", { method: "POST", body: JSON.stringify({ plugin_id: uninstallId }) });
      setRevision(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); setUninstallId(null); }
  };
  return <section className="rounded-xl bg-card p-4" aria-label="Native plugins">
    <h3 className="text-[15px] font-medium text-ink">{t("connectors.title")}</h3>
    <p className="mt-1 text-[13px] text-ink-secondary">{bot
      ? "Choose installed plugins for this bot. Requires Cursor, Claude Code or Codex. Changes apply on its next turn."
      : "Install from an HTTP or HTTPS archive or GitHub URL, then choose which bots use it. Local paths are not supported. Install from the same URL again to update."}</p>
    {!bot && <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); void install(); }}>
      <input className="min-w-0 flex-1 rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink" aria-label="Plugin source" placeholder="HTTP or HTTPS plugin URL" inputMode="url" value={source} onChange={event => setSource(event.target.value)} disabled={working} />
      <button className="rounded-lg bg-accent px-3 py-2 text-[13px] text-white disabled:opacity-40" disabled={working || !source.trim()}>{working ? "Installing…" : "Install"}</button>
    </form>}
    <div className="mt-3 divide-y divide-hairline/40">
      {ids.map(id => {
        const installed = plugins.find(plugin => plugin.id === id);
        return <div key={id} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1"><div className="text-[13px] font-medium text-ink">{id} <span className="font-normal text-ink-secondary">{installed?.version ?? "Not installed"}</span></div>
            {installed?.description && <p className="text-[12px] text-ink-secondary">{installed.description}</p>}</div>
          {bot && patch && <Switch checked={bot.plugins?.includes(id) ?? false} aria-label={`Use ${id}`} disabled={!installed && !bot.plugins?.includes(id)} onClick={() => patch({ plugins: !bot.plugins?.includes(id) ? [...new Set([...(bot.plugins ?? []), id])] : (bot.plugins ?? []).filter(value => value !== id) })} />}
          {!bot && <button type="button" aria-label={`Uninstall ${id}`} disabled={working} onClick={() => setUninstallId(id)} className="shrink-0 rounded-lg px-2 py-1 text-[13px] text-danger hover:bg-control disabled:opacity-40">Uninstall</button>}
        </div>;
      })}
      {!ids.length && <p className="py-3 text-[13px] text-ink-secondary">No plugins installed.</p>}
    </div>
    {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
    <ConfirmDialog open={uninstallId !== null} title={`Uninstall ${uninstallId ?? "plugin"}?`}
      body="This removes the plugin from the shared library, all bots and new bot defaults. Running turns using it must finish first. You can reinstall it later."
      confirmLabel="Uninstall" pending={working} onCancel={() => { if (!working) setUninstallId(null); }} onConfirm={() => void uninstall()} />
  </section>;
}
