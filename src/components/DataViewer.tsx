import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
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
import {
  formatCellValue,
  formatCsv,
  formatInsertSql,
  formatJson,
  formatRawClipboardValue,
  formatTsv,
} from "../lib/gridFormatters";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import { ContextMenu } from "./ContextMenu";
import type {
  FilterCondition,
  QueryResultSet,
  ResultColumn,
  SortSpec,
  StagedChange,
} from "../types/dba";

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

interface ActiveCell {
  isInsert: boolean;
  row: number;
  colIdx: number; // index into visibleCols
}

interface CellRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export const DataViewer: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
  const {
    connections,
    connectedIds,
    databasesByConn,
    schemasByConnDb,
    objectsByKey,
    activeTabId,
    inspectedTableMeta,
    connectTo,
    loadDatabases,
    loadSchemas,
    loadObjects,
    updateTab,
    setInspectedCell,
    setInspectedTableMeta,
    openTab,
    openSafetyModal,
    addLog,
  } = useWorkbenchStore();

  const sqlConnections = useMemo(
    () => connections.filter((c) => c.engine !== "mongodb"),
    [connections]
  );
  const conn = connections.find((c) => c.id === tab.connectionId);
  const isProd = conn?.environment === "production";
  const isReadOnly = conn?.readOnly ?? false;
  const supportsSchemas = conn?.engine === "postgres" || conn?.engine === "mssql";

  const dbs = tab.connectionId ? databasesByConn[tab.connectionId] ?? [] : [];
  const activeDb = tab.database ?? conn?.database ?? "";
  const schemas =
    tab.connectionId && activeDb
      ? schemasByConnDb[`${tab.connectionId}::${activeDb}`] ?? []
      : [];
  const availableTables = useMemo(() => {
    if (!tab.connectionId || !activeDb) return [];
    const schemaKey = supportsSchemas ? tab.schema ?? "" : activeDb;
    const objs =
      objectsByKey[`${tab.connectionId}::${activeDb}::${schemaKey}`] ??
      objectsByKey[`${tab.connectionId}::${activeDb}::`] ??
      [];
    return objs.filter(
      (o) => o.kind === "table" || o.kind === "view" || o.kind === "materialized_view"
    );
  }, [objectsByKey, tab.connectionId, activeDb, supportsSchemas, tab.schema]);

  const [switchingDb, setSwitchingDb] = useState(false);
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
  const [editingCell, setEditingCell] = useState<{
    row: number;
    col: string;
    isInsert?: boolean;
  } | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [previewSqlModal, setPreviewSqlModal] = useState<string[] | null>(null);

  // Column visibility, multi-selection, active cell & context menus
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [selectedCols, setSelectedCols] = useState<Set<number>>(new Set());
  const [colSelectionAnchor, setColSelectionAnchor] = useState<number | null>(null);
  const [cellRange, setCellRange] = useState<CellRange | null>(null);
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);

  const [headerMenu, setHeaderMenu] = useState<{
    x: number;
    y: number;
    vColIdx: number;
  } | null>(null);
  const [cellMenu, setCellMenu] = useState<{
    x: number;
    y: number;
    rowIdx: number;
    vColIdx: number;
    isInsert: boolean;
  } | null>(null);

  const [colWidths, setColWidths] = useState<Record<string, number>>({});

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const draggingHeaderRef = useRef<{ active: boolean; anchorCol: number }>({
    active: false,
    anchorCol: -1,
  });
  const draggingCellRef = useRef<{ active: boolean; anchorRow: number; anchorCol: number }>({
    active: false,
    anchorRow: -1,
    anchorCol: -1,
  });
  const skipBlurCommitRef = useRef(false);

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
      setSelectedCols(new Set());
      setCellRange(null);
      setActiveCell((prev) => {
        if (res.rows.length === 0 || res.columns.length === 0) return null;
        if (!prev) return { isInsert: false, row: 0, colIdx: 0 };
        return {
          isInsert: false,
          row: Math.min(prev.row, res.rows.length - 1),
          colIdx: Math.min(prev.colIdx, res.columns.length - 1),
        };
      });
    } catch (err) {
      const msg = formatApiError(err);
      setError(msg);
      addLog("error", `Fetch ${tab.table} failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [
    tab.connectionId,
    tab.database,
    tab.schema,
    tab.table,
    page,
    pageSize,
    appliedFilters,
    sorts,
    addLog,
  ]);

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

  // Auto-load databases & schemas for switcher dropdowns
  useEffect(() => {
    if (!tab.connectionId || !connectedIds.has(tab.connectionId)) return;
    if (!databasesByConn[tab.connectionId]) {
      loadDatabases(tab.connectionId);
    }
    if (supportsSchemas && activeDb && !schemasByConnDb[`${tab.connectionId}::${activeDb}`]) {
      loadSchemas(tab.connectionId, activeDb);
    }
  }, [
    tab.connectionId,
    activeDb,
    supportsSchemas,
    connectedIds,
    databasesByConn,
    schemasByConnDb,
    loadDatabases,
    loadSchemas,
  ]);

  // Load fallback table list when table fails to load (e.g., table not found in switched DB)
  useEffect(() => {
    if (!error || !tab.connectionId || !activeDb || !connectedIds.has(tab.connectionId)) return;
    if (availableTables.length === 0) {
      loadObjects(tab.connectionId, activeDb, supportsSchemas ? tab.schema : activeDb);
    }
  }, [
    error,
    tab.connectionId,
    activeDb,
    tab.schema,
    supportsSchemas,
    connectedIds,
    availableTables.length,
    loadObjects,
  ]);

  // End header/cell drag on window mouseup
  useEffect(() => {
    const onMouseUp = () => {
      draggingHeaderRef.current.active = false;
      draggingCellRef.current.active = false;
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  const rows = data?.rows ?? [];
  const columns = data?.columns ?? [];
  const visibleCols = useMemo(
    () =>
      columns
        .map((col, origIdx) => ({ col, origIdx }))
        .filter(({ col }) => !hiddenColumns.has(col.name)),
    [columns, hiddenColumns]
  );
  const pkCols = useMemo(() => columns.filter((c) => c.isPrimaryKey), [columns]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 26,
    overscan: 15,
  });

  const startColumnResize = (e: React.PointerEvent<HTMLDivElement>, colName: string) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement;
    const startX = e.clientX;
    const startW = colWidths[colName] ?? th?.getBoundingClientRect().width ?? 140;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const nextW = Math.max(60, Math.min(720, Math.round(startW + (ev.clientX - startX))));
      setColWidths((prev) => ({ ...prev, [colName]: nextW }));
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const autoFitColumn = (colName: string, origIdx: number, dataType: string) => {
    let maxLen = colName.length + formatDataType(dataType).length + 4;
    const sample = rows.slice(0, 100);
    for (const r of sample) {
      const val = r[origIdx];
      const str =
        val === null || val === undefined
          ? "NULL"
          : typeof val === "object"
          ? JSON.stringify(val)
          : String(val);
      if (str.length > maxLen) maxLen = str.length;
    }
    const fitted = Math.max(76, Math.min(480, Math.round(maxLen * 7.5 + 32)));
    setColWidths((prev) => ({ ...prev, [colName]: fitted }));
  };

  // Helper to get effective cell value (staged patch or original)
  const getEffectiveValue = useCallback(
    (rowIdx: number, col: ResultColumn, origColIdx: number): unknown => {
      const rowPatch = stagedUpdates[rowIdx];
      if (rowPatch && col.name in rowPatch) return rowPatch[col.name];
      return rows[rowIdx]?.[origColIdx];
    },
    [rows, stagedUpdates]
  );

  // Sync RightInspector & auto-scroll when activeCell changes
  useEffect(() => {
    if (!activeCell || viewMode !== "grid") return;
    const vCol = visibleCols[activeCell.colIdx];
    if (vCol) {
      if (activeCell.isInsert) {
        const ins = stagedInserts[activeCell.row];
        if (ins) {
          setInspectedCell({
            column: vCol.col.name,
            dataType: vCol.col.dataType,
            value: ins[vCol.col.name] ?? null,
          });
        }
      } else if (rows[activeCell.row]) {
        setSelectedRowIdx(activeCell.row);
        setInspectedCell({
          column: vCol.col.name,
          dataType: vCol.col.dataType,
          value: getEffectiveValue(activeCell.row, vCol.col, vCol.origIdx),
        });
      }
    }

    if (!activeCell.isInsert && rows.length > 0) {
      rowVirtualizer.scrollToIndex(activeCell.row, { align: "auto" });
    }
    const cellKey = `${activeCell.isInsert ? "ins" : "row"}-${activeCell.row}-${activeCell.colIdx}`;
    const raf = window.requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const el = container.querySelector<HTMLElement>(`[data-cell-key="${cellKey}"]`);
      el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [
    activeCell,
    viewMode,
    visibleCols,
    rows,
    stagedInserts,
    getEffectiveValue,
    setInspectedCell,
    rowVirtualizer,
  ]);

  const buildStagedPayloadWith = useCallback(
    (
      insertsArg: Record<string, unknown>[],
      updatesArg: Record<number, Record<string, unknown>>,
      deletesArg: Set<number>
    ): StagedChange[] => {
      const changes: StagedChange[] = [];
      for (const ins of insertsArg) {
        if (Object.keys(ins).length > 0) {
          changes.push({ kind: "insert", values: ins });
        }
      }
      for (const [rowIdxStr, patch] of Object.entries(updatesArg)) {
        const rowIdx = Number(rowIdxStr);
        if (deletesArg.has(rowIdx)) continue;
        if (Object.keys(patch).length === 0) continue;
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
      for (const rowIdx of deletesArg) {
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
    },
    [rows, pkCols, columns]
  );

  const buildStagedPayload = useCallback(
    () => buildStagedPayloadWith(stagedInserts, stagedUpdates, stagedDeletes),
    [buildStagedPayloadWith, stagedInserts, stagedUpdates, stagedDeletes]
  );

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
        addLog(
          "success",
          `Applied ${changes.length} change(s) to ${tab.table} (${affected} rows affected)`
        );
        await fetchData();
      } catch (err) {
        addLog("error", `Apply changes failed: ${formatApiError(err)}`);
        setError(formatApiError(err));
      }
    },
    [tab.connectionId, tab.database, tab.schema, tab.table, addLog, fetchData]
  );

  const applyChangesPayload = useCallback(
    async (changes: StagedChange[]) => {
      if (!tab.connectionId || !tab.table || changes.length === 0) return;
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
    },
    [tab.connectionId, tab.database, tab.schema, tab.table, openSafetyModal, executeApply]
  );

  const handleApplyChanges = useCallback(async () => {
    const changes = buildStagedPayload();
    if (changes.length === 0) return;
    await applyChangesPayload(changes);
  }, [buildStagedPayload, applyChangesPayload]);

  // Sync dirty status for Unsaved Changes Guard
  useEffect(() => {
    const isDirty = totalStagedCount > 0;
    if (Boolean(tab.dirty) !== isDirty) {
      updateTab(tab.id, { dirty: isDirty });
    }
  }, [totalStagedCount, tab.dirty, tab.id, updateTab]);

  // Manual refresh (F5 / Ctrl+R) & File -> Save menu action when this tab is active
  useEffect(() => {
    if (activeTabId !== tab.id) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) {
        e.preventDefault();
        fetchData();
      }
    };
    const onMenuAction = (e: Event) => {
      const action = (e as CustomEvent<{ action?: string }>).detail?.action;
      if (action === "save" && totalStagedCount > 0) {
        handleApplyChanges();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("dba:menu-action", onMenuAction);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("dba:menu-action", onMenuAction);
    };
  }, [activeTabId, tab.id, fetchData, totalStagedCount, handleApplyChanges]);

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

  // Switch Connection / Database / Schema safely
  const confirmDiscardBeforeSwitch = (label: string): boolean => {
    if (totalStagedCount === 0) return true;
    return window.confirm(`Discard ${totalStagedCount} unsaved change(s) and switch ${label}?`);
  };

  const resetStateForSwitch = () => {
    setStagedUpdates({});
    setStagedDeletes(new Set());
    setStagedInserts([]);
    setEditingCell(null);
    setSelectedCols(new Set());
    setCellRange(null);
    setActiveCell(null);
    setHiddenColumns(new Set());
    setPage(1);
  };

  const handleSwitchConnection = async (newConnId: string) => {
    if (!newConnId || newConnId === tab.connectionId) return;
    if (!confirmDiscardBeforeSwitch("connection")) return;
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
        undefined;
      let nextSchema: string | undefined = undefined;
      if (
        nextDb &&
        (targetConn?.engine === "postgres" || targetConn?.engine === "mssql")
      ) {
        const schemaList = await loadSchemas(newConnId, nextDb);
        const preferred = targetConn.engine === "postgres" ? "public" : "dbo";
        nextSchema =
          (tab.schema && schemaList.some((s) => s.name === tab.schema)
            ? tab.schema
            : schemaList.find((s) => s.name === preferred)?.name) ??
          schemaList[0]?.name ??
          preferred;
      }
      resetStateForSwitch();
      updateTab(tab.id, {
        connectionId: newConnId,
        database: nextDb,
        schema: nextSchema,
      });
    } finally {
      setSwitchingDb(false);
    }
  };

  const handleSwitchDatabase = async (newDb: string) => {
    if (!newDb || newDb === activeDb || !tab.connectionId) return;
    if (!confirmDiscardBeforeSwitch("database")) return;
    setSwitchingDb(true);
    try {
      if (!connectedIds.has(tab.connectionId)) {
        const ok = await connectTo(tab.connectionId);
        if (!ok) return;
      }
      let nextSchema = tab.schema;
      if (supportsSchemas) {
        const schemaList = await loadSchemas(tab.connectionId, newDb);
        const preferred = conn?.engine === "postgres" ? "public" : "dbo";
        nextSchema =
          (tab.schema && schemaList.some((s) => s.name === tab.schema)
            ? tab.schema
            : schemaList.find((s) => s.name === preferred)?.name) ??
          schemaList[0]?.name ??
          preferred;
      } else {
        nextSchema = undefined;
      }
      resetStateForSwitch();
      updateTab(tab.id, { database: newDb, schema: nextSchema });
    } finally {
      setSwitchingDb(false);
    }
  };

  const handleSwitchSchema = (newSchema: string) => {
    if (!newSchema || newSchema === tab.schema) return;
    if (!confirmDiscardBeforeSwitch("schema")) return;
    resetStateForSwitch();
    updateTab(tab.id, { schema: newSchema });
  };

  // Single-cell value mutation (supports NULL and "" explicitly)
  const setCellExplicitValue = useCallback(
    async (rowIdx: number, colName: string, value: unknown, isInsert = false) => {
      if (isReadOnly) return;
      if (isInsert) {
        setStagedInserts((prev) =>
          prev.map((r, i) => (i === rowIdx ? { ...r, [colName]: value } : r))
        );
        return;
      }
      if (stagedDeletes.has(rowIdx)) return;
      const colIdx = columns.findIndex((c) => c.name === colName);
      const original = rows[rowIdx]?.[colIdx];
      if (value === original) {
        // Remove patch if reverting to original
        setStagedUpdates((prev) => {
          const rowPatch = prev[rowIdx];
          if (!rowPatch || !(colName in rowPatch)) return prev;
          const nextRow = { ...rowPatch };
          delete nextRow[colName];
          const next = { ...prev };
          if (Object.keys(nextRow).length === 0) delete next[rowIdx];
          else next[rowIdx] = nextRow;
          return next;
        });
        return;
      }
      if (instantCommit && !isProd) {
        const row = rows[rowIdx];
        if (!row) return;
        const primary_keys: Record<string, unknown> = {};
        const keyCols = pkCols.length > 0 ? pkCols : columns;
        keyCols.forEach((c) => {
          const ci = columns.findIndex((x) => x.name === c.name);
          if (ci >= 0) primary_keys[c.name] = row[ci];
        });
        await executeApply([{ kind: "update", primary_keys, changes: { [colName]: value } }], false);
      } else {
        setStagedUpdates((prev) => ({
          ...prev,
          [rowIdx]: { ...(prev[rowIdx] ?? {}), [colName]: value },
        }));
      }
    },
    [isReadOnly, stagedDeletes, columns, rows, instantCommit, isProd, pkCols, executeApply]
  );

  // Batch set value (NULL or "") on multiple rows & columns
  const batchSetSelectedValue = useCallback(
    (rowIndices: number[], colIndices: number[], value: unknown) => {
      if (isReadOnly || rowIndices.length === 0 || colIndices.length === 0) return;
      setStagedUpdates((prev) => {
        const next = { ...prev };
        for (const rIdx of rowIndices) {
          if (stagedDeletes.has(rIdx) || !rows[rIdx]) continue;
          const existing = { ...(next[rIdx] ?? {}) };
          for (const vColIdx of colIndices) {
            const vCol = visibleCols[vColIdx];
            if (!vCol) continue;
            existing[vCol.col.name] = value;
          }
          next[rIdx] = existing;
        }
        return next;
      });
    },
    [isReadOnly, stagedDeletes, rows, visibleCols]
  );

  const commitCellEdit = useCallback(
    async (
      rowIdx: number,
      colName: string,
      isInsert?: boolean,
      draftOverride?: string
    ) => {
      const draft = draftOverride !== undefined ? draftOverride : editDraft;
      setEditingCell(null);
      if (isInsert) {
        const parsedInsert = draft.toUpperCase() === "NULL" ? null : draft;
        setStagedInserts((prev) =>
          prev.map((r, i) => (i === rowIdx ? { ...r, [colName]: parsedInsert } : r))
        );
        return;
      }

      const colIdx = columns.findIndex((c) => c.name === colName);
      const original = rows[rowIdx]?.[colIdx];
      const parsed = parseInputValue(draft, original);
      if (parsed === original) return;

      await setCellExplicitValue(rowIdx, colName, parsed, false);
    },
    [editDraft, columns, rows, setCellExplicitValue]
  );

  // Atomic commit of currently edited cell + immediate apply to DB (Ctrl+Enter / Ctrl+S in edit mode)
  const commitAndApplyAtomically = useCallback(
    async (rowIdx: number, colName: string, isInsert?: boolean) => {
      skipBlurCommitRef.current = true;
      setEditingCell(null);

      let nextInserts = stagedInserts;
      let nextUpdates = stagedUpdates;

      if (isInsert) {
        const parsedInsert = editDraft.toUpperCase() === "NULL" ? null : editDraft;
        nextInserts = stagedInserts.map((r, i) =>
          i === rowIdx ? { ...r, [colName]: parsedInsert } : r
        );
        setStagedInserts(nextInserts);
      } else {
        const colIdx = columns.findIndex((c) => c.name === colName);
        const original = rows[rowIdx]?.[colIdx];
        const parsed = parseInputValue(editDraft, original);
        if (parsed !== original) {
          nextUpdates = {
            ...stagedUpdates,
            [rowIdx]: { ...(stagedUpdates[rowIdx] ?? {}), [colName]: parsed },
          };
          setStagedUpdates(nextUpdates);
        }
      }

      const changes = buildStagedPayloadWith(nextInserts, nextUpdates, stagedDeletes);
      if (changes.length > 0) {
        await applyChangesPayload(changes);
      }
    },
    [
      stagedInserts,
      stagedUpdates,
      stagedDeletes,
      editDraft,
      columns,
      rows,
      buildStagedPayloadWith,
      applyChangesPayload,
    ]
  );

  // Selection helpers
  const getEffectiveSelection = useCallback((): {
    rowIndices: number[];
    colIndices: number[];
  } => {
    if (selectedCols.size > 0) {
      const colIndices = Array.from(selectedCols)
        .filter((i) => i >= 0 && i < visibleCols.length)
        .sort((a, b) => a - b);
      const rowIndices = rows.map((_, i) => i);
      return { rowIndices, colIndices };
    }
    if (cellRange) {
      const rMin = Math.max(0, Math.min(cellRange.startRow, cellRange.endRow));
      const rMax = Math.min(rows.length - 1, Math.max(cellRange.startRow, cellRange.endRow));
      const cMin = Math.max(0, Math.min(cellRange.startCol, cellRange.endCol));
      const cMax = Math.min(
        visibleCols.length - 1,
        Math.max(cellRange.startCol, cellRange.endCol)
      );
      const rowIndices: number[] = [];
      for (let r = rMin; r <= rMax; r++) rowIndices.push(r);
      const colIndices: number[] = [];
      for (let c = cMin; c <= cMax; c++) colIndices.push(c);
      return { rowIndices, colIndices };
    }
    if (activeCell && !activeCell.isInsert && rows[activeCell.row] && visibleCols[activeCell.colIdx]) {
      return { rowIndices: [activeCell.row], colIndices: [activeCell.colIdx] };
    }
    return { rowIndices: [], colIndices: [] };
  }, [selectedCols, cellRange, activeCell, rows, visibleCols]);

  const isCellSelected = useCallback(
    (rowIdx: number, vColIdx: number): boolean => {
      if (selectedCols.has(vColIdx)) return true;
      if (cellRange) {
        const rMin = Math.min(cellRange.startRow, cellRange.endRow);
        const rMax = Math.max(cellRange.startRow, cellRange.endRow);
        const cMin = Math.min(cellRange.startCol, cellRange.endCol);
        const cMax = Math.max(cellRange.startCol, cellRange.endCol);
        return rowIdx >= rMin && rowIdx <= rMax && vColIdx >= cMin && vColIdx <= cMax;
      }
      return false;
    },
    [selectedCols, cellRange]
  );

  const hasMultiSelection = useMemo(() => {
    if (selectedCols.size > 0) return true;
    if (cellRange) {
      return (
        cellRange.startRow !== cellRange.endRow || cellRange.startCol !== cellRange.endCol
      );
    }
    return false;
  }, [selectedCols, cellRange]);

  // Clipboard helpers
  const copyToClipboard = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        addLog("info", `Copied ${label} to clipboard`);
      } catch (err) {
        addLog("error", `Clipboard copy failed: ${String(err)}`);
      }
    },
    [addLog]
  );

  const extractMatrix = useCallback(
    (rowIndices: number[], colIndices: number[]) => {
      const colNames = colIndices
        .map((i) => visibleCols[i]?.col.name)
        .filter((n): n is string => Boolean(n));
      const matrix = rowIndices.map((rIdx) =>
        colIndices.map((vColIdx) => {
          const vCol = visibleCols[vColIdx];
          if (!vCol) return null;
          return getEffectiveValue(rIdx, vCol.col, vCol.origIdx);
        })
      );
      return { colNames, matrix };
    },
    [visibleCols, getEffectiveValue]
  );

  const copySelectionFormatted = useCallback(
    (
      format: "tsv" | "tsv_headers" | "csv" | "json" | "insert_sql",
      overrideRows?: number[],
      overrideCols?: number[]
    ) => {
      const sel =
        overrideRows && overrideCols
          ? { rowIndices: overrideRows, colIndices: overrideCols }
          : getEffectiveSelection();
      if (sel.rowIndices.length === 0 || sel.colIndices.length === 0) return;
      const { colNames, matrix } = extractMatrix(sel.rowIndices, sel.colIndices);
      if (format === "tsv") {
        copyToClipboard(formatTsv(matrix, colNames, false), "selection (TSV)");
      } else if (format === "tsv_headers") {
        copyToClipboard(formatTsv(matrix, colNames, true), "selection with headers (TSV)");
      } else if (format === "csv") {
        copyToClipboard(formatCsv(matrix, colNames, true), "selection (CSV)");
      } else if (format === "json") {
        copyToClipboard(formatJson(matrix, colNames), "selection (JSON)");
      } else if (format === "insert_sql") {
        copyToClipboard(
          formatInsertSql(tab.table ?? "table", tab.schema, conn?.engine, matrix, colNames),
          "selection (INSERT SQL)"
        );
      }
    },
    [getEffectiveSelection, extractMatrix, copyToClipboard, tab.table, tab.schema, conn?.engine]
  );

  // Add / Duplicate Row helpers
  const addBlankRow = useCallback(() => {
    if (isReadOnly) return;
    const blank: Record<string, unknown> = {};
    columns.forEach((c) => {
      if (!c.isPrimaryKey) blank[c.name] = null;
    });
    const nextIdx = stagedInserts.length;
    setStagedInserts((prev) => [...prev, blank]);
    if (visibleCols.length > 0) {
      setActiveCell({ isInsert: true, row: nextIdx, colIdx: 0 });
    }
  }, [isReadOnly, columns, stagedInserts.length, visibleCols.length]);

  const duplicateRow = useCallback(
    (rowIdx: number, isInsert: boolean) => {
      if (isReadOnly) return;
      const autoIncSet = new Set(
        (inspectedTableMeta?.columns ?? [])
          .filter((c) => c.isAutoIncrement)
          .map((c) => c.name)
      );
      const copy: Record<string, unknown> = {};
      if (isInsert) {
        const src = stagedInserts[rowIdx];
        if (!src) return;
        columns.forEach((c) => {
          copy[c.name] = c.isPrimaryKey || autoIncSet.has(c.name) ? null : src[c.name] ?? null;
        });
      } else {
        columns.forEach((c, origIdx) => {
          if (c.isPrimaryKey || autoIncSet.has(c.name)) {
            copy[c.name] = null;
          } else {
            copy[c.name] = getEffectiveValue(rowIdx, c, origIdx);
          }
        });
      }
      const nextIdx = stagedInserts.length;
      setStagedInserts((prev) => [...prev, copy]);
      setActiveCell({ isInsert: true, row: nextIdx, colIdx: 0 });
    },
    [isReadOnly, inspectedTableMeta, stagedInserts, columns, getEffectiveValue]
  );

  // Quick Filter helper
  const applyQuickFilter = useCallback(
    (colName: string, val: unknown, exclude: boolean) => {
      const cond: FilterCondition =
        val === null || val === undefined
          ? { column: colName, operator: exclude ? "IS NOT NULL" : "IS NULL", value: "" }
          : {
              column: colName,
              operator: exclude ? "!=" : "=",
              value: formatRawClipboardValue(val),
            };
      const nextFilters = [...appliedFilters, cond];
      setDraftFilters(nextFilters);
      setAppliedFilters(nextFilters);
      setShowFilters(true);
      setPage(1);
    },
    [appliedFilters]
  );

  // Keyboard Grid Movement (Unified across +NEW insert rows and data rows)
  const moveActiveCell = useCallback(
    (dRow: number, dCol: number, wrapCol = false) => {
      const totalCols = visibleCols.length;
      const insertCount = stagedInserts.length;
      const totalRows = insertCount + rows.length;
      if (totalCols === 0 || totalRows === 0) return;

      setSelectedCols(new Set());
      setCellRange(null);

      setActiveCell((prev) => {
        let curUnifiedRow = prev
          ? prev.isInsert
            ? prev.row
            : insertCount + prev.row
          : insertCount > 0
          ? 0
          : insertCount;
        let curCol = prev ? prev.colIdx : 0;

        let nextRow = curUnifiedRow + dRow;
        let nextCol = curCol + dCol;

        if (wrapCol) {
          if (nextCol >= totalCols) {
            nextCol = 0;
            nextRow += 1;
          } else if (nextCol < 0) {
            nextCol = totalCols - 1;
            nextRow -= 1;
          }
        }

        nextRow = Math.max(0, Math.min(totalRows - 1, nextRow));
        nextCol = Math.max(0, Math.min(totalCols - 1, nextCol));

        if (nextRow < insertCount) {
          return { isInsert: true, row: nextRow, colIdx: nextCol };
        }
        return { isInsert: false, row: nextRow - insertCount, colIdx: nextCol };
      });
    },
    [visibleCols.length, stagedInserts.length, rows.length]
  );

  const startEditingCell = useCallback(
    (target: ActiveCell, initialText?: string) => {
      if (isReadOnly) return;
      if (!target.isInsert && stagedDeletes.has(target.row)) return;
      const vCol = visibleCols[target.colIdx];
      if (!vCol) return;
      skipBlurCommitRef.current = false;
      setEditingCell({ row: target.row, col: vCol.col.name, isInsert: target.isInsert });
      if (initialText !== undefined) {
        setEditDraft(initialText);
      } else if (target.isInsert) {
        const val = stagedInserts[target.row]?.[vCol.col.name];
        setEditDraft(val == null ? "" : String(val));
      } else {
        const val = getEffectiveValue(target.row, vCol.col, vCol.origIdx);
        setEditDraft(val == null ? "" : formatCellValue(val));
      }
    },
    [isReadOnly, stagedDeletes, visibleCols, stagedInserts, getEffectiveValue]
  );

  // Navigation Mode Global Keyboard Listener (scoped strictly to active tab & grid mode)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeTabId !== tab.id || viewMode !== "grid") return;
      if (previewSqlModal || headerMenu || cellMenu) return;

      const targetEl = e.target as HTMLElement | null;
      const isInInput =
        targetEl &&
        (targetEl.tagName === "INPUT" ||
          targetEl.tagName === "TEXTAREA" ||
          targetEl.tagName === "SELECT" ||
          targetEl.isContentEditable);

      // While editing cell, input's own onKeyDown handles everything
      if (editingCell || isInInput) return;

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;

      // Ctrl+S or Ctrl+Enter -> Apply staged changes
      if (mod && (key.toLowerCase() === "s" || key === "Enter")) {
        if (totalStagedCount > 0) {
          e.preventDefault();
          handleApplyChanges();
        }
        return;
      }

      // Ctrl+C -> Copy selection as TSV
      if (mod && key.toLowerCase() === "c") {
        const sel = getEffectiveSelection();
        if (sel.rowIndices.length > 0 && sel.colIndices.length > 0) {
          e.preventDefault();
          copySelectionFormatted("tsv", sel.rowIndices, sel.colIndices);
        }
        return;
      }

      // Ctrl+Shift+N -> Set active cell to NULL
      if (mod && e.shiftKey && key.toLowerCase() === "n") {
        if (activeCell && !isReadOnly) {
          const vCol = visibleCols[activeCell.colIdx];
          if (vCol) {
            e.preventDefault();
            setCellExplicitValue(activeCell.row, vCol.col.name, null, activeCell.isInsert);
          }
        }
        return;
      }

      if (key === "ArrowUp") {
        e.preventDefault();
        moveActiveCell(-1, 0);
        return;
      }
      if (key === "ArrowDown") {
        e.preventDefault();
        moveActiveCell(1, 0);
        return;
      }
      if (key === "ArrowLeft") {
        e.preventDefault();
        moveActiveCell(0, -1);
        return;
      }
      if (key === "ArrowRight") {
        e.preventDefault();
        moveActiveCell(0, 1);
        return;
      }
      if (key === "Tab") {
        e.preventDefault();
        moveActiveCell(0, e.shiftKey ? -1 : 1, true);
        return;
      }
      if (key === "Enter") {
        e.preventDefault();
        moveActiveCell(1, 0);
        return;
      }
      if (key === "F2") {
        if (activeCell) {
          e.preventDefault();
          startEditingCell(activeCell);
        }
        return;
      }

      // Direct printable character starts inline edit on active cell
      if (
        activeCell &&
        !mod &&
        !e.altKey &&
        key.length === 1 &&
        !isReadOnly &&
        (activeCell.isInsert || !stagedDeletes.has(activeCell.row))
      ) {
        e.preventDefault();
        startEditingCell(activeCell, key);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeTabId,
    tab.id,
    viewMode,
    previewSqlModal,
    headerMenu,
    cellMenu,
    editingCell,
    totalStagedCount,
    handleApplyChanges,
    getEffectiveSelection,
    copySelectionFormatted,
    activeCell,
    isReadOnly,
    visibleCols,
    setCellExplicitValue,
    moveActiveCell,
    startEditingCell,
    stagedDeletes,
  ]);

  // Edit-mode input keyboard handler
  const handleEditInputKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIdx: number,
    colName: string,
    isInsert: boolean
  ) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "Enter" || e.key.toLowerCase() === "s")) {
      e.preventDefault();
      e.stopPropagation();
      commitAndApplyAtomically(rowIdx, colName, isInsert);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      skipBlurCommitRef.current = true;
      setEditingCell(null);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      skipBlurCommitRef.current = true;
      commitCellEdit(rowIdx, colName, isInsert);
      moveActiveCell(1, 0);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      skipBlurCommitRef.current = true;
      commitCellEdit(rowIdx, colName, isInsert);
      moveActiveCell(-1, 0);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      skipBlurCommitRef.current = true;
      commitCellEdit(rowIdx, colName, isInsert);
      moveActiveCell(1, 0);
      return;
    }
    if (mod && e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      skipBlurCommitRef.current = true;
      commitCellEdit(rowIdx, colName, isInsert);
      moveActiveCell(0, -1);
      return;
    }
    if (mod && e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      skipBlurCommitRef.current = true;
      commitCellEdit(rowIdx, colName, isInsert);
      moveActiveCell(0, 1);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      skipBlurCommitRef.current = true;
      commitCellEdit(rowIdx, colName, isInsert);
      moveActiveCell(0, e.shiftKey ? -1 : 1, true);
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

  const setColumnSort = (colName: string, direction: "ASC" | "DESC" | null) => {
    if (!direction) {
      setSorts((prev) => prev.filter((s) => s.column !== colName));
    } else {
      setSorts([{ column: colName, direction }]);
    }
  };

  // Column header mouse selection handlers
  const handleHeaderMouseDown = (e: React.MouseEvent, vColIdx: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    setCellRange(null);

    if (e.ctrlKey || e.metaKey) {
      setSelectedCols((prev) => {
        const next = new Set(prev);
        if (next.has(vColIdx)) next.delete(vColIdx);
        else next.add(vColIdx);
        return next;
      });
      setColSelectionAnchor(vColIdx);
    } else if (e.shiftKey && colSelectionAnchor !== null) {
      const min = Math.min(colSelectionAnchor, vColIdx);
      const max = Math.max(colSelectionAnchor, vColIdx);
      const next = new Set<number>();
      for (let i = min; i <= max; i++) next.add(i);
      setSelectedCols(next);
    } else {
      setSelectedCols(new Set([vColIdx]));
      setColSelectionAnchor(vColIdx);
      draggingHeaderRef.current = { active: true, anchorCol: vColIdx };
    }
  };

  const handleHeaderMouseEnter = (vColIdx: number) => {
    if (!draggingHeaderRef.current.active) return;
    const min = Math.min(draggingHeaderRef.current.anchorCol, vColIdx);
    const max = Math.max(draggingHeaderRef.current.anchorCol, vColIdx);
    const next = new Set<number>();
    for (let i = min; i <= max; i++) next.add(i);
    setSelectedCols(next);
  };

  const handleHeaderContextMenu = (e: React.MouseEvent, vColIdx: number) => {
    e.preventDefault();
    setCellMenu(null);
    if (!selectedCols.has(vColIdx)) {
      setSelectedCols(new Set([vColIdx]));
      setColSelectionAnchor(vColIdx);
      setCellRange(null);
    }
    setHeaderMenu({ x: e.clientX, y: e.clientY, vColIdx });
  };

  // Cell mouse selection & context menu handlers
  const handleCellMouseDown = (
    e: React.MouseEvent,
    rowIdx: number,
    vColIdx: number
  ) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, input")) return;

    setSelectedCols(new Set());
    setSelectedRowIdx(rowIdx);

    if (e.shiftKey && activeCell && !activeCell.isInsert) {
      e.preventDefault();
      setCellRange({
        startRow: activeCell.row,
        startCol: activeCell.colIdx,
        endRow: rowIdx,
        endCol: vColIdx,
      });
    } else {
      setActiveCell({ isInsert: false, row: rowIdx, colIdx: vColIdx });
      setCellRange(null);
      draggingCellRef.current = { active: true, anchorRow: rowIdx, anchorCol: vColIdx };
    }
  };

  const handleCellMouseEnter = (rowIdx: number, vColIdx: number) => {
    if (!draggingCellRef.current.active) return;
    const { anchorRow, anchorCol } = draggingCellRef.current;
    if (rowIdx !== anchorRow || vColIdx !== anchorCol) {
      setCellRange({
        startRow: anchorRow,
        startCol: anchorCol,
        endRow: rowIdx,
        endCol: vColIdx,
      });
    }
  };

  const handleCellContextMenu = (
    e: React.MouseEvent,
    rowIdx: number,
    vColIdx: number,
    isInsert: boolean
  ) => {
    e.preventDefault();
    setHeaderMenu(null);
    if (isInsert) {
      setSelectedCols(new Set());
      setCellRange(null);
      setActiveCell({ isInsert: true, row: rowIdx, colIdx: vColIdx });
    } else if (!isCellSelected(rowIdx, vColIdx)) {
      setSelectedCols(new Set());
      setCellRange(null);
      setActiveCell({ isInsert: false, row: rowIdx, colIdx: vColIdx });
      setSelectedRowIdx(rowIdx);
    }
    setCellMenu({ x: e.clientX, y: e.clientY, rowIdx, vColIdx, isInsert });
  };

  const totalPages = data?.totalCount ? Math.max(1, Math.ceil(data.totalCount / pageSize)) : 1;
  const envDotClass =
    conn?.environment === "production"
      ? "bg-red-500"
      : conn?.environment === "staging"
      ? "bg-amber-400"
      : "bg-emerald-500";

  return (
    <div className="h-full flex flex-col bg-[var(--surface-canvas)] text-xs">
      {/* Toolbar */}
      <div className="px-2.5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={fetchData}
            title="Refresh Data"
            className="h-7 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1"
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
                : "border-[var(--border-strong)] hover:bg-[var(--surface-hover)]"
            }`}
          >
            <Filter className="w-3.5 h-3.5" />
            Filter {appliedFilters.length > 0 ? `(${appliedFilters.length})` : ""}
          </button>

          {!isReadOnly && (
            <button
              onClick={addBlankRow}
              className="h-7 px-2.5 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
              Add Row
            </button>
          )}

          {/* Grid / Form View Toggle */}
          <div className="flex rounded border border-[var(--border-strong)] overflow-hidden ml-1">
            <button
              onClick={() => setViewMode("grid")}
              title="Spreadsheet Grid View"
              className={`h-7 px-2 flex items-center ${
                viewMode === "grid"
                  ? "bg-indigo-600 text-white"
                  : "hover:bg-[var(--surface-hover)]"
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
                  : "hover:bg-[var(--surface-hover)]"
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
                  : "border-[var(--border-strong)] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
              }`}
            >
              <Zap className="w-3 h-3" />
              {instantCommit ? "Instant Commit" : "Staged Mode"}
            </button>
          )}

          {hiddenColumns.size > 0 && (
            <button
              onClick={() => setHiddenColumns(new Set())}
              title="Restore all hidden columns"
              className="h-7 px-2 rounded border border-indigo-500/50 bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 flex items-center gap-1"
            >
              <Eye className="w-3.5 h-3.5" />
              Show All Columns ({hiddenColumns.size} hidden)
            </button>
          )}
        </div>

        {/* Right: Staged Changes Actions + Interactive Connection/Database/Schema Switcher */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {totalStagedCount > 0 && (
            <>
              <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium">
                {totalStagedCount} staged
              </span>
              <button
                onClick={handlePreviewSql}
                className="h-7 px-2.5 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1"
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
                className="h-7 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] text-zinc-400 flex items-center gap-1"
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

          {/* Navicat-Style Connection / Database / Schema Switcher */}
          <div className="flex items-center gap-1 pl-1.5 border-l border-[var(--border-strong)]">
            <span
              className={`w-2 h-2 rounded-full shrink-0 ${envDotClass}`}
              title={`Environment: ${conn?.environment ?? "local"}`}
            />
            <select
              value={tab.connectionId ?? ""}
              disabled={switchingDb}
              onChange={(e) => handleSwitchConnection(e.target.value)}
              title="Switch SQL Connection"
              className="h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] max-w-[150px] truncate"
            >
              {sqlConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.engine.toUpperCase()})
                </option>
              ))}
            </select>
            <select
              value={activeDb}
              disabled={switchingDb || !tab.connectionId}
              onChange={(e) => handleSwitchDatabase(e.target.value)}
              title="Switch Database"
              className="h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] max-w-[140px] truncate font-mono"
            >
              {activeDb && !dbs.some((d) => d.name === activeDb) && (
                <option value={activeDb}>{activeDb}</option>
              )}
              {dbs.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
            {supportsSchemas && (
              <select
                value={tab.schema ?? ""}
                disabled={switchingDb || !activeDb}
                onChange={(e) => handleSwitchSchema(e.target.value)}
                title="Switch Schema"
                className="h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] max-w-[120px] truncate font-mono"
              >
                {tab.schema && !schemas.some((s) => s.name === tab.schema) && (
                  <option value={tab.schema}>{tab.schema}</option>
                )}
                {schemas.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>

      {/* Visual Filter Builder (Manual Apply via Enter or Apply Button) */}
      {showFilters && (
        <div className="px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] space-y-1.5">
          {draftFilters.map((f, idx) => (
            <div key={idx} className="flex items-center gap-1.5">
              <select
                value={f.column}
                onChange={(e) =>
                  setDraftFilters((prev) =>
                    prev.map((x, i) => (i === idx ? { ...x, column: e.target.value } : x))
                  )
                }
                className="h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)]"
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
                className="h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
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
                  className="h-7 px-2 w-52 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
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
                  className="h-7 px-2 w-40 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
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
              className="h-6 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1"
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
                className="h-6 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] text-zinc-500"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 font-mono flex flex-wrap items-center justify-between gap-2">
          <span>{error}</span>
          {availableTables.length > 0 && (
            <div className="flex items-center gap-1.5 text-zinc-200 font-sans">
              <span className="text-[0.75rem] text-zinc-400">
                Switch table in {activeDb}:
              </span>
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  resetStateForSwitch();
                  updateTab(tab.id, {
                    table: e.target.value,
                    title: e.target.value,
                  });
                }}
                className="h-6 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] text-xs font-mono"
              >
                <option value="">Select table...</option>
                {availableTables.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Main Content: Grid View or Form View */}
      {viewMode === "grid" ? (
        <div ref={scrollContainerRef} className="flex-1 overflow-auto relative select-none">
          <table className="w-max min-w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-[var(--surface-panel)] border-b border-[var(--border-subtle)]">
              <tr>
                <th className="w-12 px-2 py-1.5 text-[0.72rem] font-semibold text-zinc-500 border-r border-[var(--border-subtle)]">
                  #
                </th>
                {visibleCols.map(({ col, origIdx }, vColIdx) => {
                  const sort = sorts.find((s) => s.column === col.name);
                  const isColSel = selectedCols.has(vColIdx);
                  const customW = colWidths[col.name];
                  return (
                    <th
                      key={col.name}
                      style={
                        customW
                          ? { width: customW, minWidth: customW, maxWidth: customW }
                          : undefined
                      }
                      onMouseDown={(e) => handleHeaderMouseDown(e, vColIdx)}
                      onMouseEnter={() => handleHeaderMouseEnter(vColIdx)}
                      onDoubleClick={() => toggleSort(col.name)}
                      onContextMenu={(e) => handleHeaderContextMenu(e, vColIdx)}
                      className={`relative px-2.5 py-1 font-semibold border-r border-[var(--border-subtle)] cursor-pointer whitespace-nowrap select-none transition-colors ${
                        isColSel
                          ? "bg-indigo-500/25 text-indigo-700 dark:text-indigo-200"
                          : "text-zinc-700 dark:text-zinc-200 hover:bg-[var(--surface-hover)]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5 pr-1">
                        <div className="flex items-center gap-1.5 min-w-0 truncate">
                          {col.isPrimaryKey && (
                            <span className="text-[0.68rem] px-1 rounded bg-amber-500/20 text-amber-400 shrink-0">
                              PK
                            </span>
                          )}
                          <span className="truncate">{col.name}</span>
                          <span className="text-[0.68rem] font-normal text-neutral-400 dark:text-neutral-500 shrink-0">
                            {formatDataType(col.dataType)}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleSort(col.name);
                          }}
                          title={
                            sort
                              ? `Sorted ${sort.direction} (click to toggle)`
                              : `Sort by ${col.name}`
                          }
                          className={`p-0.5 rounded hover:bg-zinc-300/70 dark:hover:bg-zinc-700/70 shrink-0 ${
                            sort
                              ? "text-indigo-500 dark:text-indigo-400"
                              : "text-zinc-400 opacity-50 hover:opacity-100"
                          }`}
                        >
                          {sort ? (
                            sort.direction === "ASC" ? (
                              <ArrowUp className="w-3 h-3" />
                            ) : (
                              <ArrowDown className="w-3 h-3" />
                            )
                          ) : (
                            <ArrowUpDown className="w-3 h-3" />
                          )}
                        </button>
                      </div>
                      <div
                        onPointerDown={(e) => startColumnResize(e, col.name)}
                        onMouseDown={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          autoFitColumn(col.name, origIdx, col.dataType);
                        }}
                        title="Drag to resize • Double-click to auto-fit"
                        className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-indigo-500/60"
                      />
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
                  {visibleCols.map(({ col }, vColIdx) => {
                    const isEditing =
                      editingCell?.isInsert &&
                      editingCell.row === iIdx &&
                      editingCell.col === col.name;
                    const isActive =
                      activeCell?.isInsert &&
                      activeCell.row === iIdx &&
                      activeCell.colIdx === vColIdx;
                    const val = ins[col.name];
                    return (
                      <td
                        key={col.name}
                        data-cell-key={`ins-${iIdx}-${vColIdx}`}
                        onClick={() => {
                          setSelectedCols(new Set());
                          setCellRange(null);
                          setActiveCell({ isInsert: true, row: iIdx, colIdx: vColIdx });
                        }}
                        onDoubleClick={() =>
                          startEditingCell({ isInsert: true, row: iIdx, colIdx: vColIdx })
                        }
                        onContextMenu={(e) => handleCellContextMenu(e, iIdx, vColIdx, true)}
                        className={`px-2.5 py-1 border-r border-zinc-800/40 font-mono max-w-[260px] truncate ${
                          isActive ? "ring-2 ring-inset ring-emerald-500" : ""
                        }`}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            onBlur={() => {
                              if (skipBlurCommitRef.current) {
                                skipBlurCommitRef.current = false;
                                return;
                              }
                              commitCellEdit(iIdx, col.name, true);
                            }}
                            onKeyDown={(e) => handleEditInputKeyDown(e, iIdx, col.name, true)}
                            className="w-full bg-[var(--surface-canvas)] text-zinc-900 dark:text-zinc-100 px-1 py-0.5 rounded border border-emerald-500 focus:outline-none select-text"
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
                    className={`border-b border-[var(--border-subtle)] ${
                      isDeleted
                        ? "bg-red-500/15 line-through text-red-400"
                        : rowIdx === selectedRowIdx
                        ? "bg-indigo-500/10"
                        : "hover:bg-[var(--surface-hover)]"
                    }`}
                  >
                    <td className="px-2 py-1 text-[0.72rem] text-zinc-500 border-r border-[var(--border-subtle)] font-mono flex items-center justify-between gap-1">
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
                    {visibleCols.map(({ col, origIdx }, vColIdx) => {
                      const hasPatch = rowPatch && col.name in rowPatch;
                      const cellVal = hasPatch ? rowPatch[col.name] : row[origIdx];
                      const isEditing =
                        !editingCell?.isInsert &&
                        editingCell?.row === rowIdx &&
                        editingCell?.col === col.name;
                      const isActive =
                        !activeCell?.isInsert &&
                        activeCell?.row === rowIdx &&
                        activeCell?.colIdx === vColIdx;
                      const inSelection = isCellSelected(rowIdx, vColIdx);

                      const customW = colWidths[col.name];
                      return (
                        <td
                          key={col.name}
                          data-cell-key={`row-${rowIdx}-${vColIdx}`}
                          style={
                            customW
                              ? { width: customW, minWidth: customW, maxWidth: customW }
                              : undefined
                          }
                          onMouseDown={(e) => handleCellMouseDown(e, rowIdx, vColIdx)}
                          onMouseEnter={() => handleCellMouseEnter(rowIdx, vColIdx)}
                          onDoubleClick={() => {
                            if (isReadOnly || isDeleted) return;
                            startEditingCell({ isInsert: false, row: rowIdx, colIdx: vColIdx });
                          }}
                          onContextMenu={(e) =>
                            handleCellContextMenu(e, rowIdx, vColIdx, false)
                          }
                          className={`px-2.5 py-0.5 h-[26px] border-r border-[var(--border-subtle)]/70 font-mono truncate ${
                            customW ? "" : "max-w-[300px]"
                          } ${
                            hasPatch
                              ? "bg-amber-500/20 text-amber-300"
                              : inSelection
                              ? "bg-indigo-500/20"
                              : ""
                          } ${isActive ? "ring-2 ring-inset ring-indigo-500" : ""}`}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              value={editDraft}
                              onChange={(e) => setEditDraft(e.target.value)}
                              onBlur={() => {
                                if (skipBlurCommitRef.current) {
                                  skipBlurCommitRef.current = false;
                                  return;
                                }
                                commitCellEdit(rowIdx, col.name, false);
                              }}
                              onKeyDown={(e) =>
                                handleEditInputKeyDown(e, rowIdx, col.name, false)
                              }
                              className="w-full bg-[var(--surface-canvas)] text-zinc-900 dark:text-zinc-100 px-1 py-0.5 rounded border border-indigo-500 focus:outline-none select-text"
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
              <div className="flex items-center justify-between pb-2 border-b border-[var(--border-subtle)]">
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
                      className="col-span-2 p-1.5 rounded bg-[var(--surface-panel)] border border-[var(--border-strong)] font-mono text-xs"
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

      {/* Column Header Right-Click Context Menu */}
      {headerMenu && (() => {
        const colIndices = Array.from(selectedCols)
          .filter((i) => i >= 0 && i < visibleCols.length)
          .sort((a, b) => a - b);
        const targetVCol = visibleCols[headerMenu.vColIdx];
        if (!targetVCol) return null;
        const selectedColNames = colIndices.map((i) => visibleCols[i].col.name);
        const allRowIndices = rows.map((_, i) => i);
        const plural = selectedColNames.length > 1;

        return (
          <ContextMenu
            x={headerMenu.x}
            y={headerMenu.y}
            onClose={() => setHeaderMenu(null)}
            className="w-60"
          >
            <button
              onClick={() => {
                copyToClipboard(selectedColNames.join(", "), "column name(s)");
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2"
            >
              <Copy className="w-3.5 h-3.5 text-zinc-400" />
              Copy Column Name{plural ? `s (${selectedColNames.length})` : ""}
            </button>
            <button
              onClick={() => {
                copyToClipboard(selectedColNames.join("\n"), "column name(s) (newline)");
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2"
            >
              <Copy className="w-3.5 h-3.5 text-zinc-400" />
              Copy Column Name{plural ? "s" : ""} (Newline)
            </button>

            <div className="my-1 border-t border-[var(--border-subtle)]" />

            <button
              onClick={() => {
                copySelectionFormatted("tsv", allRowIndices, colIndices);
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
            >
              Copy Selected (TSV)
            </button>
            <button
              onClick={() => {
                copySelectionFormatted("tsv_headers", allRowIndices, colIndices);
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
            >
              Copy Selected with Headers
            </button>
            <button
              onClick={() => {
                copySelectionFormatted("csv", allRowIndices, colIndices);
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
            >
              Copy Selected as CSV
            </button>
            <button
              onClick={() => {
                copySelectionFormatted("json", allRowIndices, colIndices);
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
            >
              Copy Selected as JSON
            </button>
            <button
              onClick={() => {
                copySelectionFormatted("insert_sql", allRowIndices, colIndices);
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
            >
              Copy Selected as INSERT SQL
            </button>

            <div className="my-1 border-t border-[var(--border-subtle)]" />

            <button
              disabled={isReadOnly || rows.length === 0}
              onClick={() => {
                batchSetSelectedValue(allRowIndices, colIndices, null);
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-40"
            >
              Set Selected Cells to <span className="font-mono text-zinc-400">NULL</span>
            </button>
            <button
              disabled={isReadOnly || rows.length === 0}
              onClick={() => {
                batchSetSelectedValue(allRowIndices, colIndices, "");
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-40"
            >
              Set Selected Cells to Empty String <span className="font-mono text-zinc-400">("")</span>
            </button>

            <div className="my-1 border-t border-[var(--border-subtle)]" />

            <button
              onClick={() => {
                setColumnSort(targetVCol.col.name, "ASC");
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2"
            >
              <ArrowUp className="w-3.5 h-3.5 text-zinc-400" /> Sort Ascending
            </button>
            <button
              onClick={() => {
                setColumnSort(targetVCol.col.name, "DESC");
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2"
            >
              <ArrowDown className="w-3.5 h-3.5 text-zinc-400" /> Sort Descending
            </button>
            <button
              onClick={() => {
                setColumnSort(targetVCol.col.name, null);
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
            >
              Clear Sort
            </button>
            <button
              onClick={() => {
                setDraftFilters((prev) => [
                  ...prev,
                  { column: targetVCol.col.name, operator: "=", value: "" },
                ]);
                setShowFilters(true);
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2"
            >
              <Filter className="w-3.5 h-3.5 text-zinc-400" /> Filter by Column
            </button>

            <div className="my-1 border-t border-[var(--border-subtle)]" />

            <button
              disabled={visibleCols.length - selectedColNames.length < 1}
              onClick={() => {
                setHiddenColumns((prev) => {
                  const next = new Set(prev);
                  selectedColNames.forEach((n) => next.add(n));
                  return next;
                });
                setSelectedCols(new Set());
                setHeaderMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-40 flex items-center gap-2"
            >
              <EyeOff className="w-3.5 h-3.5 text-zinc-400" />
              Hide Selected Column{plural ? "s" : ""}
            </button>
            {hiddenColumns.size > 0 && (
              <button
                onClick={() => {
                  setHiddenColumns(new Set());
                  setHeaderMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] text-indigo-400 flex items-center gap-2"
              >
                <Eye className="w-3.5 h-3.5" /> Show All Columns ({hiddenColumns.size})
              </button>
            )}
          </ContextMenu>
        );
      })()}

      {/* Cell & Row Right-Click Context Menu */}
      {cellMenu && (() => {
        const vCol = visibleCols[cellMenu.vColIdx];
        if (!vCol) return null;
        const { col, origIdx } = vCol;
        const isInsert = cellMenu.isInsert;
        const isDeleted = !isInsert && stagedDeletes.has(cellMenu.rowIdx);
        const hasPatch =
          !isInsert && Boolean(stagedUpdates[cellMenu.rowIdx] && col.name in stagedUpdates[cellMenu.rowIdx]);
        const cellVal = isInsert
          ? stagedInserts[cellMenu.rowIdx]?.[col.name] ?? null
          : getEffectiveValue(cellMenu.rowIdx, col, origIdx);
        const multiActive = !isInsert && hasMultiSelection;
        const sel = getEffectiveSelection();
        const allVisibleColIndices = visibleCols.map((_, i) => i);

        return (
          <ContextMenu
            x={cellMenu.x}
            y={cellMenu.y}
            onClose={() => setCellMenu(null)}
            className="w-60"
          >
            {/* Value Actions */}
            <button
              disabled={isReadOnly || isDeleted}
              onClick={() => {
                if (multiActive) {
                  batchSetSelectedValue(sel.rowIndices, sel.colIndices, null);
                } else {
                  setCellExplicitValue(cellMenu.rowIdx, col.name, null, isInsert);
                }
                setCellMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-40"
            >
              {multiActive ? "Set Selected Cells to " : "Set to "}
              <span className="font-mono text-zinc-400">NULL</span>
            </button>
            <button
              disabled={isReadOnly || isDeleted}
              onClick={() => {
                if (multiActive) {
                  batchSetSelectedValue(sel.rowIndices, sel.colIndices, "");
                } else {
                  setCellExplicitValue(cellMenu.rowIdx, col.name, "", isInsert);
                }
                setCellMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-40"
            >
              {multiActive ? "Set Selected Cells to " : "Set to Empty String "}
              <span className="font-mono text-zinc-400">("")</span>
            </button>
            <button
              disabled={isReadOnly || isDeleted}
              onClick={() => {
                startEditingCell({
                  isInsert,
                  row: cellMenu.rowIdx,
                  colIdx: cellMenu.vColIdx,
                });
                setCellMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-40 flex items-center gap-2"
            >
              <Edit3 className="w-3.5 h-3.5 text-zinc-400" /> Edit Cell
            </button>
            {hasPatch && (
              <button
                onClick={() => {
                  setStagedUpdates((prev) => {
                    const rowPatch = prev[cellMenu.rowIdx];
                    if (!rowPatch) return prev;
                    const nextRow = { ...rowPatch };
                    delete nextRow[col.name];
                    const next = { ...prev };
                    if (Object.keys(nextRow).length === 0) delete next[cellMenu.rowIdx];
                    else next[cellMenu.rowIdx] = nextRow;
                    return next;
                  });
                  setCellMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] text-amber-400 flex items-center gap-2"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Undo Cell Change
              </button>
            )}

            <div className="my-1 border-t border-[var(--border-subtle)]" />

            {/* Copy Actions */}
            <button
              onClick={() => {
                copyToClipboard(formatRawClipboardValue(cellVal), "cell value");
                setCellMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2"
            >
              <Copy className="w-3.5 h-3.5 text-zinc-400" /> Copy Cell Value
            </button>
            <button
              onClick={() => {
                copyToClipboard(col.name, "column name");
                setCellMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
            >
              Copy Column Name
            </button>
            {multiActive && (
              <>
                <button
                  onClick={() => {
                    copySelectionFormatted("tsv");
                    setCellMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                >
                  Copy Selected Cells (TSV)
                </button>
                <button
                  onClick={() => {
                    copySelectionFormatted("csv");
                    setCellMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                >
                  Copy Selected as CSV
                </button>
                <button
                  onClick={() => {
                    copySelectionFormatted("json");
                    setCellMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                >
                  Copy Selected as JSON
                </button>
                <button
                  onClick={() => {
                    copySelectionFormatted("insert_sql");
                    setCellMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                >
                  Copy Selected as INSERT SQL
                </button>
              </>
            )}
            {!isInsert && (
              <>
                <button
                  onClick={() => {
                    copySelectionFormatted("json", [cellMenu.rowIdx], allVisibleColIndices);
                    setCellMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                >
                  Copy Row as JSON
                </button>
                <button
                  onClick={() => {
                    copySelectionFormatted(
                      "insert_sql",
                      [cellMenu.rowIdx],
                      allVisibleColIndices
                    );
                    setCellMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                >
                  Copy Row as INSERT SQL
                </button>
                <button
                  onClick={() => {
                    copySelectionFormatted("tsv", [cellMenu.rowIdx], allVisibleColIndices);
                    setCellMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                >
                  Copy Row as TSV
                </button>
              </>
            )}

            {/* Quick Filter & FK Jump */}
            {!isInsert && (
              <>
                <div className="my-1 border-t border-[var(--border-subtle)]" />
                <button
                  onClick={() => {
                    applyQuickFilter(col.name, cellVal, false);
                    setCellMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2"
                >
                  <Filter className="w-3.5 h-3.5 text-zinc-400" /> Filter by This Value
                </button>
                <button
                  onClick={() => {
                    applyQuickFilter(col.name, cellVal, true);
                    setCellMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
                >
                  Exclude This Value
                </button>
                {col.fkTarget && cellVal != null && (
                  <button
                    onClick={() => {
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
                      setCellMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] text-indigo-400 flex items-center gap-2 truncate"
                  >
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">
                      Jump to {col.fkTarget.table}.{col.fkTarget.column} = {String(cellVal)}
                    </span>
                  </button>
                )}
              </>
            )}

            <div className="my-1 border-t border-[var(--border-subtle)]" />

            {/* Row Actions */}
            <button
              disabled={isReadOnly}
              onClick={() => {
                addBlankRow();
                setCellMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-40 flex items-center gap-2"
            >
              <Plus className="w-3.5 h-3.5 text-emerald-400" /> Add Row
            </button>
            <button
              disabled={isReadOnly}
              onClick={() => {
                duplicateRow(cellMenu.rowIdx, isInsert);
                setCellMenu(null);
              }}
              className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-40"
            >
              Duplicate Row
            </button>
            {isInsert ? (
              <button
                disabled={isReadOnly}
                onClick={() => {
                  setStagedInserts((prev) => prev.filter((_, idx) => idx !== cellMenu.rowIdx));
                  setCellMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-red-500/15 text-red-400 disabled:opacity-40 flex items-center gap-2"
              >
                <Trash2 className="w-3.5 h-3.5" /> Remove New Row
              </button>
            ) : (
              <button
                disabled={isReadOnly}
                onClick={() => {
                  setStagedDeletes((prev) => {
                    const next = new Set(prev);
                    if (next.has(cellMenu.rowIdx)) next.delete(cellMenu.rowIdx);
                    else next.add(cellMenu.rowIdx);
                    return next;
                  });
                  setCellMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-red-500/15 text-red-400 disabled:opacity-40 flex items-center gap-2"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {isDeleted ? "Undo Delete Row" : "Delete Row"}
              </button>
            )}
          </ContextMenu>
        );
      })()}

      {/* Classic Navicat Bottom Record Edit & Pagination Bar */}
      <div className="px-2.5 py-1.5 border-t border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex flex-wrap items-center justify-between gap-2 text-[0.78rem] text-zinc-500">
        {/* Left: Navicat + / - / ✓ / ✕ / ↻ Record Controls */}
        <div className="flex items-center gap-1">
          {!isReadOnly && (
            <>
              <button
                onClick={addBlankRow}
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
                title="Apply Staged Changes (Ctrl+S / Ctrl+Enter)"
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
          {selectedCols.size > 0 && (
            <span className="ml-2 px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400">
              {selectedCols.size} col{selectedCols.size > 1 ? "s" : ""} selected
            </span>
          )}
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

      {/* Preview SQL Modal */}
      {previewSqlModal && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setPreviewSqlModal(null)}
        >
          <div
            className="w-full max-w-xl rounded-md border border-[var(--border-strong)] bg-[var(--surface-panel)] shadow-2xl overflow-hidden"
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
            <pre className="p-4 text-[0.8rem] font-mono text-emerald-300 bg-[#1e1f22] max-h-80 overflow-auto whitespace-pre-wrap">
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
