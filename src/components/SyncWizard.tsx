import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  GitCompare,
  Play,
  RefreshCw,
  Table2,
  XCircle,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  DataSyncPlan,
  StructureSyncPlan,
  SyncDiffStatus,
  SyncExecutionResult,
} from "../types/datavault";

const STATUS_BADGE: Record<SyncDiffStatus, string> = {
  new: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
  modified: "bg-amber-500/15 text-amber-500 border-amber-500/30",
  deleted: "bg-red-500/15 text-red-500 border-red-500/30",
  unchanged: "bg-zinc-500/15 text-zinc-400 border-zinc-500/20",
};

export const SyncWizard: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
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

  const sqlConns = useMemo(
    () => connections.filter((c) => c.engine !== "mongodb"),
    [connections]
  );

  const [mode, setMode] = useState<"structure" | "data">(
    tab.wizardMode === "data_sync" ? "data" : "structure"
  );

  const [srcConnId, setSrcConnId] = useState(
    tab.connectionId ?? sqlConns[0]?.id ?? ""
  );
  const [srcDb, setSrcDb] = useState(tab.database ?? "");
  const [srcSchema, setSrcSchema] = useState(tab.schema ?? "");

  const [tgtConnId, setTgtConnId] = useState(
    sqlConns[1]?.id ?? sqlConns[0]?.id ?? ""
  );
  const [tgtDb, setTgtDb] = useState("");
  const [tgtSchema, setTgtSchema] = useState("");

  // Structure sync state
  const [includeDrops, setIncludeDrops] = useState(false);
  const [structPlan, setStructPlan] = useState<StructureSyncPlan | null>(null);
  const [selectedStructTables, setSelectedStructTables] = useState<Set<string>>(
    new Set()
  );
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());

  // Data sync state
  const [selectedDataTables, setSelectedDataTables] = useState<Set<string>>(
    new Set()
  );
  const [customKeys, setCustomKeys] = useState<Record<string, string>>({});
  const [includeDeletes, setIncludeDeletes] = useState(false);
  const [dataPlan, setDataPlan] = useState<DataSyncPlan | null>(null);
  const [activeDataTable, setActiveDataTable] = useState<string | null>(null);

  // Shared run/result state
  const [comparing, setComparing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState<SyncExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const srcConn = sqlConns.find((c) => c.id === srcConnId);
  const tgtConn = sqlConns.find((c) => c.id === tgtConnId);

  const srcDbs = databasesByConn[srcConnId] ?? [];
  const effSrcDb = srcDb || srcConn?.database || srcDbs[0]?.name || "";
  const srcSchemas = schemasByConnDb[`${srcConnId}::${effSrcDb}`] ?? [];
  const effSrcSchema =
    srcSchema ||
    (srcConn?.engine === "postgres"
      ? "public"
      : srcConn?.engine === "mssql"
      ? "dbo"
      : effSrcDb);
  const srcTables = (
    objectsByKey[`${srcConnId}::${effSrcDb}::${effSrcSchema}`] ?? []
  ).filter((o) => o.kind === "table");

  const tgtDbs = databasesByConn[tgtConnId] ?? [];
  const effTgtDb = tgtDb || tgtConn?.database || tgtDbs[0]?.name || "";
  const tgtSchemas = schemasByConnDb[`${tgtConnId}::${effTgtDb}`] ?? [];
  const effTgtSchema =
    tgtSchema ||
    (tgtConn?.engine === "postgres"
      ? "public"
      : tgtConn?.engine === "mssql"
      ? "dbo"
      : effTgtDb);

  const initConn = async (cid: string, isSrc: boolean) => {
    if (!cid) return;
    try {
      if (!connectedIds.has(cid)) await connectTo(cid);
      const dbs = await loadDatabases(cid);
      const c = sqlConns.find((x) => x.id === cid);
      const d = c?.database || dbs[0]?.name || "";
      if (isSrc) setSrcDb(d);
      else setTgtDb(d);
      if (d && (c?.engine === "postgres" || c?.engine === "mssql")) {
        const sc = await loadSchemas(cid, d);
        const pref = c.engine === "mssql" ? "dbo" : "public";
        const chosen = sc.find((s) => s.name === pref)?.name ?? sc[0]?.name ?? pref;
        if (isSrc) setSrcSchema(chosen);
        else setTgtSchema(chosen);
        await loadObjects(cid, d, chosen);
      } else if (d) {
        if (isSrc) setSrcSchema(d);
        else setTgtSchema(d);
        await loadObjects(cid, d, d);
      }
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  useEffect(() => {
    if (srcConnId && !srcDbs.length) {
      initConn(srcConnId, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcConnId]);

  useEffect(() => {
    if (tgtConnId && !tgtDbs.length) {
      initConn(tgtConnId, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tgtConnId]);

  const handleCompareStructure = async () => {
    if (!srcConnId || !tgtConnId) return;
    setError(null);
    setExecResult(null);
    setComparing(true);
    try {
      if (!connectedIds.has(srcConnId)) await connectTo(srcConnId);
      if (!connectedIds.has(tgtConnId)) await connectTo(tgtConnId);
      const plan = await api.computeStructureSync({
        sourceConnectionId: srcConnId,
        sourceDatabase: effSrcDb || null,
        sourceSchema: effSrcSchema || null,
        targetConnectionId: tgtConnId,
        targetDatabase: effTgtDb || null,
        targetSchema: effTgtSchema || null,
        includeDrops,
      });
      setStructPlan(plan);
      const changed = new Set(
        plan.tables
          .filter((t) => t.ddlStatements.length > 0)
          .map((t) => t.tableName)
      );
      setSelectedStructTables(changed);
      setExpandedTables(new Set(Array.from(changed).slice(0, 5)));
      addLog("info", `Structure Sync compare: ${plan.summary}`);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setComparing(false);
    }
  };

  const handleCompareData = async () => {
    if (!srcConnId || !tgtConnId) return;
    const picked = Array.from(selectedDataTables);
    if (picked.length === 0) {
      setError("Select at least one source table to compare data.");
      return;
    }
    setError(null);
    setExecResult(null);
    setComparing(true);
    try {
      if (!connectedIds.has(srcConnId)) await connectTo(srcConnId);
      if (!connectedIds.has(tgtConnId)) await connectTo(tgtConnId);
      const plan = await api.computeDataSync({
        sourceConnectionId: srcConnId,
        sourceDatabase: effSrcDb || null,
        sourceSchema: effSrcSchema || null,
        targetConnectionId: tgtConnId,
        targetDatabase: effTgtDb || null,
        targetSchema: effTgtSchema || null,
        tables: picked.map((t) => ({
          sourceTable: t,
          targetTable: t,
          keyColumns: (customKeys[t] || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        })),
        includeDeletes,
        maxDiffRowsPerTable: 150,
      });
      setDataPlan(plan);
      setActiveDataTable(plan.tables[0]?.sourceTable ?? null);
      addLog("info", `Data Sync compare: ${plan.summary}`);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setComparing(false);
    }
  };

  const activeStatements = useMemo(() => {
    if (mode === "structure" && structPlan) {
      return structPlan.tables
        .filter((t) => selectedStructTables.has(t.tableName))
        .flatMap((t) => t.ddlStatements);
    }
    if (mode === "data" && dataPlan) {
      return dataPlan.tables.flatMap((t) => t.statements);
    }
    return [];
  }, [mode, structPlan, selectedStructTables, dataPlan]);

  const executeStatements = async (confirmedProd: boolean) => {
    if (!tgtConnId || activeStatements.length === 0) return;
    setExecuting(true);
    setError(null);
    try {
      const res = await api.executeSyncScript({
        connectionId: tgtConnId,
        database: effTgtDb || null,
        statements: activeStatements,
        stopOnError: true,
        confirmedProduction: confirmedProd,
      });
      setExecResult(res);
      addLog(res.ok ? "success" : "error", `Sync executed: ${res.summary}`);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setExecuting(false);
    }
  };

  const handleApplySync = () => {
    if (activeStatements.length === 0) return;
    if (tgtConn?.environment === "production") {
      openSafetyModal({
        title: `Apply ${mode === "structure" ? "Structure" : "Data"} Sync to PRODUCTION`,
        warnings: [
          `Target connection "${tgtConn.name}" is tagged as PRODUCTION.`,
          `This will execute ${activeStatements.length} statement(s) on ${effTgtDb || "target database"}.`,
        ],
        sqlPreview: activeStatements.slice(0, 30).join("\n"),
        onConfirm: () => executeStatements(true),
      });
    } else {
      executeStatements(false);
    }
  };

  const currentDataDiff = dataPlan?.tables.find(
    (t) => t.sourceTable === activeDataTable
  );

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#1e1f22] text-xs overflow-hidden">
      {/* Header Bar */}
      <div className="px-4 py-2.5 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-semibold text-sm text-zinc-900 dark:text-zinc-100">
            <GitCompare className="w-4 h-4 text-orange-400" />
            <span>Synchronization</span>
          </div>
          <div className="flex rounded-md border border-zinc-300 dark:border-[#3b3d44] overflow-hidden">
            <button
              onClick={() => {
                setMode("structure");
                setExecResult(null);
              }}
              className={`px-3 py-1 font-medium cursor-pointer ${
                mode === "structure"
                  ? "bg-orange-500 text-white"
                  : "bg-white dark:bg-[#1e1f22] text-zinc-600 dark:text-zinc-300"
              }`}
            >
              Structure Sync
            </button>
            <button
              onClick={() => {
                setMode("data");
                setExecResult(null);
              }}
              className={`px-3 py-1 font-medium cursor-pointer ${
                mode === "data"
                  ? "bg-orange-500 text-white"
                  : "bg-white dark:bg-[#1e1f22] text-zinc-600 dark:text-zinc-300"
              }`}
            >
              Data Sync
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={mode === "structure" ? handleCompareStructure : handleCompareData}
            disabled={comparing || !srcConnId || !tgtConnId}
            className="h-7 px-3 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${comparing ? "animate-spin" : ""}`} />
            <span>{comparing ? "Comparing..." : "Compare"}</span>
          </button>
          <button
            onClick={handleApplySync}
            disabled={executing || activeStatements.length === 0}
            className="h-7 px-3 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium flex items-center gap-1.5 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            <span>
              {executing
                ? "Applying..."
                : `Apply (${activeStatements.length} stmt)`}
            </span>
          </button>
        </div>
      </div>

      {/* Source -> Target Picker */}
      <div className="px-4 py-3 border-b border-zinc-200 dark:border-[#32343a] grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-3 items-center shrink-0">
        <div className="p-2.5 rounded-md border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#23252a] space-y-2">
          <div className="font-semibold text-zinc-500 uppercase text-[0.65rem] tracking-wider flex items-center gap-1">
            <Database className="w-3 h-3 text-sky-400" /> Source (Reference)
          </div>
          <div className="grid grid-cols-3 gap-2">
            <select
              value={srcConnId}
              onChange={(e) => {
                setSrcConnId(e.target.value);
                initConn(e.target.value, true);
              }}
              className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
            >
              <option value="">Select Connection</option>
              {sqlConns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.engine})
                </option>
              ))}
            </select>
            <select
              value={effSrcDb}
              onChange={(e) => {
                setSrcDb(e.target.value);
                loadObjects(srcConnId, e.target.value, effSrcSchema);
              }}
              className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
            >
              {srcDbs.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
            <select
              value={effSrcSchema}
              onChange={(e) => {
                setSrcSchema(e.target.value);
                loadObjects(srcConnId, effSrcDb, e.target.value);
              }}
              className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
            >
              {srcSchemas.length > 0 ? (
                srcSchemas.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))
              ) : (
                <option value={effSrcSchema}>{effSrcSchema || "default"}</option>
              )}
            </select>
          </div>
        </div>

        <div className="flex flex-col items-center justify-center gap-1 text-zinc-400">
          <ArrowRight className="w-5 h-5 text-orange-400" />
          <label className="flex items-center gap-1 text-[0.7rem] cursor-pointer">
            <input
              type="checkbox"
              checked={mode === "structure" ? includeDrops : includeDeletes}
              onChange={(e) =>
                mode === "structure"
                  ? setIncludeDrops(e.target.checked)
                  : setIncludeDeletes(e.target.checked)
              }
            />
            <span>{mode === "structure" ? "Include DROPs" : "Include DELETEs"}</span>
          </label>
        </div>

        <div className="p-2.5 rounded-md border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#23252a] space-y-2">
          <div className="font-semibold text-zinc-500 uppercase text-[0.65rem] tracking-wider flex items-center justify-between">
            <span className="flex items-center gap-1">
              <Database className="w-3 h-3 text-emerald-400" /> Target (To Update)
            </span>
            {tgtConn?.environment === "production" && (
              <span className="px-1.5 py-0.5 rounded bg-red-600 text-white text-[0.6rem]">
                PRODUCTION
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <select
              value={tgtConnId}
              onChange={(e) => {
                setTgtConnId(e.target.value);
                initConn(e.target.value, false);
              }}
              className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
            >
              <option value="">Select Connection</option>
              {sqlConns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.engine})
                </option>
              ))}
            </select>
            <select
              value={effTgtDb}
              onChange={(e) => setTgtDb(e.target.value)}
              className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
            >
              {tgtDbs.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
            <select
              value={effTgtSchema}
              onChange={(e) => setTgtSchema(e.target.value)}
              className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
            >
              {tgtSchemas.length > 0 ? (
                tgtSchemas.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))
              ) : (
                <option value={effTgtSchema}>{effTgtSchema || "default"}</option>
              )}
            </select>
          </div>
        </div>
      </div>

      {/* Banners */}
      {error && (
        <div className="mx-4 mt-2 p-2.5 rounded bg-red-500/10 border border-red-500/30 text-red-400 flex items-center gap-2 shrink-0">
          <XCircle className="w-4 h-4 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}
      {execResult && (
        <div
          className={`mx-4 mt-2 p-2.5 rounded border flex items-center justify-between shrink-0 ${
            execResult.ok
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : "bg-red-500/10 border-red-500/30 text-red-400"
          }`}
        >
          <div className="flex items-center gap-2">
            {execResult.ok ? (
              <CheckCircle2 className="w-4 h-4" />
            ) : (
              <XCircle className="w-4 h-4" />
            )}
            <span>
              {execResult.summary} ({execResult.durationMs} ms)
            </span>
          </div>
          {execResult.errors.length > 0 && (
            <span className="text-[0.7rem] truncate max-w-md">
              {execResult.errors[0]}
            </span>
          )}
        </div>
      )}

      {/* Main Content Area */}
      {mode === "structure" ? (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 min-h-0 overflow-hidden">
          {/* Left: Visual Schema Diff Tree */}
          <div className="border-r border-zinc-200 dark:border-[#32343a] flex flex-col min-h-0 overflow-hidden">
            <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#23252a] flex items-center justify-between">
              <span className="font-semibold">
                Schema Diff {structPlan ? `— ${structPlan.summary}` : ""}
              </span>
              {structPlan && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      setSelectedStructTables(
                        new Set(
                          structPlan.tables
                            .filter((t) => t.ddlStatements.length > 0)
                            .map((t) => t.tableName)
                        )
                      )
                    }
                    className="text-indigo-400 hover:underline cursor-pointer"
                  >
                    Select Changed
                  </button>
                  <button
                    onClick={() => setSelectedStructTables(new Set())}
                    className="text-zinc-400 hover:underline cursor-pointer"
                  >
                    None
                  </button>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {!structPlan ? (
                <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-2 p-6 text-center">
                  <GitCompare className="w-8 h-8 opacity-40" />
                  <p>
                    Choose Source & Target connections above and click{" "}
                    <strong>Compare</strong> to inspect table, column, index, and
                    foreign key differences.
                  </p>
                </div>
              ) : (
                structPlan.tables.map((t) => {
                  const isOpen = expandedTables.has(t.tableName);
                  const checked = selectedStructTables.has(t.tableName);
                  return (
                    <div
                      key={t.tableName}
                      className="rounded border border-zinc-200 dark:border-[#35373c] bg-zinc-50/50 dark:bg-[#23252a]"
                    >
                      <div className="px-2.5 py-1.5 flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={t.ddlStatements.length === 0}
                          onChange={(e) => {
                            const next = new Set(selectedStructTables);
                            if (e.target.checked) next.add(t.tableName);
                            else next.delete(t.tableName);
                            setSelectedStructTables(next);
                          }}
                        />
                        <button
                          onClick={() => {
                            const next = new Set(expandedTables);
                            if (isOpen) next.delete(t.tableName);
                            else next.add(t.tableName);
                            setExpandedTables(next);
                          }}
                          className="flex items-center gap-1.5 flex-1 text-left cursor-pointer"
                        >
                          {isOpen ? (
                            <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 text-zinc-400" />
                          )}
                          <Table2 className="w-3.5 h-3.5 text-sky-400" />
                          <span className="font-mono font-medium">{t.tableName}</span>
                        </button>
                        <span
                          className={`px-1.5 py-0.5 rounded border text-[0.65rem] uppercase font-semibold ${STATUS_BADGE[t.status]}`}
                        >
                          {t.status}
                        </span>
                        <span className="text-[0.68rem] text-zinc-500">
                          {t.ddlStatements.length} DDL
                        </span>
                      </div>
                      {isOpen &&
                        (t.columnDiffs.length > 0 ||
                          t.indexDiffs.length > 0 ||
                          t.fkDiffs.length > 0) && (
                          <div className="px-7 pb-2 pt-1 border-t border-zinc-200 dark:border-[#32343a] space-y-1 text-[0.72rem]">
                            {t.columnDiffs.map((c) => (
                              <div
                                key={`c-${c.name}`}
                                className="flex items-center justify-between gap-2"
                              >
                                <span className="font-mono">
                                  COL <strong>{c.name}</strong>
                                </span>
                                <span className="text-zinc-400 truncate">{c.details}</span>
                                <span
                                  className={`px-1 rounded border text-[0.6rem] uppercase ${STATUS_BADGE[c.status]}`}
                                >
                                  {c.status}
                                </span>
                              </div>
                            ))}
                            {t.indexDiffs.map((i) => (
                              <div
                                key={`i-${i.name}`}
                                className="flex items-center justify-between gap-2"
                              >
                                <span className="font-mono text-purple-400">
                                  IDX {i.name}
                                </span>
                                <span className="text-zinc-400 truncate">{i.details}</span>
                                <span
                                  className={`px-1 rounded border text-[0.6rem] uppercase ${STATUS_BADGE[i.status]}`}
                                >
                                  {i.status}
                                </span>
                              </div>
                            ))}
                            {t.fkDiffs.map((f) => (
                              <div
                                key={`f-${f.name}`}
                                className="flex items-center justify-between gap-2"
                              >
                                <span className="font-mono text-amber-400">
                                  FK {f.name}
                                </span>
                                <span className="text-zinc-400 truncate">
                                  {f.sourceSummary || f.targetSummary}
                                </span>
                                <span
                                  className={`px-1 rounded border text-[0.6rem] uppercase ${STATUS_BADGE[f.status]}`}
                                >
                                  {f.status}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: Generated Migration DDL Script */}
          <div className="flex flex-col min-h-0 overflow-hidden">
            <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#23252a] flex items-center justify-between">
              <span className="font-semibold">Migration DDL Preview</span>
              <button
                onClick={() =>
                  navigator.clipboard?.writeText(activeStatements.join("\n"))
                }
                disabled={activeStatements.length === 0}
                className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200 disabled:opacity-40 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" /> Copy SQL
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-3 font-mono text-[0.75rem] bg-zinc-950 text-emerald-300 whitespace-pre-wrap">
              {activeStatements.length > 0
                ? activeStatements.join("\n\n")
                : "-- No migration statements selected."}
            </pre>
          </div>
        </div>
      ) : (
        /* Data Sync View */
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-[280px_1fr] min-h-0 overflow-hidden">
          {/* Table selector + custom keys */}
          <div className="border-r border-zinc-200 dark:border-[#32343a] flex flex-col min-h-0 overflow-hidden">
            <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#23252a] flex items-center justify-between">
              <span className="font-semibold">Tables ({srcTables.length})</span>
              <button
                onClick={() =>
                  setSelectedDataTables(
                    selectedDataTables.size === srcTables.length
                      ? new Set()
                      : new Set(srcTables.map((t) => t.name))
                  )
                }
                className="text-indigo-400 hover:underline cursor-pointer"
              >
                {selectedDataTables.size === srcTables.length ? "None" : "All"}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {srcTables.map((t) => {
                const checked = selectedDataTables.has(t.name);
                return (
                  <div
                    key={t.name}
                    className="p-2 rounded border border-zinc-200 dark:border-[#35373c] bg-zinc-50/50 dark:bg-[#23252a] space-y-1"
                  >
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const next = new Set(selectedDataTables);
                          if (e.target.checked) next.add(t.name);
                          else next.delete(t.name);
                          setSelectedDataTables(next);
                        }}
                      />
                      <span className="font-mono font-medium truncate">{t.name}</span>
                    </label>
                    {checked && (
                      <input
                        value={customKeys[t.name] ?? ""}
                        onChange={(e) =>
                          setCustomKeys((prev) => ({
                            ...prev,
                            [t.name]: e.target.value,
                          }))
                        }
                        placeholder="Key cols (blank = auto PK)"
                        className="w-full h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] text-[0.7rem]"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Data diff results & row inspector */}
          <div className="flex flex-col min-h-0 overflow-hidden">
            {!dataPlan ? (
              <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 gap-2 p-6 text-center">
                <GitCompare className="w-8 h-8 opacity-40" />
                <p>
                  Select tables on the left and click <strong>Compare</strong> to
                  compute streaming row-hash differences (Inserts / Updates / Deletes).
                </p>
              </div>
            ) : (
              <>
                <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#23252a] flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-semibold">
                      +{dataPlan.totalInserts} Inserts
                    </span>
                    <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 font-semibold">
                      ~{dataPlan.totalUpdates} Updates
                    </span>
                    <span className="px-2 py-0.5 rounded bg-red-500/15 text-red-400 font-semibold">
                      -{dataPlan.totalDeletes} Deletes
                    </span>
                  </div>
                  <div className="flex items-center gap-1 overflow-x-auto">
                    {dataPlan.tables.map((tb) => (
                      <button
                        key={tb.sourceTable}
                        onClick={() => setActiveDataTable(tb.sourceTable)}
                        className={`px-2 py-0.5 rounded font-mono cursor-pointer ${
                          activeDataTable === tb.sourceTable
                            ? "bg-indigo-600 text-white"
                            : "bg-zinc-200 dark:bg-[#32343a] text-zinc-700 dark:text-zinc-300"
                        }`}
                      >
                        {tb.sourceTable} ({tb.inserts + tb.updates + tb.deletes})
                      </button>
                    ))}
                  </div>
                </div>

                {currentDataDiff && (
                  <div className="flex-1 grid grid-cols-1 xl:grid-cols-2 min-h-0 overflow-hidden">
                    <div className="border-r border-zinc-200 dark:border-[#32343a] overflow-y-auto p-2 space-y-1.5">
                      {currentDataDiff.error && (
                        <div className="p-2 rounded bg-red-500/10 text-red-400">
                          {currentDataDiff.error}
                        </div>
                      )}
                      {currentDataDiff.sampleDiffs.length === 0 ? (
                        <div className="p-6 text-center text-zinc-500">
                          Table is in sync ({currentDataDiff.unchanged} unchanged rows).
                        </div>
                      ) : (
                        currentDataDiff.sampleDiffs.map((row, i) => (
                          <div
                            key={i}
                            className="p-2 rounded border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#23252a] space-y-1"
                          >
                            <div className="flex items-center justify-between">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[0.65rem] font-semibold uppercase ${
                                  row.kind === "insert"
                                    ? "bg-emerald-500/20 text-emerald-400"
                                    : row.kind === "update"
                                    ? "bg-amber-500/20 text-amber-400"
                                    : "bg-red-500/20 text-red-400"
                                }`}
                              >
                                {row.kind}
                              </span>
                              <span className="font-mono text-zinc-400 text-[0.7rem]">
                                Key: {JSON.stringify(row.keyValues)}
                              </span>
                            </div>
                            {row.changedColumns.length > 0 && (
                              <div className="text-[0.7rem] text-zinc-400">
                                Changed:{" "}
                                <span className="font-mono text-amber-300">
                                  {row.changedColumns.join(", ")}
                                </span>
                              </div>
                            )}
                            <div className="font-mono text-[0.7rem] text-zinc-300 bg-zinc-950/60 p-1.5 rounded overflow-x-auto">
                              {row.sql}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                    <pre className="overflow-auto p-3 font-mono text-[0.72rem] bg-zinc-950 text-emerald-300 whitespace-pre-wrap">
                      {currentDataDiff.statements.length > 0
                        ? currentDataDiff.statements.join("\n")
                        : "-- No sync SQL statements for this table."}
                    </pre>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
