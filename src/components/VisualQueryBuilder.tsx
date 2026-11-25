import React, { useEffect, useRef, useState } from "react";
import {
  FileCode2,
  KeyRound,
  Link2,
  Play,
  Plus,
  Table2,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  QbJoinItem,
  QbJoinType,
  QbOrderItem,
  QbSelectColumn,
  QbTableItem,
  QbWhereCondition,
  QueryResultSet,
  TableMetadata,
} from "../types/datavault";

const CARD_W = 220;
const HEADER_H = 30;
const ROW_H = 22;

function makeId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const VisualQueryBuilder: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
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
    openTab,
    addLog,
  } = useWorkbenchStore();

  const sqlConns = connections.filter((c) => c.engine !== "mongodb");
  const [connId, setConnId] = useState(tab.connectionId ?? sqlConns[0]?.id ?? "");
  const [database, setDatabase] = useState(tab.database ?? "");
  const [schema, setSchema] = useState(tab.schema ?? "");

  const [tables, setTables] = useState<QbTableItem[]>([]);
  const [metaByTableId, setMetaByTableId] = useState<Record<string, TableMetadata>>(
    {}
  );
  const [joins, setJoins] = useState<QbJoinItem[]>([]);
  const [columns, setColumns] = useState<QbSelectColumn[]>([]);
  const [whereConds, setWhereConds] = useState<QbWhereCondition[]>([]);
  const [groupBy, setGroupBy] = useState<string[]>([]);
  const [having, setHaving] = useState("");
  const [orderBy, setOrderBy] = useState<QbOrderItem[]>([]);
  const [distinct, setDistinct] = useState(false);
  const [limit, setLimit] = useState<string>("100");

  const [generatedSql, setGeneratedSql] = useState(
    "-- Add tables from the left panel to start building your query\n"
  );
  const [clauseTab, setClauseTab] = useState<
    "columns" | "joins" | "where" | "order" | "sql" | "results"
  >("sql");
  const [resultSet, setResultSet] = useState<QueryResultSet | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dragRef = useRef<{
    tableId: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const conn = sqlConns.find((c) => c.id === connId);
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
  ).filter((o) => o.kind === "table" || o.kind === "view");

  const initConn = async (cid: string) => {
    if (!cid) return;
    if (!connectedIds.has(cid)) await connectTo(cid);
    const dbList = await loadDatabases(cid);
    const c = sqlConns.find((x) => x.id === cid);
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
  };

  useEffect(() => {
    if (connId && !dbs.length) {
      initConn(connId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  // Live SQL generation via Rust backend whenever visual query state changes
  useEffect(() => {
    const parsedLimit = limit.trim() ? parseInt(limit, 10) : null;
    api
      .generateVisualQuerySql({
        engine: conn?.engine ?? "postgres",
        distinct,
        tables,
        joins,
        columns,
        whereConditions: whereConds,
        groupBy,
        having: having.trim() || null,
        orderBy,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : null,
      })
      .then((sql) => setGeneratedSql(sql))
      .catch(() => {});
  }, [
    conn?.engine,
    distinct,
    tables,
    joins,
    columns,
    whereConds,
    groupBy,
    having,
    orderBy,
    limit,
  ]);

  const handleAddTableToCanvas = async (tableName: string) => {
    if (!connId) return;
    setError(null);
    try {
      const meta = await api.getTableMetadata(
        connId,
        tableName,
        effDb || undefined,
        effSchema || undefined
      );
      const id = makeId();
      const idx = tables.length;
      const baseAlias = tableName.slice(0, 1).toLowerCase() + (idx + 1);
      const newItem: QbTableItem = {
        id,
        schema: effSchema || null,
        table: tableName,
        alias: baseAlias,
        x: 30 + (idx % 4) * 260,
        y: 30 + Math.floor(idx / 4) * 220,
      };

      const nextTables = [...tables, newItem];
      const nextMetas = { ...metaByTableId, [id]: meta };

      // Auto-detect FK joins between new table and existing canvas tables
      const autoJoins: QbJoinItem[] = [];
      for (const existing of tables) {
        const exMeta = metaByTableId[existing.id];
        if (!exMeta) continue;
        // New table references existing table
        for (const fk of meta.foreignKeys) {
          if (fk.refTable.toLowerCase() === existing.table.toLowerCase()) {
            autoJoins.push({
              id: makeId(),
              leftTableId: existing.id,
              leftColumn: fk.refColumns[0] ?? "id",
              rightTableId: id,
              rightColumn: fk.columns[0] ?? "id",
              joinType: "inner",
            });
          }
        }
        // Existing table references new table
        for (const fk of exMeta.foreignKeys) {
          if (fk.refTable.toLowerCase() === tableName.toLowerCase()) {
            autoJoins.push({
              id: makeId(),
              leftTableId: existing.id,
              leftColumn: fk.columns[0] ?? "id",
              rightTableId: id,
              rightColumn: fk.refColumns[0] ?? "id",
              joinType: "inner",
            });
          }
        }
      }

      setTables(nextTables);
      setMetaByTableId(nextMetas);
      if (autoJoins.length > 0) {
        setJoins((prev) => [...prev, ...autoJoins]);
      }
      // Auto-select first 5 columns of first table
      if (tables.length === 0) {
        setColumns(
          meta.columns.slice(0, 5).map((c) => ({
            tableId: id,
            column: c.name,
            alias: null,
            aggregate: null,
            selected: true,
          }))
        );
      }
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const toggleColumn = (tableId: string, colName: string) => {
    const exists = columns.find(
      (c) => c.tableId === tableId && c.column === colName
    );
    if (exists) {
      setColumns((prev) =>
        prev.filter((c) => !(c.tableId === tableId && c.column === colName))
      );
    } else {
      setColumns((prev) => [
        ...prev,
        {
          tableId,
          column: colName,
          alias: null,
          aggregate: null,
          selected: true,
        },
      ]);
    }
  };

  const removeTable = (tableId: string) => {
    setTables((prev) => prev.filter((t) => t.id !== tableId));
    setJoins((prev) =>
      prev.filter((j) => j.leftTableId !== tableId && j.rightTableId !== tableId)
    );
    setColumns((prev) => prev.filter((c) => c.tableId !== tableId));
    setWhereConds((prev) => prev.filter((w) => w.tableId !== tableId));
    setOrderBy((prev) => prev.filter((o) => o.tableId !== tableId));
  };

  const handleRunQuery = async () => {
    if (!connId || tables.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.executeQuery(
        connId,
        generatedSql,
        effDb || undefined,
        undefined,
        false
      );
      setResultSet(res.resultSets[0] ?? null);
      setClauseTab("results");
      addLog(
        "success",
        `Visual Query executed in ${res.totalExecutionMs} ms`,
        generatedSql
      );
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setRunning(false);
    }
  };

  const tableMap = new Map(tables.map((t) => [t.id, t]));

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#1e1f22] text-xs overflow-hidden">
      {/* Top Toolbar */}
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex items-center justify-between gap-2 flex-wrap shrink-0">
        <div className="flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-violet-400" />
          <span className="font-semibold text-sm">Visual Query Builder</span>
          <select
            value={connId}
            onChange={(e) => {
              setConnId(e.target.value);
              initConn(e.target.value);
            }}
            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
          >
            <option value="">Connection...</option>
            {sqlConns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {dbs.length > 0 && (
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
          )}
          {schemas.length > 0 && (
            <select
              value={effSchema}
              onChange={(e) => {
                setSchema(e.target.value);
                loadObjects(connId, effDb, e.target.value);
              }}
              className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
            >
              {schemas.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={distinct}
              onChange={(e) => setDistinct(e.target.checked)}
            />
            <span>DISTINCT</span>
          </label>
          <div className="flex items-center gap-1">
            <span className="text-zinc-400">LIMIT</span>
            <input
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="h-7 w-16 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
            />
          </div>
          <button
            onClick={handleRunQuery}
            disabled={running || tables.length === 0}
            className="h-7 px-3 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium flex items-center gap-1 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            <span>{running ? "Running..." : "Run Query"}</span>
          </button>
          <button
            onClick={() =>
              openTab({
                kind: "query",
                title: "Visual Query",
                connectionId: connId || undefined,
                database: effDb || undefined,
                sql: generatedSql,
              })
            }
            disabled={tables.length === 0}
            className="h-7 px-3 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white font-medium flex items-center gap-1 cursor-pointer"
          >
            <FileCode2 className="w-3.5 h-3.5" />
            <span>Open in SQL Editor</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-3 mt-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Split: Left Table Palette + Right Canvas & Clause Tabs */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Table Palette */}
        <div className="w-56 border-r border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#23252a] flex flex-col min-h-0 shrink-0">
          <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] font-semibold text-zinc-400 uppercase text-[0.65rem] tracking-wider">
            Tables & Views ({availTables.length})
          </div>
          <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
            {availTables.map((obj) => (
              <button
                key={obj.name}
                onClick={() => handleAddTableToCanvas(obj.name)}
                className="w-full px-2 py-1.5 rounded hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center justify-between gap-1.5 text-left cursor-pointer"
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <Table2 className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span className="font-mono truncate">{obj.name}</span>
                </span>
                <Plus className="w-3 h-3 text-zinc-400 shrink-0" />
              </button>
            ))}
          </div>
        </div>

        {/* Center Canvas + Bottom Clause Drawer */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {/* Interactive Table & Join Canvas */}
          <div
            className="flex-1 relative overflow-auto bg-[#16171a] select-none"
            style={{
              backgroundImage:
                "radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)",
              backgroundSize: "18px 18px",
            }}
            onMouseMove={(e) => {
              const d = dragRef.current;
              if (!d) return;
              const dx = e.clientX - d.startX;
              const dy = e.clientY - d.startY;
              setTables((prev) =>
                prev.map((t) =>
                  t.id === d.tableId
                    ? {
                        ...t,
                        x: Math.max(0, Math.round(d.origX + dx)),
                        y: Math.max(0, Math.round(d.origY + dy)),
                      }
                    : t
                )
              );
            }}
            onMouseUp={() => {
              dragRef.current = null;
            }}
            onMouseLeave={() => {
              dragRef.current = null;
            }}
          >
            {tables.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 gap-1.5 pointer-events-none">
                <Wand2 className="w-8 h-8 opacity-30" />
                <p>Click tables on the left to add them to the query canvas.</p>
                <p className="text-[0.7rem]">
                  Foreign key JOINs are detected automatically.
                </p>
              </div>
            )}

            {/* Join SVG lines */}
            <svg
              className="absolute inset-0 overflow-visible pointer-events-none"
              width="3000"
              height="2000"
            >
              {joins.map((j) => {
                const lt = tableMap.get(j.leftTableId);
                const rt = tableMap.get(j.rightTableId);
                if (!lt || !rt) return null;
                const x1 = lt.x < rt.x ? lt.x + CARD_W : lt.x;
                const x2 = lt.x < rt.x ? rt.x : rt.x + CARD_W;
                const y1 = lt.y + HEADER_H + 14;
                const y2 = rt.y + HEADER_H + 14;
                const cx = (x1 + x2) / 2;
                return (
                  <g key={j.id}>
                    <path
                      d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke="#a78bfa"
                      strokeWidth="2"
                    />
                    <rect
                      x={cx - 26}
                      y={(y1 + y2) / 2 - 9}
                      width="52"
                      height="18"
                      rx="4"
                      fill="#1e1f22"
                      stroke="#7c3aed"
                      strokeWidth="1"
                    />
                    <text
                      x={cx}
                      y={(y1 + y2) / 2 + 3}
                      textAnchor="middle"
                      fill="#ddd6fe"
                      fontSize="9"
                      fontFamily="monospace"
                    >
                      {j.joinType.toUpperCase()}
                    </text>
                  </g>
                );
              })}
            </svg>

            {/* Draggable Table Cards */}
            {tables.map((t) => {
              const meta = metaByTableId[t.id];
              return (
                <div
                  key={t.id}
                  style={{ left: t.x, top: t.y, width: CARD_W }}
                  className="absolute rounded-md overflow-hidden bg-[#23252a] border border-[#3a3c44] shadow-lg z-10"
                >
                  <div
                    onMouseDown={(e) => {
                      dragRef.current = {
                        tableId: t.id,
                        startX: e.clientX,
                        startY: e.clientY,
                        origX: t.x,
                        origY: t.y,
                      };
                    }}
                    className="h-[30px] px-2 bg-violet-600 text-white flex items-center justify-between gap-1 cursor-move"
                  >
                    <span className="font-mono font-semibold truncate">
                      {t.table}{" "}
                      <span className="opacity-75 font-normal">({t.alias})</span>
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeTable(t.id);
                      }}
                      className="hover:bg-black/20 p-0.5 rounded cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="max-h-56 overflow-y-auto divide-y divide-zinc-800/70">
                    {(meta?.columns ?? []).map((c) => {
                      const isSel = columns.some(
                        (sc) => sc.tableId === t.id && sc.column === c.name
                      );
                      return (
                        <label
                          key={c.name}
                          className="h-[22px] px-2 flex items-center justify-between gap-1.5 hover:bg-zinc-800/60 cursor-pointer text-[0.7rem]"
                        >
                          <span className="flex items-center gap-1.5 min-w-0">
                            <input
                              type="checkbox"
                              checked={isSel}
                              onChange={() => toggleColumn(t.id, c.name)}
                            />
                            {c.isPrimaryKey && (
                              <KeyRound className="w-3 h-3 text-amber-400 shrink-0" />
                            )}
                            <span className="font-mono truncate text-zinc-200">
                              {c.name}
                            </span>
                          </span>
                          <span className="text-[0.62rem] text-zinc-400 font-mono shrink-0">
                            {c.dataType}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Bottom Clause Builder & Live SQL / Results */}
          <div className="h-64 border-t border-zinc-200 dark:border-[#32343a] flex flex-col shrink-0">
            <div className="px-2 py-1 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex items-center gap-1">
              {(
                [
                  ["sql", "Live SQL"],
                  ["columns", `Columns (${columns.length})`],
                  ["joins", `JOINs (${joins.length})`],
                  ["where", `WHERE (${whereConds.length})`],
                  ["order", `GROUP / ORDER`],
                  ["results", `Results${resultSet ? ` (${resultSet.rows.length})` : ""}`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setClauseTab(key)}
                  className={`px-2.5 py-1 rounded text-[0.72rem] font-medium cursor-pointer ${
                    clauseTab === key
                      ? "bg-indigo-600 text-white"
                      : "text-zinc-400 hover:bg-zinc-200 dark:hover:bg-[#32343a]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-auto p-2.5">
              {clauseTab === "sql" && (
                <pre className="h-full p-2.5 rounded bg-zinc-950 text-emerald-300 font-mono text-[0.75rem] whitespace-pre-wrap overflow-auto">
                  {generatedSql}
                </pre>
              )}

              {clauseTab === "columns" && (
                <div className="space-y-1.5">
                  {columns.length === 0 ? (
                    <div className="text-zinc-500">
                      Check columns on table cards above (empty = SELECT *).
                    </div>
                  ) : (
                    columns.map((c, idx) => {
                      const t = tableMap.get(c.tableId);
                      return (
                        <div
                          key={`${c.tableId}-${c.column}-${idx}`}
                          className="grid grid-cols-[1fr_110px_140px_auto] gap-2 items-center"
                        >
                          <span className="font-mono">
                            {t?.alias || t?.table}.{c.column}
                          </span>
                          <select
                            value={c.aggregate ?? ""}
                            onChange={(e) => {
                              const next = [...columns];
                              next[idx] = {
                                ...c,
                                aggregate: e.target.value || null,
                              };
                              setColumns(next);
                            }}
                            className="h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                          >
                            <option value="">No Agg</option>
                            <option value="COUNT">COUNT</option>
                            <option value="SUM">SUM</option>
                            <option value="AVG">AVG</option>
                            <option value="MIN">MIN</option>
                            <option value="MAX">MAX</option>
                          </select>
                          <input
                            value={c.alias ?? ""}
                            onChange={(e) => {
                              const next = [...columns];
                              next[idx] = { ...c, alias: e.target.value || null };
                              setColumns(next);
                            }}
                            placeholder="Alias..."
                            className="h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                          />
                          <button
                            onClick={() =>
                              setColumns((prev) => prev.filter((_, i) => i !== idx))
                            }
                            className="text-zinc-400 hover:text-red-400 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {clauseTab === "joins" && (
                <div className="space-y-2">
                  <button
                    onClick={() => {
                      if (tables.length < 2) return;
                      setJoins((prev) => [
                        ...prev,
                        {
                          id: makeId(),
                          leftTableId: tables[0].id,
                          leftColumn:
                            metaByTableId[tables[0].id]?.columns[0]?.name ?? "id",
                          rightTableId: tables[1].id,
                          rightColumn:
                            metaByTableId[tables[1].id]?.columns[0]?.name ?? "id",
                          joinType: "inner",
                        },
                      ]);
                    }}
                    disabled={tables.length < 2}
                    className="h-6 px-2 rounded bg-indigo-600 disabled:opacity-40 text-white flex items-center gap-1 cursor-pointer"
                  >
                    <Link2 className="w-3 h-3" /> Add JOIN
                  </button>
                  {joins.map((j, idx) => (
                    <div
                      key={j.id}
                      className="flex items-center gap-1.5 flex-wrap"
                    >
                      <select
                        value={j.joinType}
                        onChange={(e) => {
                          const next = [...joins];
                          next[idx] = {
                            ...j,
                            joinType: e.target.value as QbJoinType,
                          };
                          setJoins(next);
                        }}
                        className="h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                      >
                        <option value="inner">INNER JOIN</option>
                        <option value="left">LEFT JOIN</option>
                        <option value="right">RIGHT JOIN</option>
                        <option value="full">FULL OUTER JOIN</option>
                      </select>
                      <select
                        value={j.leftTableId}
                        onChange={(e) => {
                          const next = [...joins];
                          next[idx] = { ...j, leftTableId: e.target.value };
                          setJoins(next);
                        }}
                        className="h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                      >
                        {tables.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.table} ({t.alias})
                          </option>
                        ))}
                      </select>
                      <input
                        value={j.leftColumn}
                        onChange={(e) => {
                          const next = [...joins];
                          next[idx] = { ...j, leftColumn: e.target.value };
                          setJoins(next);
                        }}
                        className="h-6 w-28 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                      />
                      <span>=</span>
                      <select
                        value={j.rightTableId}
                        onChange={(e) => {
                          const next = [...joins];
                          next[idx] = { ...j, rightTableId: e.target.value };
                          setJoins(next);
                        }}
                        className="h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                      >
                        {tables.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.table} ({t.alias})
                          </option>
                        ))}
                      </select>
                      <input
                        value={j.rightColumn}
                        onChange={(e) => {
                          const next = [...joins];
                          next[idx] = { ...j, rightColumn: e.target.value };
                          setJoins(next);
                        }}
                        className="h-6 w-28 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                      />
                      <button
                        onClick={() =>
                          setJoins((prev) => prev.filter((x) => x.id !== j.id))
                        }
                        className="text-zinc-400 hover:text-red-400 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {clauseTab === "where" && (
                <div className="space-y-2">
                  <button
                    onClick={() => {
                      if (tables.length === 0) return;
                      setWhereConds((prev) => [
                        ...prev,
                        {
                          id: makeId(),
                          conjunction: "AND",
                          tableId: tables[0].id,
                          column:
                            metaByTableId[tables[0].id]?.columns[0]?.name ?? "id",
                          operator: "=",
                          value: "",
                        },
                      ]);
                    }}
                    disabled={tables.length === 0}
                    className="h-6 px-2 rounded bg-indigo-600 disabled:opacity-40 text-white flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" /> Add Condition
                  </button>
                  {whereConds.map((w, idx) => (
                    <div key={w.id} className="flex items-center gap-1.5 flex-wrap">
                      {idx > 0 && (
                        <select
                          value={w.conjunction}
                          onChange={(e) => {
                            const next = [...whereConds];
                            next[idx] = {
                              ...w,
                              conjunction: e.target.value as "AND" | "OR",
                            };
                            setWhereConds(next);
                          }}
                          className="h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                        >
                          <option value="AND">AND</option>
                          <option value="OR">OR</option>
                        </select>
                      )}
                      <select
                        value={w.tableId}
                        onChange={(e) => {
                          const next = [...whereConds];
                          next[idx] = { ...w, tableId: e.target.value };
                          setWhereConds(next);
                        }}
                        className="h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                      >
                        {tables.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.table} ({t.alias})
                          </option>
                        ))}
                      </select>
                      <input
                        value={w.column}
                        onChange={(e) => {
                          const next = [...whereConds];
                          next[idx] = { ...w, column: e.target.value };
                          setWhereConds(next);
                        }}
                        className="h-6 w-28 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                      />
                      <select
                        value={w.operator}
                        onChange={(e) => {
                          const next = [...whereConds];
                          next[idx] = { ...w, operator: e.target.value };
                          setWhereConds(next);
                        }}
                        className="h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                      >
                        {["=", "!=", ">", "<", ">=", "<=", "LIKE", "IN", "IS NULL", "IS NOT NULL"].map(
                          (op) => (
                            <option key={op} value={op}>
                              {op}
                            </option>
                          )
                        )}
                      </select>
                      {w.operator !== "IS NULL" && w.operator !== "IS NOT NULL" && (
                        <input
                          value={w.value ?? ""}
                          onChange={(e) => {
                            const next = [...whereConds];
                            next[idx] = { ...w, value: e.target.value };
                            setWhereConds(next);
                          }}
                          placeholder="Value"
                          className="h-6 w-36 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                        />
                      )}
                      <button
                        onClick={() =>
                          setWhereConds((prev) => prev.filter((x) => x.id !== w.id))
                        }
                        className="text-zinc-400 hover:text-red-400 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {clauseTab === "order" && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <div className="font-semibold">GROUP BY & HAVING</div>
                    <input
                      value={groupBy.join(", ")}
                      onChange={(e) =>
                        setGroupBy(
                          e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean)
                        )
                      }
                      placeholder='e.g. u.email, o.status'
                      className="w-full h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                    />
                    <input
                      value={having}
                      onChange={(e) => setHaving(e.target.value)}
                      placeholder="HAVING clause (e.g. COUNT(o.id) > 1)"
                      className="w-full h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">ORDER BY</span>
                      <button
                        onClick={() => {
                          if (tables.length === 0) return;
                          setOrderBy((prev) => [
                            ...prev,
                            {
                              tableId: tables[0].id,
                              column:
                                metaByTableId[tables[0].id]?.columns[0]?.name ?? "id",
                              direction: "ASC",
                            },
                          ]);
                        }}
                        className="text-indigo-400 hover:underline cursor-pointer"
                      >
                        + Add Sort
                      </button>
                    </div>
                    {orderBy.map((o, idx) => (
                      <div key={idx} className="flex items-center gap-1.5">
                        <select
                          value={o.tableId}
                          onChange={(e) => {
                            const next = [...orderBy];
                            next[idx] = { ...o, tableId: e.target.value };
                            setOrderBy(next);
                          }}
                          className="h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                        >
                          {tables.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.alias}
                            </option>
                          ))}
                        </select>
                        <input
                          value={o.column}
                          onChange={(e) => {
                            const next = [...orderBy];
                            next[idx] = { ...o, column: e.target.value };
                            setOrderBy(next);
                          }}
                          className="h-6 flex-1 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                        />
                        <select
                          value={o.direction}
                          onChange={(e) => {
                            const next = [...orderBy];
                            next[idx] = {
                              ...o,
                              direction: e.target.value as "ASC" | "DESC",
                            };
                            setOrderBy(next);
                          }}
                          className="h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                        >
                          <option value="ASC">ASC</option>
                          <option value="DESC">DESC</option>
                        </select>
                        <button
                          onClick={() =>
                            setOrderBy((prev) => prev.filter((_, i) => i !== idx))
                          }
                          className="text-zinc-400 hover:text-red-400 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {clauseTab === "results" && (
                <div className="h-full overflow-auto">
                  {!resultSet ? (
                    <div className="text-zinc-500">
                      Click <strong>Run Query</strong> to preview results here.
                    </div>
                  ) : (
                    <table className="w-full border-collapse text-[0.72rem] font-mono">
                      <thead>
                        <tr className="bg-zinc-100 dark:bg-[#25262a] border-b border-zinc-300 dark:border-[#35373c]">
                          {resultSet.columns.map((col) => (
                            <th
                              key={col.name}
                              className="px-2 py-1 text-left font-semibold whitespace-nowrap"
                            >
                              {col.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-200 dark:divide-[#2e3036]">
                        {resultSet.rows.map((row, rIdx) => (
                          <tr key={rIdx}>
                            {row.map((val, cIdx) => (
                              <td
                                key={cIdx}
                                className="px-2 py-1 whitespace-nowrap max-w-[260px] truncate"
                              >
                                {val === null ? (
                                  <span className="text-zinc-500 italic">NULL</span>
                                ) : typeof val === "object" ? (
                                  JSON.stringify(val)
                                ) : (
                                  String(val)
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
