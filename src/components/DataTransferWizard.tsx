import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Play,
  Plus,
  Save,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  DatabaseObject,
  DataJobProfile,
  DataTransferResult,
  ImportErrorPolicy,
  ObjectKind,
  TransferObjectSelection,
  TransferTableMode,
  TypeMappingRule,
} from "../types/datavault";

const TRANSFERABLE_OBJECT_KINDS: ObjectKind[] = [
  "view",
  "materialized_view",
  "function",
  "procedure",
  "trigger",
  "event",
  "sequence",
  "enum_type",
];

interface ObjectCategory {
  id: string;
  label: string;
  kinds: ObjectKind[];
}

const OBJECT_CATEGORIES: ObjectCategory[] = [
  { id: "tables", label: "Tables / Collections", kinds: ["table", "collection"] },
  { id: "views", label: "Views", kinds: ["view", "materialized_view"] },
  { id: "functions", label: "Functions", kinds: ["function"] },
  { id: "procedures", label: "Procedures", kinds: ["procedure"] },
  { id: "triggers", label: "Triggers", kinds: ["trigger"] },
  { id: "events", label: "Events", kinds: ["event"] },
  { id: "other", label: "Sequences & Types", kinds: ["sequence", "enum_type"] },
];

const objKey = (kind: ObjectKind, name: string) => `${kind}::${name}`;

export const DataTransferWizard: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
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

  const [srcConnId, setSrcConnId] = useState(tab.connectionId ?? connections[0]?.id ?? "");
  const [srcDb, setSrcDb] = useState(tab.database ?? "");
  const [srcSchema, setSrcSchema] = useState(tab.schema ?? "");

  const [tgtConnId, setTgtConnId] = useState(connections[1]?.id ?? connections[0]?.id ?? "");
  const [tgtDb, setTgtDb] = useState("");
  const [tgtSchema, setTgtSchema] = useState("");

  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [selectedObjects, setSelectedObjects] = useState<Set<string>>(new Set());
  const [includeData, setIncludeData] = useState(true);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(["tables", "views", "functions", "procedures"])
  );
  const [mode, setMode] = useState<TransferTableMode>("create_if_not_exists");
  const [errorPolicy, setErrorPolicy] = useState<ImportErrorPolicy>("stop_on_error");
  const [batchSize, setBatchSize] = useState(250);
  const [typeMappings, setTypeMappings] = useState<TypeMappingRule[]>([]);

  const [running, setRunning] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [result, setResult] = useState<DataTransferResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [profiles, setProfiles] = useState<DataJobProfile[]>([]);
  const [profileName, setProfileName] = useState("");

  const srcConn = connections.find((c) => c.id === srcConnId);
  const tgtConn = connections.find((c) => c.id === tgtConnId);

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
  const allSrcObjects = objectsByKey[`${srcConnId}::${effSrcDb}::${effSrcSchema}`] ?? [];
  const srcTableObjects = useMemo(
    () => allSrcObjects.filter((o) => o.kind === "table" || o.kind === "collection"),
    [allSrcObjects]
  );
  const srcOtherObjects = useMemo(
    () => allSrcObjects.filter((o) => TRANSFERABLE_OBJECT_KINDS.includes(o.kind)),
    [allSrcObjects]
  );
  const objectsByCategory = useMemo(() => {
    const map: Record<string, DatabaseObject[]> = {};
    for (const cat of OBJECT_CATEGORIES) {
      map[cat.id] = allSrcObjects.filter((o) => cat.kinds.includes(o.kind));
    }
    return map;
  }, [allSrcObjects]);
  const totalAvailableCount = srcTableObjects.length + srcOtherObjects.length;
  const totalSelectedCount = selectedTables.size + selectedObjects.size;

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

  const loadProfiles = useCallback(async () => {
    try {
      setProfiles(await api.listJobProfiles("transfer"));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  // Auto-load default Type Mapping Matrix whenever source or target engine changes
  useEffect(() => {
    if (!srcConn || !tgtConn) return;
    api
      .getDefaultTypeMappings(srcConn.engine, tgtConn.engine)
      .then((rules) => setTypeMappings(rules))
      .catch(() => {});
  }, [srcConn?.engine, tgtConn?.engine]);

  const initConnection = async (cid: string, isSource: boolean) => {
    if (!cid) return;
    if (!connectedIds.has(cid)) await connectTo(cid);
    const dbList = await loadDatabases(cid);
    const c = connections.find((x) => x.id === cid);
    const d = c?.database || dbList[0]?.name || "";
    if (isSource) setSrcDb(d);
    else setTgtDb(d);

    if (d && (c?.engine === "postgres" || c?.engine === "mssql")) {
      const sc = await loadSchemas(cid, d);
      const pref = c.engine === "mssql" ? "dbo" : "public";
      const chosen = sc.find((s) => s.name === pref)?.name ?? sc[0]?.name ?? pref;
      if (isSource) {
        setSrcSchema(chosen);
        await loadObjects(cid, d, chosen);
      } else {
        setTgtSchema(chosen);
      }
    } else if (d && isSource) {
      setSrcSchema(d);
      await loadObjects(cid, d, d);
    } else if (d) {
      setTgtSchema(d);
    }
  };

  const executeTransfer = async (confirmedProduction = false) => {
    const tbls = Array.from(selectedTables);
    const objs: TransferObjectSelection[] = srcOtherObjects
      .filter((o) => selectedObjects.has(objKey(o.kind, o.name)))
      .map((o) => ({ name: o.name, kind: o.kind }));

    if (!srcConnId || !tgtConnId || (tbls.length === 0 && objs.length === 0)) {
      setError("Select source connection, target connection, and at least one database object.");
      return;
    }
    if (tgtConn?.environment === "production" && !confirmedProduction) {
      openSafetyModal({
        title: `Data Transfer to PRODUCTION (${tgtConn.name})`,
        warnings: [
          `Target connection "${tgtConn.name}" is marked PRODUCTION!`,
          `Mode: ${mode} (${tbls.length} table(s), ${objs.length} object(s))`,
        ],
        sqlPreview: `TRANSFER ${[...tbls, ...objs.map((o) => `${o.kind}:${o.name}`)].join(", ")}\nFROM ${srcConn?.name} (${srcConn?.engine})\nTO ${tgtConn.name} (${tgtConn.engine})`,
        onConfirm: () => executeTransfer(true),
      });
      return;
    }

    const jobId = `transfer-${Date.now()}`;
    setActiveJobId(jobId);
    setRunning(true);
    setError(null);
    setResult(null);

    try {
      const res = await api.runDataTransfer({
        jobId,
        sourceConnectionId: srcConnId,
        sourceDatabase: effSrcDb || null,
        sourceSchema: effSrcSchema || null,
        targetConnectionId: tgtConnId,
        targetDatabase: effTgtDb || null,
        targetSchema: effTgtSchema || null,
        tables: tbls.map((t) => ({
          sourceTable: t,
          targetTable: t,
          includeData,
        })),
        objects: objs,
        mode,
        typeMappings,
        batchSize,
        errorPolicy,
        confirmedProduction,
      });
      setResult(res);
      addLog(res.ok ? "success" : "error", res.summary);
    } catch (err) {
      const msg = formatApiError(err);
      setError(msg);
      addLog("error", msg);
    } finally {
      setRunning(false);
      setActiveJobId(null);
    }
  };

  const handleSaveProfile = async () => {
    if (!profileName.trim()) return;
    await api.saveJobProfile({
      id: "",
      name: profileName.trim(),
      kind: "transfer",
      config: {
        srcConnId,
        srcDb: effSrcDb,
        srcSchema: effSrcSchema,
        tgtConnId,
        tgtDb: effTgtDb,
        tgtSchema: effTgtSchema,
        selectedTables: Array.from(selectedTables),
        selectedObjects: Array.from(selectedObjects),
        includeData,
        mode,
        errorPolicy,
        batchSize,
        typeMappings,
      },
      updatedAt: "",
    });
    setProfileName("");
    loadProfiles();
    addLog("success", `Saved Transfer Profile "${profileName.trim()}"`);
  };

  const isCrossEngine = srcConn && tgtConn && srcConn.engine !== tgtConn.engine;

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#1e1f22] text-xs">
      {/* Header */}
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="w-4 h-4 text-teal-400" />
          <span className="font-semibold">Data Transfer Wizard</span>
          {isCrossEngine && (
            <span className="px-2 py-0.5 rounded bg-teal-500/20 text-teal-400 font-mono text-[0.7rem]">
              Cross-Engine: {srcConn.engine.toUpperCase()} → {tgtConn.engine.toUpperCase()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <button
              onClick={() => activeJobId && api.cancelDataJob(activeJobId)}
              className="h-7 px-3 rounded bg-red-600 hover:bg-red-500 text-white font-medium flex items-center gap-1.5"
            >
              <Square className="w-3 h-3 fill-current" /> Cancel Transfer
            </button>
          ) : (
            <button
              onClick={() => executeTransfer(false)}
              className="h-7 px-3.5 rounded bg-teal-600 hover:bg-teal-500 text-white font-medium flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5 fill-current" /> Start Transfer
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 font-mono">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Source -> Target Pickers */}
        <div className="grid grid-cols-1 lg:grid-cols-11 gap-3 items-stretch">
          <div className="lg:col-span-5 p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a] space-y-2">
            <div className="font-semibold text-sky-400">Source Database</div>
            <div className="grid grid-cols-3 gap-2">
              <select
                value={srcConnId}
                onChange={(e) => {
                  setSrcConnId(e.target.value);
                  initConnection(e.target.value, true);
                }}
                className="h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700"
              >
                <option value="">Connection...</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.engine})
                  </option>
                ))}
              </select>
              <select
                value={effSrcDb}
                onChange={(e) => {
                  setSrcDb(e.target.value);
                  loadObjects(srcConnId, e.target.value, e.target.value);
                }}
                className="h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
              >
                {srcDbs.length === 0 && <option value={effSrcDb}>{effSrcDb || "db"}</option>}
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
                className="h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
              >
                {srcSchemas.length === 0 && <option value={effSrcSchema}>{effSrcSchema || "—"}</option>}
                {srcSchemas.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="lg:col-span-1 flex items-center justify-center text-teal-400">
            <ArrowRight className="w-6 h-6" />
          </div>

          <div className="lg:col-span-5 p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a] space-y-2">
            <div className="font-semibold text-emerald-400">Target Database</div>
            <div className="grid grid-cols-3 gap-2">
              <select
                value={tgtConnId}
                onChange={(e) => {
                  setTgtConnId(e.target.value);
                  initConnection(e.target.value, false);
                }}
                className="h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700"
              >
                <option value="">Connection...</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.engine})
                  </option>
                ))}
              </select>
              <select
                value={effTgtDb}
                onChange={(e) => setTgtDb(e.target.value)}
                className="h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
              >
                {tgtDbs.length === 0 && <option value={effTgtDb}>{effTgtDb || "db"}</option>}
                {tgtDbs.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
              <select
                value={effTgtSchema}
                onChange={(e) => setTgtSchema(e.target.value)}
                className="h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
              >
                {tgtSchemas.length === 0 && <option value={effTgtSchema}>{effTgtSchema || "—"}</option>}
                {tgtSchemas.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Options + Table Picker + Type Mapping Matrix */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Database Objects Selection (Navicat-style) */}
          <div className="p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a] space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold">
                Database Objects ({totalSelectedCount}/{totalAvailableCount})
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setSelectedTables(new Set(srcTableObjects.map((o) => o.name)));
                    if (!isCrossEngine) {
                      setSelectedObjects(
                        new Set(srcOtherObjects.map((o) => objKey(o.kind, o.name)))
                      );
                    }
                  }}
                  className="text-sky-400 hover:underline cursor-pointer"
                >
                  All
                </button>
                <button
                  onClick={() => {
                    setSelectedTables(new Set());
                    setSelectedObjects(new Set());
                  }}
                  className="text-zinc-500 hover:underline cursor-pointer"
                >
                  None
                </button>
              </div>
            </div>
            <div className="max-h-64 overflow-auto space-y-1.5 p-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-200 dark:border-zinc-800">
              {totalAvailableCount === 0 ? (
                <div className="py-8 text-center text-zinc-500">
                  Select a connected source database to list objects.
                </div>
              ) : (
                OBJECT_CATEGORIES.map((cat) => {
                  const items = objectsByCategory[cat.id] ?? [];
                  if (items.length === 0) return null;
                  const isTableCat = cat.id === "tables";
                  const disabled = !isTableCat && Boolean(isCrossEngine);
                  const selectedInCat = isTableCat
                    ? items.filter((o) => selectedTables.has(o.name)).length
                    : items.filter((o) => selectedObjects.has(objKey(o.kind, o.name))).length;
                  const allInCatSelected = selectedInCat === items.length && items.length > 0;
                  const expanded = expandedCategories.has(cat.id);

                  return (
                    <div key={cat.id} className="space-y-0.5">
                      <div className="flex items-center justify-between px-1.5 py-1 rounded bg-zinc-100/80 dark:bg-[#25262a]">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedCategories((prev) => {
                                const next = new Set(prev);
                                if (next.has(cat.id)) next.delete(cat.id);
                                else next.add(cat.id);
                                return next;
                              })
                            }
                            className="text-zinc-500 hover:text-zinc-200 cursor-pointer"
                          >
                            {expanded ? (
                              <ChevronDown className="w-3.5 h-3.5" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <input
                            type="checkbox"
                            disabled={disabled}
                            checked={allInCatSelected}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              if (isTableCat) {
                                setSelectedTables((prev) => {
                                  const next = new Set(prev);
                                  for (const item of items) {
                                    if (checked) next.add(item.name);
                                    else next.delete(item.name);
                                  }
                                  return next;
                                });
                              } else {
                                setSelectedObjects((prev) => {
                                  const next = new Set(prev);
                                  for (const item of items) {
                                    const k = objKey(item.kind, item.name);
                                    if (checked) next.add(k);
                                    else next.delete(k);
                                  }
                                  return next;
                                });
                              }
                            }}
                          />
                          <span className={`font-semibold truncate ${disabled ? "text-zinc-500" : ""}`}>
                            {cat.label}
                          </span>
                        </div>
                        <span className="text-[0.68rem] font-mono text-zinc-500 shrink-0">
                          {disabled ? "same-engine only" : `${selectedInCat}/${items.length}`}
                        </span>
                      </div>

                      {expanded && (
                        <div className="pl-5 space-y-0.5">
                          {items.map((o) => {
                            const key = objKey(o.kind, o.name);
                            const isChecked = isTableCat
                              ? selectedTables.has(o.name)
                              : selectedObjects.has(key);
                            return (
                              <label
                                key={key}
                                className={`flex items-center justify-between px-2 py-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 font-mono ${
                                  disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
                                }`}
                              >
                                <span className="flex items-center gap-1.5 truncate">
                                  <input
                                    type="checkbox"
                                    disabled={disabled}
                                    checked={isChecked}
                                    onChange={(e) => {
                                      const checked = e.target.checked;
                                      if (isTableCat) {
                                        setSelectedTables((prev) => {
                                          const next = new Set(prev);
                                          if (checked) next.add(o.name);
                                          else next.delete(o.name);
                                          return next;
                                        });
                                      } else {
                                        setSelectedObjects((prev) => {
                                          const next = new Set(prev);
                                          if (checked) next.add(key);
                                          else next.delete(key);
                                          return next;
                                        });
                                      }
                                    }}
                                  />
                                  <span className="truncate">{o.name}</span>
                                </span>
                                <span className="text-[0.66rem] text-zinc-500 shrink-0 ml-2">
                                  {o.kind}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeData}
                  onChange={(e) => setIncludeData(e.target.checked)}
                />
                <span>Include Table Data (uncheck for structure-only copy)</span>
              </label>
              <div>
                <label className="block text-zinc-500 mb-1">Transfer Mode</label>
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as TransferTableMode)}
                  className="w-full h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700"
                >
                  <option value="create_if_not_exists">Create if Missing & Insert</option>
                  <option value="drop_and_recreate">Drop & Recreate Target</option>
                  <option value="append">Append to Existing Table</option>
                  <option value="upsert">Upsert (Match Primary Key)</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-zinc-500 mb-1">Batch Size</label>
                  <input
                    type="number"
                    value={batchSize}
                    onChange={(e) => setBatchSize(Number(e.target.value) || 250)}
                    className="w-full h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-zinc-500 mb-1">On Error</label>
                  <select
                    value={errorPolicy}
                    onChange={(e) => setErrorPolicy(e.target.value as ImportErrorPolicy)}
                    className="w-full h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700"
                  >
                    <option value="stop_on_error">Stop</option>
                    <option value="skip_and_log">Skip Object</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Customizable Type Mapping Matrix */}
          <div className="p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a] space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Type Mapping Matrix</span>
              <button
                onClick={() =>
                  setTypeMappings((prev) => [...prev, { sourceType: "", targetType: "" }])
                }
                className="h-6 px-2 rounded border border-zinc-300 dark:border-zinc-700 flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> Add Rule
              </button>
            </div>
            <div className="max-h-72 overflow-auto space-y-1">
              {typeMappings.map((rule, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <input
                    value={rule.sourceType}
                    onChange={(e) =>
                      setTypeMappings((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, sourceType: e.target.value } : x))
                      )
                    }
                    placeholder="source type"
                    className="flex-1 h-6 px-1.5 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono"
                  />
                  <span className="text-zinc-500">→</span>
                  <input
                    value={rule.targetType}
                    onChange={(e) =>
                      setTypeMappings((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, targetType: e.target.value } : x))
                      )
                    }
                    placeholder="target type"
                    className="flex-1 h-6 px-1.5 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700 font-mono text-teal-400"
                  />
                  <button
                    onClick={() => setTypeMappings((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-zinc-500 hover:text-red-400 p-0.5"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Saved Transfer Profiles */}
          <div className="p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a] space-y-2.5">
            <div className="font-semibold">Transfer Profiles</div>
            <div className="flex gap-1.5">
              <input
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                placeholder="Profile name..."
                className="flex-1 h-7 px-2 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-zinc-700"
              />
              <button
                onClick={handleSaveProfile}
                className="h-7 px-2.5 rounded bg-teal-600 hover:bg-teal-500 text-white flex items-center gap-1"
              >
                <Save className="w-3.5 h-3.5" /> Save
              </button>
            </div>
            <div className="space-y-1.5 max-h-64 overflow-auto">
              {profiles.length === 0 ? (
                <div className="text-zinc-500 py-6 text-center">No saved transfer profiles.</div>
              ) : (
                profiles.map((p) => (
                  <div
                    key={p.id}
                    className="p-2 rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#1e1f22] flex items-center justify-between gap-2"
                  >
                    <button
                      onClick={() => {
                        const cfg = p.config as Record<string, unknown>;
                        if (typeof cfg.srcConnId === "string") setSrcConnId(cfg.srcConnId);
                        if (typeof cfg.srcDb === "string") setSrcDb(cfg.srcDb);
                        if (typeof cfg.srcSchema === "string") setSrcSchema(cfg.srcSchema);
                        if (typeof cfg.tgtConnId === "string") setTgtConnId(cfg.tgtConnId);
                        if (typeof cfg.tgtDb === "string") setTgtDb(cfg.tgtDb);
                        if (typeof cfg.tgtSchema === "string") setTgtSchema(cfg.tgtSchema);
                        if (Array.isArray(cfg.selectedTables))
                          setSelectedTables(new Set(cfg.selectedTables as string[]));
                        if (Array.isArray(cfg.selectedObjects))
                          setSelectedObjects(new Set(cfg.selectedObjects as string[]));
                        if (typeof cfg.includeData === "boolean")
                          setIncludeData(cfg.includeData);
                        if (typeof cfg.mode === "string") setMode(cfg.mode as TransferTableMode);
                        if (Array.isArray(cfg.typeMappings))
                          setTypeMappings(cfg.typeMappings as TypeMappingRule[]);
                        addLog("info", `Loaded transfer profile "${p.name}"`);
                      }}
                      className="text-left flex-1 min-w-0 hover:text-teal-400"
                    >
                      <div className="font-medium truncate">{p.name}</div>
                      <div className="text-[0.68rem] text-zinc-500 font-mono">
                        {new Date(p.updatedAt).toLocaleString()}
                      </div>
                    </button>
                    <button
                      onClick={async () => {
                        await api.deleteJobProfile(p.id);
                        loadProfiles();
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

        {/* Transfer Result Report */}
        {result && (
          <div
            className={`p-3.5 rounded-lg border space-y-2.5 ${
              result.ok
                ? "border-emerald-500/40 bg-emerald-500/10"
                : "border-amber-500/40 bg-amber-500/10"
            }`}
          >
            <div className="flex items-center gap-2 font-semibold">
              {result.ok ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              ) : (
                <XCircle className="w-4 h-4 text-amber-400" />
              )}
              <span>{result.summary}</span>
              <span className="ml-auto font-mono text-zinc-400">{result.durationMs}ms</span>
            </div>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-zinc-700/40 text-zinc-400">
                  <th className="py-1 px-2">Type</th>
                  <th className="py-1 px-2">Source</th>
                  <th className="py-1 px-2">Target</th>
                  <th className="py-1 px-2 text-right">Rows</th>
                  <th className="py-1 px-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {result.tables.map((tr) => (
                  <tr key={`tbl-${tr.sourceTable}`} className="border-b border-zinc-800/40 font-mono">
                    <td className="py-1 px-2 text-sky-400">table</td>
                    <td className="py-1 px-2">{tr.sourceTable}</td>
                    <td className="py-1 px-2">{tr.targetTable}</td>
                    <td className="py-1 px-2 text-right">{tr.rowsTransferred.toLocaleString()}</td>
                    <td className="py-1 px-2">
                      {tr.ok ? (
                        <span className="text-emerald-400">OK</span>
                      ) : (
                        <span className="text-red-400">{tr.error}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {(result.objects ?? []).map((or) => (
                  <tr key={`obj-${or.kind}-${or.name}`} className="border-b border-zinc-800/40 font-mono">
                    <td className="py-1 px-2 text-purple-400">{or.kind}</td>
                    <td className="py-1 px-2">{or.name}</td>
                    <td className="py-1 px-2">{or.name}</td>
                    <td className="py-1 px-2 text-right">—</td>
                    <td className="py-1 px-2">
                      {or.ok ? (
                        <span className="text-emerald-400">OK</span>
                      ) : (
                        <span className="text-red-400">{or.error}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
