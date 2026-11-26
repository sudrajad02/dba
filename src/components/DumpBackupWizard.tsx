import React, { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  FileCode2,
  FolderOpen,
  HardDriveDownload,
  Loader2,
  Play,
  RefreshCw,
  Square,
  Terminal,
  XCircle,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  DataJobProgress,
  DataJobResult,
  ImportErrorPolicy,
  NativeCliRunResult,
  NativeCliToolInfo,
} from "../types/dba";

export const DumpBackupWizard: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
  const {
    connections,
    connectedIds,
    databasesByConn,
    schemasByConnDb,
    objectsByKey,
    connectTo,
    loadDatabases,
    loadSchemas,
    loadObjects,
    openSafetyModal,
    addLog,
  } = useWorkbenchStore();

  const [section, setSection] = useState<"dump" | "execute_sql" | "native_cli">(
    tab.wizardMode === "execute_sql"
      ? "execute_sql"
      : tab.wizardMode === "native_cli"
      ? "native_cli"
      : "dump"
  );

  const [connId, setConnId] = useState(tab.connectionId ?? connections[0]?.id ?? "");
  const [database, setDatabase] = useState(tab.database ?? "");
  const [schema, setSchema] = useState(tab.schema ?? "");

  // Built-in SQL Dump state
  const [selectedTables, setSelectedTables] = useState<Set<string>>(
    new Set(tab.table ? [tab.table] : [])
  );
  const [dumpPath, setDumpPath] = useState("");
  const [includeStructure, setIncludeStructure] = useState(true);
  const [includeData, setIncludeData] = useState(true);
  const [dropExisting, setDropExisting] = useState(false);
  const [chunkSize, setChunkSize] = useState(250);

  // Streaming Execute SQL File state
  const [sqlFilePath, setSqlFilePath] = useState("");
  const [errorPolicy, setErrorPolicy] = useState<ImportErrorPolicy>("stop_on_error");

  // Native CLI state
  const [cliTools, setCliTools] = useState<NativeCliToolInfo[]>([]);
  const [selectedTool, setSelectedTool] = useState("pg_dump");
  const [cliFilePath, setCliFilePath] = useState("");
  const [cliFormat, setCliFormat] = useState("custom");
  const [cliCompress, setCliCompress] = useState(true);
  const [cliJobs, setCliJobs] = useState(2);
  const [cliSchemaOnly, setCliSchemaOnly] = useState(false);
  const [cliDataOnly, setCliDataOnly] = useState(false);
  const [cliExtraArgs, setCliExtraArgs] = useState("");
  const [cliResult, setCliResult] = useState<NativeCliRunResult | null>(null);

  // Common job state
  const [running, setRunning] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<DataJobProgress | null>(null);
  const [jobResult, setJobResult] = useState<DataJobResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to backend streaming progress events for active job
  useEffect(() => {
    if (!activeJobId) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<DataJobProgress>("data-job-progress", (event) => {
      if (event.payload && event.payload.jobId === activeJobId) {
        setProgress(event.payload);
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [activeJobId]);

  const conn = connections.find((c) => c.id === connId);
  const dbs = databasesByConn[connId] ?? [];
  const effDb = database || conn?.database || dbs[0]?.name || "";
  const schemas = schemasByConnDb[`${connId}::${effDb}`] ?? [];
  const effSchema =
    schema ||
    (conn?.engine === "postgres"
      ? "public"
      : conn?.engine === "mssql"
      ? "dbo"
      : effDb);
  const objects = objectsByKey[`${connId}::${effDb}::${effSchema}`] ?? [];
  const tables = objects.filter((o) => o.kind === "table");

  const loadCliTools = useCallback(async () => {
    try {
      const tools = await api.detectNativeCliTools();
      setCliTools(tools);
      const firstAvail = tools.find((t) => t.available && (!conn || t.engine === conn.engine));
      if (firstAvail) setSelectedTool(firstAvail.name);
    } catch {
      // ignore
    }
  }, [conn]);

  useEffect(() => {
    loadCliTools();
  }, [loadCliTools]);

  const handleSelectConnection = async (cid: string) => {
    setConnId(cid);
    if (!cid) return;
    if (!connectedIds.has(cid)) await connectTo(cid);
    const dbList = await loadDatabases(cid);
    const c = connections.find((x) => x.id === cid);
    const d = c?.database || dbList[0]?.name;
    if (d) {
      setDatabase(d);
      if (c?.engine === "postgres" || c?.engine === "mssql") {
        const sc = await loadSchemas(cid, d);
        const pref = c.engine === "mssql" ? "dbo" : "public";
        const chosen = sc.find((s) => s.name === pref)?.name ?? sc[0]?.name ?? pref;
        setSchema(chosen);
        await loadObjects(cid, d, chosen);
      } else {
        setSchema(d);
        await loadObjects(cid, d, d);
      }
    }
  };

  const handleSelectDatabase = async (dbName: string) => {
    setDatabase(dbName);
    setSelectedTables(new Set());
    setError(null);
    if (!connId || !dbName) return;
    if (conn?.engine === "postgres" || conn?.engine === "mssql") {
      const sc = await loadSchemas(connId, dbName);
      const pref = conn.engine === "mssql" ? "dbo" : "public";
      const chosen = sc.find((s) => s.name === pref)?.name ?? sc[0]?.name ?? pref;
      setSchema(chosen);
      await loadObjects(connId, dbName, chosen);
    } else {
      setSchema(dbName);
      await loadObjects(connId, dbName, dbName);
    }
  };

  const handleRunDump = async () => {
    const tbls = Array.from(selectedTables);
    if (!connId) {
      setError("Please select a connection.");
      return;
    }
    if (tbls.length === 0) {
      setError("Please select at least one table to dump.");
      return;
    }
    let targetPath = dumpPath.trim();
    if (!targetPath) {
      try {
        const picked = await saveDialog({
          defaultPath: `${effDb || "backup"}_dump.sql`,
          filters: [{ name: "SQL", extensions: ["sql"] }],
        });
        if (typeof picked === "string" && picked.trim()) {
          targetPath = picked.trim();
          setDumpPath(targetPath);
        } else {
          setError("Please choose an output .sql file path (or click Browse).");
          return;
        }
      } catch (err) {
        setError(`Failed to open save dialog: ${formatApiError(err)}`);
        return;
      }
    }
    const jobId = `dump-${Date.now()}`;
    setActiveJobId(jobId);
    setProgress({
      jobId,
      percent: 0,
      currentItem: tbls[0] ?? "Initializing...",
      completedItems: 0,
      totalItems: tbls.length,
      rowsProcessed: 0,
      elapsedMs: 0,
    });
    setRunning(true);
    setError(null);
    setJobResult(null);
    try {
      const res = await api.dumpSql({
        jobId,
        connectionId: connId,
        database: effDb || null,
        schema: effSchema || null,
        tables: tbls,
        outputPath: targetPath,
        includeStructure,
        includeData,
        dropExisting,
        chunkSize,
      });
      setJobResult(res);
      addLog(res.ok ? "success" : "warn", res.summary);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setRunning(false);
      setActiveJobId(null);
      setProgress(null);
    }
  };

  const handleRunSqlFile = async (confirmedProduction = false) => {
    if (!connId || !sqlFilePath.trim()) {
      setError("Select a connection and .sql script file path.");
      return;
    }
    if (conn?.environment === "production" && !confirmedProduction) {
      openSafetyModal({
        title: `Execute SQL File on PRODUCTION (${conn.name})`,
        warnings: [`Target connection "${conn.name}" is marked PRODUCTION!`],
        sqlPreview: `-- Streaming execute file:\n${sqlFilePath}`,
        onConfirm: () => handleRunSqlFile(true),
      });
      return;
    }
    const jobId = `execsql-${Date.now()}`;
    setActiveJobId(jobId);
    setProgress({
      jobId,
      percent: 0,
      currentItem: "Starting SQL file execution...",
      completedItems: 0,
      totalItems: 0,
      rowsProcessed: 0,
      elapsedMs: 0,
    });
    setRunning(true);
    setError(null);
    setJobResult(null);
    try {
      const res = await api.executeSqlFile({
        jobId,
        connectionId: connId,
        database: effDb || null,
        filePath: sqlFilePath.trim(),
        errorPolicy,
        confirmedProduction,
      });
      setJobResult(res);
      addLog(res.ok ? "success" : "error", res.summary);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setRunning(false);
      setActiveJobId(null);
      setProgress(null);
    }
  };

  const handleRunNativeCli = async (confirmedProduction = false) => {
    if (!connId || !cliFilePath.trim()) {
      setError("Select connection and target/source file path.");
      return;
    }
    const isRestore = ["pg_restore", "psql", "mysql", "mongorestore"].includes(selectedTool);
    if (isRestore && conn?.environment === "production" && !confirmedProduction) {
      openSafetyModal({
        title: `Run ${selectedTool} on PRODUCTION (${conn.name})`,
        warnings: [`Target connection "${conn.name}" is PRODUCTION!`],
        sqlPreview: `${selectedTool} -> ${cliFilePath}`,
        onConfirm: () => handleRunNativeCli(true),
      });
      return;
    }

    setRunning(true);
    setError(null);
    setCliResult(null);
    try {
      const res = await api.runNativeCli({
        connectionId: connId,
        database: effDb || null,
        tool: selectedTool,
        filePath: cliFilePath.trim(),
        format: cliFormat,
        compress: cliCompress,
        parallelJobs: cliJobs,
        schemaOnly: cliSchemaOnly,
        dataOnly: cliDataOnly,
        extraArgs: cliExtraArgs
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
        confirmedProduction,
      });
      setCliResult(res);
      addLog(
        res.ok ? "success" : "error",
        `${selectedTool} exited with code ${res.exitCode} (${res.durationMs}ms)`
      );
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#1e1f22] text-xs">
      {/* Top Bar */}
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-[var(--border-strong)] overflow-hidden">
            <button
              onClick={() => setSection("dump")}
              className={`h-7 px-3 flex items-center gap-1.5 font-medium ${
                section === "dump"
                  ? "bg-blue-600 text-white"
                  : "hover:bg-[var(--surface-hover)]"
              }`}
            >
              <HardDriveDownload className="w-3.5 h-3.5" /> Built-in SQL Dump
            </button>
            <button
              onClick={() => setSection("execute_sql")}
              className={`h-7 px-3 flex items-center gap-1.5 font-medium ${
                section === "execute_sql"
                  ? "bg-emerald-600 text-white"
                  : "hover:bg-[var(--surface-hover)]"
              }`}
            >
              <FileCode2 className="w-3.5 h-3.5" /> Execute SQL File
            </button>
            <button
              onClick={() => setSection("native_cli")}
              className={`h-7 px-3 flex items-center gap-1.5 font-medium ${
                section === "native_cli"
                  ? "bg-indigo-600 text-white"
                  : "hover:bg-[var(--surface-hover)]"
              }`}
            >
              <Terminal className="w-3.5 h-3.5" /> Native CLI Tools
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={connId}
            onChange={(e) => handleSelectConnection(e.target.value)}
            className="h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-[var(--border-strong)]"
          >
            <option value="">Select Connection...</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.engine})
              </option>
            ))}
          </select>
          <select
            value={effDb}
            onChange={(e) => handleSelectDatabase(e.target.value)}
            className="h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
          >
            {dbs.length === 0 && <option value={effDb}>{effDb || "default"}</option>}
            {dbs.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
          {running && activeJobId && (
            <button
              onClick={() => api.cancelDataJob(activeJobId)}
              className="h-7 px-3 rounded bg-red-600 text-white flex items-center gap-1"
            >
              <Square className="w-3 h-3 fill-current" /> Cancel
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 font-mono">
          {error}
        </div>
      )}

      {running && (
        <div className="px-4 py-2.5 border-b border-[var(--border-subtle)] bg-blue-500/8 space-y-1.5 shrink-0">
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 min-w-0">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500 shrink-0" />
              <span className="font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                {section === "dump"
                  ? progress
                    ? `Dumping table ${Math.min(progress.completedItems + 1, progress.totalItems)}/${progress.totalItems}: ${progress.currentItem}`
                    : "Streaming SQL Dump..."
                  : section === "execute_sql"
                  ? progress?.currentItem || "Executing SQL file..."
                  : `Running ${selectedTool}...`}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0 font-mono text-[0.75rem]">
              {progress && (
                <>
                  <span className="text-zinc-500">
                    {section === "dump"
                      ? `${progress.rowsProcessed.toLocaleString()} rows`
                      : `${progress.rowsProcessed.toLocaleString()} stmts`}
                  </span>
                  <span className="text-zinc-500">
                    {(progress.elapsedMs / 1000).toFixed(1)}s
                  </span>
                  <span className="font-bold text-blue-500 dark:text-blue-400 w-12 text-right">
                    {progress.percent.toFixed(1)}%
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="w-full h-2 rounded-full bg-[var(--surface-elevated)] overflow-hidden">
            {progress ? (
              <div
                className="h-full bg-blue-600 dark:bg-blue-500 transition-all duration-150 ease-out rounded-full"
                style={{ width: `${Math.max(2, Math.min(100, progress.percent))}%` }}
              />
            ) : (
              <div className="h-full w-1/3 bg-indigo-500 animate-pulse rounded-full" />
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {section === "dump" && (
          <div className="max-w-4xl space-y-4">
            <div className="p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a] space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold">Select Tables to Dump ({selectedTables.size}/{tables.length})</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSelectedTables(new Set(tables.map((t) => t.name)))}
                    className="text-sky-400 hover:underline"
                  >
                    Select All
                  </button>
                  <button
                    onClick={() => setSelectedTables(new Set())}
                    className="text-zinc-500 hover:underline"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="max-h-48 overflow-auto grid grid-cols-2 sm:grid-cols-3 gap-1.5 p-2 rounded bg-white dark:bg-[#1e1f22] border border-[var(--border-subtle)]">
                {tables.length === 0 ? (
                  <div className="col-span-full py-4 text-center text-zinc-500">
                    Connect and select a database/schema to list tables.
                  </div>
                ) : (
                  tables.map((t) => (
                    <label
                      key={t.name}
                      className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-[var(--surface-hover)] cursor-pointer font-mono"
                    >
                      <input
                        type="checkbox"
                        checked={selectedTables.has(t.name)}
                        onChange={(e) =>
                          setSelectedTables((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(t.name);
                            else next.delete(t.name);
                            return next;
                          })
                        }
                      />
                      <span className="truncate">{t.name}</span>
                    </label>
                  ))
                )}
              </div>

              <div className="space-y-1">
                <label className="block text-[0.72rem] text-zinc-500">
                  Output <code>.sql</code> File Path
                </label>
                <div className="flex gap-1.5">
                  <input
                    value={dumpPath}
                    onChange={(e) => {
                      setDumpPath(e.target.value);
                      if (error) setError(null);
                    }}
                    placeholder={`Click Browse or type path, e.g. /tmp/${effDb || "backup"}_dump.sql`}
                    className="flex-1 h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const p = await saveDialog({
                          defaultPath: `${effDb || "backup"}_dump.sql`,
                          filters: [{ name: "SQL", extensions: ["sql"] }],
                        });
                        if (typeof p === "string" && p.trim()) {
                          setDumpPath(p);
                          setError(null);
                        }
                      } catch (err) {
                        setError(`Failed to open save dialog: ${formatApiError(err)}`);
                      }
                    }}
                    className="h-7 px-2.5 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1 cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5" /> Browse
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={includeStructure}
                    onChange={(e) => setIncludeStructure(e.target.checked)}
                  />
                  Include Structure (DDL)
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={includeData}
                    onChange={(e) => setIncludeData(e.target.checked)}
                  />
                  Include Data (Chunked INSERT)
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={dropExisting}
                    onChange={(e) => setDropExisting(e.target.checked)}
                  />
                  Add DROP TABLE IF EXISTS
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-zinc-500">Rows / INSERT:</span>
                  <input
                    type="number"
                    value={chunkSize}
                    onChange={(e) => setChunkSize(Number(e.target.value) || 250)}
                    className="w-20 h-6 px-1.5 rounded bg-white dark:bg-[#1e1f22] border border-[var(--border-strong)] font-mono"
                  />
                </label>
              </div>

              <button
                disabled={running}
                onClick={handleRunDump}
                className="h-8 px-4 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-medium flex items-center gap-1.5 cursor-pointer"
              >
                {running ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Dumping... {progress ? `(${progress.percent.toFixed(0)}%)` : ""}
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" /> Start Streaming SQL Dump
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {section === "execute_sql" && (
          <div className="max-w-3xl p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a] space-y-3">
            <div className="font-semibold">Streaming Execute SQL File (Low-RAM Reader)</div>
            <p className="text-zinc-500">
              Streams large <code>.sql</code> dump files statement-by-statement without loading the
              entire file into memory.
            </p>
            <div className="flex gap-1.5">
              <input
                value={sqlFilePath}
                onChange={(e) => setSqlFilePath(e.target.value)}
                placeholder="/path/to/dump.sql"
                className="flex-1 h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-[var(--border-strong)] font-mono"
              />
              <button
                onClick={async () => {
                  const p = await openDialog({
                    multiple: false,
                    filters: [{ name: "SQL", extensions: ["sql"] }],
                  });
                  if (typeof p === "string") setSqlFilePath(p);
                }}
                className="h-7 px-2.5 rounded border border-[var(--border-strong)] flex items-center gap-1"
              >
                <FolderOpen className="w-3.5 h-3.5" /> Browse
              </button>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5">
                <span className="text-zinc-500">Error Policy:</span>
                <select
                  value={errorPolicy}
                  onChange={(e) => setErrorPolicy(e.target.value as ImportErrorPolicy)}
                  className="h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-[var(--border-strong)]"
                >
                  <option value="stop_on_error">Stop on first error</option>
                  <option value="skip_and_log">Continue & log errors</option>
                </select>
              </label>
            </div>

            <button
              disabled={running}
              onClick={() => handleRunSqlFile(false)}
              className="h-8 px-4 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5 fill-current" /> Execute SQL File
            </button>
          </div>
        )}

        {section === "native_cli" && (
          <div className="max-w-5xl space-y-4">
            {/* Auto-detected binaries */}
            <div className="p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a] space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold">Auto-Detected Native CLI Binaries (PATH)</span>
                <button
                  onClick={loadCliTools}
                  className="h-6 px-2 rounded border border-[var(--border-strong)] flex items-center gap-1"
                >
                  <RefreshCw className="w-3 h-3" /> Re-scan
                </button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                {cliTools.map((t) => (
                  <button
                    key={t.name}
                    disabled={!t.available}
                    onClick={() => setSelectedTool(t.name)}
                    className={`p-2 rounded border text-left transition ${
                      selectedTool === t.name
                        ? "border-indigo-500 bg-indigo-500/15"
                        : t.available
                        ? "border-[var(--border-strong)] hover:border-sky-500"
                        : "border-[var(--border-subtle)] opacity-45 cursor-not-allowed"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-semibold">{t.name}</span>
                      <span
                        className={`w-2 h-2 rounded-full ${
                          t.available ? "bg-emerald-400" : "bg-zinc-600"
                        }`}
                      />
                    </div>
                    <div className="text-[0.68rem] text-zinc-500 uppercase mt-0.5">
                      {t.engine} • {t.role}
                    </div>
                    <div className="text-[0.66rem] text-zinc-400 truncate mt-0.5">
                      {t.available ? t.version || t.path : "Not installed"}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Native CLI Runner Form */}
            <div className="p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a] space-y-3">
              <div className="font-semibold">
                Run <span className="font-mono text-indigo-400">{selectedTool}</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="sm:col-span-2">
                  <label className="block text-zinc-500 mb-1">Archive / File / Directory Path</label>
                  <input
                    value={cliFilePath}
                    onChange={(e) => setCliFilePath(e.target.value)}
                    placeholder={`/tmp/${effDb || "db"}_backup.dump`}
                    className="w-full h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-[var(--border-strong)] font-mono"
                  />
                </div>
                <div>
                  <label className="block text-zinc-500 mb-1">Format</label>
                  <select
                    value={cliFormat}
                    onChange={(e) => setCliFormat(e.target.value)}
                    className="w-full h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-[var(--border-strong)]"
                  >
                    <option value="custom">Custom Binary (-Fc)</option>
                    <option value="plain">Plain SQL (-Fp)</option>
                    <option value="directory">Directory (-Fd)</option>
                    <option value="archive">BSON Archive (--archive)</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={cliCompress}
                    onChange={(e) => setCliCompress(e.target.checked)}
                  />
                  Compression (gzip / -Z6)
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={cliSchemaOnly}
                    onChange={(e) => setCliSchemaOnly(e.target.checked)}
                  />
                  Schema Only
                </label>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={cliDataOnly}
                    onChange={(e) => setCliDataOnly(e.target.checked)}
                  />
                  Data Only
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-zinc-500">Parallel Jobs (-j):</span>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={cliJobs}
                    onChange={(e) => setCliJobs(Number(e.target.value) || 1)}
                    className="w-16 h-6 px-1.5 rounded bg-white dark:bg-[#1e1f22] border border-[var(--border-strong)] font-mono"
                  />
                </label>
              </div>

              <div>
                <label className="block text-zinc-500 mb-1">Extra CLI Flags (optional)</label>
                <input
                  value={cliExtraArgs}
                  onChange={(e) => setCliExtraArgs(e.target.value)}
                  placeholder="--no-owner --no-acl"
                  className="w-full h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-[var(--border-strong)] font-mono"
                />
              </div>

              <button
                disabled={running}
                onClick={() => handleRunNativeCli(false)}
                className="h-8 px-4 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-1.5"
              >
                <Play className="w-3.5 h-3.5 fill-current" /> Run {selectedTool}
              </button>
            </div>

            {cliResult && (
              <div
                className={`p-3.5 rounded-lg border space-y-2 ${
                  cliResult.ok
                    ? "border-emerald-500/40 bg-emerald-500/10"
                    : "border-red-500/40 bg-red-500/10"
                }`}
              >
                <div className="flex items-center justify-between font-semibold">
                  <span>
                    Exit Code: {cliResult.exitCode} ({cliResult.durationMs}ms)
                  </span>
                  <span className="font-mono text-[0.72rem] text-zinc-400">
                    {cliResult.commandPreview}
                  </span>
                </div>
                {(cliResult.stdout || cliResult.stderr) && (
                  <pre className="p-2.5 rounded bg-[#1e1f22] text-zinc-200 font-mono text-[0.72rem] max-h-56 overflow-auto whitespace-pre-wrap">
                    {cliResult.stdout}
                    {cliResult.stderr ? `\n${cliResult.stderr}` : ""}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}

        {jobResult && (
          <div
            className={`max-w-4xl p-3.5 rounded-lg border space-y-2 ${
              jobResult.ok
                ? "border-emerald-500/40 bg-emerald-500/10"
                : "border-red-500/40 bg-red-500/10"
            }`}
          >
            <div className="flex items-center gap-2 font-semibold">
              {jobResult.ok ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              ) : (
                <XCircle className="w-4 h-4 text-red-400" />
              )}
              <span>{jobResult.summary}</span>
              <span className="ml-auto font-mono text-zinc-400">{jobResult.durationMs}ms</span>
            </div>
            {jobResult.errors.length > 0 && (
              <pre className="p-2 rounded bg-[#1e1f22] text-red-300 font-mono text-[0.72rem] max-h-40 overflow-auto">
                {jobResult.errors.join("\n")}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
