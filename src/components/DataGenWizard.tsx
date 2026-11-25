import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  Eye,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  XCircle,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  DataGenColumnRule,
  DataGenGeneratorKind,
  DataGenPreviewResult,
  DataGenResult,
} from "../types/dba";

const GENERATOR_OPTIONS: { value: DataGenGeneratorKind; label: string }[] = [
  { value: "auto_increment_skip", label: "Auto-Increment (Skip)" },
  { value: "foreign_key_sample", label: "Foreign Key Sample" },
  { value: "uuid", label: "UUID v4" },
  { value: "full_name", label: "Full Name" },
  { value: "first_name", label: "First Name" },
  { value: "last_name", label: "Last Name" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone Number" },
  { value: "username", label: "Username" },
  { value: "address", label: "Street Address" },
  { value: "city", label: "City" },
  { value: "country", label: "Country" },
  { value: "company", label: "Company Name" },
  { value: "url", label: "URL" },
  { value: "boolean", label: "Boolean" },
  { value: "integer_range", label: "Integer Range" },
  { value: "decimal_range", label: "Decimal Range" },
  { value: "date_range", label: "Date Range" },
  { value: "timestamp_range", label: "Timestamp Range" },
  { value: "enum_list", label: "Enum List" },
  { value: "regex_pattern", label: "Regex Pattern" },
  { value: "text_lorem", label: "Lorem Text" },
  { value: "null", label: "Always NULL" },
];

export const DataGenWizard: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
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

  const [connId, setConnId] = useState(tab.connectionId ?? connections[0]?.id ?? "");
  const [database, setDatabase] = useState(tab.database ?? "");
  const [schema, setSchema] = useState(tab.schema ?? "");
  const [table, setTable] = useState(tab.table ?? "");

  const [rowCount, setRowCount] = useState(1000);
  const [batchSize, setBatchSize] = useState(500);
  const [seed, setSeed] = useState<string>("42");
  const [truncateBefore, setTruncateBefore] = useState(false);

  const [rules, setRules] = useState<DataGenColumnRule[]>([]);
  const [preview, setPreview] = useState<DataGenPreviewResult | null>(null);
  const [result, setResult] = useState<DataGenResult | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  const availTables = (
    objectsByKey[`${connId}::${effDb}::${effSchema}`] ?? []
  ).filter((o) => o.kind === "table" || o.kind === "collection");

  const initConn = async (cid: string) => {
    if (!cid) return;
    try {
      if (!connectedIds.has(cid)) await connectTo(cid);
      const dbList = await loadDatabases(cid);
      const c = connections.find((x) => x.id === cid);
      const d = c?.database || dbList[0]?.name || "";
      setDatabase(d);
      if (d && (c?.engine === "postgres" || c?.engine === "mssql")) {
        const sc = await loadSchemas(cid, d);
        const pref = c.engine === "mssql" ? "dbo" : "public";
        const chosen = sc.find((s) => s.name === pref)?.name ?? sc[0]?.name ?? pref;
        setSchema(chosen);
        await loadObjects(cid, d, chosen);
      } else if (d) {
        setSchema(d);
        await loadObjects(cid, d, d);
      }
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  useEffect(() => {
    if (connId && !dbs.length) {
      initConn(connId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  const handleInferRules = async (targetTable: string) => {
    if (!connId || !targetTable) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    setResult(null);
    try {
      if (!connectedIds.has(connId)) await connectTo(connId);
      const inferred = await api.inferDataGenRules({
        connectionId: connId,
        database: effDb || null,
        schema: effSchema || null,
        table: targetTable,
      });
      setRules(inferred);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setLoading(false);
    }
  };

  const buildRequest = (confirmedProd: boolean, jobId?: string) => ({
    jobId: jobId ?? null,
    connectionId: connId,
    database: effDb || null,
    schema: effSchema || null,
    table,
    rowCount,
    batchSize,
    truncateBefore,
    seed: seed.trim() ? Number(seed) : null,
    rules,
    confirmedProduction: confirmedProd,
  });

  const handlePreview = async () => {
    if (!connId || !table || rules.length === 0) return;
    setError(null);
    try {
      const res = await api.previewDataGen(buildRequest(false));
      setPreview(res);
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const executeRun = async (confirmedProd: boolean) => {
    const jobId = `datagen-${Date.now()}`;
    setActiveJobId(jobId);
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.runDataGen(buildRequest(confirmedProd, jobId));
      setResult(res);
      addLog(res.ok ? "success" : "error", `Data Gen: ${res.summary}`);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setRunning(false);
      setActiveJobId(null);
    }
  };

  const handleGenerate = () => {
    if (!connId || !table || rules.length === 0) return;
    if (conn?.environment === "production" || truncateBefore) {
      openSafetyModal({
        title: `Generate ${rowCount.toLocaleString()} Dummy Rows into ${table}`,
        warnings: [
          ...(conn?.environment === "production"
            ? [`Target connection "${conn.name}" is tagged as PRODUCTION.`]
            : []),
          ...(truncateBefore
            ? [`TRUNCATE BEFORE GENERATE is enabled — existing rows in "${table}" will be deleted!`]
            : []),
        ],
        sqlPreview: `Target: ${effDb}.${effSchema}.${table}\nRows: ${rowCount}\nBatch Size: ${batchSize}\nTruncate: ${truncateBefore}`,
        onConfirm: () => executeRun(true),
      });
    } else {
      executeRun(false);
    }
  };

  const updateRule = (idx: number, patch: Partial<DataGenColumnRule>) => {
    setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#1e1f22] text-xs overflow-hidden">
      {/* Header Bar */}
      <div className="px-4 py-2.5 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex items-center justify-between gap-2 flex-wrap shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-400" />
          <span className="font-semibold text-sm">Data Generation Engine</span>
          {conn?.environment === "production" && (
            <span className="px-1.5 py-0.5 rounded bg-red-600 text-white text-[0.62rem] font-semibold">
              PRODUCTION
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handlePreview}
            disabled={rules.length === 0 || running}
            className="h-7 px-3 rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#32343a] disabled:opacity-40 flex items-center gap-1.5 cursor-pointer"
          >
            <Eye className="w-3.5 h-3.5 text-sky-400" />
            <span>Preview 10 Rows</span>
          </button>
          {running && activeJobId ? (
            <button
              onClick={() => api.cancelDataJob(activeJobId)}
              className="h-7 px-3 rounded bg-red-600 hover:bg-red-500 text-white font-medium flex items-center gap-1.5 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" /> Cancel
            </button>
          ) : (
            <button
              onClick={handleGenerate}
              disabled={rules.length === 0 || !table}
              className="h-7 px-3 rounded bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-medium flex items-center gap-1.5 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Generate {rowCount.toLocaleString()} Rows</span>
            </button>
          )}
        </div>
      </div>

      {/* Target Picker & Options */}
      <div className="px-4 py-3 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50/50 dark:bg-[#23252a] space-y-2.5 shrink-0">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
          <select
            value={connId}
            onChange={(e) => {
              setConnId(e.target.value);
              setTable("");
              setRules([]);
              initConn(e.target.value);
            }}
            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
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
            onChange={(e) => {
              setDatabase(e.target.value);
              loadObjects(connId, e.target.value, effSchema);
            }}
            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
          >
            {dbs.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>

          <select
            value={effSchema}
            onChange={(e) => {
              setSchema(e.target.value);
              loadObjects(connId, effDb, e.target.value);
            }}
            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
          >
            {schemas.length > 0 ? (
              schemas.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))
            ) : (
              <option value={effSchema}>{effSchema || "default"}</option>
            )}
          </select>

          <select
            value={table}
            onChange={(e) => {
              setTable(e.target.value);
              if (e.target.value) handleInferRules(e.target.value);
            }}
            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
          >
            <option value="">Select Table / Collection...</option>
            {availTables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>

          <button
            onClick={() => table && handleInferRules(table)}
            disabled={!table || loading}
            className="h-7 px-2.5 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>Auto-Detect Rules</span>
          </button>
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-400">Rows:</span>
            <input
              type="number"
              min={1}
              max={1000000}
              value={rowCount}
              onChange={(e) => setRowCount(Math.max(1, Number(e.target.value) || 1))}
              className="h-7 w-24 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
            />
            {[100, 1000, 10000, 100000].map((n) => (
              <button
                key={n}
                onClick={() => setRowCount(n)}
                className="px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-[#32343a] hover:bg-indigo-600 hover:text-white text-[0.68rem] font-mono cursor-pointer"
              >
                {n >= 1000 ? `${n / 1000}k` : n}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-zinc-400">Batch:</span>
            <input
              type="number"
              min={1}
              max={2000}
              value={batchSize}
              onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value) || 500))}
              className="h-7 w-20 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-zinc-400">Seed:</span>
            <input
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="Random"
              className="h-7 w-20 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
            />
          </div>

          <label className="flex items-center gap-1.5 cursor-pointer text-amber-400">
            <input
              type="checkbox"
              checked={truncateBefore}
              onChange={(e) => setTruncateBefore(e.target.checked)}
            />
            <span>Truncate table before insert</span>
          </label>
        </div>
      </div>

      {/* Banners */}
      {error && (
        <div className="mx-4 mt-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-red-400 flex items-center gap-2 shrink-0">
          <XCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {result && (
        <div
          className={`mx-4 mt-2 p-2 rounded border flex items-center gap-2 shrink-0 ${
            result.ok
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : "bg-red-500/10 border-red-500/30 text-red-400"
          }`}
        >
          {result.ok ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <XCircle className="w-4 h-4 shrink-0" />
          )}
          <span>{result.summary}</span>
        </div>
      )}

      {/* Main Content: Rules Table + Preview */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <div className="flex-1 overflow-auto p-4">
          {rules.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-2">
              <Sparkles className="w-9 h-9 opacity-30" />
              <p>
                Select a target table above to auto-detect column generators (UUID, Name,
                Email, Phone, Ranges, Regex, and Foreign Key-aware sampling).
              </p>
            </div>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-[#32343a] text-zinc-400 text-[0.7rem] uppercase">
                  <th className="py-1.5 px-2">Column</th>
                  <th className="py-1.5 px-2">DB Type</th>
                  <th className="py-1.5 px-2">Generator</th>
                  <th className="py-1.5 px-2 w-20">Null %</th>
                  <th className="py-1.5 px-2">Parameters (Min/Max, Enum, Pattern, FK)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-[#2e3036]">
                {rules.map((r, idx) => (
                  <tr key={r.column} className="hover:bg-zinc-50 dark:hover:bg-[#25262c]">
                    <td className="py-1.5 px-2 font-mono font-medium">{r.column}</td>
                    <td className="py-1.5 px-2 font-mono text-zinc-400">{r.dataType}</td>
                    <td className="py-1.5 px-2">
                      <select
                        value={r.generator}
                        onChange={(e) =>
                          updateRule(idx, {
                            generator: e.target.value as DataGenGeneratorKind,
                          })
                        }
                        className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                      >
                        {GENERATOR_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1.5 px-2">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={r.nullPercent}
                        onChange={(e) =>
                          updateRule(idx, {
                            nullPercent: Math.min(100, Math.max(0, Number(e.target.value) || 0)),
                          })
                        }
                        className="h-7 w-16 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                      />
                    </td>
                    <td className="py-1.5 px-2">
                      {(r.generator === "integer_range" || r.generator === "decimal_range") && (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            value={r.minNum ?? 1}
                            onChange={(e) => updateRule(idx, { minNum: Number(e.target.value) })}
                            placeholder="Min"
                            className="h-7 w-24 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                          />
                          <span>to</span>
                          <input
                            type="number"
                            value={r.maxNum ?? 1000}
                            onChange={(e) => updateRule(idx, { maxNum: Number(e.target.value) })}
                            placeholder="Max"
                            className="h-7 w-24 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                          />
                        </div>
                      )}
                      {(r.generator === "date_range" || r.generator === "timestamp_range") && (
                        <div className="flex items-center gap-1.5">
                          <input
                            value={r.startDate ?? "2022-01-01"}
                            onChange={(e) => updateRule(idx, { startDate: e.target.value })}
                            className="h-7 w-28 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                          />
                          <span>to</span>
                          <input
                            value={r.endDate ?? "2026-12-31"}
                            onChange={(e) => updateRule(idx, { endDate: e.target.value })}
                            className="h-7 w-28 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                          />
                        </div>
                      )}
                      {r.generator === "enum_list" && (
                        <input
                          value={r.enumValues.join(", ")}
                          onChange={(e) =>
                            updateRule(idx, {
                              enumValues: e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            })
                          }
                          placeholder="active, pending, inactive"
                          className="h-7 w-full max-w-sm px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                        />
                      )}
                      {r.generator === "regex_pattern" && (
                        <input
                          value={r.pattern ?? "[A-Z]{3}-\\d{4}"}
                          onChange={(e) => updateRule(idx, { pattern: e.target.value })}
                          placeholder="[A-Z]{3}-\d{4}"
                          className="h-7 w-56 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                        />
                      )}
                      {r.generator === "foreign_key_sample" && (
                        <span className="px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-400 font-mono text-[0.7rem]">
                          FK → {r.fkTable}.{r.fkColumn}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Sample Preview Drawer */}
        {preview && (
          <div className="h-56 border-t border-zinc-200 dark:border-[#32343a] flex flex-col shrink-0">
            <div className="px-3 py-1.5 bg-zinc-50 dark:bg-[#25262a] border-b border-zinc-200 dark:border-[#32343a] font-semibold">
              Sample Preview ({preview.rows.length} rows)
            </div>
            <div className="flex-1 overflow-auto">
              <table className="w-full border-collapse text-left font-mono text-[0.7rem]">
                <thead>
                  <tr className="bg-zinc-100 dark:bg-[#23252a] border-b border-zinc-200 dark:border-[#32343a]">
                    {preview.columns.map((c) => (
                      <th key={c} className="py-1 px-2 whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200 dark:divide-[#2c2e34]">
                  {preview.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} className="py-1 px-2 whitespace-nowrap">
                          {cell === null ? (
                            <span className="text-zinc-500 italic">NULL</span>
                          ) : (
                            String(cell)
                          )}
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
    </div>
  );
};
