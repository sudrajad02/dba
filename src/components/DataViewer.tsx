import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  ExternalLink,
  Filter,
  LayoutGrid,
  List,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  FilterCondition,
  QueryResultSet,
  SortSpec,
  StagedChange,
} from "../types/datavault";

const FILTER_OPS = [
  "=",
  "!=",
  ">",
  "<",
  ">=",
  "<=",
  "LIKE",
  "ILIKE",
  "IN",
  "BETWEEN",
  "IS NULL",
  "IS NOT NULL",
];

function formatDataType(raw: string): string {
  const s = raw.replace(/^MYSQL_TYPE_/i, "").toLowerCase();
  const map: Record<string, string> = {
    var_string: "varchar",
    string: "char",
    long: "int",
    longlong: "bigint",
    short: "smallint",
    tiny: "tinyint",
    int24: "mediumint",
    newdecimal: "decimal",
    datetime2: "datetime",
    timestamp2: "timestamp",
    time2: "time",
    tiny_blob: "tinyblob",
    medium_blob: "mediumblob",
    long_blob: "longblob",
  };
  return map[s] ?? s;
}

function formatCellValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function parseInputValue(raw: string, original: unknown): unknown {
  if (raw === "" && original === null) return null;
  if (raw.toUpperCase() === "NULL") return null;
  if (typeof original === "boolean") {
    if (raw.toLowerCase() === "true") return true;
    if (raw.toLowerCase() === "false") return false;
  }
  if (typeof original === "number" && raw.trim() !== "" && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }
  return raw;
}

export const DataViewer: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
  const {
    connections,
    setInspectedCell,
    setInspectedTableMeta,
    openTab,
    openSafetyModal,
    addLog,
  } = useWorkbenchStore();

  const conn = connections.find((c) => c.id === tab.connectionId);
  const isProd = conn?.environment === "production";
  const isReadOnly = conn?.readOnly ?? false;

  const [data, setData] = useState<QueryResultSet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  const [draftFilters, setDraftFilters] = useState<FilterCondition[]>(tab.initialFilters ?? []);
  const [appliedFilters, setAppliedFilters] = useState<FilterCondition[]>(tab.initialFilters ?? []);
  const [showFilters, setShowFilters] = useState((tab.initialFilters?.length ?? 0) > 0);
  const [sorts, setSorts] = useState<SortSpec[]>([]);
  const [viewMode, setViewMode] = useState<"grid" | "form">("grid");
  const [selectedRowIdx, setSelectedRowIdx] = useState(0);

  // Hybrid Edit Mode: default Staged Changes, optional Instant Row-Commit (non-Prod)
  const [instantCommit, setInstantCommit] = useState(false);
  const [stagedUpdates, setStagedUpdates] = useState<Record<number, Record<string, unknown>>>({});
  const [stagedDeletes, setStagedDeletes] = useState<Set<number>>(new Set());
  const [stagedInserts, setStagedInserts] = useState<Record<string, unknown>[]>([]);
  const [editingCell, setEditingCell] = useState<{ row: number; col: string; isInsert?: boolean } | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [previewSqlModal, setPreviewSqlModal] = useState<string[] | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    if (!tab.connectionId || !tab.table) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.fetchTableData({
        connectionId: tab.connectionId,
        database: tab.database ?? null,
        schema: tab.schema ?? null,
        table: tab.table,
        page,
        pageSize,
        filters: appliedFilters,
        sorts,
      });
      setData(res);
      setStagedUpdates({});
      setStagedDeletes(new Set());
      setStagedInserts([]);
      setSelectedRowIdx(0);
    } catch (err) {
      const msg = formatApiError(err);
      setError(msg);
      addLog("error", `Fetch ${tab.table} failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId, tab.database, tab.schema, tab.table, page, pageSize, appliedFilters, sorts, addLog]);

  const applyDraftFilters = useCallback(() => {
    setPage(1);
    setAppliedFilters(draftFilters.map((f) => ({ ...f })));
  }, [draftFilters]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!tab.connectionId || !tab.table) return;
    api
      .getTableMetadata(tab.connectionId, tab.table, tab.database, tab.schema)
      .then((m) => setInspectedTableMeta(m))
      .catch(() => {});
  }, [tab.connectionId, tab.database, tab.schema, tab.table, setInspectedTableMeta]);

  const rows = data?.rows ?? [];
  const columns = data?.columns ?? [];
  const pkCols = useMemo(() => columns.filter((c) => c.isPrimaryKey), [columns]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 36,
    overscan: 15,
  });

  const buildStagedPayload = useCallback((): StagedChange[] => {
    const changes: StagedChange[] = [];
    for (const ins of stagedInserts) {
      if (Object.keys(ins).length > 0) {
        changes.push({ kind: "insert", values: ins });
      }
    }
    for (const [rowIdxStr, patch] of Object.entries(stagedUpdates)) {
      const rowIdx = Number(rowIdxStr);
      if (stagedDeletes.has(rowIdx)) continue;
      const row = rows[rowIdx];
      if (!row) continue;
      const primary_keys: Record<string, unknown> = {};
      const keyCols = pkCols.length > 0 ? pkCols : columns;
      keyCols.forEach((c) => {
        const ci = columns.findIndex((x) => x.name === c.name);
        if (ci >= 0) primary_keys[c.name] = row[ci];
      });
      changes.push({ kind: "update", primary_keys, changes: patch });
    }
    for (const rowIdx of stagedDeletes) {
      const row = rows[rowIdx];
      if (!row) continue;
      const primary_keys: Record<string, unknown> = {};
      const keyCols = pkCols.length > 0 ? pkCols : columns;
      keyCols.forEach((c) => {
        const ci = columns.findIndex((x) => x.name === c.name);
        if (ci >= 0) primary_keys[c.name] = row[ci];
      });
      changes.push({ kind: "delete", primary_keys });
    }
    return changes;
  }, [stagedInserts, stagedUpdates, stagedDeletes, rows, pkCols, columns]);

  const totalStagedCount =
    stagedInserts.length + Object.keys(stagedUpdates).length + stagedDeletes.size;

  const executeApply = useCallback(
    async (changes: StagedChange[], confirmedProduction = false) => {
      if (!tab.connectionId || !tab.table || changes.length === 0) return;
      try {
        const affected = await api.applyStagedChanges({
          connectionId: tab.connectionId,
          database: tab.database ?? null,
          schema: tab.schema ?? null,
          table: tab.table,
          changes,
          confirmedProduction,
        });
        addLog("success", `Applied ${changes.length} change(s) to ${tab.table} (${affected} rows affected)`);
        await fetchData();
      } catch (err) {
        addLog("error", `Apply changes failed: ${formatApiError(err)}`);
        setError(formatApiError(err));
      }
    },
    [tab.connectionId, tab.database, tab.schema, tab.table, addLog, fetchData]
  );

  const handleApplyChanges = useCallback(async () => {
    if (!tab.connectionId || !tab.table) return;
    const changes = buildStagedPayload();
    if (changes.length === 0) return;

    try {
      const preview = await api.previewStagedChanges({
        connectionId: tab.connectionId,
        database: tab.database ?? null,
        schema: tab.schema ?? null,
        table: tab.table,
        changes,
        confirmedProduction: false,
      });
      if (preview.requiresConfirmation) {
        openSafetyModal({
          title: `Apply ${changes.length} Change(s) to ${tab.table}`,
          warnings: preview.safetyWarnings,
          sqlPreview: preview.statements.join("\n"),
          onConfirm: () => executeApply(changes, true),
        });
      } else {
        await executeApply(changes, false);
      }
    } catch (err) {
      setError(formatApiError(err));
    }
  }, [tab, buildStagedPayload, openSafetyModal, executeApply]);

  const handlePreviewSql = async () => {
    if (!tab.connectionId || !tab.table) return;
    const changes = buildStagedPayload();
    if (changes.length === 0) return;
    try {
      const preview = await api.previewStagedChanges({
        connectionId: tab.connectionId,
        database: tab.database ?? null,
        schema: tab.schema ?? null,
        table: tab.table,
        changes,
        confirmedProduction: false,
      });
      setPreviewSqlModal(preview.statements);
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  // Ctrl+S to apply staged changes
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && totalStagedCount > 0) {
        e.preventDefault();
        handleApplyChanges();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [totalStagedCount, handleApplyChanges]);

  const commitCellEdit = async (rowIdx: number, colName: string, isInsert?: boolean) => {
    setEditingCell(null);
    if (isInsert) {
      setStagedInserts((prev) =>
        prev.map((r, i) => (i === rowIdx ? { ...r, [colName]: editDraft } : r))
      );
      return;
    }

    const colIdx = columns.findIndex((c) => c.name === colName);
    const original = rows[rowIdx]?.[colIdx];
    const parsed = parseInputValue(editDraft, original);
    if (parsed === original) return;

    if (instantCommit && !isProd && !isReadOnly) {
      const row = rows[rowIdx];
      const primary_keys: Record<string, unknown> = {};
      const keyCols = pkCols.length > 0 ? pkCols : columns;
      keyCols.forEach((c) => {
        const ci = columns.findIndex((x) => x.name === c.name);
        if (ci >= 0) primary_keys[c.name] = row[ci];
      });
      await executeApply([{ kind: "update", primary_keys, changes: { [colName]: parsed } }], false);
    } else {
      setStagedUpdates((prev) => ({
        ...prev,
        [rowIdx]: { ...(prev[rowIdx] ?? {}), [colName]: parsed },
      }));
    }
  };

  const toggleSort = (colName: string) => {
    setSorts((prev) => {
      const existing = prev.find((s) => s.column === colName);
      if (!existing) return [{ column: colName, direction: "ASC" }];
      if (existing.direction === "ASC") return [{ column: colName, direction: "DESC" }];
      return [];
    });
  };

  const totalPages = data?.totalCount ? Math.max(1, Math.ceil(data.totalCount / pageSize)) : 1;

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-950 text-xs">
      {/* Toolbar */}
      <div className="px-2.5 py-1.5 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/70 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={fetchData}
            title="Refresh Data"
            className="h-7 px-2 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-1"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>

          <button
            onClick={() => {
              setShowFilters((prev) => {
                const next = !prev;
                if (next && draftFilters.length === 0 && columns.length > 0) {
                  setDraftFilters([{ column: columns[0].name, operator: "=", value: "" }]);
                }
                return next;
              });
            }}
            className={`h-7 px-2.5 rounded border flex items-center gap-1.5 ${
              showFilters || appliedFilters.length > 0
                ? "border-indigo-500 bg-indigo-500/15 text-indigo-500 dark:text-indigo-400"
                : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800"
            }`}
          >
            <Filter className="w-3.5 h-3.5" />
            Filter {appliedFilters.length > 0 ? `(${appliedFilters.length})` : ""}
          </button>

          {!isReadOnly && (
            <button
              onClick={() => {
                const blank: Record<string, unknown> = {};
                columns.forEach((c) => {
                  if (!c.isPrimaryKey) blank[c.name] = null;
                });
                setStagedInserts((prev) => [...prev, blank]);
              }}
              className="h-7 px-2.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
              Add Row
            </button>
          )}

          {/* Grid / Form View Toggle */}
          <div className="flex rounded border border-zinc-300 dark:border-zinc-700 overflow-hidden ml-1">
            <button
              onClick={() => setViewMode("grid")}
              title="Spreadsheet Grid View"
              className={`h-7 px-2 flex items-center ${
                viewMode === "grid"
                  ? "bg-indigo-600 text-white"
                  : "hover:bg-zinc-200 dark:hover:bg-zinc-800"
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode("form")}
              title="Form View (Single Row)"
              className={`h-7 px-2 flex items-center ${
                viewMode === "form"
                  ? "bg-indigo-600 text-white"
                  : "hover:bg-zinc-200 dark:hover:bg-zinc-800"
              }`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Instant Row-Commit Toggle (Non-Prod Only) */}
          {!isReadOnly && !isProd && (
            <button
              onClick={() => setInstantCommit((v) => !v)}
              title="Toggle Navicat Instant Row-Commit Mode"
              className={`h-7 px-2 rounded border flex items-center gap-1 text-[0.8rem] ${
                instantCommit
                  ? "border-amber-500 bg-amber-500/15 text-amber-500 dark:text-amber-400"
                  : "border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
              }`}
            >
              <Zap className="w-3 h-3" />
              {instantCommit ? "Instant Commit" : "Staged Mode"}
            </button>
          )}
        </div>

        {/* Staged Changes Actions */}
        <div className="flex items-center gap-1.5">
          {totalStagedCount > 0 && (
            <>
              <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium">
                {totalStagedCount} staged
              </span>
              <button
                onClick={handlePreviewSql}
                className="h-7 px-2.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-1"
              >
                <Code2 className="w-3.5 h-3.5" />
                Preview SQL
              </button>
              <button
                onClick={() => {
                  setStagedUpdates({});
                  setStagedDeletes(new Set());
                  setStagedInserts([]);
                }}
                className="h-7 px-2 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-400 flex items-center gap-1"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Discard
              </button>
              <button
                onClick={handleApplyChanges}
                className="h-7 px-3 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1"
              >
                <Save className="w-3.5 h-3.5" />
                Apply (Ctrl+S)
              </button>
            </>
          )}
        </div>
      </div>

      {/* Visual Filter Builder (Manual Apply via Enter or Apply Button) */}
      {showFilters && (
        <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 space-y-1.5">
          {draftFilters.map((f, idx) => (
            <div key={idx} className="flex items-center gap-1.5">
              <select
                value={f.column}
                onChange={(e) =>
                  setDraftFilters((prev) =>
                    prev.map((x, i) => (i === idx ? { ...x, column: e.target.value } : x))
                  )
                }
                className="h-7 px-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700"
              >
                {columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <select
                value={f.operator}
                onChange={(e) =>
                  setDraftFilters((prev) =>
                    prev.map((x, i) => (i === idx ? { ...x, operator: e.target.value } : x))
                  )
                }
                className="h-7 px-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
              >
                {FILTER_OPS.map((op) => (
                  <option key={op} value={op}>
                    {op}
                  </option>
                ))}
              </select>
              {f.operator !== "IS NULL" && f.operator !== "IS NOT NULL" && (
                <input
                  value={f.value ?? ""}
                  onChange={(e) =>
                    setDraftFilters((prev) =>
                      prev.map((x, i) => (i === idx ? { ...x, value: e.target.value } : x))
                    )
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyDraftFilters();
                    }
                  }}
                  placeholder={f.operator === "IN" ? "1, 2, 3" : "Value... (Enter to apply)"}
                  className="h-7 px-2 w-52 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                />
              )}
              {f.operator === "BETWEEN" && (
                <input
                  value={f.value2 ?? ""}
                  onChange={(e) =>
                    setDraftFilters((prev) =>
                      prev.map((x, i) => (i === idx ? { ...x, value2: e.target.value } : x))
                    )
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyDraftFilters();
                    }
                  }}
                  placeholder="End value..."
                  className="h-7 px-2 w-40 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                />
              )}
              <button
                onClick={() => setDraftFilters((prev) => prev.filter((_, i) => i !== idx))}
                className="p-1 text-zinc-500 hover:text-red-400"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-0.5">
            <button
              onClick={() =>
                setDraftFilters((prev) => [
                  ...prev,
                  { column: columns[0]?.name ?? "", operator: "=", value: "" },
                ])
              }
              className="h-6 px-2 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Add Condition
            </button>
            <button
              onClick={applyDraftFilters}
              className="h-6 px-2.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-1 cursor-pointer"
            >
              <Check className="w-3 h-3" /> Apply Filter
            </button>
            {(draftFilters.length > 0 || appliedFilters.length > 0) && (
              <button
                onClick={() => {
                  setDraftFilters([]);
                  setAppliedFilters([]);
                  setPage(1);
                }}
                className="h-6 px-2 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 font-mono">
          {error}
        </div>
      )}

      {/* Main Content: Grid View or Form View */}
      {viewMode === "grid" ? (
        <div ref={scrollContainerRef} className="flex-1 overflow-auto relative">
          <table className="w-max min-w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-zinc-100 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
              <tr>
                <th className="w-12 px-2 py-1.5 text-[0.72rem] font-semibold text-zinc-500 border-r border-zinc-200 dark:border-zinc-800">
                  #
                </th>
                {columns.map((col) => {
                  const sort = sorts.find((s) => s.column === col.name);
                  return (
                    <th
                      key={col.name}
                      onClick={() => toggleSort(col.name)}
                      className="px-2.5 py-1.5 font-semibold text-zinc-700 dark:text-zinc-200 border-r border-zinc-200 dark:border-zinc-800 cursor-pointer hover:bg-zinc-200/60 dark:hover:bg-zinc-800/80 whitespace-nowrap select-none"
                    >
                      <div className="flex items-center gap-1.5">
                        {col.isPrimaryKey && (
                          <span className="text-[0.68rem] px-1 rounded bg-amber-500/20 text-amber-400">
                            PK
                          </span>
                        )}
                        <span>{col.name}</span>
                        <span className="text-[0.68rem] font-normal text-neutral-400 dark:text-neutral-500">
                          {formatDataType(col.dataType)}
                        </span>
                        {sort &&
                          (sort.direction === "ASC" ? (
                            <ArrowUp className="w-3 h-3 text-indigo-500 dark:text-indigo-400" />
                          ) : (
                            <ArrowDown className="w-3 h-3 text-indigo-500 dark:text-indigo-400" />
                          ))}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {/* Staged Inserts (Green) */}
              {stagedInserts.map((ins, iIdx) => (
                <tr
                  key={`ins-${iIdx}`}
                  className="bg-emerald-500/15 border-b border-emerald-500/30"
                >
                  <td className="px-2 py-1 text-[0.72rem] text-emerald-400 border-r border-zinc-800/40 font-mono">
                    +NEW
                  </td>
                  {columns.map((col) => {
                    const isEditing =
                      editingCell?.isInsert &&
                      editingCell.row === iIdx &&
                      editingCell.col === col.name;
                    const val = ins[col.name];
                    return (
                      <td
                        key={col.name}
                        onDoubleClick={() => {
                          setEditingCell({ row: iIdx, col: col.name, isInsert: true });
                          setEditDraft(val == null ? "" : String(val));
                        }}
                        className="px-2.5 py-1 border-r border-zinc-800/40 font-mono max-w-[260px] truncate"
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            onBlur={() => commitCellEdit(iIdx, col.name, true)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitCellEdit(iIdx, col.name, true);
                              if (e.key === "Escape") setEditingCell(null);
                            }}
                            className="w-full bg-zinc-950 text-white px-1 py-0.5 rounded border border-emerald-500 focus:outline-none"
                          />
                        ) : (
                          <span className={val == null ? "text-zinc-500 italic" : ""}>
                            {formatCellValue(val)}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}

              {/* Virtualized Data Rows */}
              {rowVirtualizer.getVirtualItems().length > 0 && (
                <tr style={{ height: `${rowVirtualizer.getVirtualItems()[0].start}px` }} />
              )}
              {rowVirtualizer.getVirtualItems().map((vRow) => {
                const rowIdx = vRow.index;
                const row = rows[rowIdx];
                const isDeleted = stagedDeletes.has(rowIdx);
                const rowPatch = stagedUpdates[rowIdx];
                return (
                  <tr
                    key={vRow.key}
                    onClick={() => setSelectedRowIdx(rowIdx)}
                    className={`border-b border-zinc-200/70 dark:border-zinc-800/70 ${
                      isDeleted
                        ? "bg-red-500/15 line-through text-red-400"
                        : rowIdx === selectedRowIdx
                        ? "bg-indigo-500/15"
                        : "hover:bg-zinc-100/70 dark:hover:bg-zinc-100 dark:bg-zinc-900"
                    }`}
                  >
                    <td className="px-2 py-1 text-[0.72rem] text-zinc-500 border-r border-zinc-200 dark:border-zinc-800 font-mono flex items-center justify-between gap-1">
                      <span>{(page - 1) * pageSize + rowIdx + 1}</span>
                      {!isReadOnly && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setStagedDeletes((prev) => {
                              const next = new Set(prev);
                              if (next.has(rowIdx)) next.delete(rowIdx);
                              else next.add(rowIdx);
                              return next;
                            });
                          }}
                          title={isDeleted ? "Undo Delete" : "Stage Delete Row"}
                          className="text-zinc-500 hover:text-red-400"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </td>
                    {columns.map((col, colIdx) => {
                      const hasPatch = rowPatch && col.name in rowPatch;
                      const cellVal = hasPatch ? rowPatch[col.name] : row[colIdx];
                      const isEditing =
                        !editingCell?.isInsert &&
                        editingCell?.row === rowIdx &&
                        editingCell?.col === col.name;

                      return (
                        <td
                          key={col.name}
                          onClick={() =>
                            setInspectedCell({
                              column: col.name,
                              dataType: col.dataType,
                              value: cellVal,
                            })
                          }
                          onDoubleClick={() => {
                            if (isReadOnly || isDeleted) return;
                            setEditingCell({ row: rowIdx, col: col.name });
                            setEditDraft(cellVal == null ? "" : formatCellValue(cellVal));
                          }}
                          className={`px-2.5 py-1 border-r border-zinc-200/70 dark:border-zinc-800/70 font-mono max-w-[300px] truncate ${
                            hasPatch ? "bg-amber-500/20 text-amber-300" : ""
                          }`}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              value={editDraft}
                              onChange={(e) => setEditDraft(e.target.value)}
                              onBlur={() => commitCellEdit(rowIdx, col.name)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitCellEdit(rowIdx, col.name);
                                if (e.key === "Escape") setEditingCell(null);
                              }}
                              className="w-full bg-zinc-950 text-white px-1 py-0.5 rounded border border-indigo-500 focus:outline-none"
                            />
                          ) : (
                            <div className="flex items-center justify-between gap-1.5">
                              <span
                                className={
                                  cellVal === null || cellVal === undefined
                                    ? "text-zinc-500 italic"
                                    : "truncate"
                                }
                              >
                                {formatCellValue(cellVal)}
                              </span>
                              {/* Foreign Key Jump */}
                              {col.fkTarget && cellVal != null && (
                                <button
                                  title={`Jump to ${col.fkTarget.table}.${col.fkTarget.column} = ${cellVal}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openTab({
                                      kind: "table",
                                      title: `${col.fkTarget!.table} (${col.fkTarget!.column}=${cellVal})`,
                                      connectionId: tab.connectionId,
                                      database: tab.database,
                                      schema: col.fkTarget!.schema ?? tab.schema,
                                      table: col.fkTarget!.table,
                                      initialFilters: [
                                        {
                                          column: col.fkTarget!.column,
                                          operator: "=",
                                          value: String(cellVal),
                                        },
                                      ],
                                    });
                                  }}
                                  className="shrink-0 text-indigo-500 dark:text-indigo-400 hover:text-indigo-400"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        /* Form View (Single Row Vertical Inspector/Editor) */
        <div className="flex-1 overflow-auto p-4 max-w-2xl">
          {rows[selectedRowIdx] ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between pb-2 border-b border-zinc-200 dark:border-zinc-800">
                <span className="font-semibold">
                  Row {(page - 1) * pageSize + selectedRowIdx + 1} of {rows.length}
                </span>
                <div className="flex gap-1">
                  <button
                    disabled={selectedRowIdx <= 0}
                    onClick={() => setSelectedRowIdx((i) => Math.max(0, i - 1))}
                    className="h-6 px-2 rounded border border-zinc-700 disabled:opacity-40"
                  >
                    Prev Row
                  </button>
                  <button
                    disabled={selectedRowIdx >= rows.length - 1}
                    onClick={() =>
                      setSelectedRowIdx((i) => Math.min(rows.length - 1, i + 1))
                    }
                    className="h-6 px-2 rounded border border-zinc-700 disabled:opacity-40"
                  >
                    Next Row
                  </button>
                </div>
              </div>
              {columns.map((col, idx) => {
                const patched = stagedUpdates[selectedRowIdx]?.[col.name];
                const val = patched !== undefined ? patched : rows[selectedRowIdx][idx];
                return (
                  <div key={col.name} className="grid grid-cols-3 gap-3 items-start">
                    <div className="pt-1.5">
                      <div className="font-medium text-zinc-800 dark:text-zinc-200">
                        {col.name}
                      </div>
                      <div className="text-[0.72rem] text-zinc-500">{col.dataType}</div>
                    </div>
                    <textarea
                      rows={String(val ?? "").length > 60 ? 3 : 1}
                      disabled={isReadOnly}
                      value={val == null ? "" : formatCellValue(val)}
                      placeholder="NULL"
                      onChange={(e) => {
                        const nextVal = parseInputValue(e.target.value, rows[selectedRowIdx][idx]);
                        setStagedUpdates((prev) => ({
                          ...prev,
                          [selectedRowIdx]: {
                            ...(prev[selectedRowIdx] ?? {}),
                            [col.name]: nextVal,
                          },
                        }));
                      }}
                      className="col-span-2 p-1.5 rounded bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 font-mono text-xs"
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-zinc-500">No rows to display</div>
          )}
        </div>
      )}

      {/* Classic Navicat Bottom Record Edit & Pagination Bar */}
      <div className="px-2.5 py-1.5 border-t border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex flex-wrap items-center justify-between gap-2 text-[0.78rem] text-zinc-500">
        {/* Left: Navicat + / - / ✓ / ✕ / ↻ Record Controls */}
        <div className="flex items-center gap-1">
          {!isReadOnly && (
            <>
              <button
                onClick={() => {
                  const blank: Record<string, unknown> = {};
                  columns.forEach((c) => {
                    if (!c.isPrimaryKey) blank[c.name] = null;
                  });
                  setStagedInserts((prev) => [...prev, blank]);
                }}
                title="Add Record (+)"
                className="h-7 w-7 flex items-center justify-center rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#35373d] text-emerald-400"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
              <button
                disabled={rows.length === 0}
                onClick={() => {
                  setStagedDeletes((prev) => {
                    const next = new Set(prev);
                    if (next.has(selectedRowIdx)) next.delete(selectedRowIdx);
                    else next.add(selectedRowIdx);
                    return next;
                  });
                }}
                title="Delete Selected Record (-)"
                className="h-7 w-7 flex items-center justify-center rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-red-500/15 text-red-400 disabled:opacity-35"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button
                disabled={totalStagedCount === 0}
                onClick={handleApplyChanges}
                title="Apply Staged Changes (Ctrl+S)"
                className="h-7 w-7 flex items-center justify-center rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-emerald-500/20 text-emerald-400 disabled:opacity-35"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                disabled={totalStagedCount === 0}
                onClick={() => {
                  setStagedUpdates({});
                  setStagedDeletes(new Set());
                  setStagedInserts([]);
                }}
                title="Discard Changes"
                className="h-7 w-7 flex items-center justify-center rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#35373d] text-zinc-400 disabled:opacity-35"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          <button
            onClick={fetchData}
            title="Refresh"
            className="h-7 w-7 flex items-center justify-center rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#35373d]"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <span className="ml-2 text-zinc-500">
            {data
              ? `${rows.length} rows${
                  data.totalCount != null ? ` / ${data.totalCount.toLocaleString()}` : ""
                } • ${data.executionMs}ms`
              : "Ready"}
          </span>
        </div>

        {/* Right: Pagination */}
        <div className="flex items-center gap-2">
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            className="h-7 px-1.5 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-[#3b3d44]"
          >
            <option value={100}>100 / page</option>
            <option value={500}>500 / page</option>
            <option value={1000}>1000 / page</option>
          </select>
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-40"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="font-mono">
            Page {page} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-40"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Preview SQL Modal */}
      {previewSqlModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setPreviewSqlModal(null)}
        >
          <div
            className="w-full max-w-xl rounded-md border border-zinc-700 bg-zinc-900 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
              <span className="font-semibold text-zinc-100">
                Staged Changes SQL Preview ({previewSqlModal.length} statements)
              </span>
              <button onClick={() => setPreviewSqlModal(null)}>
                <X className="w-4 h-4 text-zinc-400" />
              </button>
            </div>
            <pre className="p-4 text-[0.8rem] font-mono text-emerald-300 bg-zinc-950 max-h-80 overflow-auto whitespace-pre-wrap">
              {previewSqlModal.join("\n")}
            </pre>
            <div className="px-4 py-2.5 border-t border-zinc-800 flex justify-end gap-2">
              <button
                onClick={() => setPreviewSqlModal(null)}
                className="h-7 px-3 rounded bg-zinc-800 text-zinc-200"
              >
                Close
              </button>
              <button
                onClick={() => {
                  setPreviewSqlModal(null);
                  handleApplyChanges();
                }}
                className="h-7 px-3 rounded bg-emerald-600 text-white font-medium"
              >
                Apply Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
