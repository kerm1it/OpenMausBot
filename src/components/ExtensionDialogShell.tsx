import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { t } from "@/lib/i18n";

export const extensionFieldClass = "w-full rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink";
export const extensionButtonClass = "rounded-lg bg-accent px-4 py-2 text-[13px] text-white disabled:opacity-40";

export function ExtensionDialogShell({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = () => { if (!busy) onClose(); };
  useModalDialog(ref, close);
  return createPortal(<div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="flex max-h-[90dvh] w-full max-w-2xl flex-col rounded-2xl border border-hairline bg-card text-ink shadow-2xl outline-none">
      <header className="flex items-center justify-between border-b border-hairline px-5 py-4"><h2 className="text-lg font-semibold">{title}</h2><button aria-label={t("common.close")} disabled={busy} onClick={close}><X size={20} /></button></header>
      <div className="overflow-y-auto p-5">{children}</div>
    </div>
  </div>, document.body);
}
