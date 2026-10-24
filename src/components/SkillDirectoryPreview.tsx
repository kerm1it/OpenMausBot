import type { SkillDirectoryFileWire } from "../../shared/skill-directory";

export function SkillDirectoryPreview({ files }: { files?: SkillDirectoryFileWire[] }) {
  if (!files?.length) return null;
  return <div className="mt-3 space-y-2" aria-label="Complete Skill directory">
    {files.map(file => <details key={file.path} className="rounded-lg border border-hairline/40 p-2">
      <summary className="break-all font-mono text-[11px] text-ink-secondary">{file.path} · {file.size} bytes{file.executable ? " · executable" : ""}{file.binary ? " · binary" : ""}</summary>
      <div className="mt-1 break-all font-mono text-[10px] text-ink-secondary">sha256 {file.sha256}</div>
      {file.content !== undefined && <pre tabIndex={0} aria-label={`Full ${file.path}`} className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] text-ink">{file.content}</pre>}
      {file.download && <a className="mt-1 inline-block text-[12px] text-accent" href={file.download} download>Download file</a>}
    </details>)}
  </div>;
}
