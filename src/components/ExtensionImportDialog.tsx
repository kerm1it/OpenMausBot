import { useEffect, useRef, useState } from "react";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { prepareExtension, prepareExtensionFile, discardExtension, importExtension } from "@/lib/extension-client";
import type { ExtensionInput } from "@/lib/extension-events";
import type { ExtensionFilePreview, ExtensionImportOptions, ExtensionImportPreview, ExtensionImportResult } from "../../shared/extension-import";
import { ExtensionDialogShell, extensionButtonClass, extensionFieldClass } from "./ExtensionDialogShell";

function FileList({ files, previewId }: { files: ExtensionFilePreview[]; previewId: string }) {
  return <div className="max-h-60 overflow-y-auto rounded-lg border border-hairline p-3 text-[12px]">
    {files.map(file => <details key={file.path} className="py-1">
      <summary className="cursor-pointer break-all">{file.path} <span className="text-ink-secondary">({file.size} B{file.executable ? " · executable" : ""})</span></summary>
      {file.text !== undefined ? <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-control p-2">{file.text}</pre>
        : <a className="text-accent" href={`/api/extensions/${encodeURIComponent(previewId)}/files?path=${encodeURIComponent(file.path)}`} download>{t("extension.downloadFile")}</a>}
    </details>)}
  </div>;
}

export function extensionImportBlocked(preview: ExtensionImportPreview, omitted: string[], reused: string[]) {
  return preview.plugins.some(plugin => !omitted.includes(plugin.id) && (plugin.state === "unavailable" || (plugin.state === "different" && !reused.includes(plugin.id))));
}

export function ExtensionImportDialog({ initialInput, onClose, onImported }: {
  initialInput?: ExtensionInput; onClose: () => void; onImported: (result: ExtensionImportResult) => void;
}) {
  const { state } = useStore();
  const [input, setInput] = useState(typeof initialInput === "string" ? initialInput : "");
  const [preview, setPreview] = useState<ExtensionImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [section, setSection] = useState("");
  const [model, setModel] = useState("");
  const [memory, setMemory] = useState(false);
  const [routines, setRoutines] = useState(false);
  const [omittedPlugins, setOmittedPlugins] = useState<string[]>([]);
  const [reusedPlugins, setReusedPlugins] = useState<string[]>([]);
  const [omittedSkills, setOmittedSkills] = useState<string[]>([]);
  const prepared = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const generation = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; request.current?.abort(); if (prepared.current) void discardExtension(prepared.current); }; }, []);
  const prepare = async (value: ExtensionInput | File) => {
    request.current?.abort();
    const current = ++generation.current;
    setBusy(true); setError("");
    const controller = new AbortController(); request.current = controller;
    try {
      const result = value instanceof File ? await prepareExtensionFile(value, controller.signal) : await prepareExtension(value, controller.signal);
      if (!alive.current || current !== generation.current) { void discardExtension(result.id); return; }
      prepared.current = result.id;
      setMemory(false); setRoutines(false);
      setOmittedPlugins([]); setReusedPlugins([]); setOmittedSkills([]);
      setPreview(result); setName(result.name);
    } catch (cause) { if (alive.current && current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current && current === generation.current) setBusy(false); }
  };
  useEffect(() => { if (initialInput) void prepare(initialInput); }, [initialInput]);
  const toggle = (items: string[], id: string) => items.includes(id) ? items.filter(value => value !== id) : [...items, id];
  const confirm = async () => {
    if (!preview || busy || extensionImportBlocked(preview, omittedPlugins, reusedPlugins)) return;
    setBusy(true); setCommitting(true); setError("");
    const options: ExtensionImportOptions = { name: name.trim(), section, includeMemory: memory, includeRoutines: routines,
      omitPlugins: omittedPlugins, reusePlugins: reusedPlugins, omitSkills: omittedSkills };
    if (model) { const [instanceId, modelId] = JSON.parse(model) as [string, string]; options.modelSelection = { instanceId, model: modelId }; }
    try {
      const result = await importExtension(preview.id, options);
      prepared.current = null;
      void discardExtension(preview.id);
      onImported(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) { setBusy(false); setCommitting(false); } }
  };
  return <ExtensionDialogShell title={t("extension.importTitle")} busy={committing} onClose={onClose}>
    {!preview ? <div className="space-y-4">
      <p className="text-[13px] text-ink-secondary">{t("extension.inputHelp")}</p>
      <textarea className={`${extensionFieldClass} min-h-28`} aria-label={t("extension.source")} value={input} onChange={event => setInput(event.target.value)} placeholder="https://… / openmausbot://… / grokbot://…" disabled={busy} />
      <div className="flex items-center gap-3"><button className={extensionButtonClass} disabled={busy || !input.trim()} onClick={() => void prepare(input)}>{busy ? t("extension.preparing") : t("extension.preview")}</button>
        <label className="cursor-pointer text-[13px] text-accent">{t("extension.chooseFile")}<input className="sr-only" type="file" accept=".zip,.json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void prepare(file); }} /></label></div>
    </div> : <div className="space-y-4 text-[13px]">
      <div><div className="break-all text-xs text-ink-secondary">{preview.source} · {preview.type}</div><h3 className="mt-1 text-lg font-semibold">{preview.name}</h3><p className="whitespace-pre-wrap text-ink-secondary">{preview.description}</p></div>
      {preview.warnings.map((warning, index) => <p key={index} className="rounded-lg bg-control p-3 text-ink-secondary">{warning}</p>)}
      {preview.type === "bot" && <>
        <label className="block">{t("extension.botName")}<input className={extensionFieldClass} value={name} onChange={event => setName(event.target.value)} /></label>
        <div className="grid grid-cols-2 gap-3"><label>{t("extension.department")}<select className={extensionFieldClass} value={section} onChange={event => setSection(event.target.value)}><option value="">{t("extension.defaultDepartment")}</option>{(state.sections ?? []).map(value => <option key={value}>{value}</option>)}</select></label>
          <label>{t("extension.model")}<select className={extensionFieldClass} value={model} onChange={event => setModel(event.target.value)}><option value="">{t("extension.defaultModel")}</option>{state.instances.filter(instance => instance.snapshot.state === "available").flatMap(instance => instance.models.options.map(option => <option key={`${instance.instanceId}/${option.id}`} value={JSON.stringify([instance.instanceId, option.id])}>{instance.displayName} · {option.label}</option>))}</select></label></div>
        {preview.profile?.soul && <details><summary className="cursor-pointer">{t("extension.instructions")}</summary><pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded bg-control p-3">{preview.profile.soul}</pre></details>}
      </>}
      {preview.requirements.length > 0 && <div className="rounded-lg bg-control p-3"><h4 className="font-medium">{t("extension.requirements")}</h4>{preview.requirements.map((requirement, index) => <p key={index} className="mt-1"><strong>{requirement.name}</strong>{requirement.description ? ` · ${requirement.description}` : ""}</p>)}</div>}
      {preview.plugins.length > 0 && <section><h4 className="font-medium">{t("extension.plugins")}</h4>{preview.plugins.map(plugin => <div key={plugin.id} className="mt-2 rounded-lg border border-hairline p-3">
        <label className="flex gap-2"><input type="checkbox" disabled={preview.type === "plugin"} checked={!omittedPlugins.includes(plugin.id)} onChange={() => setOmittedPlugins(toggle(omittedPlugins, plugin.id))} /><span>{plugin.name} {plugin.version ?? ""} {plugin.optional ? `(${t("extension.optional")})` : ""}</span></label>
        <p className="mt-1 text-xs text-ink-secondary">{t(`extension.pluginState.${plugin.state}`)}{plugin.installedVersion ? ` · ${plugin.installedVersion}` : ""}{plugin.error ? ` · ${plugin.error}` : ""}</p>
        {plugin.state === "different" && !omittedPlugins.includes(plugin.id) && <label className="mt-2 flex gap-2"><input type="checkbox" checked={reusedPlugins.includes(plugin.id)} onChange={() => setReusedPlugins(toggle(reusedPlugins, plugin.id))} />{t("extension.reusePlugin")}</label>}
        {omittedPlugins.includes(plugin.id) && <p className="mt-2 text-xs text-danger">{t("extension.omitWarning")}</p>}
      </div>)}</section>}
      {preview.skills.length > 0 && <section><h4 className="font-medium">{t("extension.skills")}</h4>{preview.skills.map(skill => <div key={skill.path} className="mt-2"><label className="mb-1 flex gap-2"><input type="checkbox" checked={!omittedSkills.includes(skill.name)} onChange={() => setOmittedSkills(toggle(omittedSkills, skill.name))} />{skill.name}</label><FileList files={skill.files} previewId={preview.id} /></div>)}</section>}
      {preview.memory.length > 0 && <div><label className="flex gap-2"><input type="checkbox" checked={memory} onChange={event => setMemory(event.target.checked)} />{t("extension.includeMemory")} ({preview.memory.length})</label><details className="mt-1"><summary>{t("extension.preview")}</summary>{preview.memory.map(file => <div key={file.path}><strong>{file.path}</strong><pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-control p-2">{file.text}</pre></div>)}</details></div>}
      {preview.routines.length > 0 && <div><label className="flex gap-2"><input type="checkbox" checked={routines} onChange={event => setRoutines(event.target.checked)} />{t("extension.includeRoutines")} ({preview.routines.length})</label><p className="mt-1 text-xs text-ink-secondary">{t("extension.routinesPaused")}</p>{preview.routines.map((routine, index) => <p key={index}>{routine.name} · {routine.schedule}</p>)}</div>}
      <details><summary className="cursor-pointer">{t("extension.files")} ({preview.files.length})</summary><FileList files={preview.files} previewId={preview.id} /></details>
      {preview.type === "plugin" && <p className="text-ink-secondary">{t("extension.libraryOnly")}</p>}
      {extensionImportBlocked(preview, omittedPlugins, reusedPlugins) && <p role="status" className="text-danger">{t("extension.resolveDependencies")}</p>}
      <div className="flex justify-between gap-3 border-t border-hairline pt-4"><button disabled={busy} onClick={() => { void discardExtension(preview.id); prepared.current = null; setPreview(null); }}>{t("extension.back")}</button><button className={extensionButtonClass} disabled={busy || (preview.type === "bot" && !name.trim()) || extensionImportBlocked(preview, omittedPlugins, reusedPlugins)} onClick={() => void confirm()}>{busy ? t("extension.importing") : preview.type === "bot" ? t("extension.createBot") : t("extension.installPlugin")}</button></div>
    </div>}
    {error && <p role="alert" className="mt-3 text-[13px] text-danger">{error}</p>}
  </ExtensionDialogShell>;
}
