import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Database,
  Edit3,
  Eye,
  FileCode2,
  Folder,
  FolderOpen,
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
  X,
  Zap,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import {
  buildTabFromSavedQuery,
  formatSavedQueryFilename,
  isMongoSavedQuery,
} from "../lib/savedQueries";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { SaveQueryModal } from "./SaveQueryModal";
import type {
  ConnectionProfile,
  DatabaseObject,
  ObjectKind,
  SavedQuery,
} from "../types/dba";

interface ContextMenuState {
  x: number;
  y: number;
  type: "connection" | "database" | "object" | "saved_query";
  connection?: ConnectionProfile;
  database?: string;
  schema?: string;
  object?: DatabaseObject;
  savedQuery?: SavedQuery;
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
    updateTab,
    tabs,
    openConnectionModal,
    refreshConnections,
    refreshSavedQueries,
    openSafetyModal,
    addLog,
    savedQueries,
    browserContext,
    setBrowserContext,
    copiedObject,
    setCopiedObject,
    pasteCopiedObject,
  } = useWorkbenchStore();

  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [queryModal, setQueryModal] = useState<{
    mode: "rename" | "duplicate";
    query: SavedQuery;
  } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const handleOutside = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("mousedown", handleOutside);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleOutside);
      window.removeEventListener("keydown", handleKey);
    };
  }, [ctxMenu]);
  const [createDbModal, setCreateDbModal] = useState<{
    connection: ConnectionProfile;
    name: string;
    charset: string;
    collation: string;
    submitting: boolean;
    error: string | null;
  } | null>(null);

  const openCreateDbModal = (conn: ConnectionProfile) => {
    setCreateDbModal({
      connection: conn,
      name: "",
      charset: conn.engine === "mysql" ? "utf8mb4" : conn.engine === "postgres" ? "UTF8" : "",
      collation: conn.engine === "mysql" ? "utf8mb4_unicode_ci" : "",
      submitting: false,
      error: null,
    });
  };

  const handleCreateDatabase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createDbModal) return;
    const trimmed = createDbModal.name.trim();
    if (!trimmed) {
      setCreateDbModal((prev) => (prev ? { ...prev, error: "Database name is required." } : null));
      return;
    }

    setCreateDbModal((prev) => (prev ? { ...prev, submitting: true, error: null } : null));
    const { connection, charset, collation } = createDbModal;
    try {
      if (!connectedIds.has(connection.id)) {
        const ok = await connectTo(connection.id);
        if (!ok) {
          setCreateDbModal((prev) =>
            prev ? { ...prev, submitting: false, error: "Failed to connect to server." } : null
          );
          return;
        }
      }
      await api.createDatabase(
        connection.id,
        trimmed,
        charset.trim() || undefined,
        collation.trim() || undefined
      );
      addLog("success", `Created database "${trimmed}" on ${connection.name}`);
      await loadDatabases(connection.id);
      setExpanded((prev) => new Set(prev).add(`conn:${connection.id}`));
      setCreateDbModal(null);
    } catch (err) {
      const msg = formatApiError(err);
      setCreateDbModal((prev) => (prev ? { ...prev, submitting: false, error: msg } : null));
      addLog("error", `Create database failed: ${msg}`);
    }
  };

  const handleDropDatabase = (conn: ConnectionProfile, db: string) => {
    const quoted =
      conn.engine === "mysql"
        ? `\`${db}\``
        : conn.engine === "mssql"
        ? `[${db}]`
        : `"${db}"`;
    openSafetyModal({
      title: `Drop Database "${db}"`,
      warnings: [
        `This will permanently DROP DATABASE "${db}" and ALL tables/data inside it.`,
        ...(conn.environment === "production"
          ? [`Target connection "${conn.name}" is PRODUCTION!`]
          : []),
      ],
      sqlPreview:
        conn.engine === "mongodb"
          ? `db.getSiblingDB("${db}").dropDatabase()`
          : `DROP DATABASE ${quoted};`,
      onConfirm: async () => {
        try {
          await api.dropDatabase(conn.id, db, true);
          addLog("warn", `Dropped database "${db}" on ${conn.name}`);
          await loadDatabases(conn.id);
        } catch (err) {
          addLog("error", `Drop database failed: ${formatApiError(err)}`);
        }
      },
    });
  };

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

  const handleSelectConnection = (conn: ConnectionProfile) => {
    setSelectedNodeKey(`conn:${conn.id}`);
    setBrowserContext({
      connectionId: conn.id,
      database: null,
      schema: null,
      category: "table",
    });
  };

  const handleDoubleClickConnection = async (conn: ConnectionProfile) => {
    const key = `conn:${conn.id}`;
    setSelectedNodeKey(key);
    if (!connectedIds.has(conn.id)) {
      setLoading(key, true);
      const ok = await connectTo(conn.id);
      setLoading(key, false);
      if (ok) {
        setExpanded((prev) => new Set(prev).add(key));
      }
      return;
    }
    if (!expanded.has(key)) {
      setExpanded((prev) => new Set(prev).add(key));
    }
  };

  const loadDatabaseChildren = async (conn: ConnectionProfile, dbName: string) => {
    const key = `db:${conn.id}:${dbName}`;
    if (conn.engine === "postgres" || conn.engine === "mssql") {
      const existingSchemas = schemasByConnDb[`${conn.id}::${dbName}`];
      setLoading(key, true);
      const schemas = existingSchemas ?? (await loadSchemas(conn.id, dbName));
      const preferred = conn.engine === "mssql" ? "dbo" : "public";
      const defaultSchema =
        schemas.find((s) => s.name === preferred)?.name ?? schemas[0]?.name ?? preferred;
      if (!objectsByKey[`${conn.id}::${dbName}::${defaultSchema}`]) {
        await loadObjects(conn.id, dbName, defaultSchema);
      }
      setLoading(key, false);
      return defaultSchema;
    } else {
      if (!objectsByKey[`${conn.id}::${dbName}::${dbName}`]) {
        setLoading(key, true);
        await loadObjects(conn.id, dbName, dbName);
        setLoading(key, false);
      }
      return dbName;
    }
  };

  const handleToggleDatabase = async (conn: ConnectionProfile, dbName: string) => {
    const key = `db:${conn.id}:${dbName}`;
    const willExpand = !expanded.has(key);
    toggleExpand(key);
    if (willExpand) {
      await loadDatabaseChildren(conn, dbName);
    }
  };

  const handleSelectDatabase = async (conn: ConnectionProfile, dbName: string) => {
    setSelectedNodeKey(`db:${conn.id}:${dbName}`);
    if (conn.engine === "postgres" || conn.engine === "mssql") {
      const cachedSchemas = schemasByConnDb[`${conn.id}::${dbName}`];
      const preferred = conn.engine === "mssql" ? "dbo" : "public";
      const initialSchema =
        cachedSchemas?.find((s) => s.name === preferred)?.name ??
        cachedSchemas?.[0]?.name ??
        preferred;
      setBrowserContext({
        connectionId: conn.id,
        database: dbName,
        schema: initialSchema,
        category: "table",
      });
      if (!cachedSchemas || !objectsByKey[`${conn.id}::${dbName}::${initialSchema}`]) {
        const resolvedSchema = await loadDatabaseChildren(conn, dbName);
        if (resolvedSchema !== initialSchema) {
          setBrowserContext({
            connectionId: conn.id,
            database: dbName,
            schema: resolvedSchema,
            category: "table",
          });
        }
      }
    } else {
      setBrowserContext({
        connectionId: conn.id,
        database: dbName,
        schema: dbName,
        category: "table",
      });
      if (!objectsByKey[`${conn.id}::${dbName}::${dbName}`]) {
        await loadDatabaseChildren(conn, dbName);
      }
    }
  };

  const handleDoubleClickDatabase = async (conn: ConnectionProfile, dbName: string) => {
    const key = `db:${conn.id}:${dbName}`;
    setExpanded((prev) => new Set(prev).add(key));
    await handleSelectDatabase(conn, dbName);
  };

  const handleToggleSchema = async (
    conn: ConnectionProfile,
    dbName: string,
    schemaName: string
  ) => {
    const key = `schema:${conn.id}:${dbName}:${schemaName}`;
    const willExpand = !expanded.has(key);
    toggleExpand(key);
    if (!willExpand) return;

    if (!objectsByKey[`${conn.id}::${dbName}::${schemaName}`]) {
      setLoading(key, true);
      await loadObjects(conn.id, dbName, schemaName);
      setLoading(key, false);
    }
  };

  const handleSelectSchema = async (
    conn: ConnectionProfile,
    dbName: string,
    schemaName: string
  ) => {
    const key = `schema:${conn.id}:${dbName}:${schemaName}`;
    setSelectedNodeKey(key);
    setBrowserContext({
      connectionId: conn.id,
      database: dbName,
      schema: schemaName,
      category: "table",
    });
    if (!objectsByKey[`${conn.id}::${dbName}::${schemaName}`]) {
      setLoading(key, true);
      await loadObjects(conn.id, dbName, schemaName);
      setLoading(key, false);
    }
  };

  const handleDoubleClickSchema = async (
    conn: ConnectionProfile,
    dbName: string,
    schemaName: string
  ) => {
    const key = `schema:${conn.id}:${dbName}:${schemaName}`;
    setExpanded((prev) => new Set(prev).add(key));
    await handleSelectSchema(conn, dbName, schemaName);
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

  const handleOpenSavedQuery = (
    sq: SavedQuery,
    fallback?: { connectionId?: string; database?: string; schema?: string }
  ) => {
    openTab(buildTabFromSavedQuery(sq, fallback));
  };

  const handleDeleteSavedQuery = (sq: SavedQuery) => {
    const filename = formatSavedQueryFilename(sq);
    openSafetyModal({
      title: `Delete Saved Query "${filename}"`,
      warnings: [`This will permanently delete "${filename}" from your local workspace.`],
      sqlPreview: sq.path,
      onConfirm: async () => {
        try {
          await api.deleteSavedQuery(sq.path);
          await refreshSavedQueries();
          addLog("warn", `Deleted saved query "${filename}"`, undefined, true);
        } catch (err) {
          addLog("error", formatApiError(err));
        }
      },
    });
  };

  const handleSavedQueryModalSubmit = async (cleanName: string) => {
    if (!queryModal) return;
    if (queryModal.mode === "rename") {
      const renamed = await api.renameSavedQuery(queryModal.query.path, cleanName);
      const filename = formatSavedQueryFilename(renamed);
      for (const t of tabs) {
        if (t.savedQueryPath === queryModal.query.path) {
          updateTab(t.id, { title: filename, savedQueryPath: renamed.path });
        }
      }
      await refreshSavedQueries();
      addLog("success", `Renamed query to ${filename}`, undefined, true);
    } else {
      const dup = await api.duplicateSavedQuery(queryModal.query.path, cleanName);
      const filename = formatSavedQueryFilename(dup);
      await refreshSavedQueries();
      addLog("success", `Duplicated query as ${filename}`, undefined, true);
    }
  };

  const globalSavedQueries = useMemo(() => {
    const connIds = new Set(connections.map((c) => c.id));
    const q = filter.trim().toLowerCase();
    return savedQueries.filter((sq) => {
      const isGlobal =
        !sq.connectionId || !sq.database || !connIds.has(sq.connectionId);
      if (!isGlobal) return false;
      if (q && !sq.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [savedQueries, connections, filter]);

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
          const isActiveCategory =
            selectedNodeKey !== null
              ? selectedNodeKey === catKey
              : browserContext.connectionId === conn.id &&
                browserContext.database === dbName &&
                (browserContext.schema ?? browserContext.database) === (schemaName ?? dbName) &&
                cat.browserCategory !== undefined &&
                browserContext.category === cat.browserCategory;
          return (
            <div key={cat.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => {
                  setSelectedNodeKey(catKey);
                  if (cat.browserCategory) {
                    setBrowserContext({
                      connectionId: conn.id,
                      database: dbName,
                      schema: schemaName ?? dbName,
                      category: cat.browserCategory,
                    });
                  }
                  if (!objectsByKey[key] && connectedIds.has(conn.id)) {
                    loadObjects(conn.id, dbName, schemaName);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedNodeKey(catKey);
                    if (cat.browserCategory) {
                      setBrowserContext({
                        connectionId: conn.id,
                        database: dbName,
                        schema: schemaName ?? dbName,
                        category: cat.browserCategory,
                      });
                    }
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
                className={`w-full flex items-center gap-1 px-1 py-0.5 rounded text-xs cursor-pointer transition-colors ${
                  isActiveCategory
                    ? "bg-sky-500/20 text-sky-700 dark:text-sky-200 font-semibold"
                    : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/80"
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpand(catKey);
                  }}
                  aria-label={isOpen ? `Collapse ${cat.label}` : `Expand ${cat.label}`}
                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-300/70 dark:hover:bg-zinc-700/80 text-zinc-500 shrink-0 cursor-pointer"
                >
                  {isOpen ? (
                    <ChevronDown className="w-3 h-3 shrink-0" />
                  ) : (
                    <ChevronRight className="w-3 h-3 shrink-0" />
                  )}
                </button>
                <span className={`truncate ${isActiveCategory ? "font-semibold" : "font-medium"}`}>
                  {cat.label}
                </span>
                <span
                  className={`ml-auto pr-1 text-[0.72rem] ${
                    isActiveCategory
                      ? "text-sky-700 dark:text-sky-300 font-semibold"
                      : "text-zinc-500"
                  }`}
                >
                  {items.length}
                </span>
              </div>
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
        {(() => {
          const dbQueries = savedQueries.filter(
            (sq) =>
              sq.connectionId === conn.id &&
              sq.database === dbName &&
              (!q || sq.name.toLowerCase().includes(q))
          );
          const qCatKey = `cat:${key}:queries`;
          const isQOpen = expanded.has(qCatKey) || (q.length > 0 && dbQueries.length > 0);
          const isActiveQueries =
            selectedNodeKey !== null
              ? selectedNodeKey === qCatKey
              : browserContext.connectionId === conn.id &&
                browserContext.database === dbName &&
                (browserContext.schema ?? browserContext.database) === (schemaName ?? dbName) &&
                browserContext.category === "query";

          return (
            <div>
              <div
                role="button"
                tabIndex={0}
                onClick={() => {
                  setSelectedNodeKey(qCatKey);
                  setBrowserContext({
                    connectionId: conn.id,
                    database: dbName,
                    schema: schemaName ?? dbName,
                    category: "query",
                  });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedNodeKey(qCatKey);
                    setBrowserContext({
                      connectionId: conn.id,
                      database: dbName,
                      schema: schemaName ?? dbName,
                      category: "query",
                    });
                  }
                }}
                className={`w-full flex items-center gap-1 px-1 py-0.5 rounded text-xs cursor-pointer transition-colors ${
                  isActiveQueries
                    ? "bg-sky-500/20 text-sky-700 dark:text-sky-200 font-semibold"
                    : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/80"
                }`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpand(qCatKey);
                  }}
                  aria-label={isQOpen ? "Collapse Queries" : "Expand Queries"}
                  className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-300/70 dark:hover:bg-zinc-700/80 text-zinc-500 shrink-0 cursor-pointer"
                >
                  {isQOpen ? (
                    <ChevronDown className="w-3 h-3 shrink-0" />
                  ) : (
                    <ChevronRight className="w-3 h-3 shrink-0" />
                  )}
                </button>
                <span className={`truncate ${isActiveQueries ? "font-semibold" : "font-medium"}`}>
                  Queries
                </span>
                <span
                  className={`ml-auto pr-1 text-[0.72rem] ${
                    isActiveQueries
                      ? "text-sky-700 dark:text-sky-300 font-semibold"
                      : "text-zinc-500"
                  }`}
                >
                  {dbQueries.length}
                </span>
              </div>
              {isQOpen && (
                <div className="pl-3 space-y-0.5">
                  {dbQueries.length === 0 ? (
                    <div className="px-2 py-1 text-[0.72rem] text-zinc-500 italic">
                      No saved queries
                    </div>
                  ) : (
                    dbQueries.map((sq) => {
                      const isMongo = isMongoSavedQuery(sq);
                      return (
                        <div
                          key={sq.id}
                          onDoubleClick={() =>
                            handleOpenSavedQuery(sq, {
                              connectionId: conn.id,
                              database: dbName,
                              schema: schemaName,
                            })
                          }
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setCtxMenu({
                              x: Math.min(e.clientX, window.innerWidth - 200),
                              y: Math.min(e.clientY, window.innerHeight - 170),
                              type: "saved_query",
                              connection: conn,
                              database: dbName,
                              schema: schemaName,
                              savedQuery: sq,
                            });
                          }}
                          className="group flex items-center gap-1.5 px-1.5 py-1 rounded text-xs text-zinc-800 dark:text-zinc-200 hover:bg-indigo-500/15 cursor-pointer"
                        >
                          {isMongo ? (
                            <Braces className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" />
                          ) : (
                            <FileCode2 className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
                          )}
                          <span className="truncate">{sq.name}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })()}
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
                  const isActiveConn =
                    selectedNodeKey !== null
                      ? selectedNodeKey === connKey
                      : browserContext.connectionId === conn.id &&
                        (!isConnected || !isOpen || !browserContext.database);

                  return (
                    <div key={conn.id}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => handleSelectConnection(conn)}
                        onDoubleClick={() => handleDoubleClickConnection(conn)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleDoubleClickConnection(conn);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setCtxMenu({
                            x: e.clientX,
                            y: e.clientY,
                            type: "connection",
                            connection: conn,
                          });
                        }}
                        className={`group flex items-center gap-1 px-1 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                          isActiveConn
                            ? "bg-sky-500/20 text-sky-700 dark:text-sky-200 font-semibold"
                            : "font-medium text-zinc-800 dark:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-800"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleConnection(conn);
                          }}
                          aria-label={isOpen ? `Collapse ${conn.name}` : `Expand ${conn.name}`}
                          className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-300/70 dark:hover:bg-zinc-700/80 text-zinc-500 shrink-0 cursor-pointer"
                        >
                          {isOpen ? (
                            <ChevronDown className="w-3.5 h-3.5 shrink-0" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                          )}
                        </button>
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            isConnected
                              ? ENV_DOT[conn.environment] ?? "bg-emerald-500"
                              : "bg-zinc-500/40"
                          }`}
                        />
                        <span className="truncate ml-0.5">{conn.name}</span>
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
                            const isCurrentDb =
                              browserContext.connectionId === conn.id &&
                              browserContext.database === db.name;
                            const isActiveDb =
                              selectedNodeKey !== null
                                ? selectedNodeKey === dbKey
                                : isCurrentDb && !dbOpen;

                            return (
                              <div key={db.name}>
                                <div
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => handleSelectDatabase(conn, db.name)}
                                  onDoubleClick={() => handleDoubleClickDatabase(conn, db.name)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") handleDoubleClickDatabase(conn, db.name);
                                  }}
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
                                  className={`w-full flex items-center gap-1 px-1 py-0.5 rounded text-xs cursor-pointer transition-colors ${
                                    isActiveDb
                                      ? "bg-sky-500/20 text-sky-700 dark:text-sky-200 font-semibold"
                                      : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/80"
                                  }`}
                                >
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleToggleDatabase(conn, db.name);
                                    }}
                                    aria-label={dbOpen ? `Collapse ${db.name}` : `Expand ${db.name}`}
                                    className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-300/70 dark:hover:bg-zinc-700/80 text-zinc-500 shrink-0 cursor-pointer"
                                  >
                                    {dbOpen ? (
                                      <ChevronDown className="w-3 h-3 shrink-0" />
                                    ) : (
                                      <ChevronRight className="w-3 h-3 shrink-0" />
                                    )}
                                  </button>
                                  <Database className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
                                  <span className="truncate ml-0.5">{db.name}</span>
                                  {loadingKeys.has(dbKey) && (
                                    <RefreshCw className="w-3 h-3 ml-auto animate-spin text-indigo-500 dark:text-indigo-400" />
                                  )}
                                </div>

                                {dbOpen &&
                                  (conn.engine === "postgres" || conn.engine === "mssql" ? (
                                    <div className="pl-3 space-y-0.5">
                                      {schemas.map((sc) => {
                                        const scKey = `schema:${conn.id}:${db.name}:${sc.name}`;
                                        const scOpen = expanded.has(scKey);
                                        const isActiveSchema =
                                          selectedNodeKey !== null
                                            ? selectedNodeKey === scKey
                                            : isCurrentDb &&
                                              browserContext.schema === sc.name &&
                                              !scOpen;
                                        return (
                                          <div key={sc.name}>
                                            <div
                                              role="button"
                                              tabIndex={0}
                                              onClick={() =>
                                                handleSelectSchema(conn, db.name, sc.name)
                                              }
                                              onDoubleClick={() =>
                                                handleDoubleClickSchema(conn, db.name, sc.name)
                                              }
                                              onKeyDown={(e) => {
                                                if (e.key === "Enter")
                                                  handleDoubleClickSchema(conn, db.name, sc.name);
                                              }}
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
                                              className={`w-full flex items-center gap-1 px-1 py-0.5 rounded text-xs cursor-pointer transition-colors ${
                                                isActiveSchema
                                                  ? "bg-sky-500/20 text-sky-700 dark:text-sky-200 font-semibold"
                                                  : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/80"
                                              }`}
                                            >
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleToggleSchema(conn, db.name, sc.name);
                                                }}
                                                aria-label={
                                                  scOpen ? `Collapse ${sc.name}` : `Expand ${sc.name}`
                                                }
                                                className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-300/70 dark:hover:bg-zinc-700/80 text-zinc-500 shrink-0 cursor-pointer"
                                              >
                                                {scOpen ? (
                                                  <ChevronDown className="w-3 h-3" />
                                                ) : (
                                                  <ChevronRight className="w-3 h-3" />
                                                )}
                                              </button>
                                              <Layers className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                                              <span className="truncate ml-0.5">{sc.name}</span>
                                              {loadingKeys.has(scKey) && (
                                                <RefreshCw className="w-3 h-3 ml-auto animate-spin text-indigo-500 dark:text-indigo-400" />
                                              )}
                                            </div>
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

        {/* Global / Legacy Saved Queries Section */}
        {globalSavedQueries.length > 0 && (
          <div className="pt-2 border-t border-zinc-200 dark:border-zinc-800">
            <div className="px-1.5 pb-1 text-[0.72rem] font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-1">
              <FileCode2 className="w-3 h-3" />
              Global Saved Queries
            </div>
            <div className="space-y-0.5">
              {globalSavedQueries.map((sq) => {
                const isMongo = isMongoSavedQuery(sq);
                return (
                  <div
                    key={sq.id}
                    onDoubleClick={() => handleOpenSavedQuery(sq)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setCtxMenu({
                        x: Math.min(e.clientX, window.innerWidth - 200),
                        y: Math.min(e.clientY, window.innerHeight - 170),
                        type: "saved_query",
                        savedQuery: sq,
                      });
                    }}
                    className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-xs text-zinc-700 dark:text-zinc-300 hover:bg-indigo-500/15 text-left cursor-pointer"
                  >
                    {isMongo ? (
                      <Braces className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400 shrink-0" />
                    ) : (
                      <FileCode2 className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400 shrink-0" />
                    )}
                    <span className="truncate">{sq.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Context Menu */}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          style={{ top: ctxMenu.y, left: ctxMenu.x }}
          className="fixed z-50 w-48 py-1 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          {ctxMenu.type === "saved_query" && ctxMenu.savedQuery ? (
            <>
              <button
                onClick={() => {
                  handleOpenSavedQuery(ctxMenu.savedQuery!, {
                    connectionId: ctxMenu.connection?.id,
                    database: ctxMenu.database,
                    schema: ctxMenu.schema,
                  });
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <FolderOpen className="w-3.5 h-3.5 text-sky-400" /> Open Query
              </button>
              <button
                onClick={() => {
                  setQueryModal({ mode: "rename", query: ctxMenu.savedQuery! });
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <Edit3 className="w-3.5 h-3.5" /> Rename
              </button>
              <button
                onClick={() => {
                  setQueryModal({ mode: "duplicate", query: ctxMenu.savedQuery! });
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <Copy className="w-3.5 h-3.5 text-teal-400" /> Duplicate
              </button>
              <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
              <button
                onClick={() => {
                  handleDeleteSavedQuery(ctxMenu.savedQuery!);
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-red-500 hover:bg-red-500/10"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            </>
          ) : ctxMenu.type === "connection" && ctxMenu.connection ? (
            (() => {
              const ctxConn = ctxMenu.connection!;
              const isConnected = connectedIds.has(ctxConn.id);
              return (
                <>
                  {isConnected ? (
                    <button
                      onClick={() => {
                        disconnectFrom(ctxConn.id);
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <Plug className="w-3.5 h-3.5 text-amber-400" /> Disconnect
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        connectTo(ctxConn.id);
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <PlugZap className="w-3.5 h-3.5 text-emerald-400" /> Connect
                    </button>
                  )}
                  <button
                    disabled={!isConnected}
                    onClick={() => {
                      if (ctxConn.engine === "mongodb") {
                        openTab({
                          kind: "mongo_query",
                          title: `MQL — ${ctxConn.name}`,
                          connectionId: ctxConn.id,
                          database: ctxConn.database ?? undefined,
                          mongoMode: "mql",
                        });
                      } else {
                        openTab({
                          kind: "query",
                          title: `Query — ${ctxConn.name}`,
                          connectionId: ctxConn.id,
                          database: ctxConn.database ?? undefined,
                          sql: "",
                        });
                      }
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    <FileCode2 className="w-3.5 h-3.5 text-indigo-500 dark:text-indigo-400" />{" "}
                    {ctxConn.engine === "mongodb" ? "New MQL Query" : "New Query"}
                  </button>
                  <button
                    disabled={!isConnected}
                    onClick={() => {
                      openCreateDbModal(ctxConn);
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    <Plus className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" /> New Database...
                  </button>
                  <button
                    disabled={!isConnected}
                    onClick={() => {
                      loadDatabases(ctxConn.id);
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    <RefreshCw className="w-3.5 h-3.5" /> Refresh Databases
                  </button>
                  <button
                    onClick={() => {
                      openConnectionModal(ctxConn);
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <Edit3 className="w-3.5 h-3.5" /> Edit Connection
                  </button>
                  <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                  <button
                    onClick={async () => {
                      await api.deleteConnection(ctxConn.id);
                      await refreshConnections();
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-red-500 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete Connection
                  </button>
                </>
              );
            })()
          ) : ctxMenu.type === "database" && ctxMenu.connection ? (
            <>
              <button
                disabled={!copiedObject}
                onClick={() => {
                  if (ctxMenu.database && ctxMenu.connection) {
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
                  if (ctxMenu.database && ctxMenu.connection) {
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
              {ctxMenu.database && ctxMenu.connection && (
                <>
                  <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                  <button
                    onClick={() => {
                      handleDropDatabase(ctxMenu.connection!, ctxMenu.database!);
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-red-500 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Drop Database
                  </button>
                </>
              )}
            </>
          ) : (
            ctxMenu.object &&
            ctxMenu.connection &&
            (() => {
              const ctxConn = ctxMenu.connection!;
              const ctxObj = ctxMenu.object!;
              return (
                <>
                  <button
                    onClick={() => {
                      if (ctxConn.engine === "mongodb") {
                        openTab({
                          kind: "mongo_collection",
                          title: ctxObj.name,
                          connectionId: ctxConn.id,
                          database: ctxMenu.database,
                          collection: ctxObj.name,
                        });
                      } else {
                        openTab({
                          kind: "table",
                          title: ctxObj.name,
                          connectionId: ctxConn.id,
                          database: ctxMenu.database,
                          schema: ctxMenu.schema,
                          table: ctxObj.name,
                        });
                      }
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <Table2 className="w-3.5 h-3.5 text-cyan-500 dark:text-cyan-400" />{" "}
                    {ctxConn.engine === "mongodb" ? "Open Collection" : "Open Table Data"}
                  </button>
                  {ctxConn.engine === "mongodb" && ctxObj.kind === "collection" && (
                    <>
                      <button
                        onClick={() => {
                          openTab({
                            kind: "mongo_query",
                            title: `Pipeline: ${ctxObj.name}`,
                            connectionId: ctxConn.id,
                            database: ctxMenu.database,
                            collection: ctxObj.name,
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
                            title: `Design: ${ctxObj.name}`,
                            connectionId: ctxConn.id,
                            database: ctxMenu.database,
                            collection: ctxObj.name,
                          });
                          setCtxMenu(null);
                        }}
                        className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      >
                        <Wrench className="w-3.5 h-3.5 text-amber-400" /> Indexes & Validation
                      </button>
                    </>
                  )}
                  {ctxObj.kind === "table" && (
                    <button
                      onClick={() => {
                        openTab({
                          kind: "designer",
                          title: `Design: ${ctxObj.name}`,
                          connectionId: ctxConn.id,
                          database: ctxMenu.database,
                          schema: ctxMenu.schema,
                          table: ctxObj.name,
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
                        title: `Export: ${ctxObj.name}`,
                        connectionId: ctxConn.id,
                        database: ctxMenu.database,
                        schema: ctxMenu.schema,
                        table: ctxObj.name,
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
                        title: `Import: ${ctxObj.name}`,
                        connectionId: ctxConn.id,
                        database: ctxMenu.database,
                        schema: ctxMenu.schema,
                        table: ctxObj.name,
                        wizardMode: "import",
                      });
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <FileCode2 className="w-3.5 h-3.5 text-emerald-400" /> Import Wizard...
                  </button>
                  {ctxObj.kind === "table" && (
                    <button
                      onClick={() => {
                        openTab({
                          kind: "dump_backup",
                          title: `Dump: ${ctxObj.name}`,
                          connectionId: ctxConn.id,
                          database: ctxMenu.database,
                          schema: ctxMenu.schema,
                          table: ctxObj.name,
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
                      if (ctxMenu.database) {
                        setCopiedObject({
                          connectionId: ctxConn.id,
                          database: ctxMenu.database,
                          schema: ctxMenu.schema ?? ctxMenu.database,
                          object: ctxObj,
                        });
                        addLog(
                          "info",
                          `Copied ${ctxObj.kind} "${ctxObj.name}" — paste into any target database`
                        );
                      }
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <Copy className="w-3.5 h-3.5 text-teal-400" /> Copy {ctxObj.kind}
                  </button>
                  {copiedObject && ctxMenu.database && (
                    <button
                      onClick={() => {
                        pasteCopiedObject(
                          ctxConn.id,
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
                        ctxConn,
                        ctxMenu.database!,
                        ctxMenu.schema,
                        ctxObj
                      );
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <Copy className="w-3.5 h-3.5" /> Copy DDL
                  </button>
                  {ctxObj.kind === "table" && (
                    <>
                      <button
                        onClick={() => {
                          handleDuplicateTable(
                            ctxConn,
                            ctxMenu.database!,
                            ctxMenu.schema,
                            ctxObj.name
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
                            ctxConn,
                            ctxMenu.database!,
                            ctxMenu.schema,
                            ctxObj.name
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
                        ctxConn,
                        ctxMenu.database!,
                        ctxMenu.schema,
                        ctxObj
                      );
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-red-500 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Drop {ctxObj.kind}
                  </button>
                </>
              );
            })()
          )}
        </div>
      )}

      {/* Create Database Modal */}
      {createDbModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-xs p-4"
          onClick={() => !createDbModal.submitting && setCreateDbModal(null)}
        >
          <form
            onSubmit={handleCreateDatabase}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden text-xs"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <Database className="w-4 h-4 text-emerald-500" />
                <div>
                  <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    New Database
                  </h3>
                  <p className="text-[11px] text-zinc-500">
                    {createDbModal.connection.name} ({createDbModal.connection.engine.toUpperCase()})
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={createDbModal.submitting}
                onClick={() => setCreateDbModal(null)}
                className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <div>
                <label className="block text-zinc-500 mb-1">Database Name</label>
                <input
                  autoFocus
                  value={createDbModal.name}
                  onChange={(e) =>
                    setCreateDbModal((prev) =>
                      prev ? { ...prev, name: e.target.value, error: null } : null
                    )
                  }
                  placeholder="e.g. my_app_db"
                  className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono focus:outline-none focus:border-indigo-500"
                />
              </div>

              {createDbModal.connection.engine === "mysql" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-zinc-500 mb-1">Character Set</label>
                    <select
                      value={createDbModal.charset}
                      onChange={(e) => {
                        const cs = e.target.value;
                        const defaultCol =
                          cs === "utf8mb4"
                            ? "utf8mb4_unicode_ci"
                            : cs === "utf8mb3"
                            ? "utf8mb3_unicode_ci"
                            : cs === "latin1"
                            ? "latin1_swedish_ci"
                            : "";
                        setCreateDbModal((prev) =>
                          prev ? { ...prev, charset: cs, collation: defaultCol } : null
                        );
                      }}
                      className="w-full h-8 px-2 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                    >
                      <option value="">Server Default</option>
                      <option value="utf8mb4">utf8mb4</option>
                      <option value="utf8mb3">utf8mb3</option>
                      <option value="latin1">latin1</option>
                      <option value="ascii">ascii</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-zinc-500 mb-1">Collation</label>
                    <input
                      value={createDbModal.collation}
                      onChange={(e) =>
                        setCreateDbModal((prev) =>
                          prev ? { ...prev, collation: e.target.value } : null
                        )
                      }
                      placeholder="utf8mb4_unicode_ci"
                      className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                    />
                  </div>
                </div>
              )}

              {createDbModal.connection.engine === "postgres" && (
                <div>
                  <label className="block text-zinc-500 mb-1">Encoding</label>
                  <select
                    value={createDbModal.charset}
                    onChange={(e) =>
                      setCreateDbModal((prev) =>
                        prev ? { ...prev, charset: e.target.value } : null
                      )
                    }
                    className="w-full h-8 px-2 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                  >
                    <option value="">Server Default</option>
                    <option value="UTF8">UTF8</option>
                    <option value="SQL_ASCII">SQL_ASCII</option>
                    <option value="LATIN1">LATIN1</option>
                  </select>
                </div>
              )}

              {createDbModal.connection.engine === "mssql" && (
                <div>
                  <label className="block text-zinc-500 mb-1">Collation (optional)</label>
                  <input
                    value={createDbModal.collation}
                    onChange={(e) =>
                      setCreateDbModal((prev) =>
                        prev ? { ...prev, collation: e.target.value } : null
                      )
                    }
                    placeholder="e.g. SQL_Latin1_General_CP1_CI_AS"
                    className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                  />
                </div>
              )}

              {createDbModal.connection.engine === "mongodb" && (
                <p className="text-[11px] text-zinc-500 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded p-2">
                  MongoDB materializes databases lazily. An initial <code className="font-mono">_init</code> collection will be created so the database appears immediately.
                </p>
              )}

              {createDbModal.connection.engine !== "mongodb" && createDbModal.name.trim() && (
                <div className="rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 px-2.5 py-2 font-mono text-[11px] text-zinc-600 dark:text-zinc-400 break-all">
                  {createDbModal.connection.engine === "mysql"
                    ? `CREATE DATABASE \`${createDbModal.name.trim()}\`${
                        createDbModal.charset ? ` CHARACTER SET ${createDbModal.charset}` : ""
                      }${createDbModal.collation ? ` COLLATE ${createDbModal.collation}` : ""};`
                    : createDbModal.connection.engine === "postgres"
                    ? `CREATE DATABASE "${createDbModal.name.trim()}"${
                        createDbModal.charset ? ` WITH ENCODING '${createDbModal.charset}'` : ""
                      };`
                    : `CREATE DATABASE [${createDbModal.name.trim()}]${
                        createDbModal.collation ? ` COLLATE ${createDbModal.collation}` : ""
                      };`}
                </div>
              )}

              {createDbModal.error && (
                <div className="rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-red-600 dark:text-red-400">
                  {createDbModal.error}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-950/40">
              <button
                type="button"
                disabled={createDbModal.submitting}
                onClick={() => setCreateDbModal(null)}
                className="px-3 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={createDbModal.submitting || !createDbModal.name.trim()}
                className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50"
              >
                {createDbModal.submitting ? "Creating..." : "Create Database"}
              </button>
            </div>
          </form>
        </div>
      )}

      {queryModal && (
        <SaveQueryModal
          open={true}
          mode={queryModal.mode}
          initialName={
            queryModal.mode === "duplicate"
              ? `${queryModal.query.name}_copy`
              : queryModal.query.name
          }
          extension={isMongoSavedQuery(queryModal.query) ? ".mongodb.json" : ".sql"}
          connectionName={
            connections.find((c) => c.id === queryModal.query.connectionId)?.name ?? null
          }
          databaseName={queryModal.query.database ?? null}
          existingNames={savedQueries
            .filter(
              (sq) =>
                sq.path !== queryModal.query.path &&
                (sq.connectionId ?? "") === (queryModal.query.connectionId ?? "") &&
                (sq.database ?? "") === (queryModal.query.database ?? "")
            )
            .map((sq) => sq.name)}
          allowOverwrite={false}
          onClose={() => setQueryModal(null)}
          onSubmit={handleSavedQueryModalSubmit}
        />
      )}
    </aside>
  );
};
