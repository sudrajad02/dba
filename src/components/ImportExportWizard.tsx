import React, { useCallback, useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  Download,
  FileSpreadsheet,
  FolderOpen,
  Play,
  Save,
  Square,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  ColumnMapping,
  DataFileFormat,
  DataJobProfile,
  DataJobResult,
  ImportErrorPolicy,
  SqlExportMode,
} from "../types/datavault";

const FORMAT_OPTIONS: { value: DataFileFormat; label: string; ext: string }[] = [
  { value: "csv", label: "CSV (.csv)", ext: "csv" },
  { value: "json", label: "JSON Array (.json)", ext: "json" },
  { value: "jsonl", label: "JSON Lines (.jsonl)", ext: "jsonl" },
  { value: "xlsx", label: "Excel (.xlsx)", ext: "xlsx" },
  { value: "sql", label: "SQL Insert/Upsert (.sql)", ext: "sql" },
];

export const ImportExportWizard: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
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

  const [mode, setMode] = useState<"export" | "import">(
    tab.wizardMode === "import" ? "import" : "export"
  );
  const [connId, setConnId] = useState(tab.connectionId ?? connections[0]?.id ?? "");
  const [database, setDatabase] = useState(tab.database ?? "");
  const [schema, setSchema] = useState(tab.schema ?? "");
  const [table, setTable] = useState(tab.table ?? tab.collection ?? "");
  const [format, setFormat] = useState<DataFileFormat>("csv");
  const [filePath, setFilePath] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [includeHeaders, setIncludeHeaders] = useState(true);
  const [sqlMode, setSqlMode] = useState<SqlExportMode>("insert");
  const [errorPolicy, setErrorPolicy] = useState<ImportErrorPolicy>("stop_on_error");
  const [batchSize, setBatchSize] = useState(500);
  const [truncateBefore, setTruncateBefore] = useState(false);

  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [previewRows, setPreviewRows] = useState<unknown[][]>([]);
  const [running, setRunning] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [result, setResult] = useState<DataJobResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reusable Profiles
  const [profiles, setProfiles] = useState<DataJobProfile[]>([]);
  const [profileName, setProfileName] = useState("");

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
  const tables = objects.filter(
    (o) => o.kind === "table" || o.kind === "view" || o.kind === "collection"
  );

  const refreshProfiles = useCallback(async () => {
    try {
      const list = await api.listJobProfiles(mode);
      setProfiles(list);
    } catch {
      // ignore
    }
  }, [mode]);

  useEffect(() => {
    refreshProfiles();
  }, [refreshProfiles]);

  const ensureConnectedAndLoaded = async (cid: string) => {
    if (!cid) return;
    if (!connectedIds.has(cid)) {
      await connectTo(cid);
    }
    const dbList = await loadDatabases(cid);
    const c = connections.find((x) => x.id === cid);
    const d = c?.database || dbList[0]?.name;
    if (d) {
      setDatabase(d);
      if (c?.engine === "postgres" || c?.engine === "mssql") {
        const sc = await loadSchemas(cid, d);
        const defSc = c.engine === "mssql" ? "dbo" : "public";
        const chosen = sc.find((s) => s.name === defSc)?.name ?? sc[0]?.name ?? defSc;
        setSchema(chosen);
        await loadObjects(cid, d, chosen);
      } else {
        setSchema(d);
        await loadObjects(cid, d, d);
      }
    }
  };

  // Auto-load table columns for Export column mapping
  const loadExportColumns = async () => {
    if (!connId || !table) return;
    setError(null);
    try {
      const meta = await api.getTableMetadata(
        connId,
        table,
        effDb || undefined,
        effSchema || undefined
      );
      setMappings(
        meta.columns.map((c) => ({
          sourceColumn: c.name,
          targetColumn: c.name,
          included: true,
          targetType: c.dataType,
        }))
      );
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const handlePreviewImport = async () => {
    if (!filePath.trim()) {
      setError("Select or enter an input file path first.");
      return;
    }
    setError(null);
    try {
      const res = await api.previewImportFile({
        filePath: filePath.trim(),
        format,
        delimiter,
        hasHeaders: includeHeaders,
        sampleRows: 10,
      });
      setPreviewRows(res.sampleRows);
      setMappings(
        res.columns.map((col) => ({
          sourceColumn: col,
          targetColumn: col,
          included: true,
          targetType: null,
        }))
      );
      addLog("info", `Previewed ${res.columns.length} column(s) from ${filePath}`);
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const handleBrowseFile = async () => {
    try {
      const ext = FORMAT_OPTIONS.find((f) => f.value === format)?.ext ?? "csv";
      if (mode === "export") {
        const chosen = await saveDialog({
          defaultPath: `${table || "export"}.${ext}`,
          filters: [{ name: format.toUpperCase(), extensions: [ext] }],
        });
        if (typeof chosen === "string") setFilePath(chosen);
      } else {
        const chosen = await openDialog({
          multiple: false,
          filters: [{ name: format.toUpperCase(), extensions: [ext] }],
        });
        if (typeof chosen === "string") setFilePath(chosen);
      }
    } catch (err) {
      addLog("warn", `File dialog unavailable: ${String(err)}`);
    }
  };

  const executeJob = async (confirmedProduction = false) => {
    if (!connId || !table || !filePath.trim()) {
      setError("Please select connection, table/collection, and file path.");
      return;
    }
    if (mode === "import" && conn?.environment === "production" && !confirmedProduction) {
      openSafetyModal({
        title: `Import Data into PRODUCTION (${table})`,
        warnings: [
          `Target connection "${conn.name}" is marked PRODUCTION!`,
          ...(truncateBefore ? ["TRUNCATE before import is enabled!"] : []),
        ],
        sqlPreview: `IMPORT (${format.toUpperCase()}) FROM '${filePath}' INTO ${effSchema ? `${effSchema}.` : ""}${table}`,
        onConfirm: () => executeJob(true),
      });
      return;
    }

    const jobId = `job-${Date.now()}`;
    setActiveJobId(jobId);
    setRunning(true);
    setError(null);
    setResult(null);

    try {
      if (mode === "export") {
        const res = await api.exportTableData({
          jobId,
          connectionId: connId,
          database: effDb || null,
          schema: effSchema || null,
          table,
          format,
          outputPath: filePath.trim(),
          delimiter,
          includeHeaders,
          sqlMode,
          batchSize,
          columnMappings: mappings,
        });
        setResult(res);
        addLog(res.ok ? "success" : "warn", res.summary);
      } else {
        const res = await api.importTableData({
          jobId,
          connectionId: connId,
          database: effDb || null,
          schema: effSchema || null,
          table,
          format,
          filePath: filePath.trim(),
          delimiter,
          hasHeaders: includeHeaders,
          columnMappings: mappings,
          errorPolicy,
          batchSize,
          truncateBefore,
          confirmedProduction,
        });
        setResult(res);
        addLog(res.ok ? "success" : "error", res.summary);
      }
    } catch (err) {
      const msg = formatApiError(err);
      setError(msg);
      addLog("error", msg);
    } finally {
      setRunning(false);
      setActiveJobId(null);
    }
  };

  const handleCancel = async () => {
    if (activeJobId) {
      await api.cancelDataJob(activeJobId);
      addLog("warn", `Requested cancellation for job ${activeJobId}`);
    }
  };

  const handleSaveProfile = async () => {
    if (!profileName.trim()) return;
    try {
      await api.saveJobProfile({
        id: "",
        name: profileName.trim(),
        kind: mode,
        config: {
          connId,
          database: effDb,
          schema: effSchema,
          table,
          format,
          filePath,
          delimiter,
          includeHeaders,
          sqlMode,
          errorPolicy,
          batchSize,
          truncateBefore,
          mappings,
        },
        updatedAt: "",
      });
      setProfileName("");
      addLog("success", `Saved ${mode} profile "${profileName.trim()}"`);
      await refreshProfiles();
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const applyProfile = (p: DataJobProfile) => {
    const cfg = p.config as Record<string, unknown>;
    if (typeof cfg.connId === "string") setConnId(cfg.connId);
    if (typeof cfg.database === "string") setDatabase(cfg.database);
    if (typeof cfg.schema === "string") setSchema(cfg.schema);
    if (typeof cfg.table === "string") setTable(cfg.table);
    if (typeof cfg.format === "string") setFormat(cfg.format as DataFileFormat);
    if (typeof cfg.filePath === "string") setFilePath(cfg.filePath);
    if (typeof cfg.delimiter === "string") setDelimiter(cfg.delimiter);
    if (typeof cfg.includeHeaders === "boolean") setIncludeHeaders(cfg.includeHeaders);
    if (typeof cfg.sqlMode === "string") setSqlMode(cfg.sqlMode as SqlExportMode);
    if (typeof cfg.errorPolicy === "string") setErrorPolicy(cfg.errorPolicy as ImportErrorPolicy);
    if (typeof cfg.batchSize === "number") setBatchSize(cfg.batchSize);
    if (typeof cfg.truncateBefore === "boolean") setTruncateBefore(cfg.truncateBefore);
    if (Array.isArray(cfg.mappings)) setMappings(cfg.mappings as ColumnMapping[]);
    addLog("info", `Loaded profile "${p.name}"`);
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#1e1f22] text-xs">
      {/* Header Toolbar */}
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex rounded border border-zinc-300 dark:border-zinc-700 overflow-hidden">
            <button
              onClick={() => setMode("export")}
              className={`h-7 px-3 flex items-center gap-1.5 font-medium ${
                mode === "export"
                  ? "bg-indigo-600 text-white"
                  : "hover:bg-zinc-200 dark:hover:bg-zinc-800"
              }`}
            >
              <Download className="w-3.5 h-3.5" /> Export Wizard
            </button>
            <button
              onClick={() => {
                setMode("import");
                if (format === "sql") setFormat("csv");
              }}
              className={`h-7 px-3 flex items-center gap-1.5 font-medium ${
                mode === "import"
                  ? "bg-emerald-600 text-white"
                  : "hover:bg-zinc-200 dark:hover:bg-zinc-800"
              }`}
            >
              <Upload className="w-3.5 h-3.5" /> Import Wizard
            </button>
          </div>
          <span className="text-zinc-500">
            Built-in Rust Streaming Engine (CSV • JSON/JSONL • Excel .xlsx • SQL)
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {running ? (
            <button
              onClick={handleCancel}
              className="h-7 px-3 rounded bg-red-600 hover:bg-red-500 text-white font-medium flex items-center gap-1.5"
            >
              <Square className="w-3 h-3 fill-current" /> Cancel Job
            </button>
          ) : (
            <button
              onClick={() => executeJob(false)}
              className="h-7 px-3.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              {mode === "export" ? "Start Export" : "Start Import"}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 font-mono">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left/Center Config & Mapping */}
        <div className="lg:col-span-2 space-y-4">
          <div className="p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a] space-y-3">
            <div className="font-semibold flex items-center gap-1.5">
              <FileSpreadsheet className="w-4 h-4 text-sky-400" />
              1. Source / Target & Format
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div>
                <label className="block text-zinc-500 mb-1">Connection</label>
                <select
                  value={connId}
                  onChange={(e) => {
                    setConnId(e.target.value);
                    ensureConnectedAndLoaded(e.target.value);
                  }}
                  className="w-full h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700"
                >
                  <option value="">Select connection...</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.engine})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-zinc-500 mb-1">Database</label>
                <select
                  value={effDb}
                  onChange={(e) => {
                    setDatabase(e.target.value);
                    loadObjects(connId, e.target.value, e.target.value);
                  }}
                  className="w-full h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
                >
                  {dbs.length === 0 && <option value={effDb}>{effDb || "default"}</option>}
                  {dbs.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-zinc-500 mb-1">Schema</label>
                <select
                  value={effSchema}
                  onChange={(e) => {
                    setSchema(e.target.value);
                    loadObjects(connId, effDb, e.target.value);
                  }}
                  className="w-full h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
                >
                  {schemas.length === 0 && <option value={effSchema}>{effSchema || "—"}</option>}
                  {schemas.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-zinc-500 mb-1">Table / Collection</label>
                <input
                  value={table}
                  onChange={(e) => setTable(e.target.value)}
                  list="ie-tables-list"
                  placeholder="table_name"
                  className="w-full h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
                />
                <datalist id="ie-tables-list">
                  {tables.map((t) => (
                    <option key={t.name} value={t.name} />
                  ))}
                </datalist>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div>
                <label className="block text-zinc-500 mb-1">File Format</label>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as DataFileFormat)}
                  className="w-full h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700"
                >
                  {FORMAT_OPTIONS.filter((f) => mode === "export" || f.value !== "sql").map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="block text-zinc-500 mb-1">
                  {mode === "export" ? "Output File Path" : "Input File Path"}
                </label>
                <div className="flex gap-1.5">
                  <input
                    value={filePath}
                    onChange={(e) => setFilePath(e.target.value)}
                    placeholder={`/tmp/${table || "data"}.${format}`}
                    className="flex-1 h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
                  />
                  <button
                    onClick={handleBrowseFile}
                    className="h-7 px-2.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-1"
                  >
                    <FolderOpen className="w-3.5 h-3.5" /> Browse
                  </button>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-1">
              {format === "csv" && (
                <label className="flex items-center gap-1.5">
                  <span className="text-zinc-500">Delimiter:</span>
                  <input
                    value={delimiter}
                    onChange={(e) => setDelimiter(e.target.value)}
                    className="w-10 h-6 px-1.5 text-center rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
                  />
                </label>
              )}
              {(format === "csv" || format === "xlsx") && (
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={includeHeaders}
                    onChange={(e) => setIncludeHeaders(e.target.checked)}
                  />
                  {mode === "export" ? "Include header row" : "First row is header"}
                </label>
              )}
              {mode === "export" && format === "sql" && (
                <label className="flex items-center gap-1.5">
                  <span className="text-zinc-500">SQL Mode:</span>
                  <select
                    value={sqlMode}
                    onChange={(e) => setSqlMode(e.target.value as SqlExportMode)}
                    className="h-6 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700"
                  >
                    <option value="insert">INSERT</option>
                    <option value="upsert">UPSERT (ON CONFLICT / DUPLICATE KEY)</option>
                  </select>
                </label>
              )}
              {mode === "import" && (
                <>
                  <label className="flex items-center gap-1.5">
                    <span className="text-zinc-500">Error Policy:</span>
                    <select
                      value={errorPolicy}
                      onChange={(e) => setErrorPolicy(e.target.value as ImportErrorPolicy)}
                      className="h-6 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700"
                    >
                      <option value="stop_on_error">Stop on error</option>
                      <option value="skip_and_log">Skip & log errors</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5 text-amber-400">
                    <input
                      type="checkbox"
                      checked={truncateBefore}
                      onChange={(e) => setTruncateBefore(e.target.checked)}
                    />
                    Truncate table first
                  </label>
                </>
              )}
              <label className="flex items-center gap-1.5">
                <span className="text-zinc-500">Batch Size:</span>
                <input
                  type="number"
                  value={batchSize}
                  onChange={(e) => setBatchSize(Number(e.target.value) || 250)}
                  className="w-20 h-6 px-1.5 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
                />
              </label>
            </div>
          </div>

          {/* Step 2: Column Mapping */}
          <div className="p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a] space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="font-semibold">2. Column Mapping & Type Transform</div>
              <button
                onClick={mode === "export" ? loadExportColumns : handlePreviewImport}
                className="h-7 px-2.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800"
              >
                {mode === "export" ? "Load Table Columns" : "Preview File & Detect Columns"}
              </button>
            </div>

            {mappings.length === 0 ? (
              <div className="py-6 text-center text-zinc-500">
                Leave empty to map all columns 1:1 automatically, or click the button above to
                customize column mapping.
              </div>
            ) : (
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500">
                    <th className="py-1 px-2 w-10">Inc</th>
                    <th className="py-1 px-2">Source Column</th>
                    <th className="py-1 px-2">Target Column</th>
                    <th className="py-1 px-2">Type Cast (optional)</th>
                  </tr>
                </thead>
                <tbody>
                  {mappings.map((m, idx) => (
                    <tr
                      key={`${m.sourceColumn}-${idx}`}
                      className="border-b border-zinc-200/50 dark:border-zinc-800/50"
                    >
                      <td className="py-1 px-2">
                        <input
                          type="checkbox"
                          checked={m.included}
                          onChange={(e) =>
                            setMappings((prev) =>
                              prev.map((x, i) =>
                                i === idx ? { ...x, included: e.target.checked } : x
                              )
                            )
                          }
                        />
                      </td>
                      <td className="py-1 px-2 font-mono">{m.sourceColumn}</td>
                      <td className="py-1 px-2">
                        <input
                          value={m.targetColumn}
                          onChange={(e) =>
                            setMappings((prev) =>
                              prev.map((x, i) =>
                                i === idx ? { ...x, targetColumn: e.target.value } : x
                              )
                            )
                          }
                          className="w-full h-6 px-1.5 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
                        />
                      </td>
                      <td className="py-1 px-2">
                        <input
                          value={m.targetType ?? ""}
                          onChange={(e) =>
                            setMappings((prev) =>
                              prev.map((x, i) =>
                                i === idx ? { ...x, targetType: e.target.value || null } : x
                              )
                            )
                          }
                          placeholder="auto / int / float / bool / json"
                          className="w-full h-6 px-1.5 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {previewRows.length > 0 && mode === "import" && (
              <div className="pt-2">
                <div className="text-[0.72rem] text-zinc-500 mb-1">
                  File Preview (first {previewRows.length} rows)
                </div>
                <div className="max-h-40 overflow-auto rounded border border-zinc-200 dark:border-zinc-800">
                  <table className="w-full text-left font-mono text-[0.72rem]">
                    <tbody>
                      {previewRows.map((row, rIdx) => (
                        <tr
                          key={rIdx}
                          className="border-b border-zinc-200/40 dark:border-zinc-800/40"
                        >
                          {row.map((cell, cIdx) => (
                            <td key={cIdx} className="px-2 py-1 truncate max-w-[160px]">
                              {cell === null ? "NULL" : String(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Job Result */}
          {result && (
            <div
              className={`p-3.5 rounded-lg border space-y-2 ${
                result.ok
                  ? "border-emerald-500/40 bg-emerald-500/10"
                  : "border-red-500/40 bg-red-500/10"
              }`}
            >
              <div className="flex items-center gap-2 font-semibold">
                {result.ok ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-400" />
                )}
                <span>{result.summary}</span>
                <span className="ml-auto font-mono text-zinc-400">{result.durationMs}ms</span>
              </div>
              {result.errors.length > 0 && (
                <pre className="p-2 rounded bg-zinc-950 text-red-300 font-mono text-[0.72rem] max-h-36 overflow-auto">
                  {result.errors.join("\n")}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Reusable Profiles */}
        <div className="space-y-3">
          <div className="p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a] space-y-2.5">
            <div className="font-semibold">Reusable Profiles (.dvjob.json)</div>
            <div className="flex gap-1.5">
              <input
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder={`Save current ${mode} config...`}
                className="flex-1 h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700"
              />
              <button
                onClick={handleSaveProfile}
                className="h-7 px-2.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1"
              >
                <Save className="w-3.5 h-3.5" /> Save
              </button>
            </div>

            <div className="space-y-1.5 pt-1">
              {profiles.length === 0 ? (
                <div className="text-zinc-500 py-4 text-center">No saved {mode} profiles yet.</div>
              ) : (
                profiles.map((p) => (
                  <div
                    key={p.id}
                    className="p-2 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#1e1f22] flex items-center justify-between gap-2"
                  >
                    <button
                      onClick={() => applyProfile(p)}
                      className="text-left flex-1 min-w-0 hover:text-sky-400"
                    >
                      <div className="font-medium truncate">{p.name}</div>
                      <div className="text-[0.68rem] text-zinc-500 font-mono">
                        {new Date(p.updatedAt).toLocaleString()}
                      </div>
                    </button>
                    <button
                      onClick={async () => {
                        await api.deleteJobProfile(p.id);
                        refreshProfiles();
                      }}
                      className="text-zinc-500 hover:text-red-400 p-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
