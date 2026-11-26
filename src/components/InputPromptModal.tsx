import React, { useEffect, useState } from "react";
import { X } from "lucide-react";

export interface InputPromptModalProps {
  open: boolean;
  title: string;
  subtitle?: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  checkboxLabel?: string;
  initialCheckbox?: boolean;
  onClose: () => void;
  onSubmit: (value: string, checked: boolean) => Promise<void> | void;
}

export const InputPromptModal: React.FC<InputPromptModalProps> = ({
  open,
  title,
  subtitle,
  label,
  initialValue = "",
  placeholder = "",
  confirmLabel = "Confirm",
  checkboxLabel,
  initialCheckbox = true,
  onClose,
  onSubmit,
}) => {
  const [value, setValue] = useState(initialValue);
  const [checked, setChecked] = useState(initialCheckbox);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setChecked(initialCheckbox);
      setSubmitting(false);
      setError(null);
    }
  }, [open, initialValue, initialCheckbox]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, submitting, onClose]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError(`${label} is required.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed, checked);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-xs p-4"
      onClick={() => !submitting && onClose()}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-[var(--border-strong)] bg-[var(--surface-panel)] shadow-2xl overflow-hidden text-xs"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)]">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
              {title}
            </h3>
            {subtitle && (
              <p className="text-[11px] text-zinc-500 truncate mt-0.5">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--surface-hover)] text-zinc-500 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="block text-zinc-500 mb-1">{label}</label>
            <input
              autoFocus
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              placeholder={placeholder}
              className="w-full h-8 px-2.5 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>

          {checkboxLabel && (
            <label className="flex items-center gap-2 text-zinc-700 dark:text-zinc-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                className="rounded border-zinc-400 text-indigo-600 focus:ring-indigo-500"
              />
              <span>{checkboxLabel}</span>
            </label>
          )}

          {error && (
            <div className="rounded-lg border border-red-400/50 bg-red-500/10 px-3 py-2 text-red-500">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-[var(--border-subtle)] bg-[var(--surface-elevated)]">
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="h-7 px-3 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !value.trim()}
            className="h-7 px-3.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50 cursor-pointer"
          >
            {submitting ? "Working..." : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
};
