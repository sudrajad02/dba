import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { format as formatSql } from "sql-formatter";
import {
  Activity,
  AlertTriangle,
  AlignLeft,
  Play,
  RefreshCw,
  Save,
  SaveAll,
  Square,
  Table2,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { formatSavedQueryFilename } from "../lib/savedQueries";
import {
  containsSchemaChangingDdl,
  registerSqlAutocompleteProvider,
  removeSqlAutocompleteContext,
  setSqlAutocompleteContext,
} from "../lib/sqlAutocomplete";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import { SaveQueryModal } from "./SaveQueryModal";
import type {
  ExplainNode,
  ExplainPlanResult,
  QueryExecutionResponse,
} from "../types/dba";

const ExplainTreeNode: React.FC<{ node: ExplainNode; depth?: number }> = ({
  node,
  depth = 0,
}) => (
  <div style={{ marginLeft: depth * 18 }} className="my-1.5">
    <div
      className={`p-2 rounded-lg border text-xs ${
        node.isFullScan
          ? "border-amber-500/50 bg-amber-500/10"
          : "border-[var(--border-subtle)] bg-[var(--surface-panel)]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold">
          {node.isFullScan && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[0.72rem]">
              <AlertTriangle className="w-3 h-3" /> FULL SCAN
            </span>
          )}
          <span className="text-zinc-900 dark:text-zinc-100">{node.nodeType}</span>
          {node.relation && (
            <span className="font-mono text-cyan-500 dark:text-cyan-400">on {node.relation}</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[0.8rem] font-mono text-zinc-500">
          {node.totalCost != null && <span>cost: {node.totalCost.toFixed(2)}</span>}
          {node.actualTimeMs != null && (
            <span className="text-indigo-500 dark:text-indigo-400">{node.actualTimeMs.toFixed(2)}ms</span>
          )}
          {node.actualRows != null && <span>rows: {node.actualRows}</span>}
        </div>
      </div>
      {node.extra && (
        <div className="mt-1 text-[0.8rem] font-mono text-zinc-500">{node.extra}</div>
      )}
    </div>
    {node.children.map((child, idx) => (
      <ExplainTreeNode key={idx} node={child} depth={depth + 1} />
    ))}
  </div>
);

export const QueryEditor: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
  const {
    connections,
    connectedIds,
    databasesByConn,
    savedQueries,
    activeTabId,
    connectTo,
    loadDatabases,
    updateTab,
    openSafetyModal,
    setInspectedCell,
    addLog,
    refreshHistory,
    refreshSavedQueries,
    theme,
    uiFontSize,
  } = useWorkbenchStore();

  const [connId, setConnId] = useState(tab.connectionId ?? "");
  const [database, setDatabase] = useState(tab.database ?? "");
  const [sql, setSql] = useState(tab.sql ?? "");
  const [running, setRunning] = useState(false);
  const [activeQueryId, setActiveQueryId] = useState<string | null>(null);
  const [response, setResponse] = useState<QueryExecutionResponse | null>(null);
  const [activeResultTab, setActiveResultTab] = useState(0);
  const [explainPlan, setExplainPlan] = useState<ExplainPlanResult | null>(null);
  const [resultView, setResultView] = useState<"results" | "explain">("results");
  const [error, setError] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [saveModalMode, setSaveModalMode] = useState<"save" | "save_as" | null>(null);
  const [schemaRefreshing, setSchemaRefreshing] = useState(false);
  const [schemaTableCount, setSchemaTableCount] = useState(0);
  const [editorHeightPct, setEditorHeightPct] = useState<number>(() => {
    const saved = Number(localStorage.getItem("dv_query_editor_split_pct"));
    return Number.isFinite(saved) && saved >= 20 && saved <= 80 ? saved : 46;
  });
  const [colWidths, setColWidths] = useState<Record<number, number>>({});

  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const modelUriRef = useRef<string | null>(null);
  const schemaCacheRef = useRef<Record<string, string[]>>({});
  const selectionDisposablesRef = useRef<{ dispose: () => void }[]>([]);

  const selectedConn = connections.find((c) => c.id === connId);
  const dbs = databasesByConn[connId] ?? [];
  const effectiveDb = database || selectedConn?.database || "";
  const effectiveSchema =
    selectedConn?.engine === "postgres"
      ? tab.schema || "public"
      : selectedConn?.engine === "mssql"
      ? tab.schema || "dbo"
      : effectiveDb || undefined;

  // Ensure databases are loaded when a connected connection is selected
  useEffect(() => {
    if (connId && connectedIds.has(connId) && !databasesByConn[connId]) {
      loadDatabases(connId);
    }
  }, [connId, connectedIds, databasesByConn, loadDatabases]);

  // Existing query names in the target connection/database folder (for overwrite warning)
  const existingNamesInTarget = useMemo(() => {
    return savedQueries
      .filter(
        (sq) =>
          (sq.connectionId ?? "") === (connId || "") &&
          (sq.database ?? "") === (effectiveDb || "")
      )
      .map((sq) => sq.name);
  }, [savedQueries, connId, effectiveDb]);

  // Keep singleton autocomplete registry synced with current tab dialect & schema
  const syncAutocompleteContext = useCallback(
    (tables: Record<string, string[]>) => {
      if (!modelUriRef.current) return;
      setSqlAutocompleteContext(modelUriRef.current, {
        engine: selectedConn?.engine,
        database: effectiveDb || undefined,
        schema: effectiveSchema,
        tables,
      });
    },
    [selectedConn?.engine, effectiveDb, effectiveSchema]
  );

  // Refresh schema cache (tables + views + columns) for Monaco autocomplete
  const refreshAutocompleteSchema = useCallback(
    async (showToast = false) => {
      if (!connId || !connectedIds.has(connId)) {
        schemaCacheRef.current = {};
        setSchemaTableCount(0);
        syncAutocompleteContext({});
        return;
      }
      setSchemaRefreshing(true);
      try {
        const res = await api.getAutocompleteSchema(
          connId,
          effectiveDb || undefined,
          effectiveSchema
        );
        schemaCacheRef.current = res.tables;
        const count = Object.keys(res.tables).length;
        setSchemaTableCount(count);
        syncAutocompleteContext(res.tables);
        if (showToast) {
          addLog(
            "info",
            `Autocomplete schema refreshed (${count} tables/views)`,
            undefined,
            true
          );
        }
      } catch (err) {
        if (showToast) {
          addLog(
            "warn",
            `Failed to refresh autocomplete schema: ${formatApiError(err)}`,
            undefined,
            true
          );
        }
      } finally {
        setSchemaRefreshing(false);
      }
    },
    [connId, connectedIds, effectiveDb, effectiveSchema, syncAutocompleteContext, addLog]
  );

  // Auto-sync dialect immediately and load schema cache on connection/database change
  useEffect(() => {
    syncAutocompleteContext(schemaCacheRef.current);
    refreshAutocompleteSchema(false);
  }, [syncAutocompleteContext, refreshAutocompleteSchema]);

  const runSqlText = useCallback(
    async (sqlToRun: string, confirmedSafety = false) => {
      const trimmed = sqlToRun.trim();
      if (!trimmed) return;
      if (!connId) {
        setError("Please select a database connection first.");
        return;
      }
      if (!connectedIds.has(connId)) {
        const ok = await connectTo(connId);
        if (!ok) return;
      }

      setError(null);
      if (!confirmedSafety) {
        try {
          const safety = await api.checkSqlSafety(connId, trimmed);
          if (!safety.allowed) {
            setError(safety.warnings.join(" "));
            addLog("warn", safety.warnings.join(" "), trimmed);
            return;
          }
          if (safety.requiresConfirmation) {
            openSafetyModal({
              title: "Confirm SQL Execution",
              warnings: safety.warnings,
              sqlPreview: trimmed,
              onConfirm: () => runSqlText(trimmed, true),
            });
            return;
          }
        } catch (err) {
          setError(formatApiError(err));
          return;
        }
      }

      const qid =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}`;
      setRunning(true);
      setActiveQueryId(qid);
      setResultView("results");

      try {
        const res = await api.executeQuery(
          connId,
          trimmed,
          database || selectedConn?.database || undefined,
          qid,
          confirmedSafety
        );
        setResponse(res);
        setActiveResultTab(0);
        addLog(
          "success",
          `Executed ${res.resultSets.length} statement(s) in ${res.totalExecutionMs}ms`,
          trimmed
        );
        refreshHistory();
        if (containsSchemaChangingDdl(trimmed)) {
          refreshAutocompleteSchema(false);
        }
      } catch (err) {
        const msg = formatApiError(err);
        setError(msg);
        addLog("error", msg, trimmed);
        refreshHistory();
      } finally {
        setRunning(false);
        setActiveQueryId(null);
      }
    },
    [
      connId,
      database,
      connectedIds,
      connectTo,
      selectedConn,
      openSafetyModal,
      addLog,
      refreshHistory,
      refreshAutocompleteSchema,
    ]
  );

  const getSelectedSql = useCallback((): string => {
    const ed = editorRef.current;
    if (!ed) return "";
    const sel = ed.getSelection();
    if (!sel || sel.isEmpty()) return "";
    return ed.getModel()?.getValueInRange(sel) ?? "";
  }, []);

  const handleRun = useCallback(() => {
    const selectedText = getSelectedSql();
    if (selectedText.trim()) {
      runSqlText(selectedText);
      return;
    }
    const currentSql = editorRef.current?.getValue() ?? sql;
    runSqlText(currentSql);
  }, [sql, getSelectedSql, runSqlText]);

  const handleRunSelected = useCallback(() => {
    const selectedText = getSelectedSql();
    if (selectedText.trim()) {
      runSqlText(selectedText);
      return;
    }
    addLog("info", "Select SQL text first to run selected query.", undefined, true);
  }, [getSelectedSql, runSqlText, addLog]);

  const handleCancel = useCallback(async () => {
    if (!connId || !activeQueryId) return;
    await api.cancelQuery(connId, activeQueryId).catch(() => {});
    addLog("warn", "Cancel signal sent to database server");
  }, [connId, activeQueryId, addLog]);

  const handleExplain = async () => {
    const trimmed = (getSelectedSql().trim() || sql.trim());
    if (!trimmed || !connId) return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.explainQuery(
        connId,
        trimmed,
        database || selectedConn?.database || undefined
      );
      setExplainPlan(res);
      setResultView("explain");
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setRunning(false);
    }
  };

  const handleBeautify = useCallback(() => {
    try {
      const currentSql = editorRef.current?.getValue() ?? sql;
      const formatted = formatSql(currentSql, {
        language:
          selectedConn?.engine === "mysql"
            ? "mysql"
            : selectedConn?.engine === "mssql"
            ? "tsql"
            : "postgresql",
        keywordCase: "upper",
      });
      setSql(formatted);
      updateTab(tab.id, { sql: formatted, dirty: true });
    } catch (err) {
      addLog("warn", `SQL format skipped: ${String(err)}`);
    }
  }, [sql, selectedConn?.engine, tab.id, updateTab, addLog]);

  const handleSaveQuery = useCallback(async () => {
    const currentSql = editorRef.current?.getValue() ?? sql;
    if (tab.savedQueryPath) {
      try {
        const saved = await api.saveQueryFile("", tab.title, currentSql, {
          connectionId: connId || null,
          database: effectiveDb || null,
          schema: tab.schema || null,
          engine: selectedConn?.engine ?? null,
          overwritePath: tab.savedQueryPath,
        });
        const filename = formatSavedQueryFilename(saved);
        updateTab(tab.id, {
          title: filename,
          sql: currentSql,
          savedQueryPath: saved.path,
          dirty: false,
        });
        await refreshSavedQueries();
        addLog("success", `Saved ${filename}`, undefined, true);
      } catch (err) {
        addLog("error", formatApiError(err));
      }
      return;
    }
    setSaveModalMode("save");
  }, [
    sql,
    tab.savedQueryPath,
    tab.title,
    tab.schema,
    tab.id,
    connId,
    effectiveDb,
    selectedConn?.engine,
    updateTab,
    refreshSavedQueries,
    addLog,
  ]);

  const handleSaveAs = useCallback(() => {
    setSaveModalMode("save_as");
  }, []);

  const handleModalSaveSubmit = useCallback(
    async (cleanName: string) => {
      const currentSql = editorRef.current?.getValue() ?? sql;
      const saved = await api.saveQueryFile("", cleanName, currentSql, {
        connectionId: connId || null,
        database: effectiveDb || null,
        schema: tab.schema || null,
        engine: selectedConn?.engine ?? null,
      });
      const filename = formatSavedQueryFilename(saved);
      updateTab(tab.id, {
        title: filename,
        sql: currentSql,
        connectionId: connId || undefined,
        database: effectiveDb || undefined,
        savedQueryPath: saved.path,
        dirty: false,
      });
      await refreshSavedQueries();
      addLog("success", `Saved ${filename}`, undefined, true);
    },
    [sql, connId, effectiveDb, tab.schema, tab.id, selectedConn?.engine, updateTab, refreshSavedQueries, addLog]
  );

  // Keep latest action callbacks in a ref so Monaco commands never hit stale closures
  const actionsRef = useRef({
    handleRun,
    handleRunSelected,
    handleSaveQuery,
    handleBeautify,
    handleCancel,
    running,
  });
  actionsRef.current = {
    handleRun,
    handleRunSelected,
    handleSaveQuery,
    handleBeautify,
    handleCancel,
    running,
  };

  // Tab-scoped window shortcuts (works even when focus is outside Monaco editor)
  useEffect(() => {
    if (activeTabId !== tab.id) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (saveModalMode) return;
      const target = e.target as HTMLElement | null;
      const inMonaco = Boolean(target?.closest(".monaco-editor"));
      if (inMonaco) return; // handled directly by Monaco commands below

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        actionsRef.current.handleRunSelected();
        return;
      }
      if (mod && !e.shiftKey && (e.key.toLowerCase() === "r" || e.key === "Enter")) {
        e.preventDefault();
        actionsRef.current.handleRun();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        actionsRef.current.handleSaveQuery();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        actionsRef.current.handleBeautify();
        return;
      }
      if (
        actionsRef.current.running &&
        (e.key === "Escape" || (mod && e.key === "."))
      ) {
        e.preventDefault();
        actionsRef.current.handleCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabId, tab.id, saveModalMode]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    const updateSelectionState = () => {
      const sel = editor.getSelection();
      const nonEmpty = Boolean(
        sel &&
          !sel.isEmpty() &&
          (editor.getModel()?.getValueInRange(sel) ?? "").trim().length > 0
      );
      setHasSelection(nonEmpty);
    };

    selectionDisposablesRef.current.forEach((d) => d.dispose());
    selectionDisposablesRef.current = [
      editor.onDidChangeCursorSelection(updateSelectionState),
      editor.onDidChangeModelContent(updateSelectionState),
    ];

    // Navicat & IDE Shortcuts via fresh actionsRef (no stale closures)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      actionsRef.current.handleRun();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyR, () => {
      actionsRef.current.handleRun();
    });
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyR,
      () => {
        actionsRef.current.handleRunSelected();
      }
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      actionsRef.current.handleSaveQuery();
    });
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
      () => {
        actionsRef.current.handleBeautify();
      }
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Period, () => {
      if (actionsRef.current.running) actionsRef.current.handleCancel();
    });
    editor.onKeyDown((e) => {
      if (e.keyCode === monaco.KeyCode.Escape && actionsRef.current.running) {
        actionsRef.current.handleCancel();
      }
    });

    // Register singleton dialect-aware & schema-aware SQL autocomplete provider
    registerSqlAutocompleteProvider(monaco);
    const modelUri = editor.getModel()?.uri.toString() ?? null;
    modelUriRef.current = modelUri;
    if (modelUri) {
      setSqlAutocompleteContext(modelUri, {
        engine: selectedConn?.engine,
        database: effectiveDb || undefined,
        schema: effectiveSchema,
        tables: schemaCacheRef.current,
      });
    }
  };

  useEffect(() => {
    return () => {
      if (modelUriRef.current) {
        removeSqlAutocompleteContext(modelUriRef.current);
        modelUriRef.current = null;
      }
      selectionDisposablesRef.current.forEach((d) => d.dispose());
    };
  }, []);

  // Keep-Alive Monaco Layout Sync when tab becomes active
  useEffect(() => {
    if (activeTabId === tab.id) {
      const raf = window.requestAnimationFrame(() => {
        editorRef.current?.layout();
      });
      return () => window.cancelAnimationFrame(raf);
    }
  }, [activeTabId, tab.id]);

  // Listen for Classic Menu Bar actions (File -> Save/Save As, Edit -> Format SQL)
  // and RightInspector Snippets "Insert at Cursor"
  useEffect(() => {
    if (activeTabId !== tab.id) return;
    const onMenuAction = (e: Event) => {
      const action = (e as CustomEvent<{ action?: string }>).detail?.action;
      if (action === "save") actionsRef.current.handleSaveQuery();
      else if (action === "save_as") handleSaveAs();
      else if (action === "format_sql") actionsRef.current.handleBeautify();
    };
    const onInsertSnippet = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (!text) return;
      const editor = editorRef.current;
      if (!editor) return;
      const selection = editor.getSelection();
      if (selection) {
        editor.executeEdits("snippet-insert", [
          { range: selection, text, forceMoveMarkers: true },
        ]);
      } else {
        const model = editor.getModel();
        if (model) {
          const lastLine = model.getLineCount();
          const lastCol = model.getLineMaxColumn(lastLine);
          editor.executeEdits("snippet-insert", [
            {
              range: {
                startLineNumber: lastLine,
                startColumn: lastCol,
                endLineNumber: lastLine,
                endColumn: lastCol,
              },
              text: `\n${text}`,
              forceMoveMarkers: true,
            },
          ]);
        }
      }
      editor.focus();
    };
    window.addEventListener("dba:menu-action", onMenuAction);
    window.addEventListener("dba:insert-snippet", onInsertSnippet);
    return () => {
      window.removeEventListener("dba:menu-action", onMenuAction);
      window.removeEventListener("dba:insert-snippet", onInsertSnippet);
    };
  }, [activeTabId, tab.id, handleSaveAs]);

  const startEditorSplitResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const pct = Math.max(20, Math.min(80, ((ev.clientY - rect.top) / rect.height) * 100));
      const rounded = Math.round(pct * 10) / 10;
      setEditorHeightPct(rounded);
      localStorage.setItem("dv_query_editor_split_pct", String(rounded));
      window.requestAnimationFrame(() => editorRef.current?.layout());
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

  const startResultColResize = (e: React.PointerEvent<HTMLDivElement>, colIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement;
    const startX = e.clientX;
    const startW = colWidths[colIdx] ?? th?.getBoundingClientRect().width ?? 140;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const nextW = Math.max(60, Math.min(720, Math.round(startW + (ev.clientX - startX))));
      setColWidths((prev) => ({ ...prev, [colIdx]: nextW }));
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

  const autoFitResultCol = (colIdx: number) => {
    if (!currentResult) return;
    const col = currentResult.columns[colIdx];
    let maxLen = (col?.name.length ?? 4) + (col?.dataType.length ?? 0) + 2;
    const sampleRows = currentResult.rows.slice(0, 100);
    for (const row of sampleRows) {
      const val = row[colIdx];
      const str = val === null || val === undefined ? "NULL" : typeof val === "object" ? JSON.stringify(val) : String(val);
      if (str.length > maxLen) maxLen = str.length;
    }
    const fitted = Math.max(72, Math.min(480, maxLen * 7.5 + 28));
    setColWidths((prev) => ({ ...prev, [colIdx]: Math.round(fitted) }));
  };

  const currentResult = response?.resultSets[activeResultTab];

  return (
    <div className="h-full flex flex-col bg-[var(--surface-canvas)] text-xs">
      {/* Query Toolbar */}
      <div className="px-2.5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] flex flex-wrap items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-1.5">
          {running ? (
            <button
              onClick={handleCancel}
              title="Stop Query (Esc / Ctrl+.)"
              className="h-7 px-3 rounded bg-red-600 hover:bg-red-500 text-white font-medium flex items-center gap-1.5"
            >
              <Square className="w-3 h-3 fill-current" />
              Stop
            </button>
          ) : (
            <button
              onClick={handleRun}
              title={
                hasSelection
                  ? "Run Selected Query (Ctrl+R / Ctrl+Shift+R)"
                  : "Run Query (Ctrl+R / Ctrl+Enter)"
              }
              className={`h-7 px-3 rounded text-white font-medium flex items-center gap-1.5 transition-colors ${
                hasSelection
                  ? "bg-teal-600 hover:bg-teal-500"
                  : "bg-emerald-600 hover:bg-emerald-500"
              }`}
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              {hasSelection ? "Run Selected Query" : "Run Query"}
            </button>
          )}

          <button
            onClick={handleExplain}
            disabled={running}
            title="Visual Explain Plan (EXPLAIN ANALYZE)"
            className="h-7 px-2.5 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1.5"
          >
            <Activity className="w-3.5 h-3.5 text-amber-400" />
            Explain
          </button>

          <button
            onClick={handleBeautify}
            title="Beautify / Format SQL (Ctrl+Shift+F)"
            className="h-7 px-2.5 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1.5"
          >
            <AlignLeft className="w-3.5 h-3.5 text-neutral-600 dark:text-neutral-300" />
            Format
          </button>

          <button
            onClick={handleSaveQuery}
            title={
              tab.savedQueryPath
                ? "Save Query (Ctrl+S)"
                : "Save Query to Workspace (Ctrl+S)"
            }
            className="h-7 px-2.5 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1.5"
          >
            <Save className="w-3.5 h-3.5" />
            Save
          </button>

          <button
            onClick={handleSaveAs}
            title="Save a Copy As..."
            className="h-7 px-2.5 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1.5"
          >
            <SaveAll className="w-3.5 h-3.5" />
            Save As
          </button>
        </div>

        {/* Connection & Database Selector */}
        <div className="flex items-center gap-1.5">
          <select
            value={connId}
            onChange={(e) => {
              setConnId(e.target.value);
              updateTab(tab.id, { connectionId: e.target.value });
            }}
            className="h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)]"
          >
            <option value="">Connection...</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.engine.toUpperCase()})
              </option>
            ))}
          </select>

          <select
            value={database}
            onChange={(e) => {
              setDatabase(e.target.value);
              updateTab(tab.id, { database: e.target.value });
            }}
            className="h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)]"
          >
            <option value="">Default DB</option>
            {dbs.map((db) => (
              <option key={db.name} value={db.name}>
                {db.name}
              </option>
            ))}
          </select>

          <button
            onClick={() => refreshAutocompleteSchema(true)}
            disabled={!connId || !connectedIds.has(connId) || schemaRefreshing}
            title={`Refresh Autocomplete Schema (${schemaTableCount} tables/views)`}
            className="h-7 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] disabled:opacity-40 flex items-center gap-1 text-zinc-600 dark:text-zinc-300"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${schemaRefreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Split Container: Monaco SQL Editor + Result / Explain Pane */}
      <div ref={splitContainerRef} className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Monaco SQL Editor */}
      <div
        style={{ height: `${editorHeightPct}%` }}
        className="min-h-[120px] shrink-0"
      >
        <Editor
          height="100%"
          defaultLanguage="sql"
          path={`dba-query-${tab.id}.sql`}
          theme={theme === "light" ? "light" : "vs-dark"}
          value={sql}
          onChange={(val) => {
            const next = val ?? "";
            setSql(next);
            updateTab(tab.id, { sql: next, dirty: true });
          }}
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: Math.max(12, Math.round(uiFontSize * 0.92)),
            fontFamily: "JetBrains Mono, Fira Code, monospace",
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: "on",
            quickSuggestions: { other: true, comments: false, strings: false },
            suggestOnTriggerCharacters: true,
            wordBasedSuggestions: "off",
          }}
        />
      </div>

      {/* Vertical Resize Splitter */}
      <div
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={startEditorSplitResize}
        className="h-1 shrink-0 cursor-row-resize bg-[var(--border-subtle)] hover:bg-indigo-500/70 active:bg-indigo-500 transition-colors"
      />

      {/* Result / Explain Pane */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Sub-tabs */}
        <div className="px-2.5 h-8 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] flex items-center gap-1.5 overflow-x-auto">
          {response?.resultSets.map((rs, idx) => (
            <button
              key={idx}
              onClick={() => {
                setResultView("results");
                setActiveResultTab(idx);
              }}
              className={`h-6 px-2.5 rounded text-[0.8rem] flex items-center gap-1.5 shrink-0 ${
                resultView === "results" && activeResultTab === idx
                  ? "bg-indigo-600 text-white font-medium"
                  : "text-zinc-500 hover:bg-[var(--surface-hover)]"
              }`}
            >
              <Table2 className="w-3 h-3" />
              Result {idx + 1} (
              {rs.rowsAffected != null ? `${rs.rowsAffected} affected` : `${rs.rows.length} rows`}
              )
            </button>
          ))}
          {explainPlan && (
            <button
              onClick={() => setResultView("explain")}
              className={`h-6 px-2.5 rounded text-[0.8rem] flex items-center gap-1.5 shrink-0 ${
                resultView === "explain"
                  ? "bg-amber-600 text-white font-medium"
                  : "text-zinc-500 hover:bg-[var(--surface-hover)]"
              }`}
            >
              <Activity className="w-3 h-3" />
              Explain Plan ({explainPlan.executionMs}ms)
            </button>
          )}
          {response && (
            <span className="ml-auto text-[0.8rem] text-zinc-500 font-mono">
              Total: {response.totalExecutionMs}ms
            </span>
          )}
        </div>

        {error && (
          <div className="p-3 bg-red-500/10 border-b border-red-500/30 text-red-400 font-mono text-xs whitespace-pre-wrap">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {resultView === "explain" && explainPlan ? (
            <div className="p-3">
              {explainPlan.root ? (
                <ExplainTreeNode node={explainPlan.root} />
              ) : (
                <pre className="p-3 rounded bg-[var(--surface-panel)] font-mono text-[0.8rem] overflow-auto">
                  {JSON.stringify(explainPlan.rawJson, null, 2)}
                </pre>
              )}
            </div>
          ) : currentResult ? (
            currentResult.columns.length > 0 ? (
              <table className="w-max min-w-full border-collapse text-left">
                <thead className="sticky top-0 bg-[var(--surface-panel)] border-b border-[var(--border-subtle)]">
                  <tr>
                    <th className="w-10 px-2 py-1 text-[0.72rem] text-zinc-500 border-r border-[var(--border-subtle)]">
                      #
                    </th>
                    {currentResult.columns.map((c, idx) => (
                      <th
                        key={idx}
                        style={
                          colWidths[idx]
                            ? { width: colWidths[idx], minWidth: colWidths[idx], maxWidth: colWidths[idx] }
                            : undefined
                        }
                        className="relative px-2.5 py-1 font-semibold border-r border-[var(--border-subtle)] whitespace-nowrap"
                      >
                        <div className="truncate pr-1.5">
                          {c.name}{" "}
                          <span className="text-[0.72rem] font-normal text-zinc-500">
                            {c.dataType}
                          </span>
                        </div>
                        <div
                          onPointerDown={(e) => startResultColResize(e, idx)}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            autoFitResultCol(idx);
                          }}
                          title="Drag to resize • Double-click to auto-fit"
                          className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-indigo-500/60"
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {currentResult.rows.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      className="h-[26px] border-b border-[var(--border-subtle)]/60 hover:bg-[var(--surface-hover)]"
                    >
                      <td className="px-2 py-0.5 text-[0.72rem] text-zinc-500 border-r border-[var(--border-subtle)] font-mono">
                        {rIdx + 1}
                      </td>
                      {row.map((cell, cIdx) => (
                        <td
                          key={cIdx}
                          style={
                            colWidths[cIdx]
                              ? { width: colWidths[cIdx], minWidth: colWidths[cIdx], maxWidth: colWidths[cIdx] }
                              : undefined
                          }
                          onClick={() =>
                            setInspectedCell({
                              column: currentResult.columns[cIdx]?.name ?? "",
                              dataType: currentResult.columns[cIdx]?.dataType ?? "",
                              value: cell,
                            })
                          }
                          className={`px-2.5 py-0.5 border-r border-[var(--border-subtle)]/60 font-mono truncate cursor-pointer ${
                            colWidths[cIdx] ? "" : "max-w-[320px]"
                          }`}
                        >
                          {cell === null || cell === undefined ? (
                            <span className="text-zinc-500 italic">NULL</span>
                          ) : typeof cell === "object" ? (
                            JSON.stringify(cell)
                          ) : (
                            String(cell)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="p-4 text-emerald-400 font-mono">
                Statement executed successfully. Rows affected:{" "}
                {currentResult.rowsAffected ?? 0} ({currentResult.executionMs}ms)
              </div>
            )
          ) : (
            <div className="h-full flex items-center justify-center text-zinc-500">
              Press <kbd className="mx-1 px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">Ctrl+R</kbd> or <kbd className="mx-1 px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">Ctrl+Enter</kbd> to run query
            </div>
          )}
        </div>
      </div>
      </div>

      <SaveQueryModal
        open={saveModalMode !== null}
        mode={saveModalMode ?? "save"}
        initialName={
          saveModalMode === "save_as"
            ? `${tab.title.replace(/\.sql$/i, "")}_copy`
            : tab.savedQueryPath
            ? tab.title.replace(/\.sql$/i, "")
            : tab.title.startsWith("Query") || tab.title === "New Query"
            ? ""
            : tab.title.replace(/\.sql$/i, "")
        }
        extension=".sql"
        connectionName={selectedConn?.name ?? null}
        databaseName={effectiveDb || null}
        existingNames={existingNamesInTarget}
        allowOverwrite={true}
        onClose={() => setSaveModalMode(null)}
        onSubmit={handleModalSaveSubmit}
      />
    </div>
  );
};
