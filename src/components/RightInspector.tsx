import React, { useMemo, useState } from "react";
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  CornerDownLeft,
  Edit3,
  FileCode2,
  Info,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import type { CodeSnippet, DbEngine } from "../types/dba";

interface SectionProps {
  title: string;
  count?: number;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

const InfoSection: React.FC<SectionProps> = ({
  title,
  count,
  icon,
  defaultOpen = true,
  children,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-[var(--border-subtle)] rounded-lg overflow-hidden bg-[var(--surface-canvas)]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full px-2.5 py-1.5 bg-[var(--surface-elevated)] flex items-center gap-1.5 text-left text-[0.74rem] font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-[var(--surface-hover)] cursor-pointer"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
        )}
        {icon}
        <span className="truncate">{title}</span>
        {count !== undefined && (
          <span className="ml-auto text-[0.68rem] font-mono text-zinc-500">
            {count}
          </span>
        )}
      </button>
      {open && <div className="p-2">{children}</div>}
    </div>
  );
};

export const RightInspector: React.FC = () => {
  const {
    inspectedCell,
    inspectedTableMeta,
    inspectedObject,
    snippets,
    refreshSnippets,
    tabs,
    activeTabId,
    openTab,
    activeConnectionId,
    toggleRightInspector,
    rightInspectorWidth,
    addLog,
  } = useWorkbenchStore();

  const [tab, setTab] = useState<"meta" | "cell" | "snippets">("meta");
  const [snippetSearch, setSnippetSearch] = useState("");
  const [editingSnippet, setEditingSnippet] = useState<{
    id: string;
    name: string;
    description: string;
    engine: DbEngine | "";
    body: string;
  } | null>(null);
  const [savingSnippet, setSavingSnippet] = useState(false);

  const filteredSnippets = useMemo(() => {
    const q = snippetSearch.trim().toLowerCase();
    if (!q) return snippets;
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.body.toLowerCase().includes(q)
    );
  }, [snippets, snippetSearch]);

  const handleInsertSnippetAtCursor = (sn: CodeSnippet) => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (activeTab && activeTab.kind === "query") {
      window.dispatchEvent(
        new CustomEvent("dba:insert-snippet", { detail: { text: sn.body } })
      );
      addLog("info", `Inserted snippet "${sn.name}" at cursor`);
      return;
    }
    openTab({
      kind: "query",
      title: sn.name,
      connectionId: activeConnectionId ?? undefined,
      sql: sn.body,
    });
  };

  const handleSaveSnippet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSnippet || !editingSnippet.name.trim() || !editingSnippet.body.trim()) {
      return;
    }
    setSavingSnippet(true);
    try {
      await api.saveSnippet({
        id: editingSnippet.id,
        name: editingSnippet.name.trim(),
        description: editingSnippet.description.trim(),
        engine: editingSnippet.engine ? editingSnippet.engine : null,
        body: editingSnippet.body,
      });
      await refreshSnippets();
      addLog(
        "success",
        `${editingSnippet.id ? "Updated" : "Created"} snippet "${editingSnippet.name.trim()}"`,
        undefined,
        true
      );
      setEditingSnippet(null);
    } catch (err) {
      addLog("error", `Failed to save snippet: ${formatApiError(err)}`);
    } finally {
      setSavingSnippet(false);
    }
  };

  const handleDeleteSnippet = async (sn: CodeSnippet) => {
    try {
      await api.deleteSnippet(sn.id);
      await refreshSnippets();
      addLog("warn", `Deleted snippet "${sn.name}"`, undefined, true);
    } catch (err) {
      addLog("error", `Failed to delete snippet: ${formatApiError(err)}`);
    }
  };

  const renderCellContent = () => {
    if (!inspectedCell) {
      return (
        <div className="p-4 text-zinc-500 text-xs">
          Click any cell in Data Viewer or Query Results to inspect JSON, long text, or binary hex.
        </div>
      );
    }

    let formatted = "";
    let isJson = false;
    const raw = inspectedCell.value;
    if (raw === null || raw === undefined) {
      formatted = "NULL";
    } else if (typeof raw === "object") {
      formatted = JSON.stringify(raw, null, 2);
      isJson = true;
    } else {
      const str = String(raw);
      if (
        (str.startsWith("{") && str.endsWith("}")) ||
        (str.startsWith("[") && str.endsWith("]"))
      ) {
        try {
          formatted = JSON.stringify(JSON.parse(str), null, 2);
          isJson = true;
        } catch {
          formatted = str;
        }
      } else {
        formatted = str;
      }
    }

    return (
      <div className="p-3 space-y-2.5 text-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="font-semibold text-zinc-900 dark:text-zinc-100 truncate">
              {inspectedCell.column}
            </div>
            <div className="text-[0.72rem] font-mono text-zinc-500">
              {inspectedCell.dataType} {isJson ? "• JSON" : ""}
            </div>
          </div>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(formatted);
              addLog("info", `Copied value of "${inspectedCell.column}"`);
            }}
            className="h-6 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1 text-[0.75rem] shrink-0 cursor-pointer"
          >
            <Copy className="w-3 h-3" /> Copy
          </button>
        </div>
        <pre className="p-2.5 rounded-lg bg-[var(--surface-canvas)] border border-[var(--border-subtle)] font-mono text-[0.78rem] overflow-auto max-h-[calc(100vh-220px)] whitespace-pre-wrap break-all">
          {formatted}
        </pre>
      </div>
    );
  };

  const renderInfoPane = () => {
    const meta = inspectedObject?.tableMeta ?? inspectedTableMeta;
    const obj = inspectedObject?.object ?? null;
    const ddl = inspectedObject?.ddl ?? meta?.ddl ?? null;
    const loading = inspectedObject?.loading ?? false;

    if (!obj && !meta) {
      return (
        <div className="p-4 text-zinc-500 text-xs space-y-1.5">
          <div className="font-medium text-zinc-700 dark:text-zinc-300">
            Navicat Information Pane
          </div>
          <p>
            Single-click any table, view, function, procedure, or trigger in the sidebar or Objects Browser to inspect its columns, indexes, foreign keys, check constraints, and DDL.
          </p>
        </div>
      );
    }

    const displayName = obj?.name ?? meta?.name ?? "Object";
    const displayKind = obj?.kind ?? "table";
    const displaySchema = inspectedObject?.schema ?? meta?.schema ?? null;
    const displayDb = inspectedObject?.database ?? null;
    const rowEstimate = obj?.rowEstimate ?? meta?.rowEstimate ?? null;
    const comment = obj?.comment ?? null;

    return (
      <div className="p-2.5 space-y-2.5 text-xs">
        {/* General */}
        <InfoSection
          title="General"
          icon={<Info className="w-3.5 h-3.5 text-sky-400 shrink-0" />}
          defaultOpen={true}
        >
          <div className="space-y-1 text-[0.75rem]">
            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-500">Name</span>
              <span className="font-mono font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                {displayName}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-zinc-500">Type</span>
              <span className="px-1.5 py-0.5 rounded bg-[var(--surface-elevated)] font-mono text-[0.68rem] uppercase text-sky-500 dark:text-sky-400">
                {displayKind.replace("_", " ")}
              </span>
            </div>
            {displayDb && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-500">Database</span>
                <span className="font-mono text-zinc-700 dark:text-zinc-300 truncate">
                  {displayDb}
                </span>
              </div>
            )}
            {displaySchema && displaySchema !== displayDb && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-500">Schema</span>
                <span className="font-mono text-zinc-700 dark:text-zinc-300 truncate">
                  {displaySchema}
                </span>
              </div>
            )}
            {rowEstimate != null && (
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-500">Rows (Est.)</span>
                <span className="font-mono text-zinc-700 dark:text-zinc-300">
                  {rowEstimate.toLocaleString()}
                </span>
              </div>
            )}
            {comment && (
              <div className="pt-1 border-t border-[var(--border-subtle)] text-zinc-500">
                {comment}
              </div>
            )}
          </div>
          {loading && (
            <div className="mt-2 flex items-center gap-1.5 text-[0.72rem] text-indigo-400">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading object details...
            </div>
          )}
        </InfoSection>

        {/* Columns */}
        {meta && meta.columns.length > 0 && (
          <InfoSection
            title="Columns"
            count={meta.columns.length}
            icon={<Table2 className="w-3.5 h-3.5 text-cyan-400 shrink-0" />}
            defaultOpen={true}
          >
            <div className="space-y-1">
              {meta.columns.map((c) => (
                <div
                  key={c.name}
                  className="px-2 py-1 rounded border border-[var(--border-subtle)] bg-[var(--surface-panel)] space-y-0.5"
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100 truncate">
                      {c.name}
                    </span>
                    <span className="text-[0.7rem] font-mono text-zinc-500 shrink-0">
                      {c.dataType}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 text-[0.65rem]">
                    {c.isPrimaryKey && (
                      <span className="px-1 rounded bg-amber-500/20 text-amber-500 font-semibold">
                        PK
                      </span>
                    )}
                    {!c.nullable && (
                      <span className="px-1 rounded bg-sky-500/15 text-sky-400 font-semibold">
                        NN
                      </span>
                    )}
                    {c.isAutoIncrement && (
                      <span className="px-1 rounded bg-emerald-500/15 text-emerald-400 font-semibold">
                        AI
                      </span>
                    )}
                    {c.defaultValue != null && c.defaultValue !== "" && (
                      <span
                        title={`Default: ${c.defaultValue}`}
                        className="font-mono text-zinc-500 truncate max-w-full"
                      >
                        = {c.defaultValue}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </InfoSection>
        )}

        {/* Indexes */}
        {meta && (
          <InfoSection
            title="Indexes"
            count={meta.indexes.length}
            icon={<KeyRound className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
            defaultOpen={meta.indexes.length > 0}
          >
            {meta.indexes.length === 0 ? (
              <div className="text-[0.74rem] text-zinc-500 italic">No indexes</div>
            ) : (
              <div className="space-y-1">
                {meta.indexes.map((idx) => (
                  <div
                    key={idx.name}
                    className="px-2 py-1.5 rounded border border-[var(--border-subtle)] bg-[var(--surface-panel)] space-y-0.5"
                  >
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono font-medium text-zinc-900 dark:text-zinc-100 truncate">
                        {idx.name}
                      </span>
                      {idx.isPrimary && (
                        <span className="px-1 rounded bg-amber-500/20 text-amber-500 text-[0.64rem] font-semibold">
                          PRIMARY
                        </span>
                      )}
                      {idx.isUnique && !idx.isPrimary && (
                        <span className="px-1 rounded bg-purple-500/20 text-purple-400 text-[0.64rem] font-semibold">
                          UNIQUE
                        </span>
                      )}
                      {idx.method && (
                        <span className="ml-auto text-[0.66rem] font-mono text-zinc-500 uppercase">
                          {idx.method}
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[0.7rem] text-zinc-500 truncate">
                      ({idx.columns.join(", ")})
                    </div>
                  </div>
                ))}
              </div>
            )}
          </InfoSection>
        )}

        {/* Foreign Keys */}
        {meta && (
          <InfoSection
            title="Foreign Keys"
            count={meta.foreignKeys.length}
            icon={<Link2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />}
            defaultOpen={meta.foreignKeys.length > 0}
          >
            {meta.foreignKeys.length === 0 ? (
              <div className="text-[0.74rem] text-zinc-500 italic">No foreign keys</div>
            ) : (
              <div className="space-y-1">
                {meta.foreignKeys.map((fk) => (
                  <div
                    key={fk.name}
                    className="px-2 py-1.5 rounded border border-[var(--border-subtle)] bg-[var(--surface-panel)] space-y-0.5"
                  >
                    <div className="font-mono font-medium text-zinc-900 dark:text-zinc-100 truncate">
                      {fk.name}
                    </div>
                    <div className="font-mono text-[0.7rem] text-sky-500 dark:text-sky-400 break-all">
                      ({fk.columns.join(", ")}) →{" "}
                      {fk.refSchema ? `${fk.refSchema}.` : ""}
                      {fk.refTable}({fk.refColumns.join(", ")})
                    </div>
                    <div className="text-[0.66rem] text-zinc-500">
                      ON UPDATE {fk.onUpdate} • ON DELETE {fk.onDelete}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </InfoSection>
        )}

        {/* Check Constraints */}
        {meta && (
          <InfoSection
            title="Check Constraints"
            count={meta.checks.length}
            icon={<ShieldCheck className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
            defaultOpen={meta.checks.length > 0}
          >
            {meta.checks.length === 0 ? (
              <div className="text-[0.74rem] text-zinc-500 italic">No check constraints</div>
            ) : (
              <div className="space-y-1">
                {meta.checks.map((chk) => (
                  <div
                    key={chk.name}
                    className="px-2 py-1.5 rounded border border-[var(--border-subtle)] bg-[var(--surface-panel)] space-y-0.5"
                  >
                    <div className="font-mono font-medium text-zinc-900 dark:text-zinc-100 truncate">
                      {chk.name}
                    </div>
                    <div className="font-mono text-[0.7rem] text-zinc-500 break-all">
                      {chk.expression}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </InfoSection>
        )}

        {/* DDL Preview */}
        <InfoSection
          title="DDL Preview"
          icon={<Code2 className="w-3.5 h-3.5 text-teal-400 shrink-0" />}
          defaultOpen={true}
        >
          {ddl ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(ddl);
                    addLog("success", `Copied DDL for "${displayName}"`, undefined, true);
                  }}
                  className="h-6 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1 text-[0.72rem] cursor-pointer"
                >
                  <Copy className="w-3 h-3" /> Copy DDL
                </button>
                <button
                  type="button"
                  onClick={() =>
                    openTab({
                      kind: "query",
                      title: `${displayName} DDL`,
                      connectionId: inspectedObject?.connectionId ?? activeConnectionId ?? undefined,
                      database: displayDb ?? undefined,
                      schema: displaySchema ?? undefined,
                      sql: ddl,
                    })
                  }
                  className="h-6 px-2 rounded bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 flex items-center gap-1 text-[0.72rem] cursor-pointer"
                >
                  <FileCode2 className="w-3 h-3" /> Open
                </button>
              </div>
              <pre className="p-2 rounded bg-[var(--surface-panel)] border border-[var(--border-subtle)] font-mono text-[0.72rem] text-zinc-700 dark:text-zinc-300 overflow-x-auto max-h-64 whitespace-pre-wrap break-words">
                {ddl}
              </pre>
            </div>
          ) : (
            <div className="text-[0.74rem] text-zinc-500 italic">
              {loading ? "Fetching DDL..." : "DDL preview unavailable for this object."}
            </div>
          )}
        </InfoSection>
      </div>
    );
  };

  return (
    <aside
      style={{ width: rightInspectorWidth }}
      className="shrink-0 h-full flex flex-col border-l border-[var(--border-subtle)] bg-[var(--surface-panel)]"
    >
      <div className="h-9 px-2 border-b border-[var(--border-subtle)] flex items-center gap-1 text-xs shrink-0">
        <button
          onClick={() => setTab("meta")}
          className={`h-7 px-2 rounded flex items-center gap-1 cursor-pointer ${
            tab === "meta"
              ? "bg-indigo-600/20 text-indigo-400 font-medium"
              : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          }`}
        >
          <Info className="w-3.5 h-3.5" /> Info
        </button>
        <button
          onClick={() => setTab("cell")}
          className={`h-7 px-2 rounded flex items-center gap-1 cursor-pointer ${
            tab === "cell"
              ? "bg-indigo-600/20 text-indigo-400 font-medium"
              : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          }`}
        >
          <Braces className="w-3.5 h-3.5" /> Cell
        </button>
        <button
          onClick={() => setTab("snippets")}
          className={`h-7 px-2 rounded flex items-center gap-1 cursor-pointer ${
            tab === "snippets"
              ? "bg-indigo-600/20 text-indigo-400 font-medium"
              : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" /> Snippets
        </button>

        <button
          onClick={toggleRightInspector}
          title="Close Inspector Panel"
          className="ml-auto p-1 rounded text-zinc-500 hover:bg-[var(--surface-hover)] hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === "meta" && renderInfoPane()}
        {tab === "cell" && renderCellContent()}

        {tab === "snippets" && (
          <div className="p-2.5 space-y-2.5 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2 top-1/2 -translate-y-1/2" />
                <input
                  value={snippetSearch}
                  onChange={(e) => setSnippetSearch(e.target.value)}
                  placeholder="Filter snippets..."
                  className="w-full h-7 pl-7 pr-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <button
                type="button"
                onClick={() =>
                  setEditingSnippet({
                    id: "",
                    name: "",
                    description: "",
                    engine: "",
                    body: "",
                  })
                }
                title="New Snippet"
                className="h-7 px-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-1 shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" /> New
              </button>
            </div>

            {editingSnippet && (
              <form
                onSubmit={handleSaveSnippet}
                className="p-2.5 rounded-lg border border-indigo-500/40 bg-[var(--surface-canvas)] space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-indigo-400">
                    {editingSnippet.id ? "Edit Snippet" : "New Snippet"}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingSnippet(null)}
                    className="p-0.5 rounded hover:bg-[var(--surface-hover)] text-zinc-500 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <input
                  autoFocus
                  value={editingSnippet.name}
                  onChange={(e) =>
                    setEditingSnippet((prev) =>
                      prev ? { ...prev, name: e.target.value } : null
                    )
                  }
                  placeholder="Snippet name"
                  className="w-full h-7 px-2 rounded bg-[var(--surface-panel)] border border-[var(--border-strong)] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <input
                  value={editingSnippet.description}
                  onChange={(e) =>
                    setEditingSnippet((prev) =>
                      prev ? { ...prev, description: e.target.value } : null
                    )
                  }
                  placeholder="Short description (optional)"
                  className="w-full h-7 px-2 rounded bg-[var(--surface-panel)] border border-[var(--border-strong)] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <select
                  value={editingSnippet.engine}
                  onChange={(e) =>
                    setEditingSnippet((prev) =>
                      prev ? { ...prev, engine: e.target.value as DbEngine | "" } : null
                    )
                  }
                  className="w-full h-7 px-2 rounded bg-[var(--surface-panel)] border border-[var(--border-strong)]"
                >
                  <option value="">All Engines</option>
                  <option value="postgres">PostgreSQL</option>
                  <option value="mysql">MySQL / MariaDB</option>
                  <option value="mssql">SQL Server</option>
                  <option value="mongodb">MongoDB</option>
                </select>
                <textarea
                  rows={5}
                  value={editingSnippet.body}
                  onChange={(e) =>
                    setEditingSnippet((prev) =>
                      prev ? { ...prev, body: e.target.value } : null
                    )
                  }
                  placeholder="SELECT * FROM ..."
                  className="w-full p-2 rounded bg-[var(--surface-panel)] border border-[var(--border-strong)] font-mono text-[0.75rem] focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <div className="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setEditingSnippet(null)}
                    className="h-6 px-2.5 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={
                      savingSnippet ||
                      !editingSnippet.name.trim() ||
                      !editingSnippet.body.trim()
                    }
                    className="h-6 px-2.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50 cursor-pointer"
                  >
                    {savingSnippet ? "Saving..." : "Save"}
                  </button>
                </div>
              </form>
            )}

            {filteredSnippets.length === 0 ? (
              <div className="py-6 text-center text-zinc-500 italic">
                No matching snippets
              </div>
            ) : (
              filteredSnippets.map((sn) => (
                <div
                  key={sn.id}
                  className="p-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-canvas)] space-y-1.5"
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <div className="min-w-0">
                      <div className="font-semibold text-zinc-800 dark:text-zinc-200 truncate">
                        {sn.name}
                      </div>
                      {sn.engine && (
                        <span className="inline-block mt-0.5 text-[0.65rem] uppercase px-1 rounded bg-[var(--surface-elevated)] text-zinc-500">
                          {sn.engine}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleInsertSnippetAtCursor(sn)}
                        title="Insert at cursor in active Query Editor (or open new tab)"
                        className="h-6 px-2 rounded bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 flex items-center gap-1 text-[0.72rem] font-medium cursor-pointer"
                      >
                        <CornerDownLeft className="w-3 h-3" /> Insert
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          openTab({
                            kind: "query",
                            title: sn.name,
                            connectionId: activeConnectionId ?? undefined,
                            sql: sn.body,
                          })
                        }
                        title="Open in New Query Tab"
                        className="h-6 w-6 rounded hover:bg-[var(--surface-hover)] text-zinc-500 hover:text-sky-400 flex items-center justify-center cursor-pointer"
                      >
                        <FileCode2 className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setEditingSnippet({
                            id: sn.id,
                            name: sn.name,
                            description: sn.description,
                            engine: sn.engine ?? "",
                            body: sn.body,
                          })
                        }
                        title="Edit Snippet"
                        className="h-6 w-6 rounded hover:bg-[var(--surface-hover)] text-zinc-500 hover:text-zinc-200 flex items-center justify-center cursor-pointer"
                      >
                        <Edit3 className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSnippet(sn)}
                        title="Delete Snippet"
                        className="h-6 w-6 rounded hover:bg-red-500/15 text-zinc-500 hover:text-red-400 flex items-center justify-center cursor-pointer"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  {sn.description && (
                    <div className="text-[0.74rem] text-zinc-500">{sn.description}</div>
                  )}
                  <pre className="p-1.5 rounded bg-[var(--surface-panel)] border border-[var(--border-subtle)] font-mono text-[0.68rem] text-zinc-500 max-h-20 overflow-hidden whitespace-pre-wrap">
                    {sn.body}
                  </pre>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
