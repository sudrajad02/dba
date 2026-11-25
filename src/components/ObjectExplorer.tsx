import React, { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Database,
  Edit3,
  Eye,
  FileCode2,
  Folder,
  FunctionSquare,
  KeyRound,
  Layers,
  ListTree,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  Wrench,
  Zap,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import type { ConnectionProfile, DatabaseObject, ObjectKind } from "../types/datavault";

interface ContextMenuState {
  x: number;
  y: number;
  type: "connection" | "database" | "object";
  connection: ConnectionProfile;
  database?: string;
  schema?: string;
  object?: DatabaseObject;
}

const ENV_DOT: Record<string, string> = {
  production: "bg-red-500",
  staging: "bg-amber-400",
  dev: "bg-emerald-400",
  local: "bg-emerald-500",
};

const OBJECT_CATEGORIES: {
  id: string;
  kinds: ObjectKind[];
  label: string;
  browserCategory?: "table" | "view" | "function";
}[] = [
  { id: "collection", kinds: ["collection"], label: "Collections", browserCategory: "table" },
  { id: "table", kinds: ["table"], label: "Tables", browserCategory: "table" },
  { id: "view", kinds: ["view", "materialized_view"], label: "Views", browserCategory: "view" },
  { id: "function", kinds: ["function", "procedure"], label: "Functions", browserCategory: "function" },
  { id: "trigger", kinds: ["trigger"], label: "Triggers" },
  { id: "index", kinds: ["index"], label: "Indexes" },
  { id: "sequence", kinds: ["sequence"], label: "Sequences" },
  { id: "enum_type", kinds: ["enum_type"], label: "Enums / Types" },
  { id: "event", kinds: ["event"], label: "Events" },
];

export const ObjectExplorer: React.FC = () => {
  const {
    connections,
    connectedIds,
    databasesByConn,
    schemasByConnDb,
    objectsByKey,
    connectTo,
    disconnectFrom,
    loadDatabases,
    loadSchemas,
    loadObjects,
    openTab,
    openConnectionModal,
    refreshConnections,
    openSafetyModal,
    addLog,
    savedQueries,
    setBrowserContext,
    copiedObject,
    setCopiedObject,
    pasteCopiedObject,
  } = useWorkbenchStore();

  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setLoading = (key: string, on: boolean) => {
    setLoadingKeys((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const handleToggleConnection = async (conn: ConnectionProfile) => {
    const key = `conn:${conn.id}`;
    if (!connectedIds.has(conn.id)) {
      setLoading(key, true);
      const ok = await connectTo(conn.id);
      setLoading(key, false);
      if (ok) {
        setExpanded((prev) => new Set(prev).add(key));
      }
      return;
    }
    toggleExpand(key);
  };

  const handleToggleDatabase = async (conn: ConnectionProfile, dbName: string) => {
    const key = `db:${conn.id}:${dbName}`;
    const willExpand = !expanded.has(key);
    toggleExpand(key);

    if (conn.engine === "postgres" || conn.engine === "mssql") {
      if (willExpand) {
        setLoading(key, true);
        const schemas = await loadSchemas(conn.id, dbName);
        const preferred = conn.engine === "mssql" ? "dbo" : "public";
        const defaultSchema =
          schemas.find((s) => s.name === preferred)?.name ?? schemas[0]?.name ?? preferred;
        await loadObjects(conn.id, dbName, defaultSchema);
        setLoading(key, false);
        setBrowserContext({
          connectionId: conn.id,
          database: dbName,
          schema: defaultSchema,
          category: "table",
        });
      }
    } else {
      setBrowserContext({
        connectionId: conn.id,
        database: dbName,
        schema: dbName,
        category: "table",
      });
      if (willExpand) {
        setLoading(key, true);
        await loadObjects(conn.id, dbName, dbName);
        setLoading(key, false);
      }
    }
  };

  const handleToggleSchema = async (
    conn: ConnectionProfile,
    dbName: string,
    schemaName: string
  ) => {
    const key = `schema:${conn.id}:${dbName}:${schemaName}`;
    const willExpand = !expanded.has(key);
    toggleExpand(key);
    setBrowserContext({
      connectionId: conn.id,
      database: dbName,
      schema: schemaName,
      category: "table",
    });
    if (!willExpand) return;

    setLoading(key, true);
    await loadObjects(conn.id, dbName, schemaName);
    setLoading(key, false);
  };

  const groupedConnections = useMemo(() => {
    const groups: Record<string, ConnectionProfile[]> = {};
    const q = filter.trim().toLowerCase();
    for (const c of connections) {
      const g = c.groupPath?.trim() || "Connections";
      if (!groups[g]) groups[g] = [];
      if (
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.host.toLowerCase().includes(q) ||
        connectedIds.has(c.id)
      ) {
        groups[g].push(c);
      }
    }
    return groups;
  }, [connections, filter, connectedIds]);

  const handleCopyDdl = async (
    conn: ConnectionProfile,
    db: string,
    schema: string | undefined,
    obj: DatabaseObject
  ) => {
    try {
      let ddl: string | null = null;
      if (obj.kind === "table") {
        const meta = await api.getTableMetadata(conn.id, obj.name, db, schema);
        ddl = meta.ddl ?? null;
      }
      if (!ddl) {
        ddl = await api.getObjectDdl(conn.id, obj.name, obj.kind, db, schema);
      }
      if (ddl) {
        await navigator.clipboard.writeText(ddl);
        addLog("success", `Copied DDL for ${obj.kind} "${obj.name}" to clipboard`);
      }
    } catch (err) {
      addLog("error", `Copy DDL failed: ${formatApiError(err)}`);
    }
  };

  const handleDuplicateTable = async (
    conn: ConnectionProfile,
    db: string,
    schema: string | undefined,
    table: string
  ) => {
    const target = window.prompt(`Duplicate table "${table}" as:`, `${table}_copy`);
    if (!target || !target.trim()) return;
    try {
      await api.duplicateTable(conn.id, table, target.trim(), true, db, schema);
      addLog("success", `Duplicated table ${table} -> ${target.trim()}`);
      await loadObjects(conn.id, db, schema ?? db);
    } catch (err) {
      addLog("error", `Duplicate failed: ${formatApiError(err)}`);
    }
  };

  const handleTruncate = (
    conn: ConnectionProfile,
    db: string,
    schema: string | undefined,
    table: string
  ) => {
    openSafetyModal({
      title: `Truncate Table "${table}"`,
      warnings: [
        `All rows in "${table}" will be permanently deleted.`,
        ...(conn.environment === "production"
          ? [`Target connection "${conn.name}" is PRODUCTION!`]
          : []),
      ],
      sqlPreview: `TRUNCATE TABLE ${schema ? `${schema}.` : ""}${table};`,
      onConfirm: async () => {
        try {
          await api.truncateTable(conn.id, table, true, db, schema);
          addLog("warn", `Truncated table ${table}`);
        } catch (err) {
          addLog("error", formatApiError(err));
        }
      },
    });
  };

  const handleDropObject = (
    conn: ConnectionProfile,
    db: string,
    schema: string | undefined,
    obj: DatabaseObject
  ) => {
    openSafetyModal({
      title: `Drop ${obj.kind} "${obj.name}"`,
      warnings: [
        `This will permanently DROP ${obj.kind.toUpperCase()} "${obj.name}".`,
        ...(conn.environment === "production"
          ? [`Target connection "${conn.name}" is PRODUCTION!`]
          : []),
      ],
      sqlPreview: `DROP ${obj.kind.toUpperCase()} ${schema ? `${schema}.` : ""}${obj.name};`,
      onConfirm: async () => {
        try {
          await api.dropObject(conn.id, obj.name, obj.kind, true, db, schema);
          addLog("warn", `Dropped ${obj.kind} ${obj.name}`);
          await loadObjects(conn.id, db, schema ?? db);
        } catch (err) {
          addLog("error", formatApiError(err));
        }
      },
    });
  };

  const renderObjectIcon = (kind: ObjectKind) => {
    switch (kind) {
      case "table":
        return <Table2 className="w-3.5 h-3.5 text-cyan-500 dark:text-cyan-400 shrink-0" />;
      case "collection":
        return <Layers className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" />;
      case "view":
      case "materialized_view":
        return <Eye className="w-3.5 h-3.5 text-neutral-500 dark:text-neutral-400 shrink-0" />;
      case "function":
      case "procedure":
        return <FunctionSquare className="w-3.5 h-3.5 text-amber-400 shrink-0" />;
      case "trigger":
      case "event":
        return <Zap className="w-3.5 h-3.5 text-orange-400 shrink-0" />;
      case "index":
        return <KeyRound className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
      default:
        return <ListTree className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
    }
  };

  const renderObjectGroups = (
    conn: ConnectionProfile,
    dbName: string,
    schemaName: string | undefined
  ) => {
    const key = `${conn.id}::${dbName}::${schemaName ?? ""}`;
    const allObjs = objectsByKey[key] ?? [];
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? allObjs.filter((o) => o.name.toLowerCase().includes(q))
      : allObjs;

    return (
      <div className="pl-3 space-y-0.5">
        {OBJECT_CATEGORIES.map((cat) => {
          const items = filtered.filter((o) => cat.kinds.includes(o.kind));
          if (items.length === 0 && cat.id !== "table" && !(conn.engine === "mongodb" && cat.id === "collection"))
            return null;
          if (conn.engine === "mongodb" && cat.id === "table" && items.length === 0) return null;
          const catKey = `cat:${key}:${cat.id}`;
          const isOpen = expanded.has(catKey) || (q.length > 0 && items.length > 0);
          return (
            <div key={cat.id}>
              <button
                onClick={() => {
                  toggleExpand(catKey);
                  if (cat.browserCategory) {
                    setBrowserContext({
                      connectionId: conn.id,
                      database: dbName,
                      schema: schemaName ?? dbName,
                      category: cat.browserCategory,
                    });
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({
                    x: e.clientX,
                    y: e.clientY,
                    type: "database",
                    connection: conn,
                    database: dbName,
                    schema: schemaName ?? dbName,
                  });
                }}
                className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-xs text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/80"
              >
                {isOpen ? (
                  <ChevronDown className="w-3 h-3 shrink-0" />
                ) : (
                  <ChevronRight className="w-3 h-3 shrink-0" />
                )}
                <span className="truncate font-medium">{cat.label}</span>
                <span className="ml-auto text-[0.72rem] text-zinc-500">{items.length}</span>
              </button>
              {isOpen && (
                <div className="pl-3 space-y-0.5">
                  {items.map((obj) => (
                    <div
                      key={`${obj.kind}-${obj.name}`}
                      onDoubleClick={() => {
                        if (conn.engine === "mongodb" && (obj.kind === "collection" || obj.kind === "view")) {
                          openTab({
                            kind: "mongo_collection",
                            title: obj.name,
                            connectionId: conn.id,
                            database: dbName,
                            collection: obj.name,
                          });
                        } else if (obj.kind === "table" || obj.kind === "view" || obj.kind === "materialized_view") {
                          openTab({
                            kind: "table",
                            title: obj.name,
                            connectionId: conn.id,
                            database: dbName,
                            schema: schemaName,
                            table: obj.name,
                          });
                        }
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtxMenu({
                          x: e.clientX,
                          y: e.clientY,
                          type: "object",
                          connection: conn,
                          database: dbName,
                          schema: schemaName,
                          object: obj,
                        });
                      }}
                      className="group flex items-center gap-1.5 px-1.5 py-1 rounded text-xs text-zinc-800 dark:text-zinc-200 hover:bg-indigo-500/15 cursor-pointer"
                    >
                      {renderObjectIcon(obj.kind)}
                      <span className="truncate">{obj.name}</span>
                      {obj.rowEstimate != null && obj.kind === "table" && (
                        <span className="ml-auto text-[0.72rem] text-zinc-500 opacity-0 group-hover:opacity-100">
                          ~{obj.rowEstimate.toLocaleString()}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <aside
      className="w-64 shrink-0 h-full flex flex-col border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/70 select-none"
      onClick={() => ctxMenu && setCtxMenu(null)}
    >
      {/* Search Filter */}
      <div className="p-2 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter objects..."
            className="w-full h-7 pl-7 pr-2 text-xs rounded-md bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <button
          onClick={() => openConnectionModal(null)}
          title="New Connection"
          className="h-7 w-7 flex items-center justify-center rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Tree Content */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-3">
        {Object.entries(groupedConnections).map(([groupName, conns]) => (
          <div key={groupName}>
            <div className="px-1.5 pb-1 text-[0.72rem] font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-1">
              <Folder className="w-3 h-3" />
              {groupName}
            </div>
            {conns.length === 0 ? (
              <div className="px-2 py-2 text-xs text-zinc-500 italic">
                No connections yet
              </div>
            ) : (
              <div className="space-y-0.5">
                {conns.map((conn) => {
                  const isConnected = connectedIds.has(conn.id);
                  const connKey = `conn:${conn.id}`;
                  const isOpen = expanded.has(connKey);
                  const dbs = databasesByConn[conn.id] ?? [];

                  return (
                    <div key={conn.id}>
                      <div
                        onClick={() => handleToggleConnection(conn)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setCtxMenu({
                            x: e.clientX,
                            y: e.clientY,
                            type: "connection",
                            connection: conn,
                          });
                        }}
                        className="group flex items-center gap-1.5 px-1.5 py-1.5 rounded-md text-xs font-medium text-zinc-800 dark:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 cursor-pointer"
                      >
                        {isOpen ? (
                          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        )}
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            isConnected
                              ? ENV_DOT[conn.environment] ?? "bg-emerald-500"
                              : "bg-zinc-500/40"
                          }`}
                        />
                        <span className="truncate">{conn.name}</span>
                        <span className="ml-auto text-[0.72rem] px-1 rounded bg-zinc-200 dark:bg-zinc-800 text-zinc-500 uppercase">
                          {conn.engine === "postgres"
                            ? "PG"
                            : conn.engine === "mysql"
                            ? "MY"
                            : conn.engine === "mssql"
                            ? "MS"
                            : "MG"}
                        </span>
                        {loadingKeys.has(connKey) && (
                          <RefreshCw className="w-3 h-3 animate-spin text-indigo-500 dark:text-indigo-400" />
                        )}
                      </div>

                      {isConnected && isOpen && (
                        <div className="pl-3 mt-0.5 space-y-0.5">
                          {dbs.map((db) => {
                            const dbKey = `db:${conn.id}:${db.name}`;
                            const dbOpen = expanded.has(dbKey);
                            const schemas =
                              schemasByConnDb[`${conn.id}::${db.name}`] ?? [];

                            return (
                              <div key={db.name}>
                                <button
                                  onClick={() => handleToggleDatabase(conn, db.name)}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    setCtxMenu({
                                      x: e.clientX,
                                      y: e.clientY,
                                      type: "database",
                                      connection: conn,
                                      database: db.name,
                                      schema:
                                        conn.engine === "postgres"
                                          ? "public"
                                          : conn.engine === "mssql"
                                          ? "dbo"
                                          : db.name,
                                    });
                                  }}
                                  className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/80"
                                >
                                  {dbOpen ? (
                                    <ChevronDown className="w-3 h-3 text-zinc-500 shrink-0" />
                                  ) : (
                                    <ChevronRight className="w-3 h-3 text-zinc-500 shrink-0" />
                                  )}
                                  <Database className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
                                  <span className="truncate">{db.name}</span>
                                  {loadingKeys.has(dbKey) && (
                                    <RefreshCw className="w-3 h-3 ml-auto animate-spin text-indigo-500 dark:text-indigo-400" />
                                  )}
                                </button>

                                {dbOpen &&
                                  (conn.engine === "postgres" || conn.engine === "mssql" ? (
                                    <div className="pl-3 space-y-0.5">
                                      {schemas.map((sc) => {
                                        const scKey = `schema:${conn.id}:${db.name}:${sc.name}`;
                                        const scOpen = expanded.has(scKey);
                                        return (
                                          <div key={sc.name}>
                                            <button
                                              onClick={() =>
                                                handleToggleSchema(conn, db.name, sc.name)
                                              }
                                              onContextMenu={(e) => {
                                                e.preventDefault();
                                                setCtxMenu({
                                                  x: e.clientX,
                                                  y: e.clientY,
                                                  type: "database",
                                                  connection: conn,
                                                  database: db.name,
                                                  schema: sc.name,
                                                });
                                              }}
                                              className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-xs text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/80"
                                            >
                                              {scOpen ? (
                                                <ChevronDown className="w-3 h-3 text-zinc-500" />
                                              ) : (
                                                <ChevronRight className="w-3 h-3 text-zinc-500" />
                                              )}
                                              <Layers className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                                              <span className="truncate">{sc.name}</span>
                                            </button>
                                            {scOpen &&
                                              renderObjectGroups(conn, db.name, sc.name)}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    renderObjectGroups(conn, db.name, db.name)
                                  ))}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}

        {/* Saved Queries Section */}
        {savedQueries.length > 0 && (
          <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800">
            <div className="px-1.5 pb-1 text-[0.72rem] font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-1">
              <FileCode2 className="w-3 h-3" />
              Saved Queries
            </div>
            <div className="space-y-0.5">
              {savedQueries.map((sq) => (
                <button
                  key={sq.id}
                  onClick={() =>
                    openTab({
                      kind: "query",
                      title: `${sq.name}.sql`,
                      sql: sq.sql,
                    })
                  }
                  className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-zinc-700 dark:text-zinc-300 hover:bg-indigo-500/15 text-left"
                >
                  <FileCode2 className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
                  <span className="truncate">{sq.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Context Menu */}
      {ctxMenu && (
        <div
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          className="fixed z-50 w-48 py-1 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.type === "connection" ? (
            <>
              {connectedIds.has(ctxMenu.connection.id) ? (
                <button
                  onClick={() => {
                    disconnectFrom(ctxMenu.connection.id);
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Plug className="w-3.5 h-3.5 text-amber-400" /> Disconnect
                </button>
              ) : (
                <button
                  onClick={() => {
                    connectTo(ctxMenu.connection.id);
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <PlugZap className="w-3.5 h-3.5 text-emerald-400" /> Connect
                </button>
              )}
              <button
                onClick={() => {
                  if (ctxMenu.connection.engine === "mongodb") {
                    openTab({
                      kind: "mongo_query",
                      title: `MQL — ${ctxMenu.connection.name}`,
                      connectionId: ctxMenu.connection.id,
                      database: ctxMenu.connection.database ?? undefined,
                      mongoMode: "mql",
                    });
                  } else {
                    openTab({
                      kind: "query",
                      title: `Query — ${ctxMenu.connection.name}`,
                      connectionId: ctxMenu.connection.id,
                      database: ctxMenu.connection.database ?? undefined,
                      sql: "",
                    });
                  }
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <FileCode2 className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />{" "}
                {ctxMenu.connection.engine === "mongodb" ? "New MQL Query" : "New Query"}
              </button>
              <button
                onClick={() => {
                  loadDatabases(ctxMenu.connection.id);
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh Databases
              </button>
              <button
                onClick={() => {
                  openConnectionModal(ctxMenu.connection);
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <Edit3 className="w-3.5 h-3.5" /> Edit Connection
              </button>
              <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
              <button
                onClick={async () => {
                  await api.deleteConnection(ctxMenu.connection.id);
                  await refreshConnections();
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-red-500 hover:bg-red-500/10"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete Connection
              </button>
            </>
          ) : ctxMenu.type === "database" ? (
            <>
              <button
                disabled={!copiedObject}
                onClick={() => {
                  if (ctxMenu.database) {
                    pasteCopiedObject(
                      ctxMenu.connection.id,
                      ctxMenu.database,
                      ctxMenu.schema ?? ctxMenu.database
                    );
                  }
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
              >
                <ClipboardPaste className="w-3.5 h-3.5 text-teal-400" />
                {copiedObject
                  ? `Paste "${copiedObject.object.name}" (${copiedObject.object.kind})`
                  : "Paste Object (nothing copied)"}
              </button>
              <button
                onClick={() => {
                  if (ctxMenu.database) {
                    loadObjects(
                      ctxMenu.connection.id,
                      ctxMenu.database,
                      ctxMenu.schema ?? ctxMenu.database
                    );
                  }
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh Objects
              </button>
            </>
          ) : (
            ctxMenu.object && (
              <>
                <button
                  onClick={() => {
                    if (ctxMenu.connection.engine === "mongodb") {
                      openTab({
                        kind: "mongo_collection",
                        title: ctxMenu.object!.name,
                        connectionId: ctxMenu.connection.id,
                        database: ctxMenu.database,
                        collection: ctxMenu.object!.name,
                      });
                    } else {
                      openTab({
                        kind: "table",
                        title: ctxMenu.object!.name,
                        connectionId: ctxMenu.connection.id,
                        database: ctxMenu.database,
                        schema: ctxMenu.schema,
                        table: ctxMenu.object!.name,
                      });
                    }
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Table2 className="w-3.5 h-3.5 text-cyan-500 dark:text-cyan-400" />{" "}
                  {ctxMenu.connection.engine === "mongodb" ? "Open Collection" : "Open Table Data"}
                </button>
                {ctxMenu.connection.engine === "mongodb" && ctxMenu.object.kind === "collection" && (
                  <>
                    <button
                      onClick={() => {
                        openTab({
                          kind: "mongo_query",
                          title: `Pipeline: ${ctxMenu.object!.name}`,
                          connectionId: ctxMenu.connection.id,
                          database: ctxMenu.database,
                          collection: ctxMenu.object!.name,
                          mongoMode: "pipeline",
                        });
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <Layers className="w-3.5 h-3.5 text-emerald-400" /> Aggregation Pipeline
                    </button>
                    <button
                      onClick={() => {
                        openTab({
                          kind: "mongo_designer",
                          title: `Design: ${ctxMenu.object!.name}`,
                          connectionId: ctxMenu.connection.id,
                          database: ctxMenu.database,
                          collection: ctxMenu.object!.name,
                        });
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <Wrench className="w-3.5 h-3.5 text-amber-400" /> Indexes & Validation
                    </button>
                  </>
                )}
                {ctxMenu.object.kind === "table" && (
                  <button
                    onClick={() => {
                      openTab({
                        kind: "designer",
                        title: `Design: ${ctxMenu.object!.name}`,
                        connectionId: ctxMenu.connection.id,
                        database: ctxMenu.database,
                        schema: ctxMenu.schema,
                        table: ctxMenu.object!.name,
                        isNewTable: false,
                      });
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <Wrench className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" /> Design Table
                  </button>
                )}
                <button
                  onClick={() => {
                    openTab({
                      kind: "import_export",
                      title: `Export: ${ctxMenu.object!.name}`,
                      connectionId: ctxMenu.connection.id,
                      database: ctxMenu.database,
                      schema: ctxMenu.schema,
                      table: ctxMenu.object!.name,
                      wizardMode: "export",
                    });
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <FileCode2 className="w-3.5 h-3.5 text-indigo-400" /> Export Wizard...
                </button>
                <button
                  onClick={() => {
                    openTab({
                      kind: "import_export",
                      title: `Import: ${ctxMenu.object!.name}`,
                      connectionId: ctxMenu.connection.id,
                      database: ctxMenu.database,
                      schema: ctxMenu.schema,
                      table: ctxMenu.object!.name,
                      wizardMode: "import",
                    });
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <FileCode2 className="w-3.5 h-3.5 text-emerald-400" /> Import Wizard...
                </button>
                {ctxMenu.object.kind === "table" && (
                  <button
                    onClick={() => {
                      openTab({
                        kind: "dump_backup",
                        title: `Dump: ${ctxMenu.object!.name}`,
                        connectionId: ctxMenu.connection.id,
                        database: ctxMenu.database,
                        schema: ctxMenu.schema,
                        table: ctxMenu.object!.name,
                        wizardMode: "dump",
                      });
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <Database className="w-3.5 h-3.5 text-blue-400" /> Dump SQL File...
                  </button>
                )}
                <button
                  onClick={() => {
                    if (ctxMenu.database && ctxMenu.object) {
                      setCopiedObject({
                        connectionId: ctxMenu.connection.id,
                        database: ctxMenu.database,
                        schema: ctxMenu.schema ?? ctxMenu.database,
                        object: ctxMenu.object,
                      });
                      addLog(
                        "info",
                        `Copied ${ctxMenu.object.kind} "${ctxMenu.object.name}" — paste into any target database`
                      );
                    }
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Copy className="w-3.5 h-3.5 text-teal-400" /> Copy {ctxMenu.object.kind}
                </button>
                {copiedObject && ctxMenu.database && (
                  <button
                    onClick={() => {
                      pasteCopiedObject(
                        ctxMenu.connection.id,
                        ctxMenu.database!,
                        ctxMenu.schema ?? ctxMenu.database!
                      );
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <ClipboardPaste className="w-3.5 h-3.5 text-emerald-400" /> Paste "{copiedObject.object.name}"
                  </button>
                )}
                <button
                  onClick={() => {
                    handleCopyDdl(
                      ctxMenu.connection,
                      ctxMenu.database!,
                      ctxMenu.schema,
                      ctxMenu.object!
                    );
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <Copy className="w-3.5 h-3.5" /> Copy DDL
                </button>
                {ctxMenu.object.kind === "table" && (
                  <>
                    <button
                      onClick={() => {
                        handleDuplicateTable(
                          ctxMenu.connection,
                          ctxMenu.database!,
                          ctxMenu.schema,
                          ctxMenu.object!.name
                        );
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <Copy className="w-3.5 h-3.5 text-sky-400" /> Duplicate Table
                    </button>
                    <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                    <button
                      onClick={() => {
                        handleTruncate(
                          ctxMenu.connection,
                          ctxMenu.database!,
                          ctxMenu.schema,
                          ctxMenu.object!.name
                        );
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-amber-500 hover:bg-amber-500/10"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Empty / Truncate
                    </button>
                  </>
                )}
                <button
                  onClick={() => {
                    handleDropObject(
                      ctxMenu.connection,
                      ctxMenu.database!,
                      ctxMenu.schema,
                      ctxMenu.object!
                    );
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-red-500 hover:bg-red-500/10"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Drop {ctxMenu.object.kind}
                </button>
              </>
            )
          )}
        </div>
      )}
    </aside>
  );
};
