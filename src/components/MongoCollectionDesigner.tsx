import React, { useCallback, useEffect, useState } from "react";
import { Check, KeyRound, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type { MongoCollectionMetadata } from "../types/dba";

export const MongoCollectionDesigner: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
  const { connections, openSafetyModal, addLog } = useWorkbenchStore();
  const conn = connections.find((c) => c.id === tab.connectionId);
  const database = tab.database ?? conn?.database ?? "admin";
  const collection = tab.collection ?? tab.table ?? "";

  const [section, setSection] = useState<"indexes" | "validation">("indexes");
  const [meta, setMeta] = useState<MongoCollectionMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create index form
  const [idxName, setIdxName] = useState("");
  const [idxKeys, setIdxKeys] = useState('{ "field": 1 }');
  const [idxUnique, setIdxUnique] = useState(false);
  const [idxSparse, setIdxSparse] = useState(false);
  const [idxTtl, setIdxTtl] = useState("");
  const [idxPartial, setIdxPartial] = useState("");

  // Validation schema form
  const [validatorJson, setValidatorJson] = useState(
    '{\n  "$jsonSchema": {\n    "bsonType": "object",\n    "required": [],\n    "properties": {}\n  }\n}'
  );
  const [validationLevel, setValidationLevel] = useState("moderate");
  const [validationAction, setValidationAction] = useState("error");

  const loadMeta = useCallback(async () => {
    if (!tab.connectionId || !collection) return;
    setLoading(true);
    setError(null);
    try {
      const m = await api.mongoGetCollectionMetadata(tab.connectionId, database, collection);
      setMeta(m);
      if (m.options.validator) {
        setValidatorJson(JSON.stringify(m.options.validator, null, 2));
      }
      if (m.options.validationLevel) setValidationLevel(m.options.validationLevel);
      if (m.options.validationAction) setValidationAction(m.options.validationAction);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId, database, collection]);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  const handleCreateIndex = async () => {
    if (!tab.connectionId || !collection) return;
    setError(null);
    try {
      const created = await api.mongoCreateIndex({
        connectionId: tab.connectionId,
        database,
        collection,
        name: idxName.trim() || null,
        keysJson: idxKeys,
        unique: idxUnique,
        sparse: idxSparse,
        ttlSeconds: idxTtl.trim() ? Number(idxTtl) : null,
        partialFilterJson: idxPartial.trim() || null,
      });
      addLog("success", `Created index "${created}" on ${collection}`);
      setIdxName("");
      await loadMeta();
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const handleDropIndex = async (name: string) => {
    if (!tab.connectionId || !collection) return;
    try {
      await api.mongoDropIndex(tab.connectionId, database, collection, name);
      addLog("warn", `Dropped index "${name}" on ${collection}`);
      await loadMeta();
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const applyValidation = async (confirmedProduction = false) => {
    if (!tab.connectionId || !collection) return;
    setError(null);
    try {
      await api.mongoUpdateValidation({
        connectionId: tab.connectionId,
        database,
        collection,
        validatorJson: validatorJson.trim() || null,
        validationLevel,
        validationAction,
        confirmedProduction,
      });
      addLog("success", `Updated JSON Schema validation for ${collection}`);
      await loadMeta();
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const handleSaveValidation = () => {
    if (conn?.environment === "production") {
      openSafetyModal({
        title: `Update Validation on ${collection}`,
        warnings: [`Target MongoDB connection "${conn.name}" is PRODUCTION!`],
        sqlPreview: validatorJson,
        onConfirm: () => applyValidation(true),
      });
    } else {
      applyValidation(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-950 text-xs">
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/70 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="font-mono font-semibold text-emerald-400">
            {database}.{collection}
          </span>
          {meta && (
            <span className="text-zinc-500">
              {meta.documentCount.toLocaleString()} docs
              {meta.options.capped ? " • CAPPED" : ""}
            </span>
          )}
          <div className="flex items-center gap-1 ml-2">
            <button
              onClick={() => setSection("indexes")}
              className={`h-7 px-2.5 rounded flex items-center gap-1.5 ${
                section === "indexes"
                  ? "bg-emerald-600 text-white font-medium"
                  : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
              }`}
            >
              <KeyRound className="w-3.5 h-3.5" /> Indexes ({meta?.indexes.length ?? 0})
            </button>
            <button
              onClick={() => setSection("validation")}
              className={`h-7 px-2.5 rounded flex items-center gap-1.5 ${
                section === "validation"
                  ? "bg-emerald-600 text-white font-medium"
                  : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" /> JSON Schema Validation
            </button>
          </div>
        </div>
        <button
          onClick={loadMeta}
          className="h-7 px-2 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 font-mono">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {section === "indexes" ? (
          <>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500">
                  <th className="py-1.5 px-2">Index Name</th>
                  <th className="py-1.5 px-2">Keys</th>
                  <th className="py-1.5 px-2">Flags</th>
                  <th className="py-1.5 px-2">TTL (s)</th>
                  <th className="py-1.5 px-2 w-12" />
                </tr>
              </thead>
              <tbody>
                {meta?.indexes.map((idx) => (
                  <tr
                    key={idx.name}
                    className="border-b border-zinc-200/60 dark:border-zinc-800/60"
                  >
                    <td className="py-1.5 px-2 font-mono font-medium">{idx.name}</td>
                    <td className="py-1.5 px-2 font-mono text-emerald-400">
                      {JSON.stringify(idx.keys)}
                    </td>
                    <td className="py-1.5 px-2 space-x-1">
                      {idx.unique && (
                        <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 text-[0.7rem]">
                          UNIQUE
                        </span>
                      )}
                      {idx.sparse && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[0.7rem]">
                          SPARSE
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 font-mono text-zinc-500">
                      {idx.ttlSeconds ?? "—"}
                    </td>
                    <td className="py-1.5 px-2 text-right">
                      {idx.name !== "_id_" && (
                        <button
                          onClick={() => handleDropIndex(idx.name)}
                          className="text-zinc-500 hover:text-red-400"
                          title="Drop Index"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Create Index Panel */}
            <div className="p-3 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 space-y-2.5 max-w-2xl">
              <div className="font-semibold">Create New Index</div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={idxName}
                  onChange={(e) => setIdxName(e.target.value)}
                  placeholder="Index name (optional)"
                  className="h-7 px-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                />
                <input
                  value={idxKeys}
                  onChange={(e) => setIdxKeys(e.target.value)}
                  placeholder='{ "email": 1 }'
                  className="h-7 px-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  value={idxTtl}
                  onChange={(e) => setIdxTtl(e.target.value)}
                  placeholder="TTL expireAfterSeconds (optional)"
                  className="h-7 px-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                />
                <input
                  value={idxPartial}
                  onChange={(e) => setIdxPartial(e.target.value)}
                  placeholder='Partial Filter JSON (optional)'
                  className="h-7 px-2 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                />
              </div>
              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={idxUnique}
                      onChange={(e) => setIdxUnique(e.target.checked)}
                    />
                    Unique
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={idxSparse}
                      onChange={(e) => setIdxSparse(e.target.checked)}
                    />
                    Sparse
                  </label>
                </div>
                <button
                  onClick={handleCreateIndex}
                  className="h-7 px-3 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" /> Create Index
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="space-y-3 max-w-3xl">
            <div className="flex items-center gap-3">
              <div>
                <label className="block text-zinc-500 mb-1">Validation Level</label>
                <select
                  value={validationLevel}
                  onChange={(e) => setValidationLevel(e.target.value)}
                  className="h-7 px-2 rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700"
                >
                  <option value="off">off</option>
                  <option value="moderate">moderate</option>
                  <option value="strict">strict</option>
                </select>
              </div>
              <div>
                <label className="block text-zinc-500 mb-1">Validation Action</label>
                <select
                  value={validationAction}
                  onChange={(e) => setValidationAction(e.target.value)}
                  className="h-7 px-2 rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700"
                >
                  <option value="error">error</option>
                  <option value="warn">warn</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-zinc-500 mb-1">Validator ($jsonSchema / Query)</label>
              <textarea
                value={validatorJson}
                onChange={(e) => setValidatorJson(e.target.value)}
                rows={14}
                className="w-full p-3 rounded bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 font-mono text-xs"
              />
            </div>

            <button
              onClick={handleSaveValidation}
              className="h-8 px-4 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5"
            >
              <Check className="w-3.5 h-3.5" /> Save Validation Rules (collMod)
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
