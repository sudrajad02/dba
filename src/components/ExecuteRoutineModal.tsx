import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  FunctionSquare,
  Loader2,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import type {
  DbEngine,
  QueryExecutionResponse,
  RoutineParameter,
  RoutineSignature,
} from "../types/dba";

interface ParamInputValue {
  key: string;
  name: string;
  mode: string;
  dataType: string;
  value: string;
  isNull: boolean;
  isRawExpr: boolean;
}

function isNumericOrBoolType(dataType: string): boolean {
  const lower = dataType.toLowerCase();
  return (
    /\b(int|integer|bigint|smallint|tinyint|mediumint|decimal|numeric|float|double|real|bit|bool|boolean|money|smallmoney|serial|bigserial)\b/.test(
      lower
    ) && !lower.includes("[]")
  );
}

function formatParamValue(p: ParamInputValue): string {
  if (p.isNull) return "NULL";
  const raw = p.value;
  if (p.isRawExpr) return raw.trim() || "NULL";
  if (isNumericOrBoolType(p.dataType)) {
    const trimmed = raw.trim();
    if (trimmed === "") return "NULL";
    if (
      /^-?\d+(\.\d+)?$/.test(trimmed) ||
      trimmed.toLowerCase() === "true" ||
      trimmed.toLowerCase() === "false"
    ) {
      return trimmed;
    }
  }
  return `'${raw.replace(/'/g, "''")}'`;
}

function quoteIdent(engine: DbEngine, ident: string): string {
  if (engine === "mysql") return `\`${ident.replace(/`/g, "``")}\``;
  if (engine === "mssql") return `[${ident.replace(/\]/g, "]]")}]`;
  return `"${ident.replace(/"/g, '""')}"`;
}

function buildLiveRoutineSql(
  engine: DbEngine,
  schema: string | undefined,
  name: string,
  kind: "function" | "procedure",
  inputs: ParamInputValue[],
  outParams: RoutineParameter[]
): string {
  const fq =
    schema && engine !== "mysql"
      ? `${quoteIdent(engine, schema)}.${quoteIdent(engine, name)}`
      : schema && engine === "mysql"
      ? `${quoteIdent("mysql", schema)}.${quoteIdent("mysql", name)}`
      : quoteIdent(engine, name);

  if (engine === "mysql") {
    if (kind === "function") {
      const args = inputs.map(formatParamValue).join(", ");
      return `SELECT ${fq}(${args}) AS result;`;
    }
    // MySQL Procedure: bind INOUT & OUT params to session variables so we can SELECT them afterwards
    const preamble: string[] = [];
    const callArgs: string[] = [];
    const selectOuts: string[] = [];

    const allOrdered: Array<{ pos: number; kind: "in" | "out"; input?: ParamInputValue; out?: RoutineParameter }> = [];
    inputs.forEach((inp, idx) => allOrdered.push({ pos: idx, kind: "in", input: inp }));
    outParams.forEach((op, idx) => allOrdered.push({ pos: 1000 + idx, kind: "out", out: op }));

    for (const item of allOrdered) {
      if (item.kind === "in" && item.input) {
        const inp = item.input;
        if (inp.mode === "INOUT") {
          const v = `@_dba_${inp.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
          preamble.push(`SET ${v} = ${formatParamValue(inp)};`);
          callArgs.push(v);
          selectOuts.push(`${v} AS ${quoteIdent("mysql", inp.name)}`);
        } else {
          callArgs.push(formatParamValue(inp));
        }
      } else if (item.out) {
        const v = `@_dba_${item.out.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        callArgs.push(v);
        selectOuts.push(`${v} AS ${quoteIdent("mysql", item.out.name)}`);
      }
    }

    const lines = [...preamble, `CALL ${fq}(${callArgs.join(", ")});`];
    if (selectOuts.length > 0) {
      lines.push(`SELECT ${selectOuts.join(", ")};`);
    }
    return lines.join("\n");
  }

  if (engine === "mssql") {
    if (kind === "function") {
      const args = inputs.map(formatParamValue).join(", ");
      return `SELECT ${fq}(${args}) AS result;`;
    }
    const decls: string[] = [];
    const execArgs: string[] = [];
    const selects: string[] = [];

    for (const inp of inputs) {
      const pName = inp.name.startsWith("@") ? inp.name : `@${inp.name}`;
      if (inp.mode === "INOUT") {
        decls.push(`DECLARE ${pName} ${inp.dataType} = ${formatParamValue(inp)};`);
        execArgs.push(`${pName} = ${pName} OUTPUT`);
        selects.push(`${pName} AS ${quoteIdent("mssql", inp.name.replace(/^@/, ""))}`);
      } else {
        execArgs.push(`${pName} = ${formatParamValue(inp)}`);
      }
    }
    for (const op of outParams) {
      const pName = op.name.startsWith("@") ? op.name : `@${op.name}`;
      decls.push(`DECLARE ${pName} ${op.dataType};`);
      execArgs.push(`${pName} = ${pName} OUTPUT`);
      selects.push(`${pName} AS ${quoteIdent("mssql", op.name.replace(/^@/, ""))}`);
    }
    const lines = [
      ...decls,
      `EXEC ${fq}${execArgs.length > 0 ? ` ${execArgs.join(", ")}` : ""};`,
    ];
    if (selects.length > 0) {
      lines.push(`SELECT ${selects.join(", ")};`);
    }
    return lines.join("\n");
  }

  // PostgreSQL
  const args = inputs.map(formatParamValue).join(", ");
  if (kind === "procedure") {
    return `CALL ${fq}(${args});`;
  }
  return `SELECT * FROM ${fq}(${args});`;
}

export const ExecuteRoutineModal: React.FC = () => {
  const {
    executeRoutineModal,
    closeExecuteRoutineModal,
    connections,
    openTab,
    openSafetyModal,
    addLog,
  } = useWorkbenchStore();

  const [loadingSig, setLoadingSig] = useState(false);
  const [signature, setSignature] = useState<RoutineSignature | null>(null);
  const [sigError, setSigError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<ParamInputValue[]>([]);

  const [running, setRunning] = useState(false);
  const [execResult, setExecResult] = useState<QueryExecutionResponse | null>(null);
  const [execError, setExecError] = useState<string | null>(null);
  const [activeResultIdx, setActiveResultIdx] = useState(0);

  const conn = useMemo(
    () =>
      executeRoutineModal
        ? connections.find((c) => c.id === executeRoutineModal.connectionId) ?? null
        : null,
    [executeRoutineModal, connections]
  );

  // Escape key closes modal
  useEffect(() => {
    if (!executeRoutineModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeExecuteRoutineModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [executeRoutineModal, closeExecuteRoutineModal]);

  // Introspect parameters when modal opens
  useEffect(() => {
    if (!executeRoutineModal) return;
    let cancelled = false;
    setLoadingSig(true);
    setSigError(null);
    setSignature(null);
    setInputs([]);
    setExecResult(null);
    setExecError(null);
    setActiveResultIdx(0);

    api
      .getRoutineParameters(
        executeRoutineModal.connectionId,
        executeRoutineModal.name,
        executeRoutineModal.kind,
        executeRoutineModal.database,
        executeRoutineModal.schema
      )
      .then((sig) => {
        if (cancelled) return;
        setSignature(sig);
        const editable = sig.parameters.filter((p) => p.mode !== "OUT");
        setInputs(
          editable.map((p, idx) => ({
            key: `${p.position}-${idx}`,
            name: p.name,
            mode: p.mode,
            dataType: p.dataType,
            value: p.defaultValue ?? "",
            isNull: false,
            isRawExpr: false,
          }))
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setSigError(formatApiError(err));
      })
      .finally(() => {
        if (!cancelled) setLoadingSig(false);
      });

    return () => {
      cancelled = true;
    };
  }, [executeRoutineModal]);

  const outParams = useMemo(
    () => (signature?.parameters ?? []).filter((p) => p.mode === "OUT"),
    [signature]
  );

  const liveSql = useMemo(() => {
    if (!executeRoutineModal || !conn) return "";
    return buildLiveRoutineSql(
      conn.engine,
      executeRoutineModal.schema,
      executeRoutineModal.name,
      executeRoutineModal.kind,
      inputs,
      outParams
    );
  }, [executeRoutineModal, conn, inputs, outParams]);

  if (!executeRoutineModal || !conn) return null;

  const runExecution = async (confirmedSafety: boolean) => {
    setRunning(true);
    setExecError(null);
    setExecResult(null);
    setActiveResultIdx(0);
    try {
      const qid =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `routine-${Date.now()}`;
      const res = await api.executeQuery(
        executeRoutineModal.connectionId,
        liveSql,
        executeRoutineModal.database,
        qid,
        confirmedSafety
      );
      setExecResult(res);
      addLog(
        "success",
        `Executed ${executeRoutineModal.kind} "${executeRoutineModal.name}" (${res.totalExecutionMs}ms)`,
        liveSql
      );
    } catch (err) {
      const msg = formatApiError(err);
      setExecError(msg);
      addLog("error", `Routine execution failed: ${msg}`, liveSql);
    } finally {
      setRunning(false);
    }
  };

  const handleExecute = () => {
    if (conn.environment === "production") {
      openSafetyModal({
        title: `Execute ${executeRoutineModal.kind.toUpperCase()} "${executeRoutineModal.name}" on PRODUCTION`,
        warnings: [
          `Target connection "${conn.name}" is marked PRODUCTION!`,
          `Executing a routine may modify production data.`,
        ],
        sqlPreview: liveSql,
        onConfirm: () => {
          runExecution(true);
        },
      });
      return;
    }
    runExecution(true);
  };

  const handleOpenInQueryEditor = () => {
    openTab({
      kind: "query",
      title: `Execute: ${executeRoutineModal.name}`,
      connectionId: executeRoutineModal.connectionId,
      database: executeRoutineModal.database,
      schema: executeRoutineModal.schema,
      sql: liveSql,
    });
    closeExecuteRoutineModal();
  };

  const activeSet = execResult?.resultSets[activeResultIdx] ?? null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={closeExecuteRoutineModal}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl max-h-[88vh] flex flex-col rounded-xl border border-[var(--border-strong)] bg-[var(--surface-panel)] shadow-2xl overflow-hidden text-xs"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-[var(--border-subtle)] bg-[var(--surface-elevated)] flex items-center gap-2 shrink-0">
          <FunctionSquare className="w-4 h-4 text-amber-400 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100 truncate">
                Execute {executeRoutineModal.name}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-mono text-[0.66rem] uppercase">
                {executeRoutineModal.kind}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-[var(--surface-canvas)] text-zinc-500 font-mono text-[0.66rem] uppercase">
                {conn.engine}
              </span>
              {signature?.returnType && (
                <span className="text-[0.7rem] font-mono text-sky-400 truncate">
                  → {signature.returnType}
                </span>
              )}
            </div>
            <div className="text-[0.72rem] text-zinc-500 truncate">
              {conn.name}
              {executeRoutineModal.database ? ` / ${executeRoutineModal.database}` : ""}
              {executeRoutineModal.schema &&
              executeRoutineModal.schema !== executeRoutineModal.database
                ? `.${executeRoutineModal.schema}`
                : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={closeExecuteRoutineModal}
            className="p-1 rounded hover:bg-[var(--surface-hover)] text-zinc-500 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Parameters Section */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                Parameters {loadingSig ? "" : `(${inputs.length})`}
              </span>
              <button
                type="button"
                onClick={() =>
                  setInputs((prev) => [
                    ...prev,
                    {
                      key: `custom-${Date.now()}`,
                      name: `arg${prev.length + 1}`,
                      mode: "IN",
                      dataType: "text",
                      value: "",
                      isNull: false,
                      isRawExpr: false,
                    },
                  ])
                }
                className="h-6 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1 text-[0.72rem] cursor-pointer"
              >
                <Plus className="w-3 h-3" /> Add Argument
              </button>
            </div>

            {loadingSig ? (
              <div className="py-4 flex items-center gap-2 text-zinc-500">
                <Loader2 className="w-4 h-4 animate-spin" /> Introspecting routine parameters...
              </div>
            ) : sigError ? (
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>Could not introspect parameters ({sigError}). You can add arguments manually above.</span>
              </div>
            ) : inputs.length === 0 ? (
              <div className="py-2 text-zinc-500 italic">
                This routine takes no input parameters.
              </div>
            ) : (
              <div className="rounded-lg border border-[var(--border-subtle)] overflow-hidden">
                <table className="w-full text-left border-collapse">
                  <thead className="bg-[var(--surface-elevated)] text-[0.7rem] text-zinc-500">
                    <tr>
                      <th className="px-2.5 py-1.5">Parameter</th>
                      <th className="px-2.5 py-1.5">Type</th>
                      <th className="px-2.5 py-1.5">Value</th>
                      <th className="px-2 py-1.5 text-center w-14">NULL</th>
                      <th className="px-2 py-1.5 text-center w-14" title="Treat value as raw SQL expression">
                        Raw
                      </th>
                      <th className="px-1.5 py-1.5 w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-subtle)] bg-[var(--surface-canvas)]">
                    {inputs.map((inp) => (
                      <tr key={inp.key}>
                        <td className="px-2.5 py-1.5 font-mono font-medium text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
                          <span>{inp.name}</span>
                          {inp.mode !== "IN" && (
                            <span className="ml-1.5 px-1 rounded bg-sky-500/15 text-sky-400 text-[0.64rem]">
                              {inp.mode}
                            </span>
                          )}
                        </td>
                        <td className="px-2.5 py-1.5 font-mono text-[0.72rem] text-zinc-500 whitespace-nowrap">
                          {inp.dataType}
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            disabled={inp.isNull}
                            value={inp.isNull ? "NULL" : inp.value}
                            onChange={(e) =>
                              setInputs((prev) =>
                                prev.map((x) =>
                                  x.key === inp.key ? { ...x, value: e.target.value } : x
                                )
                              )
                            }
                            placeholder={isNumericOrBoolType(inp.dataType) ? "0" : "value"}
                            className="w-full h-7 px-2 rounded bg-[var(--surface-panel)] border border-[var(--border-strong)] font-mono disabled:opacity-50"
                          />
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <input
                            type="checkbox"
                            checked={inp.isNull}
                            onChange={(e) =>
                              setInputs((prev) =>
                                prev.map((x) =>
                                  x.key === inp.key ? { ...x, isNull: e.target.checked } : x
                                )
                              )
                            }
                          />
                        </td>
                        <td className="px-2 py-1.5 text-center">
                          <input
                            type="checkbox"
                            disabled={inp.isNull}
                            checked={inp.isRawExpr}
                            onChange={(e) =>
                              setInputs((prev) =>
                                prev.map((x) =>
                                  x.key === inp.key ? { ...x, isRawExpr: e.target.checked } : x
                                )
                              )
                            }
                          />
                        </td>
                        <td className="px-1.5 py-1.5 text-center">
                          <button
                            type="button"
                            onClick={() =>
                              setInputs((prev) => prev.filter((x) => x.key !== inp.key))
                            }
                            className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {outParams.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-[0.72rem] text-zinc-500">
                <span>OUT parameters:</span>
                {outParams.map((op) => (
                  <span
                    key={op.position}
                    className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 font-mono"
                  >
                    {op.name}: {op.dataType}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Live SQL Preview */}
          <div className="space-y-1">
            <span className="font-semibold text-zinc-800 dark:text-zinc-200">
              SQL Preview
            </span>
            <pre className="p-2.5 rounded-lg bg-[var(--surface-canvas)] border border-[var(--border-subtle)] font-mono text-[0.74rem] text-sky-500 dark:text-sky-300 overflow-x-auto whitespace-pre-wrap">
              {liveSql}
            </pre>
          </div>

          {/* Execution Result Pane */}
          {execError && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="font-mono whitespace-pre-wrap break-words">{execError}</div>
            </div>
          )}

          {execResult && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span className="font-semibold text-emerald-400">
                  Executed in {execResult.totalExecutionMs} ms
                </span>
                {execResult.resultSets.length > 1 && (
                  <div className="flex items-center gap-1 ml-2">
                    {execResult.resultSets.map((_, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => setActiveResultIdx(idx)}
                        className={`h-6 px-2 rounded text-[0.72rem] cursor-pointer ${
                          activeResultIdx === idx
                            ? "bg-indigo-600 text-white"
                            : "bg-[var(--surface-elevated)] text-zinc-400 hover:text-zinc-200"
                        }`}
                      >
                        Result {idx + 1}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {activeSet && activeSet.columns.length > 0 ? (
                <div className="rounded-lg border border-[var(--border-subtle)] overflow-auto max-h-60 bg-[var(--surface-canvas)]">
                  <table className="w-full text-left border-collapse font-mono text-[0.74rem]">
                    <thead className="sticky top-0 bg-[var(--surface-elevated)] border-b border-[var(--border-subtle)]">
                      <tr>
                        {activeSet.columns.map((c, idx) => (
                          <th key={idx} className="px-2.5 py-1.5 font-semibold text-zinc-500 whitespace-nowrap">
                            {c.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-subtle)]">
                      {activeSet.rows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={activeSet.columns.length}
                            className="px-3 py-3 text-center text-zinc-500 italic"
                          >
                            0 rows returned
                          </td>
                        </tr>
                      ) : (
                        activeSet.rows.map((row, rIdx) => (
                          <tr key={rIdx} className="hover:bg-[var(--surface-hover)]">
                            {row.map((cell, cIdx) => (
                              <td
                                key={cIdx}
                                className="px-2.5 py-1 whitespace-nowrap max-w-[260px] truncate"
                              >
                                {cell === null || cell === undefined ? (
                                  <span className="text-zinc-500 italic">(Null)</span>
                                ) : typeof cell === "object" ? (
                                  JSON.stringify(cell)
                                ) : (
                                  String(cell)
                                )}
                              </td>
                            ))}
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-2.5 rounded-lg bg-[var(--surface-canvas)] border border-[var(--border-subtle)] text-zinc-400 font-mono">
                  OK — {activeSet?.rowsAffected ?? 0} row(s) affected.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-[var(--border-subtle)] bg-[var(--surface-elevated)] flex items-center justify-between gap-2 shrink-0">
          <button
            type="button"
            onClick={handleOpenInQueryEditor}
            className="h-7 px-3 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] text-zinc-700 dark:text-zinc-200 flex items-center gap-1.5 cursor-pointer"
          >
            <FileCode2 className="w-3.5 h-3.5" /> Open in Query Editor
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closeExecuteRoutineModal}
              className="h-7 px-3 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] text-zinc-700 dark:text-zinc-200 cursor-pointer"
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleExecute}
              disabled={running || loadingSig}
              className="h-7 px-3.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            >
              {running ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              Execute
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
