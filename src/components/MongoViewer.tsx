import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Braces,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Edit3,
  Layers,
  ListTree,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Table2,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type { MongoDocChange } from "../types/dba";

const JsonTreeNode: React.FC<{
  label: string;
  value: unknown;
  depth?: number;
}> = ({ label, value, depth = 0 }) => {
  const [open, setOpen] = useState(depth < 2);
  const isObject = value !== null && typeof value === "object";
  const isArray = Array.isArray(value);

  if (!isObject) {
    let colorClass = "text-zinc-200";
    if (value === null || value === undefined) colorClass = "text-zinc-500 italic";
    else if (typeof value === "string") colorClass = "text-emerald-400";
    else if (typeof value === "number") colorClass = "text-sky-400";
    else if (typeof value === "boolean") colorClass = "text-amber-400";

    return (
      <div
        style={{ paddingLeft: depth * 14 }}
        className="py-0.5 font-mono text-xs flex items-baseline gap-1.5"
      >
        <span className="text-indigo-400 shrink-0">{label}:</span>
        <span className={`${colorClass} break-all`}>
          {typeof value === "string" ? `"${value}"` : String(value)}
        </span>
      </div>
    );
  }

  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  // Compact display for MongoDB Extended JSON ($oid, $date)
  if (!isArray && entries.length === 1 && (entries[0][0] === "$oid" || entries[0][0] === "$date")) {
    const tag = entries[0][0] === "$oid" ? "ObjectId" : "ISODate";
    return (
      <div
        style={{ paddingLeft: depth * 14 }}
        className="py-0.5 font-mono text-xs flex items-baseline gap-1.5"
      >
        <span className="text-indigo-400 shrink-0">{label}:</span>
        <span className="text-purple-400">
          {tag}("{String(entries[0][1])}")
        </span>
      </div>
    );
  }

  return (
    <div style={{ paddingLeft: depth * 14 }} className="font-mono text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="py-0.5 flex items-center gap-1 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/70 rounded px-1 -ml-1"
      >
        {open ? (
          <ChevronDown className="w-3 h-3 text-zinc-500" />
        ) : (
          <ChevronRight className="w-3 h-3 text-zinc-500" />
        )}
        <span className="text-indigo-400">{label}</span>
        <span className="text-zinc-500">
          {isArray ? `[${entries.length}]` : `{${entries.length} fields}`}
        </span>
      </button>
      {open && (
        <div className="border-l border-[var(--border-subtle)] ml-1.5">
          {entries.map(([k, v]) => (
            <JsonTreeNode key={k} label={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
};

function formatFlatCell(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if ("$oid" in obj) return `ObjectId(${obj.$oid})`;
    if ("$date" in obj) return String(obj.$date);
    return JSON.stringify(val);
  }
  return String(val);
}

export const MongoViewer: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
  const {
    connections,
    connectedIds,
    databasesByConn,
    objectsByKey,
    connectTo,
    loadDatabases,
    loadObjects,
    updateTab,
    openTab,
    openSafetyModal,
    setInspectedCell,
    addLog,
  } = useWorkbenchStore();

  const mongoConnections = useMemo(
    () => connections.filter((c) => c.engine === "mongodb"),
    [connections]
  );
  const conn = connections.find((c) => c.id === tab.connectionId);
  const isProd = conn?.environment === "production";
  const isReadOnly = conn?.readOnly ?? false;
  const database = tab.database ?? conn?.database ?? "admin";
  const collection = tab.collection ?? tab.table ?? "";
  const dbs = tab.connectionId ? databasesByConn[tab.connectionId] ?? [] : [];
  const availableCollections = useMemo(() => {
    if (!tab.connectionId || !database) return [];
    const objs = objectsByKey[`${tab.connectionId}::${database}::`] ?? [];
    return objs.filter((o) => o.kind === "collection");
  }, [objectsByKey, tab.connectionId, database]);
  const [switchingDb, setSwitchingDb] = useState(false);

  const [docs, setDocs] = useState<Record<string, unknown>[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [executionMs, setExecutionMs] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<"tree" | "json" | "table">("tree");
  const [filterJson, setFilterJson] = useState("{}");
  const [sortJson, setSortJson] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Staged Document Edits
  const [instantCommit, setInstantCommit] = useState(false);
  const [stagedInserts, setStagedInserts] = useState<Record<string, unknown>[]>([]);
  const [stagedUpdates, setStagedUpdates] = useState<Record<number, Record<string, unknown>>>({});
  const [stagedDeletes, setStagedDeletes] = useState<Set<number>>(new Set());

  // Document Editor Modal (for editing or adding a document)
  const [editorModal, setEditorModal] = useState<{
    mode: "insert" | "edit";
    rowIdx?: number;
    rawJson: string;
  } | null>(null);
  const [previewOpsModal, setPreviewOpsModal] = useState<string | null>(null);

  const fetchDocs = useCallback(async () => {
    if (!tab.connectionId || !collection) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.mongoFetchDocuments({
        connectionId: tab.connectionId,
        database,
        collection,
        filterJson: filterJson.trim() || "{}",
        sortJson: sortJson.trim() || null,
        projectionJson: null,
        page,
        pageSize,
      });
      setDocs(res.documents);
      setTotalCount(res.totalCount);
      setExecutionMs(res.executionMs);
      setStagedInserts([]);
      setStagedUpdates({});
      setStagedDeletes(new Set());
    } catch (err) {
      const msg = formatApiError(err);
      setError(msg);
      addLog("error", `Fetch ${collection} failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId, database, collection, filterJson, sortJson, page, pageSize, addLog]);

  useEffect(() => {
    fetchDocs();
  }, [fetchDocs]);

  // Ensure database list is loaded for the active connection
  useEffect(() => {
    if (!tab.connectionId) return;
    if (connectedIds.has(tab.connectionId) && !databasesByConn[tab.connectionId]) {
      loadDatabases(tab.connectionId);
    }
  }, [tab.connectionId, connectedIds, databasesByConn, loadDatabases]);

  // Load collections list when there is an error or empty result after switching DB
  useEffect(() => {
    if (!tab.connectionId || !database || !connectedIds.has(tab.connectionId)) return;
    if (error && availableCollections.length === 0) {
      loadObjects(tab.connectionId, database);
    }
  }, [error, tab.connectionId, database, connectedIds, availableCollections.length, loadObjects]);

  const handleSwitchConnection = async (newConnId: string) => {
    if (!newConnId || newConnId === tab.connectionId) return;
    if (
      totalStaged > 0 &&
      !window.confirm("Discard unsaved changes and switch connection?")
    ) {
      return;
    }
    setSwitchingDb(true);
    try {
      if (!connectedIds.has(newConnId)) {
        const ok = await connectTo(newConnId);
        if (!ok) return;
      }
      const targetConn = connections.find((c) => c.id === newConnId);
      const dbList =
        databasesByConn[newConnId] && databasesByConn[newConnId].length > 0
          ? databasesByConn[newConnId]
          : await loadDatabases(newConnId);
      const nextDb =
        (tab.database && dbList.some((d) => d.name === tab.database)
          ? tab.database
          : targetConn?.database) ??
        dbList[0]?.name ??
        "admin";
      setStagedInserts([]);
      setStagedUpdates({});
      setStagedDeletes(new Set());
      setPage(1);
      updateTab(tab.id, { connectionId: newConnId, database: nextDb });
    } finally {
      setSwitchingDb(false);
    }
  };

  const handleSwitchDatabase = async (newDb: string) => {
    if (!newDb || newDb === database || !tab.connectionId) return;
    if (
      totalStaged > 0 &&
      !window.confirm("Discard unsaved changes and switch database?")
    ) {
      return;
    }
    setSwitchingDb(true);
    try {
      if (!connectedIds.has(tab.connectionId)) {
        const ok = await connectTo(tab.connectionId);
        if (!ok) return;
      }
      setStagedInserts([]);
      setStagedUpdates({});
      setStagedDeletes(new Set());
      setPage(1);
      updateTab(tab.id, { database: newDb });
      loadObjects(tab.connectionId, newDb);
    } finally {
      setSwitchingDb(false);
    }
  };

  const envDotClass =
    conn?.environment === "production"
      ? "bg-red-500"
      : conn?.environment === "staging"
      ? "bg-amber-400"
      : "bg-emerald-500";

  const flatColumns = useMemo(() => {
    const keys = new Set<string>();
    docs.forEach((d) => Object.keys(d).forEach((k) => keys.add(k)));
    const arr = Array.from(keys).sort();
    const idIdx = arr.indexOf("_id");
    if (idIdx > 0) {
      arr.splice(idIdx, 1);
      arr.unshift("_id");
    }
    return arr;
  }, [docs]);

  const buildChanges = useCallback((): MongoDocChange[] => {
    const changes: MongoDocChange[] = [];
    for (const ins of stagedInserts) {
      changes.push({ kind: "insert", document: ins });
    }
    for (const [idxStr, doc] of Object.entries(stagedUpdates)) {
      const idx = Number(idxStr);
      if (stagedDeletes.has(idx)) continue;
      const orig = docs[idx];
      if (!orig || !("_id" in orig)) continue;
      changes.push({ kind: "update", id: orig._id, document: doc });
    }
    for (const idx of stagedDeletes) {
      const orig = docs[idx];
      if (!orig || !("_id" in orig)) continue;
      changes.push({ kind: "delete", id: orig._id });
    }
    return changes;
  }, [stagedInserts, stagedUpdates, stagedDeletes, docs]);

  const totalStaged =
    stagedInserts.length + Object.keys(stagedUpdates).length + stagedDeletes.size;

  const executeApply = useCallback(
    async (changes: MongoDocChange[], confirmedProduction = false) => {
      if (!tab.connectionId || !collection || changes.length === 0) return;
      try {
        const affected = await api.mongoApplyDocumentChanges({
          connectionId: tab.connectionId,
          database,
          collection,
          changes,
          confirmedProduction,
        });
        addLog("success", `Applied ${changes.length} operation(s) to ${collection} (${affected} affected)`);
        await fetchDocs();
      } catch (err) {
        const msg = formatApiError(err);
        setError(msg);
        addLog("error", `Apply MongoDB changes failed: ${msg}`);
      }
    },
    [tab.connectionId, database, collection, addLog, fetchDocs]
  );

  const handleApply = useCallback(() => {
    const changes = buildChanges();
    if (changes.length === 0) return;
    if (isProd) {
      openSafetyModal({
        title: `Apply ${changes.length} Operation(s) to ${collection}`,
        warnings: [`Target MongoDB connection "${conn?.name}" is PRODUCTION!`],
        sqlPreview: JSON.stringify(changes, null, 2),
        onConfirm: () => executeApply(changes, true),
      });
    } else {
      executeApply(changes, false);
    }
  }, [buildChanges, isProd, collection, conn?.name, openSafetyModal, executeApply]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && totalStaged > 0) {
        e.preventDefault();
        handleApply();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [totalStaged, handleApply]);

  const handleSaveEditorModal = async () => {
    if (!editorModal) return;
    try {
      const parsed = JSON.parse(editorModal.rawJson);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError("Document must be a valid JSON object");
        return;
      }
      setError(null);
      if (editorModal.mode === "insert") {
        if (instantCommit && !isProd && !isReadOnly) {
          await executeApply([{ kind: "insert", document: parsed }], false);
        } else {
          setStagedInserts((prev) => [...prev, parsed]);
        }
      } else if (editorModal.rowIdx !== undefined) {
        const idx = editorModal.rowIdx;
        if (instantCommit && !isProd && !isReadOnly && "_id" in docs[idx]) {
          await executeApply([{ kind: "update", id: docs[idx]._id, document: parsed }], false);
        } else {
          setStagedUpdates((prev) => ({ ...prev, [idx]: parsed }));
        }
      }
      setEditorModal(null);
    } catch (err) {
      setError(`Invalid JSON: ${String(err)}`);
    }
  };

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <div className="h-full flex flex-col bg-[var(--surface-canvas)] text-xs">
      {/* Top Toolbar */}
      <div className="px-2.5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={fetchDocs}
            title="Refresh Collection"
            className="h-7 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>

          {!isReadOnly && (
            <button
              onClick={() =>
                setEditorModal({
                  mode: "insert",
                  rawJson: "{\n  \"name\": \"\"\n}",
                })
              }
              className="h-7 px-2.5 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5 text-emerald-400" />
              Insert Doc
            </button>
          )}

          {/* View Mode Switcher: Tree / Raw JSON / Flattened Grid */}
          <div className="flex rounded border border-[var(--border-strong)] overflow-hidden ml-1">
            <button
              onClick={() => setViewMode("tree")}
              title="Collapsible BSON/JSON Tree View"
              className={`h-7 px-2 flex items-center gap-1 ${
                viewMode === "tree"
                  ? "bg-emerald-600 text-white"
                  : "hover:bg-[var(--surface-hover)]"
              }`}
            >
              <ListTree className="w-3.5 h-3.5" /> Tree
            </button>
            <button
              onClick={() => setViewMode("json")}
              title="Raw JSON View"
              className={`h-7 px-2 flex items-center gap-1 ${
                viewMode === "json"
                  ? "bg-emerald-600 text-white"
                  : "hover:bg-[var(--surface-hover)]"
              }`}
            >
              <Braces className="w-3.5 h-3.5" /> JSON
            </button>
            <button
              onClick={() => setViewMode("table")}
              title="Flattened Table View"
              className={`h-7 px-2 flex items-center gap-1 ${
                viewMode === "table"
                  ? "bg-emerald-600 text-white"
                  : "hover:bg-[var(--surface-hover)]"
              }`}
            >
              <Table2 className="w-3.5 h-3.5" /> Table
            </button>
          </div>

          <button
            onClick={() =>
              openTab({
                kind: "mongo_query",
                title: `Pipeline: ${collection}`,
                connectionId: tab.connectionId,
                database,
                collection,
                mongoMode: "pipeline",
              })
            }
            className="h-7 px-2.5 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1"
          >
            <Layers className="w-3.5 h-3.5 text-emerald-400" />
            Pipeline
          </button>

          <button
            onClick={() =>
              openTab({
                kind: "mongo_designer",
                title: `Design: ${collection}`,
                connectionId: tab.connectionId,
                database,
                collection,
              })
            }
            className="h-7 px-2.5 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1"
          >
            <Wrench className="w-3.5 h-3.5 text-amber-400" />
            Indexes & Validation
          </button>

          {!isReadOnly && !isProd && (
            <button
              onClick={() => setInstantCommit((v) => !v)}
              className={`h-7 px-2 rounded border flex items-center gap-1 ${
                instantCommit
                  ? "border-amber-500 bg-amber-500/15 text-amber-400"
                  : "border-[var(--border-strong)] text-zinc-500"
              }`}
            >
              <Zap className="w-3 h-3" />
              {instantCommit ? "Instant Commit" : "Staged"}
            </button>
          )}
        </div>

        {/* Staged Operations Controls & Connection/Database Switcher */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {totalStaged > 0 && (
            <>
              <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium">
                {totalStaged} staged
              </span>
              <button
                onClick={() => setPreviewOpsModal(JSON.stringify(buildChanges(), null, 2))}
                className="h-7 px-2.5 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1"
              >
                <Code2 className="w-3.5 h-3.5" /> Preview
              </button>
              <button
                onClick={() => {
                  setStagedInserts([]);
                  setStagedUpdates({});
                  setStagedDeletes(new Set());
                }}
                className="h-7 px-2 rounded border border-[var(--border-strong)] text-zinc-400 flex items-center gap-1"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Discard
              </button>
              <button
                onClick={handleApply}
                className="h-7 px-3 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1"
              >
                <Save className="w-3.5 h-3.5" /> Apply (Ctrl+S)
              </button>
            </>
          )}

          {/* Navicat-Style Connection & Database Switcher */}
          <div className="flex items-center gap-1 pl-1.5 border-l border-[var(--border-strong)]">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${envDotClass}`}
              title={`Environment: ${conn?.environment ?? "local"}`}
            />
            <select
              value={tab.connectionId ?? ""}
              disabled={switchingDb}
              onChange={(e) => handleSwitchConnection(e.target.value)}
              title="Switch MongoDB Connection"
              className="h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] max-w-[150px] truncate"
            >
              {mongoConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              value={database}
              disabled={switchingDb || !tab.connectionId}
              onChange={(e) => handleSwitchDatabase(e.target.value)}
              title="Switch MongoDB Database"
              className="h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] max-w-[140px] truncate font-mono"
            >
              {!dbs.some((d) => d.name === database) && database && (
                <option value={database}>{database}</option>
              )}
              {dbs.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* MongoDB Filter & Sort Bar */}
      <div className="px-2.5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--surface-elevated)] flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 flex-1 min-w-[220px]">
          <span className="text-zinc-500 font-mono">Filter:</span>
          <input
            value={filterJson}
            onChange={(e) => setFilterJson(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setPage(1);
                fetchDocs();
              }
            }}
            placeholder='{ "status": "active" }'
            className="flex-1 h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
          />
        </div>
        <div className="flex items-center gap-1.5 w-60">
          <span className="text-zinc-500 font-mono">Sort:</span>
          <input
            value={sortJson}
            onChange={(e) => setSortJson(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setPage(1);
                fetchDocs();
              }
            }}
            placeholder='{ "_id": -1 }'
            className="flex-1 h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
          />
        </div>
        <button
          onClick={() => {
            setPage(1);
            fetchDocs();
          }}
          className="h-7 px-3 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-1"
        >
          <Search className="w-3 h-3" /> Find
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 font-mono flex flex-wrap items-center justify-between gap-2">
          <span>{error}</span>
          {availableCollections.length > 0 && (
            <div className="flex items-center gap-1.5 text-zinc-200 font-sans">
              <span className="text-[0.75rem] text-zinc-400">Open another collection in {database}:</span>
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  setPage(1);
                  updateTab(tab.id, {
                    collection: e.target.value,
                    table: e.target.value,
                    title: e.target.value,
                  });
                }}
                className="h-6 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] text-xs font-mono"
              >
                <option value="">Select collection...</option>
                {availableCollections.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-2.5 space-y-2">
        {/* Staged Inserts */}
        {stagedInserts.map((ins, i) => (
          <div
            key={`ins-${i}`}
            className="p-2.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-[0.72rem] font-mono font-semibold text-emerald-400">
                + NEW DOCUMENT (STAGED)
              </span>
              <button
                onClick={() => setStagedInserts((prev) => prev.filter((_, idx) => idx !== i))}
                className="text-zinc-400 hover:text-red-400"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <pre className="font-mono text-xs text-emerald-200 whitespace-pre-wrap">
              {JSON.stringify(ins, null, 2)}
            </pre>
          </div>
        ))}

        {viewMode === "table" ? (
          <table className="w-max min-w-full border-collapse text-left">
            <thead className="sticky top-0 bg-[var(--surface-panel)] border-b border-[var(--border-subtle)]">
              <tr>
                <th className="px-2 py-1.5 text-zinc-500 border-r border-[var(--border-subtle)] w-16">
                  #
                </th>
                {flatColumns.map((col) => (
                  <th
                    key={col}
                    className="px-2.5 py-1.5 font-semibold border-r border-[var(--border-subtle)] whitespace-nowrap font-mono"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {docs.map((origDoc, idx) => {
                const isDeleted = stagedDeletes.has(idx);
                const patched = stagedUpdates[idx];
                const doc = patched ?? origDoc;
                return (
                  <tr
                    key={idx}
                    className={`border-b border-[var(--border-subtle)] ${
                      isDeleted
                        ? "bg-red-500/15 line-through text-red-400"
                        : patched
                        ? "bg-amber-500/15"
                        : "hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <td className="px-2 py-1 border-r border-[var(--border-subtle)] font-mono text-zinc-500">
                      <div className="flex items-center gap-1">
                        <span>{(page - 1) * pageSize + idx + 1}</span>
                        {!isReadOnly && (
                          <>
                            <button
                              onClick={() =>
                                setEditorModal({
                                  mode: "edit",
                                  rowIdx: idx,
                                  rawJson: JSON.stringify(doc, null, 2),
                                })
                              }
                              className="text-zinc-500 hover:text-indigo-400"
                              title="Edit Document JSON"
                            >
                              <Edit3 className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() =>
                                setStagedDeletes((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(idx)) next.delete(idx);
                                  else next.add(idx);
                                  return next;
                                })
                              }
                              className="text-zinc-500 hover:text-red-400"
                              title="Delete Document"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                    {flatColumns.map((col) => (
                      <td
                        key={col}
                        onClick={() =>
                          setInspectedCell({
                            column: col,
                            dataType: "bson",
                            value: doc[col],
                          })
                        }
                        className="px-2.5 py-1 border-r border-[var(--border-subtle)] font-mono max-w-[280px] truncate cursor-pointer"
                      >
                        {formatFlatCell(doc[col])}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          docs.map((origDoc, idx) => {
            const isDeleted = stagedDeletes.has(idx);
            const patched = stagedUpdates[idx];
            const doc = patched ?? origDoc;
            return (
              <div
                key={idx}
                className={`rounded-lg border p-2.5 ${
                  isDeleted
                    ? "border-red-500/40 bg-red-500/10 opacity-75"
                    : patched
                    ? "border-amber-500/40 bg-amber-500/10"
                    : "border-[var(--border-subtle)] bg-[var(--surface-panel)]"
                }`}
              >
                <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-[var(--border-subtle)]">
                  <span className="font-mono text-[0.72rem] text-zinc-500">
                    #{(page - 1) * pageSize + idx + 1} • _id: {formatFlatCell(doc._id)}
                    {patched && <span className="ml-2 text-amber-400">(modified)</span>}
                    {isDeleted && <span className="ml-2 text-red-400">(staged delete)</span>}
                  </span>
                  {!isReadOnly && (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() =>
                          setEditorModal({
                            mode: "edit",
                            rowIdx: idx,
                            rawJson: JSON.stringify(doc, null, 2),
                          })
                        }
                        className="h-6 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1"
                      >
                        <Edit3 className="w-3 h-3" /> Edit
                      </button>
                      <button
                        onClick={() =>
                          setStagedDeletes((prev) => {
                            const next = new Set(prev);
                            if (next.has(idx)) next.delete(idx);
                            else next.add(idx);
                            return next;
                          })
                        }
                        className="h-6 px-2 rounded border border-[var(--border-strong)] hover:bg-red-500/15 text-red-400 flex items-center gap-1"
                      >
                        <Trash2 className="w-3 h-3" /> {isDeleted ? "Undo" : "Delete"}
                      </button>
                    </div>
                  )}
                </div>
                {viewMode === "tree" ? (
                  <JsonTreeNode label="Document" value={doc} depth={0} />
                ) : (
                  <pre className="font-mono text-xs overflow-auto whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">
                    {JSON.stringify(doc, null, 2)}
                  </pre>
                )}
              </div>
            );
          })
        )}

        {!loading && docs.length === 0 && (
          <div className="py-12 text-center text-zinc-500">
            No documents matched filter in <span className="font-mono">{database}.{collection}</span>
          </div>
        )}
      </div>

      {/* Pagination Footer */}
      <div className="px-3 py-1.5 border-t border-[var(--border-subtle)] bg-[var(--surface-panel)] flex items-center justify-between text-zinc-500">
        <span>
          {docs.length} / {totalCount.toLocaleString()} documents • {executionMs}ms
        </span>
        <div className="flex items-center gap-2">
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            className="h-6 px-1.5 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)]"
          >
            <option value={25}>25 / page</option>
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
          </select>
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="p-1 rounded hover:bg-[var(--surface-hover)] disabled:opacity-40"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="font-mono">
            Page {page} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="p-1 rounded hover:bg-[var(--surface-hover)] disabled:opacity-40"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Document JSON Editor Modal */}
      {editorModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setEditorModal(null)}
        >
          <div
            className="w-full max-w-2xl rounded-md border border-[var(--border-strong)] bg-[var(--surface-panel)] shadow-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
              <span className="font-semibold text-zinc-100">
                {editorModal.mode === "insert" ? "Insert New Document" : "Edit Document JSON"}
              </span>
              <button onClick={() => setEditorModal(null)}>
                <X className="w-4 h-4 text-zinc-400" />
              </button>
            </div>
            <textarea
              value={editorModal.rawJson}
              onChange={(e) => setEditorModal({ ...editorModal, rawJson: e.target.value })}
              rows={16}
              className="w-full p-3 bg-[#1e1f22] text-emerald-300 font-mono text-xs focus:outline-none"
            />
            <div className="px-4 py-2.5 border-t border-zinc-800 flex justify-end gap-2">
              <button
                onClick={() => setEditorModal(null)}
                className="h-7 px-3 rounded bg-zinc-800 text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEditorModal}
                className="h-7 px-3 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
              >
                {instantCommit && !isProd ? "Commit Now" : "Stage Document"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview Operations Modal */}
      {previewOpsModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setPreviewOpsModal(null)}
        >
          <div
            className="w-full max-w-xl rounded-md border border-[var(--border-strong)] bg-[var(--surface-panel)] shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
              <span className="font-semibold text-zinc-100">Staged MongoDB Operations</span>
              <button onClick={() => setPreviewOpsModal(null)}>
                <X className="w-4 h-4 text-zinc-400" />
              </button>
            </div>
            <pre className="p-4 text-xs font-mono text-emerald-300 bg-[#1e1f22] max-h-80 overflow-auto">
              {previewOpsModal}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
