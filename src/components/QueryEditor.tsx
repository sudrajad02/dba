import React, { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { format as formatSql } from "sql-formatter";
import {
  Activity,
  AlertTriangle,
  AlignLeft,
  Play,
  Save,
  Square,
  Table2,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  ExplainNode,
  ExplainPlanResult,
  QueryExecutionResponse,
} from "../types/datavault";

const ExplainTreeNode: React.FC<{ node: ExplainNode; depth?: number }> = ({
  node,
  depth = 0,
}) => (
  <div style={{ marginLeft: depth * 18 }} className="my-1.5">
    <div
      className={`p-2 rounded-lg border text-xs ${
        node.isFullScan
          ? "border-amber-500/50 bg-amber-500/10"
          : "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900"
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
    connectTo,
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

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const schemaCacheRef = useRef<Record<string, string[]>>({});
  const completionDisposableRef = useRef<{ dispose: () => void } | null>(null);

  const selectedConn = connections.find((c) => c.id === connId);
  const dbs = databasesByConn[connId] ?? [];

  // Load schema cache for Monaco autocomplete
  useEffect(() => {
    if (!connId || !connectedIds.has(connId)) return;
    api
      .getAutocompleteSchema(
        connId,
        database || selectedConn?.database || undefined,
        selectedConn?.engine === "postgres" ? "public" : database || undefined
      )
      .then((res) => {
        schemaCacheRef.current = res.tables;
      })
      .catch(() => {});
  }, [connId, database, connectedIds, selectedConn]);

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
    [connId, database, connectedIds, connectTo, selectedConn, openSafetyModal, addLog, refreshHistory]
  );

  const handleRun = useCallback(() => {
    const ed = editorRef.current;
    if (ed) {
      const sel = ed.getSelection();
      if (sel && !sel.isEmpty()) {
        const selectedText = ed.getModel()?.getValueInRange(sel) ?? "";
        if (selectedText.trim()) {
          runSqlText(selectedText);
          return;
        }
      }
    }
    runSqlText(sql);
  }, [sql, runSqlText]);

  const handleCancel = async () => {
    if (!connId || !activeQueryId) return;
    await api.cancelQuery(connId, activeQueryId).catch(() => {});
    addLog("warn", "Cancel signal sent to database server");
  };

  const handleExplain = async () => {
    const trimmed = sql.trim();
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

  const handleBeautify = () => {
    try {
      const formatted = formatSql(sql, {
        language:
          selectedConn?.engine === "mysql"
            ? "mysql"
            : selectedConn?.engine === "mssql"
            ? "tsql"
            : "postgresql",
        keywordCase: "upper",
      });
      setSql(formatted);
      updateTab(tab.id, { sql: formatted });
    } catch (err) {
      addLog("warn", `SQL format skipped: ${String(err)}`);
    }
  };

  const handleSaveQuery = async () => {
    const name = window.prompt("Save query as (filename without .sql):", tab.title.replace(/\.sql$/, ""));
    if (!name?.trim()) return;
    try {
      const saved = await api.saveQueryFile("", name.trim(), sql);
      updateTab(tab.id, { title: `${saved.name}.sql`, dirty: false });
      await refreshSavedQueries();
      addLog("success", `Saved query to ${saved.path}`);
    } catch (err) {
      addLog("error", formatApiError(err));
    }
  };

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      handleRun();
    });

    // Schema-Aware SQL Autocomplete Provider
    completionDisposableRef.current?.dispose();
    completionDisposableRef.current = monaco.languages.registerCompletionItemProvider("sql", {
      provideCompletionItems: (model: any, position: any) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const suggestions: any[] = [];
        for (const [table, cols] of Object.entries(schemaCacheRef.current)) {
          suggestions.push({
            label: table,
            kind: monaco.languages.CompletionItemKind.Struct,
            insertText: table,
            detail: "Table",
            range,
          });
          for (const col of cols) {
            suggestions.push({
              label: col,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: col,
              detail: `${table}.${col}`,
              range,
            });
          }
        }
        return { suggestions };
      },
    });
  };

  useEffect(() => {
    return () => {
      completionDisposableRef.current?.dispose();
    };
  }, []);

  const currentResult = response?.resultSets[activeResultTab];

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-950 text-xs">
      {/* Query Toolbar */}
      <div className="px-2.5 py-1.5 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/70 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {running ? (
            <button
              onClick={handleCancel}
              className="h-7 px-3 rounded bg-red-600 hover:bg-red-500 text-white font-medium flex items-center gap-1.5"
            >
              <Square className="w-3 h-3 fill-current" />
              Stop
            </button>
          ) : (
            <button
              onClick={handleRun}
              title="Run Query / Selection (Ctrl+Enter)"
              className="h-7 px-3 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              Run
            </button>
          )}

          <button
            onClick={handleExplain}
            disabled={running}
            title="Visual Explain Plan (EXPLAIN ANALYZE)"
            className="h-7 px-2.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-1.5"
          >
            <Activity className="w-3.5 h-3.5 text-amber-400" />
            Explain
          </button>

          <button
            onClick={handleBeautify}
            title="Beautify / Format SQL"
            className="h-7 px-2.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-1.5"
          >
            <AlignLeft className="w-3.5 h-3.5 text-neutral-600 dark:text-neutral-300" />
            Format
          </button>

          <button
            onClick={handleSaveQuery}
            title="Save Query to Workspace (.sql)"
            className="h-7 px-2.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-1.5"
          >
            <Save className="w-3.5 h-3.5" />
            Save
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
            className="h-7 px-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700"
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
            className="h-7 px-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700"
          >
            <option value="">Default DB</option>
            {dbs.map((db) => (
              <option key={db.name} value={db.name}>
                {db.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Monaco SQL Editor */}
      <div className="h-[46%] min-h-[160px] border-b border-zinc-200 dark:border-zinc-800">
        <Editor
          height="100%"
          defaultLanguage="sql"
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
            fontSize: Math.max(13, Math.round(uiFontSize * 0.85)),
            fontFamily: "JetBrains Mono, Fira Code, monospace",
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            wordWrap: "on",
          }}
        />
      </div>

      {/* Result / Explain Pane */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Sub-tabs */}
        <div className="px-2.5 h-8 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 flex items-center gap-1.5 overflow-x-auto">
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
                  : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
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
                  : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
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
                <pre className="p-3 rounded bg-zinc-900 font-mono text-[0.8rem] overflow-auto">
                  {JSON.stringify(explainPlan.rawJson, null, 2)}
                </pre>
              )}
            </div>
          ) : currentResult ? (
            currentResult.columns.length > 0 ? (
              <table className="w-max min-w-full border-collapse text-left">
                <thead className="sticky top-0 bg-zinc-100 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
                  <tr>
                    <th className="w-10 px-2 py-1 text-[0.72rem] text-zinc-500 border-r border-zinc-200 dark:border-zinc-800">
                      #
                    </th>
                    {currentResult.columns.map((c, idx) => (
                      <th
                        key={idx}
                        className="px-2.5 py-1 font-semibold border-r border-zinc-200 dark:border-zinc-800 whitespace-nowrap"
                      >
                        {c.name}{" "}
                        <span className="text-[0.72rem] font-normal text-zinc-500">
                          {c.dataType}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {currentResult.rows.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      className="border-b border-zinc-200/60 dark:border-zinc-800/60 hover:bg-zinc-100/70 dark:hover:bg-zinc-100 dark:bg-zinc-900"
                    >
                      <td className="px-2 py-1 text-[0.72rem] text-zinc-500 border-r border-zinc-200 dark:border-zinc-800 font-mono">
                        {rIdx + 1}
                      </td>
                      {row.map((cell, cIdx) => (
                        <td
                          key={cIdx}
                          onClick={() =>
                            setInspectedCell({
                              column: currentResult.columns[cIdx]?.name ?? "",
                              dataType: currentResult.columns[cIdx]?.dataType ?? "",
                              value: cell,
                            })
                          }
                          className="px-2.5 py-1 border-r border-zinc-200/60 dark:border-zinc-800/60 font-mono max-w-[320px] truncate cursor-pointer"
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
              Press <kbd className="mx-1 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300">Ctrl+Enter</kbd> to run query
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
