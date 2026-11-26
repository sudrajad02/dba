import React from "react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useWorkbenchStore } from "../store/useWorkbenchStore";

export const ToastContainer: React.FC = () => {
  const toasts = useWorkbenchStore((s) => s.toasts);
  const dismissToast = useWorkbenchStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-md pointer-events-none">
      {toasts.map((t) => {
        const tone =
          t.level === "error"
            ? "border-red-500/40 bg-red-950/95 text-red-100"
            : t.level === "warn"
            ? "border-amber-500/40 bg-amber-950/95 text-amber-100"
            : t.level === "success"
            ? "border-emerald-500/40 bg-emerald-950/95 text-emerald-100"
            : "border-[var(--border-strong)] bg-[var(--surface-elevated)] text-zinc-900 dark:text-zinc-100";

        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-2.5 px-3 py-2.5 rounded-lg border shadow-xl backdrop-blur-sm text-xs ${tone}`}
          >
            {t.level === "error" ? (
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            ) : t.level === "warn" ? (
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            ) : t.level === "success" ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0 break-words leading-snug">{t.message}</div>
            <button
              onClick={() => dismissToast(t.id)}
              className="p-0.5 rounded hover:bg-white/10 opacity-70 hover:opacity-100 shrink-0"
              aria-label="Dismiss notification"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
