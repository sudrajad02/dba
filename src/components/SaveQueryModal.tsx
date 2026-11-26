import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, FileCode2, Folder, Save, X } from "lucide-react";
import { validateQueryName } from "../lib/savedQueries";

export interface SaveQueryModalProps {
  open: boolean;
  mode: "save" | "save_as" | "rename" | "duplicate";
  initialName: string;
  extension: ".sql" | ".mongodb.json";
  connectionName?: string | null;
  databaseName?: string | null;
  existingNames: string[];
  allowOverwrite?: boolean;
  onClose: () => void;
  onSubmit: (cleanName: string) => Promise<void>;
}

export const SaveQueryModal: React.FC<SaveQueryModalProps> = ({
  open,
  mode,
  initialName,
  extension,
  connectionName,
  databaseName,
  existingNames,
  allowOverwrite = true,
  onClose,
  onSubmit,
}) => {
  const [name, setName] = useState(initialName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const stripped = initialName
      .replace(/\.mongodb\.json$/i, "")
      .replace(/\.sql$/i, "");
    setName(stripped);
    setError(null);
    setSubmitting(false);
    setConfirmOverwrite(false);
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 10);
  }, [open, initialName]);

  const normalizedName = useMemo(
    () =>
      name
        .trim()
        .replace(/\.mongodb\.json$/i, "")
        .replace(/\.sql$/i, "")
        .trim(),
    [name]
  );

  const validationError = useMemo(() => validateQueryName(name), [name]);

  const alreadyExists = useMemo(() => {
    if (!normalizedName) return false;
    const lower = normalizedName.toLowerCase();
    return existingNames.some((n) => n.toLowerCase() === lower);
  }, [normalizedName, existingNames]);

  if (!open) return null;

  const title =
    mode === "save_as"
      ? "Save Query As"
      : mode === "rename"
      ? "Rename Saved Query"
      : mode === "duplicate"
      ? "Duplicate Saved Query"
      : "Save Query";

  const submitLabel =
    mode === "rename"
      ? "Rename"
      : mode === "duplicate"
      ? "Duplicate"
      : alreadyExists && allowOverwrite
      ? "Overwrite & Save"
      : "Save Query";

  const locationLabel = connectionName
    ? databaseName
      ? `${connectionName} / ${databaseName}`
      : connectionName
    : "Global Saved Queries";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (validationError) {
      setError(validationError);
      return;
    }
    if (alreadyExists && !allowOverwrite) {
      setError(`A query named "${normalizedName}${extension}" already exists here.`);
      return;
    }
    if (alreadyExists && allowOverwrite && !confirmOverwrite) {
      setConfirmOverwrite(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(normalizedName);
      onClose();
    } catch (err) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4"
      onClick={() => !submitting && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !submitting) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden text-xs"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <FileCode2 className="w-4 h-4 text-emerald-500" />
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {title}
            </h3>
          </div>
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Location preview */}
          <div className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400">
            <Folder className="w-3.5 h-3.5 text-sky-500 shrink-0" />
            <span className="truncate font-medium">{locationLabel}</span>
          </div>

          <div>
            <label className="block text-zinc-500 mb-1">Query Name</label>
            <div className="flex items-center">
              <input
                ref={inputRef}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                  setConfirmOverwrite(false);
                }}
                placeholder={extension === ".mongodb.json" ? "active_users" : "report_monthly"}
                className="flex-1 h-8 px-2.5 rounded-l bg-zinc-50 dark:bg-zinc-950 border border-r-0 border-zinc-300 dark:border-zinc-700 font-mono focus:outline-none focus:border-indigo-500"
              />
              <span className="h-8 px-2.5 flex items-center rounded-r bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 font-mono text-zinc-500">
                {extension}
              </span>
            </div>
          </div>

          {alreadyExists && allowOverwrite && (
            <div className="rounded-lg border border-amber-400/50 bg-amber-500/10 px-3 py-2 text-amber-600 dark:text-amber-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <strong>{normalizedName}{extension}</strong> already exists in this location.
                {confirmOverwrite
                  ? " Click Overwrite & Save again to confirm replacing it."
                  : " Submitting will overwrite the existing file."}
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-950/40">
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !normalizedName}
            className={`px-3.5 py-1.5 rounded-lg text-white font-medium disabled:opacity-50 flex items-center gap-1.5 ${
              alreadyExists && allowOverwrite
                ? "bg-amber-600 hover:bg-amber-500"
                : "bg-indigo-600 hover:bg-indigo-500"
            }`}
          >
            <Save className="w-3.5 h-3.5" />
            {submitting ? "Saving..." : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
};
