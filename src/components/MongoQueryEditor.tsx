import React, { useState } from "react";
import Editor from "@monaco-editor/react";
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Braces,
  Layers,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  ExplainPlanResult,
  MongoAggregationStage,
  MongoAggregationStageResult,
  MongoQueryRequest,
  MongoQueryResponse,
} from "../types/datavault";

const AGG_OPERATORS = [
  "$match",
  "$project",
  "$group",
  "$sort",
  "$limit",
  "$skip",
  "$unwind",
  "$lookup",
  "$addFields",
  "$count",
];

const DEFAULT_STAGE_BODIES: Record<string, string> = {
  $match: '{\n  "status": "active"\n}',
  $project: '{\n  "_id": 1,\n  "name": 1\n}',
  $group: '{\n  "_id": "$category",\n  "total": { "$sum": 1 }\n}',
  $sort: '{\n  "total": -1\n}',
  $limit: "20",
  $skip: "0",
  $unwind: '"$tags"',
  $lookup:
    '{\n  "from": "other_collection",\n  "localField": "refId",\n  "foreignField": "_id",\n  "as": "joined"\n}',
  $addFields: '{\n  "computed": true\n}',
  $count: '"totalDocs"',
};

export const MongoQueryEditor: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
  const {
    connections,
    databasesByConn,
    objectsByKey,
    openSafetyModal,
    addLog,
    refreshHistory,
    theme,
    uiFontSize,
  } = useWorkbenchStore();

  const mongoConns = connections.filter((c) => c.engine === "mongodb");
  const [connId, setConnId] = useState(tab.connectionId ?? mongoConns[0]?.id ?? "");
  const [database, setDatabase] = useState(tab.database ?? "");
  const [collection, setCollection] = useState(tab.collection ?? "");
  const [mode, setMode] = useState<"mql" | "pipeline">(tab.mongoMode ?? "mql");

  // MQL mode state
  const [operation, setOperation] = useState<MongoQueryRequest["operation"]>("find");
  const [payloadJson, setPayloadJson] = useState("{\n  \n}");
  const [updateJson, setUpdateJson] = useState('{\n  "$set": {}\n}');
  const [limit, setLimit] = useState(100);
  const [mqlResult, setMqlResult] = useState<MongoQueryResponse | null>(null);
  const [explainResult, setExplainResult] = useState<ExplainPlanResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stage-by-Stage Aggregation Pipeline Builder state
  const [stages, setStages] = useState<MongoAggregationStage[]>([
    {
      id: "st-1",
      operator: "$match",
      bodyJson: "{\n  \n}",
      enabled: true,
    },
    {
      id: "st-2",
      operator: "$limit",
      bodyJson: "20",
      enabled: true,
    },
  ]);
  const [stageResults, setStageResults] = useState<MongoAggregationStageResult[]>([]);
  const [selectedStageIdx, setSelectedStageIdx] = useState<number>(0);

  const selectedConn = connections.find((c) => c.id === connId);
  const dbs = databasesByConn[connId] ?? [];
  const effectiveDb = database || selectedConn?.database || dbs[0]?.name || "admin";
  const collections = (objectsByKey[`${connId}::${effectiveDb}::${effectiveDb}`] ?? []).filter(
    (o) => o.kind === "collection" || o.kind === "view"
  );

  const executeMql = async (confirmedSafety = false) => {
    if (!connId || !collection) {
      setError("Select a MongoDB connection and collection first.");
      return;
    }
    const isWrite = ["insertOne", "updateMany", "deleteMany", "command"].includes(operation);
    if (isWrite && selectedConn?.environment === "production" && !confirmedSafety) {
      openSafetyModal({
        title: `Confirm MongoDB ${operation} on ${collection}`,
        warnings: [`Target MongoDB "${selectedConn.name}" is PRODUCTION!`],
        sqlPreview: `db.${collection}.${operation}(${payloadJson})`,
        onConfirm: () => executeMql(true),
      });
      return;
    }

    setRunning(true);
    setError(null);
    setExplainResult(null);
    try {
      const res = await api.mongoExecuteMql({
        connectionId: connId,
        database: effectiveDb,
        collection,
        operation,
        filterJson:
          operation === "find" ||
          operation === "count" ||
          operation === "updateMany" ||
          operation === "deleteMany"
            ? payloadJson
            : null,
        pipelineJson: operation === "aggregate" ? payloadJson : null,
        documentJson: operation === "insertOne" || operation === "command" ? payloadJson : null,
        updateJson: operation === "updateMany" ? updateJson : null,
        limit,
        skip: 0,
        confirmedSafety,
      });
      setMqlResult(res);
      addLog("success", `${res.summary} (${res.executionMs}ms)`);
      refreshHistory();
    } catch (err) {
      const msg = formatApiError(err);
      setError(msg);
      addLog("error", msg);
    } finally {
      setRunning(false);
    }
  };

  const handleExplain = async () => {
    if (!connId || !collection) return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.mongoExplainMql(connId, effectiveDb, collection, payloadJson);
      setExplainResult(res);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setRunning(false);
    }
  };

  const runPipelinePreview = async () => {
    if (!connId || !collection) {
      setError("Select a MongoDB connection and collection first.");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const results = await api.mongoPreviewAggregationStages(
        connId,
        effectiveDb,
        collection,
        stages
      );
      setStageResults(results);
      if (results.length > 0) {
        setSelectedStageIdx(results[results.length - 1].stageIndex);
      }
      addLog("success", `Previewed ${results.length} aggregation stage(s) on ${collection}`);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setRunning(false);
    }
  };

  const moveStage = (idx: number, dir: -1 | 1) => {
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= stages.length) return;
    setStages((prev) => {
      const copy = [...prev];
      [copy[idx], copy[nextIdx]] = [copy[nextIdx], copy[idx]];
      return copy;
    });
  };

  const activeStageRes = stageResults.find((r) => r.stageIndex === selectedStageIdx);

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-950 text-xs">
      {/* Toolbar */}
      <div className="px-2.5 py-1.5 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/70 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {/* Mode Switcher */}
          <div className="flex rounded border border-zinc-300 dark:border-zinc-700 overflow-hidden">
            <button
              onClick={() => setMode("mql")}
              className={`h-7 px-2.5 flex items-center gap-1.5 ${
                mode === "mql"
                  ? "bg-emerald-600 text-white font-medium"
                  : "hover:bg-zinc-200 dark:hover:bg-zinc-800"
              }`}
            >
              <Braces className="w-3.5 h-3.5" /> MQL Editor
            </button>
            <button
              onClick={() => setMode("pipeline")}
              className={`h-7 px-2.5 flex items-center gap-1.5 ${
                mode === "pipeline"
                  ? "bg-emerald-600 text-white font-medium"
                  : "hover:bg-zinc-200 dark:hover:bg-zinc-800"
              }`}
            >
              <Layers className="w-3.5 h-3.5" /> Aggregation Pipeline Builder
            </button>
          </div>

          {mode === "mql" ? (
            <>
              <select
                value={operation}
                onChange={(e) => {
                  const op = e.target.value as MongoQueryRequest["operation"];
                  setOperation(op);
                  if (op === "aggregate") setPayloadJson("[\n  { \"$match\": {} },\n  { \"$limit\": 20 }\n]");
                  else setPayloadJson("{\n  \n}");
                }}
                className="h-7 px-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
              >
                <option value="find">find</option>
                <option value="aggregate">aggregate</option>
                <option value="count">countDocuments</option>
                <option value="insertOne">insertOne</option>
                <option value="updateMany">updateMany</option>
                <option value="deleteMany">deleteMany</option>
                <option value="command">runCommand</option>
              </select>
              <button
                onClick={() => executeMql(false)}
                disabled={running}
                className="h-7 px-3 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5"
              >
                <Play className="w-3.5 h-3.5 fill-current" /> Run
              </button>
              <button
                onClick={handleExplain}
                disabled={running}
                className="h-7 px-2.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-1"
              >
                <Activity className="w-3.5 h-3.5 text-amber-400" /> Explain
              </button>
            </>
          ) : (
            <button
              onClick={runPipelinePreview}
              disabled={running}
              className="h-7 px-3 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5"
            >
              <Play className="w-3.5 h-3.5 fill-current" /> Run Stage-by-Stage Preview
            </button>
          )}
        </div>

        {/* Target Connection / DB / Collection */}
        <div className="flex items-center gap-1.5">
          <select
            value={connId}
            onChange={(e) => setConnId(e.target.value)}
            className="h-7 px-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700"
          >
            <option value="">MongoDB Connection...</option>
            {mongoConns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={effectiveDb}
            onChange={(e) => setDatabase(e.target.value)}
            className="h-7 px-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
          >
            {dbs.length === 0 && <option value={effectiveDb}>{effectiveDb}</option>}
            {dbs.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
          <input
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            list="mongo-colls-list"
            placeholder="collection"
            className="h-7 px-2 w-40 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
          />
          <datalist id="mongo-colls-list">
            {collections.map((c) => (
              <option key={c.name} value={c.name} />
            ))}
          </datalist>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 font-mono">
          {error}
        </div>
      )}

      {mode === "mql" ? (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="h-[44%] min-h-[160px] flex border-b border-zinc-200 dark:border-zinc-800">
            <div className="flex-1 flex flex-col">
              <div className="px-2.5 py-1 bg-zinc-100 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 text-[0.72rem] text-zinc-500 flex items-center justify-between">
                <span>
                  {operation === "aggregate"
                    ? "Pipeline Stages (JSON Array)"
                    : operation === "insertOne"
                    ? "Document JSON"
                    : operation === "command"
                    ? "Database Command JSON"
                    : "Filter Query JSON"}
                </span>
                {operation === "find" && (
                  <label className="flex items-center gap-1">
                    Limit:
                    <input
                      type="number"
                      value={limit}
                      onChange={(e) => setLimit(Number(e.target.value) || 100)}
                      className="w-16 h-5 px-1 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                    />
                  </label>
                )}
              </div>
              <div className="flex-1">
                <Editor
                  height="100%"
                  defaultLanguage="json"
                  theme={theme === "light" ? "light" : "vs-dark"}
                  value={payloadJson}
                  onChange={(v) => setPayloadJson(v ?? "")}
                  options={{
                    minimap: { enabled: false },
                    fontSize: Math.max(13, Math.round(uiFontSize * 0.85)),
                    automaticLayout: true,
                    tabSize: 2,
                  }}
                />
              </div>
            </div>

            {operation === "updateMany" && (
              <div className="flex-1 flex flex-col border-l border-zinc-200 dark:border-zinc-800">
                <div className="px-2.5 py-1 bg-zinc-100 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 text-[0.72rem] text-zinc-500">
                  Update Document JSON (e.g. $set)
                </div>
                <div className="flex-1">
                  <Editor
                    height="100%"
                    defaultLanguage="json"
                    theme={theme === "light" ? "light" : "vs-dark"}
                    value={updateJson}
                    onChange={(v) => setUpdateJson(v ?? "")}
                    options={{
                      minimap: { enabled: false },
                      fontSize: Math.max(13, Math.round(uiFontSize * 0.85)),
                      automaticLayout: true,
                      tabSize: 2,
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-auto p-3">
            {explainResult ? (
              <div className="space-y-2">
                <div className="font-semibold text-amber-400 flex items-center gap-1.5">
                  <Activity className="w-4 h-4" />
                  MongoDB Explain (executionStats) — {explainResult.executionMs}ms
                </div>
                {explainResult.root && (
                  <div
                    className={`p-2.5 rounded-lg border ${
                      explainResult.root.isFullScan
                        ? "border-amber-500/50 bg-amber-500/10"
                        : "border-zinc-700 bg-zinc-900"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-semibold">
                      {explainResult.root.isFullScan && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[0.72rem]">
                          <AlertTriangle className="w-3 h-3" /> COLLSCAN
                        </span>
                      )}
                      <span>{explainResult.root.nodeType}</span>
                      {explainResult.root.extra && (
                        <span className="font-mono text-zinc-400">{explainResult.root.extra}</span>
                      )}
                    </div>
                  </div>
                )}
                <pre className="p-3 rounded bg-zinc-900 border border-zinc-800 font-mono text-xs overflow-auto">
                  {JSON.stringify(explainResult.rawJson, null, 2)}
                </pre>
              </div>
            ) : mqlResult ? (
              <div className="space-y-2">
                <div className="text-emerald-400 font-mono">
                  {mqlResult.summary} ({mqlResult.executionMs}ms)
                </div>
                <pre className="p-3 rounded bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 font-mono text-xs overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(mqlResult.documents, null, 2)}
                </pre>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-zinc-500">
                Write MQL JSON above and click Run.
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Stage-by-Stage Aggregation Pipeline Builder */
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Left: Ordered Stage Cards */}
          <div className="w-1/2 border-r border-zinc-200 dark:border-zinc-800 overflow-y-auto p-3 space-y-2.5">
            {stages.map((st, idx) => {
              const res = stageResults.find((r) => r.stageIndex === idx);
              const isSelected = selectedStageIdx === idx;
              return (
                <div
                  key={st.id}
                  onClick={() => setSelectedStageIdx(idx)}
                  className={`rounded-lg border p-2.5 transition ${
                    isSelected
                      ? "border-emerald-500 bg-emerald-500/5"
                      : "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={st.enabled}
                        onChange={(e) =>
                          setStages((prev) =>
                            prev.map((x, i) =>
                              i === idx ? { ...x, enabled: e.target.checked } : x
                            )
                          )
                        }
                      />
                      <span className="font-mono text-[0.72rem] text-zinc-500">
                        Stage {idx + 1}
                      </span>
                      <select
                        value={st.operator}
                        onChange={(e) => {
                          const op = e.target.value;
                          setStages((prev) =>
                            prev.map((x, i) =>
                              i === idx
                                ? { ...x, operator: op, bodyJson: DEFAULT_STAGE_BODIES[op] ?? "{}" }
                                : x
                            )
                          );
                        }}
                        className="h-6 px-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono font-semibold text-emerald-400"
                      >
                        {AGG_OPERATORS.map((op) => (
                          <option key={op} value={op}>
                            {op}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-1">
                      {res && (
                        <span
                          className={`px-1.5 py-0.5 rounded font-mono text-[0.7rem] ${
                            res.error
                              ? "bg-red-500/20 text-red-400"
                              : "bg-emerald-500/20 text-emerald-400"
                          }`}
                        >
                          {res.error ? "Error" : `${res.docCount} docs • ${res.executionMs}ms`}
                        </span>
                      )}
                      <button
                        onClick={() => moveStage(idx, -1)}
                        className="p-1 text-zinc-500 hover:text-zinc-200"
                      >
                        <ArrowUp className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => moveStage(idx, 1)}
                        className="p-1 text-zinc-500 hover:text-zinc-200"
                      >
                        <ArrowDown className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => setStages((prev) => prev.filter((_, i) => i !== idx))}
                        className="p-1 text-zinc-500 hover:text-red-400"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={st.bodyJson}
                    onChange={(e) =>
                      setStages((prev) =>
                        prev.map((x, i) => (i === idx ? { ...x, bodyJson: e.target.value } : x))
                      )
                    }
                    rows={4}
                    className="w-full p-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
              );
            })}

            <button
              onClick={() =>
                setStages((prev) => [
                  ...prev,
                  {
                    id: `st-${Date.now()}`,
                    operator: "$project",
                    bodyJson: DEFAULT_STAGE_BODIES.$project,
                    enabled: true,
                  },
                ])
              }
              className="h-8 px-3 rounded border border-dashed border-zinc-400 dark:border-zinc-700 hover:border-emerald-500 text-zinc-500 hover:text-emerald-400 flex items-center gap-1.5 w-full justify-center"
            >
              <Plus className="w-3.5 h-3.5" /> Add Pipeline Stage
            </button>
          </div>

          {/* Right: Live Stage Output Preview */}
          <div className="w-1/2 flex flex-col min-h-0 bg-zinc-50/50 dark:bg-zinc-950">
            <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 font-semibold flex items-center justify-between">
              <span>
                Stage {selectedStageIdx + 1} Output Preview (
                {stages[selectedStageIdx]?.operator ?? "—"})
              </span>
              {activeStageRes && !activeStageRes.error && (
                <span className="font-mono text-emerald-400 text-[0.75rem]">
                  {activeStageRes.docCount} sample doc(s) • {activeStageRes.executionMs}ms
                </span>
              )}
            </div>
            <div className="flex-1 overflow-auto p-3">
              {activeStageRes ? (
                activeStageRes.error ? (
                  <div className="p-3 rounded bg-red-500/10 border border-red-500/30 text-red-400 font-mono">
                    {activeStageRes.error}
                  </div>
                ) : (
                  <pre className="font-mono text-xs whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">
                    {JSON.stringify(activeStageRes.sampleDocs, null, 2)}
                  </pre>
                )
              ) : (
                <div className="h-full flex items-center justify-center text-zinc-500 text-center">
                  Click "Run Stage-by-Stage Preview" to inspect intermediate documents after each
                  aggregation stage.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
