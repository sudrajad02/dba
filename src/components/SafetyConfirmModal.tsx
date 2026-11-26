import React from "react";
import { ShieldAlert, X } from "lucide-react";
import { useWorkbenchStore } from "../store/useWorkbenchStore";

export const SafetyConfirmModal: React.FC = () => {
  const { safetyModal, closeSafetyModal } = useWorkbenchStore();

  if (!safetyModal || !safetyModal.open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/65  flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-md border border-red-500/40 bg-[var(--surface-panel)] shadow-2xl overflow-hidden">
        <div className="px-4 py-3 bg-red-600/15 border-b border-red-500/30 flex items-center justify-between">
          <div className="flex items-center gap-2 text-red-400 font-semibold text-sm">
            <ShieldAlert className="w-4 h-4" />
            <span>Production Safety Guard — {safetyModal.title}</span>
          </div>
          <button
            onClick={closeSafetyModal}
            className="p-1 rounded hover:bg-red-500/20 text-red-400"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3 text-xs">
          <ul className="space-y-1 text-amber-400 list-disc pl-4">
            {safetyModal.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>

          <div>
            <div className="text-[0.8rem] font-medium text-zinc-500 mb-1">
              SQL Statement(s) to Execute:
            </div>
            <pre className="p-3 rounded-lg bg-[#1e1f22] text-zinc-100 font-mono text-[0.8rem] max-h-56 overflow-auto border border-zinc-800 whitespace-pre-wrap">
              {safetyModal.sqlPreview}
            </pre>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-[var(--border-subtle)] flex justify-end gap-2">
          <button
            onClick={closeSafetyModal}
            className="h-8 px-3.5 rounded-md text-xs font-medium bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              const fn = safetyModal.onConfirm;
              closeSafetyModal();
              fn();
            }}
            className="h-8 px-4 rounded-md text-xs font-semibold bg-red-600 hover:bg-red-500 text-white"
          >
            Confirm & Execute
          </button>
        </div>
      </div>
    </div>
  );
};
