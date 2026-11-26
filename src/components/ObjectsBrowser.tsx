import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Braces,
  ClipboardPaste,
  Copy,
  Database,
  Download,
  Edit3,
  Eye,
  FileCode2,
  FolderOpen,
  FunctionSquare,
  HardDriveDownload,
  KeyRound,
  Layers,
  LayoutGrid,
  List,
  ListTree,
  Play,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  Upload,
  Wrench,
  Zap,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { buildExecuteRoutineSql, buildNewObjectTemplateSql } from "../lib/objectTemplates";
import {
  buildTabFromSavedQuery,
  formatSavedQueryFilename,
  isMongoSavedQuery,
} from "../lib/savedQueries";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { ContextMenu } from "./ContextMenu";
import { EngineIcon } from "./EngineIcon";
import { InputPromptModal } from "./InputPromptModal";
import { SaveQueryModal } from "./SaveQueryModal";
import type { ConnectionProfile, DatabaseObject, DbEngine, ObjectKind, SavedQuery } from "../types/dba";

type SortKey = "name" | "kind" | "rowEstimate" | "comment";

type BrowserCtxMenu =
  | { x: number; y: number; type: "object"; object: DatabaseObject }
  | { x: number; y: number; type: "empty_objects" }
  | { x: number; y: number; type: "saved_query"; query: SavedQuery }
  | { x: number; y: number; type: "connection_card"; connection: ConnectionProfile }
  | { x: number; y: number; type: "empty_connections" };

export const ObjectsBrowser: React.FC = () => {
  const {
    connections,
    connectedIds,
    activeTabId,
    tabs,
    browserContext,
    objectsByKey,
    savedQueries,
    connectTo,
    disconnectFrom,
    refreshConnections,
    loadObjects,
    openTab,
    updateTab,
    openConnectionModal,
    openSafetyModal,
    inspectDatabaseObject,
    addLog,
    refreshSavedQueries,
    copiedObject,
    setCopiedObject,
    pasteCopiedObject,
  } = useWorkbenchStore();

  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [selectedQueryPath, setSelectedQueryPath] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<BrowserCtxMenu | null>(null);
  const [queryModal, setQueryModal] = useState<{
    mode: "rename" | "duplicate";
    query: SavedQuery;
  } | null>(null);
  const [promptModal, setPromptModal] = useState<{
    mode: "rename_table" | "duplicate_table";
    tableName: string;
  } | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);

  const conn = connections.find((c) => c.id === browserContext.connectionId);
  const objKey =
    browserContext.connectionId && browserContext.database
      ? `${browserContext.connectionId}::${browserContext.database}::${
          browserContext.schema ?? browserContext.database
        }`
      : null;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const objects = useMemo(() => {
    if (!objKey) return [];
    const raw = objectsByKey[objKey] ?? [];
    const q = search.trim().toLowerCase();
    const filtered = raw.filter((o) => {
      if (browserContext.category === "table" && o.kind !== "table" && o.kind !== "collection")
        return false;
      if (
        browserContext.category === "view" &&
        o.kind !== "view" &&
        o.kind !== "materialized_view"
      )
        return false;
      if (
        browserContext.category === "function" &&
        o.kind !== "function" &&
        o.kind !== "procedure"
      )
        return false;
      if (browserContext.category === "trigger" && o.kind !== "trigger")
        return false;
      if (q && !o.name.toLowerCase().includes(q)) return false;
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === "rowEstimate") {
        const av = a.rowEstimate ?? -1;
        const bv = b.rowEstimate ?? -1;
        return (av - bv) * dir;
      }
      if (sortKey === "kind") {
        return a.kind.localeCompare(b.kind) * dir;
      }
      if (sortKey === "comment") {
        return (a.comment ?? "").localeCompare(b.comment ?? "") * dir;
      }
      return a.name.localeCompare(b.name) * dir;
    });
  }, [objKey, objectsByKey, browserContext.category, search, sortKey, sortDir]);

  const selectedObj = objects.find((o) => o.name === selectedName) ?? null;

  const dbSavedQueries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return savedQueries.filter((sq) => {
      if (browserContext.connectionId && browserContext.database) {
        if (
          sq.connectionId !== browserContext.connectionId ||
          sq.database !== browserContext.database
        ) {
          return false;
        }
      }
      if (q && !sq.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [savedQueries, browserContext.connectionId, browserContext.database, search]);

  const selectedSavedQuery =
    dbSavedQueries.find((sq) => sq.path === selectedQueryPath) ?? null;

  const handleDuplicateConnection = (c: ConnectionProfile) => {
    openConnectionModal({
      ...c,
      id: "",
      name: `${c.name} (Copy)`,
      keyringRef: null,
      ssh: { ...c.ssh, keyringRef: null },
    });
  };

  const handleDeleteConnection = (c: ConnectionProfile) => {
    openSafetyModal({
      title: `Delete Connection "${c.name}"`,
      warnings: [
        `Remove saved connection profile "${c.name}" (${c.host}:${c.port})?`,
        "Your database server and data will not be affected.",
      ],
      sqlPreview: `DELETE PROFILE "${c.name}"`,
      onConfirm: async () => {
        try {
          if (connectedIds.has(c.id)) {
            await disconnectFrom(c.id);
          }
          await api.deleteConnection(c.id);
          await refreshConnections();
          addLog("warn", `Deleted connection "${c.name}"`, undefined, true);
        } catch (err) {
          addLog("error", `Delete connection failed: ${formatApiError(err)}`);
        }
      },
    });
  };

  const openNewQuery = () => {
    if (!conn || !browserContext.database) return;
    if (conn.engine === "mongodb") {
      openTab({
        kind: "mongo_query",
        title: `MQL — ${browserContext.database}`,
        connectionId: conn.id,
        database: browserContext.database,
        mongoMode: "mql",
      });
    } else {
      openTab({
        kind: "query",
        title: `Query — ${browserContext.database}`,
        connectionId: conn.id,
        database: browserContext.database,
        schema: browserContext.schema ?? undefined,
        sql: "",
      });
    }
  };

  const openNewObjectScript = (kind: "view" | "function" | "procedure" | "trigger") => {
    if (!conn || !browserContext.database) return;
    const labelMap = {
      view: "New View",
      function: "New Function",
      procedure: "New Procedure",
      trigger: "New Trigger",
    };
    openTab({
      kind: "query",
      title: labelMap[kind],
      connectionId: conn.id,
      database: browserContext.database,
      schema: browserContext.schema ?? undefined,
      sql: buildNewObjectTemplateSql(conn.engine, kind, browserContext.schema),
    });
  };

  const openNewTable = () => {
    if (!conn || !browserContext.database) return;
    if (conn.engine === "mongodb") {
      openTab({
        kind: "mongo_query",
        title: `Create Collection — ${browserContext.database}`,
        connectionId: conn.id,
        database: browserContext.database,
        mongoMode: "mql",
      });
      return;
    }
    openTab({
      kind: "designer",
      title: "New Table",
      connectionId: conn.id,
      database: browserContext.database,
      schema: browserContext.schema ?? undefined,
      isNewTable: true,
    });
  };

  const handleOpenSavedQuery = (sq: SavedQuery) => {
    openTab(
      buildTabFromSavedQuery(sq, {
        connectionId: conn?.id,
        database: browserContext.database,
        schema: browserContext.schema,
      })
    );
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
          if (selectedQueryPath === sq.path) setSelectedQueryPath(null);
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
      setSelectedQueryPath(renamed.path);
      addLog("success", `Renamed query to ${filename}`, undefined, true);
    } else {
      const dup = await api.duplicateSavedQuery(queryModal.query.path, cleanName);
      const filename = formatSavedQueryFilename(dup);
      await refreshSavedQueries();
      setSelectedQueryPath(dup.path);
      addLog("success", `Duplicated query as ${filename}`, undefined, true);
    }
  };

  const handleSelectObject = (obj: DatabaseObject) => {
    setSelectedName(obj.name);
    if (conn && browserContext.database) {
      inspectDatabaseObject(
        conn.id,
        browserContext.database,
        browserContext.schema ?? undefined,
        obj
      );
    }
  };

  const openObjectDdlInEditor = async (obj: DatabaseObject) => {
    if (!conn || !browserContext.database) return;
    try {
      const ddl = await api.getObjectDdl(
        conn.id,
        obj.name,
        obj.kind,
        browserContext.database,
        browserContext.schema ?? undefined
      );
      openTab({
        kind: "query",
        title: `${obj.name} (${obj.kind})`,
        connectionId: conn.id,
        database: browserContext.database,
        schema: browserContext.schema ?? undefined,
        sql: ddl,
      });
    } catch (err) {
      addLog("error", formatApiError(err));
    }
  };

  const handleOpenObject = async (obj: DatabaseObject) => {
    if (!conn || !browserContext.database) return;
    if (conn.engine === "mongodb") {
      openTab({
        kind: "mongo_collection",
        title: obj.name,
        connectionId: conn.id,
        database: browserContext.database,
        collection: obj.name,
      });
      return;
    }
    if (
      obj.kind === "function" ||
      obj.kind === "procedure" ||
      obj.kind === "trigger" ||
      obj.kind === "event" ||
      obj.kind === "sequence" ||
      obj.kind === "enum_type"
    ) {
      await openObjectDdlInEditor(obj);
      return;
    }
    openTab({
      kind: "table",
      title: obj.name,
      connectionId: conn.id,
      database: browserContext.database,
      schema: browserContext.schema ?? undefined,
      table: obj.name,
    });
  };

  const handleDesignObject = async (obj: DatabaseObject) => {
    if (!conn || !browserContext.database) return;
    if (conn.engine === "mongodb") {
      openTab({
        kind: "mongo_designer",
        title: `Design: ${obj.name}`,
        connectionId: conn.id,
        database: browserContext.database,
        collection: obj.name,
      });
      return;
    }
    if (obj.kind === "table") {
      openTab({
        kind: "designer",
        title: `Design: ${obj.name}`,
        connectionId: conn.id,
        database: browserContext.database,
        schema: browserContext.schema ?? undefined,
        table: obj.name,
        isNewTable: false,
      });
      return;
    }
    await openObjectDdlInEditor(obj);
  };

  const handleExecuteRoutine = (obj: DatabaseObject) => {
    if (!conn || !browserContext.database) return;
    openTab({
      kind: "query",
      title: `Execute: ${obj.name}`,
      connectionId: conn.id,
      database: browserContext.database,
      schema: browserContext.schema ?? undefined,
      sql: buildExecuteRoutineSql(conn.engine, obj.name, obj.kind, browserContext.schema),
    });
  };

  const handleRefresh = async () => {
    if (!conn || !browserContext.database || refreshing) return;
    setRefreshing(true);
    try {
      if (browserContext.category === "query") {
        await refreshSavedQueries();
      } else {
        await loadObjects(
          conn.id,
          browserContext.database,
          browserContext.schema ?? browserContext.database
        );
        if (selectedObj) {
          inspectDatabaseObject(
            conn.id,
            browserContext.database,
            browserContext.schema ?? undefined,
            selectedObj
          );
        }
      }
    } finally {
      setRefreshing(false);
    }
  };

  const handleTruncateTable = (obj: DatabaseObject) => {
    if (!conn || !browserContext.database) return;
    openSafetyModal({
      title: `Truncate Table "${obj.name}"`,
      warnings: [
        `All rows in "${obj.name}" will be permanently deleted.`,
        ...(conn.environment === "production"
          ? [`Target connection "${conn.name}" is PRODUCTION!`]
          : []),
      ],
      sqlPreview: `TRUNCATE TABLE ${browserContext.schema ? `${browserContext.schema}.` : ""}${obj.name};`,
      onConfirm: async () => {
        try {
          await api.truncateTable(
            conn.id,
            obj.name,
            true,
            browserContext.database ?? undefined,
            browserContext.schema ?? undefined
          );
          addLog("warn", `Truncated table ${obj.name}`, undefined, true);
        } catch (err) {
          addLog("error", formatApiError(err));
        }
      },
    });
  };

  const handleDeleteObject = (obj: DatabaseObject) => {
    if (!conn || !browserContext.database) return;
    openSafetyModal({
      title: `Drop ${obj.kind} "${obj.name}"`,
      warnings: [
        `Permanently drop ${obj.kind.toUpperCase()} "${obj.name}"?`,
        ...(conn.environment === "production"
          ? [`Target connection "${conn.name}" is PRODUCTION!`]
          : []),
      ],
      sqlPreview: `DROP ${obj.kind.toUpperCase()} ${
        browserContext.schema ? `${browserContext.schema}.` : ""
      }${obj.name};`,
      onConfirm: async () => {
        try {
          await api.dropObject(
            conn.id,
            obj.name,
            obj.kind,
            true,
            browserContext.database ?? undefined,
            browserContext.schema ?? undefined
          );
          addLog("warn", `Dropped ${obj.kind} ${obj.name}`, undefined, true);
          await handleRefresh();
        } catch (err) {
          addLog("error", formatApiError(err));
        }
      },
    });
  };

  const handlePromptModalSubmit = async (value: string, checked: boolean) => {
    if (!promptModal || !conn || !browserContext.database) return;
    const db = browserContext.database;
    const sc = browserContext.schema ?? undefined;
    if (promptModal.mode === "rename_table") {
      const runRename = async (confirmedProd: boolean) => {
        await api.renameTable(
          conn.id,
          promptModal.tableName,
          value,
          db,
          sc,
          confirmedProd
        );
        addLog("success", `Renamed "${promptModal.tableName}" to "${value}"`, undefined, true);
        setSelectedName(value);
        await loadObjects(conn.id, db, sc ?? db);
      };
      if (conn.environment === "production") {
        openSafetyModal({
          title: `Rename "${promptModal.tableName}" on PRODUCTION`,
          warnings: [
            `Renaming table "${promptModal.tableName}" to "${value}" on PRODUCTION "${conn.name}".`,
          ],
          sqlPreview: `RENAME "${promptModal.tableName}" -> "${value}"`,
          onConfirm: async () => {
            try {
              await runRename(true);
            } catch (err) {
              addLog("error", `Rename failed: ${formatApiError(err)}`);
            }
          },
        });
        return;
      }
      await runRename(false);
    } else {
      await api.duplicateTable(conn.id, promptModal.tableName, value, checked, db, sc);
      addLog("success", `Duplicated "${promptModal.tableName}" -> "${value}"`, undefined, true);
      await loadObjects(conn.id, db, sc ?? db);
    }
  };

  const handleCopyObject = (obj: DatabaseObject) => {
    if (!conn || !browserContext.database) return;
    setCopiedObject({
      connectionId: conn.id,
      database: browserContext.database,
      schema: browserContext.schema ?? browserContext.database,
      object: obj,
    });
    addLog(
      "info",
      `Copied ${obj.kind} "${obj.name}" — switch to any target DB and click Paste (Ctrl+V)`
    );
  };

  const handlePasteObject = async () => {
    if (!conn || !browserContext.database || !copiedObject || pasting) return;
    setPasting(true);
    try {
      await pasteCopiedObject(
        conn.id,
        browserContext.database,
        browserContext.schema ?? browserContext.database
      );
    } finally {
      setPasting(false);
    }
  };

  const handleCopyDdl = async (obj: DatabaseObject) => {
    if (!conn || !browserContext.database) return;
    try {
      let ddl: string | null = null;
      if (obj.kind === "table") {
        const meta = await api.getTableMetadata(
          conn.id,
          obj.name,
          browserContext.database,
          browserContext.schema ?? undefined
        );
        ddl = meta.ddl ?? null;
      }
      if (!ddl) {
        ddl = await api.getObjectDdl(
          conn.id,
          obj.name,
          obj.kind,
          browserContext.database,
          browserContext.schema ?? undefined
        );
      }
      if (ddl) {
        await navigator.clipboard.writeText(ddl);
        addLog("success", `Copied DDL for ${obj.kind} "${obj.name}"`, undefined, true);
      }
    } catch (err) {
      addLog("error", formatApiError(err));
    }
  };

  const renderObjectIcon = (kind: ObjectKind, size: "sm" | "lg" = "sm") => {
    const cls = size === "lg" ? "w-8 h-8 shrink-0" : "w-4 h-4 shrink-0";
    switch (kind) {
      case "table":
        return <Table2 className={`${cls} text-sky-400`} />;
      case "collection":
        return <Layers className={`${cls} text-emerald-400`} />;
      case "view":
      case "materialized_view":
        return <Eye className={`${cls} text-purple-400`} />;
      case "function":
      case "procedure":
        return <FunctionSquare className={`${cls} text-amber-400`} />;
      case "trigger":
      case "event":
        return <Zap className={`${cls} text-orange-400`} />;
      case "index":
        return <KeyRound className={`${cls} text-emerald-400`} />;
      default:
        return <ListTree className={`${cls} text-zinc-400`} />;
    }
  };

  useEffect(() => {
    if (activeTabId !== "objects") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (queryModal || promptModal) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (
        (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r")) &&
        conn &&
        browserContext.database
      ) {
        e.preventDefault();
        handleRefresh();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selectedObj) {
        e.preventDefault();
        handleCopyObject(selectedObj);
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === "v" &&
        copiedObject &&
        conn &&
        browserContext.database
      ) {
        e.preventDefault();
        handlePasteObject();
        return;
      }

      if (objects.length === 0 || browserContext.category === "query") return;

      const currentIdx = selectedName
        ? objects.findIndex((o) => o.name === selectedName)
        : -1;
      let nextIdx: number | null = null;

      if (e.key === "ArrowDown" || (viewMode === "grid" && e.key === "ArrowRight")) {
        nextIdx = currentIdx < 0 ? 0 : Math.min(objects.length - 1, currentIdx + 1);
      } else if (e.key === "ArrowUp" || (viewMode === "grid" && e.key === "ArrowLeft")) {
        nextIdx = currentIdx <= 0 ? 0 : currentIdx - 1;
      } else if (e.key === "Home") {
        nextIdx = 0;
      } else if (e.key === "End") {
        nextIdx = objects.length - 1;
      } else if (e.key === "Enter" && selectedObj) {
        e.preventDefault();
        handleOpenObject(selectedObj);
        return;
      }

      if (nextIdx !== null && objects[nextIdx]) {
        e.preventDefault();
        handleSelectObject(objects[nextIdx]);
        const container = listContainerRef.current;
        const el = container?.querySelector(`[data-obj-index="${nextIdx}"]`);
        if (container && el instanceof HTMLElement) {
          const headerHeight =
            container.querySelector("thead")?.getBoundingClientRect().height ?? 0;
          const cRect = container.getBoundingClientRect();
          const eRect = el.getBoundingClientRect();
          const visibleTop = cRect.top + headerHeight;
          if (eRect.top < visibleTop) {
            container.scrollTop -= visibleTop - eRect.top;
          } else if (eRect.bottom > cRect.bottom) {
            container.scrollTop += eRect.bottom - cRect.bottom;
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTabId,
    queryModal,
    promptModal,
    objects,
    selectedName,
    selectedObj,
    copiedObject,
    conn?.id,
    browserContext.database,
    browserContext.schema,
    browserContext.category,
    viewMode,
    pasting,
    refreshing,
  ]);

  // All Connections View (when no database is selected or connection is disconnected)
  if (!conn || !connectedIds.has(conn.id) || !browserContext.database) {
    return (
      <div className="h-full flex flex-col bg-[var(--surface-canvas)]">
        <div className="px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] flex items-center justify-between text-xs">
          <div className="font-semibold text-zinc-700 dark:text-zinc-200">
            All Connections ({connections.length})
          </div>
          <button
            onClick={() => openConnectionModal(null)}
            className="h-7 px-2.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> New Connection
          </button>
        </div>

        <div
          className="flex-1 overflow-auto p-4"
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY, type: "empty_connections" });
          }}
        >
          {connections.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-zinc-500 gap-3">
              <Database className="w-12 h-12 text-sky-400/70" />
              <div className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
                No Connections Configured
              </div>
              <p className="text-xs max-w-sm">
                Click <strong>Connection</strong> in the top toolbar to add a PostgreSQL, MySQL/MariaDB, SQL Server, or MongoDB server.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {connections.map((c) => {
                const active = connectedIds.has(c.id);
                return (
                  <div
                    key={c.id}
                    onDoubleClick={() => connectTo(c.id)}
                    onClick={() => connectTo(c.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCtxMenu({
                        x: e.clientX,
                        y: e.clientY,
                        type: "connection_card",
                        connection: c,
                      });
                    }}
                    className="p-3.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-panel)] hover:border-sky-500/70 transition cursor-pointer flex items-start gap-3"
                  >
                    <EngineIcon engine={c.engine} connected={active} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            active ? "bg-emerald-400" : "bg-zinc-500"
                          }`}
                        />
                        <span className="font-semibold text-xs truncate text-zinc-900 dark:text-zinc-100">
                          {c.name}
                        </span>
                      </div>
                      <div className="text-[0.72rem] font-mono text-zinc-500 truncate mt-0.5">
                        {c.host}:{c.port}
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span className="text-[0.68rem] uppercase px-1.5 py-0.2 rounded bg-[var(--surface-elevated)] text-zinc-600 dark:text-zinc-400">
                          {c.engine}
                        </span>
                        <span
                          className={`text-[0.68rem] uppercase px-1.5 py-0.2 rounded ${
                            c.environment === "production"
                              ? "bg-red-500/20 text-red-400"
                              : c.environment === "staging"
                              ? "bg-amber-500/20 text-amber-400"
                              : "bg-emerald-500/20 text-emerald-400"
                          }`}
                        >
                          {c.environment}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Context Menu for Connection Cards & Empty Connections Area */}
        {ctxMenu && (
          <ContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            onClose={() => setCtxMenu(null)}
            className="w-52"
          >
            {ctxMenu.type === "connection_card" && (() => {
              const c = ctxMenu.connection;
              const isConnected = connectedIds.has(c.id);
              return (
                <>
                  {isConnected ? (
                    <button
                      onClick={() => {
                        disconnectFrom(c.id);
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Plug className="w-3.5 h-3.5 text-amber-400" /> Disconnect
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        connectTo(c.id);
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <PlugZap className="w-3.5 h-3.5 text-emerald-400" /> Connect
                    </button>
                  )}
                  <div className="my-1 border-t border-[var(--border-subtle)]" />
                  <button
                    onClick={() => {
                      openConnectionModal(null);
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-sky-400" /> New Connection...
                  </button>
                  <button
                    onClick={() => {
                      handleDuplicateConnection(c);
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5 text-teal-400" /> Duplicate Connection
                  </button>
                  <button
                    onClick={() => {
                      openConnectionModal(c);
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" /> Edit Connection...
                  </button>
                  <div className="my-1 border-t border-[var(--border-subtle)]" />
                  <button
                    onClick={() => {
                      handleDeleteConnection(c);
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-red-500 hover:bg-red-500/10 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete Connection
                  </button>
                </>
              );
            })()}
            {ctxMenu.type === "empty_connections" && (
              <>
                {(
                  [
                    { engine: "postgres", label: "New PostgreSQL..." },
                    { engine: "mysql", label: "New MySQL / MariaDB..." },
                    { engine: "mssql", label: "New SQL Server..." },
                    { engine: "mongodb", label: "New MongoDB..." },
                  ] as { engine: DbEngine; label: string }[]
                ).map((item) => (
                  <button
                    key={item.engine}
                    onClick={() => {
                      openConnectionModal(null, item.engine);
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    <EngineIcon engine={item.engine} connected={true} size="sm" />
                    <span>{item.label}</span>
                  </button>
                ))}
                <div className="my-1 border-t border-[var(--border-subtle)]" />
                <button
                  onClick={() => {
                    refreshConnections();
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Refresh Connections
                </button>
              </>
            )}
          </ContextMenu>
        )}
      </div>
    );
  }

  const cat = browserContext.category;

  const renderSortIcon = (key: SortKey) => {
    if (sortKey !== key) return null;
    return sortDir === "asc" ? (
      <ArrowUp className="w-3 h-3 inline ml-1 text-sky-400" />
    ) : (
      <ArrowDown className="w-3 h-3 inline ml-1 text-sky-400" />
    );
  };

  return (
    <div className="h-full flex flex-col bg-[var(--surface-canvas)] text-xs">
      {/* Dynamic Context-Sensitive Sub-Toolbar */}
      <div className="px-2.5 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--surface-panel)] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 flex-wrap">
          {cat === "query" ? (
            <>
              <button
                disabled={!selectedSavedQuery}
                onClick={() => selectedSavedQuery && handleOpenSavedQuery(selectedSavedQuery)}
                className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] disabled:opacity-35 flex items-center gap-1.5 font-medium cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5 text-sky-400" /> Open
              </button>
              <button
                onClick={openNewQuery}
                className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] flex items-center gap-1.5 font-medium cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-indigo-400" /> New Query
              </button>
              <button
                disabled={!selectedSavedQuery}
                onClick={() =>
                  selectedSavedQuery &&
                  setQueryModal({ mode: "rename", query: selectedSavedQuery })
                }
                className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] disabled:opacity-35 flex items-center gap-1.5 cursor-pointer"
              >
                <Edit3 className="w-3.5 h-3.5" /> Rename
              </button>
              <button
                disabled={!selectedSavedQuery}
                onClick={() =>
                  selectedSavedQuery &&
                  setQueryModal({ mode: "duplicate", query: selectedSavedQuery })
                }
                className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] disabled:opacity-35 flex items-center gap-1.5 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5 text-teal-400" /> Duplicate
              </button>
              <button
                disabled={!selectedSavedQuery}
                onClick={() => selectedSavedQuery && handleDeleteSavedQuery(selectedSavedQuery)}
                className="h-7 px-2.5 rounded hover:bg-red-500/15 text-red-400 disabled:opacity-35 flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
              <button
                onClick={handleRefresh}
                className="h-7 px-2 rounded hover:bg-[var(--surface-hover)] cursor-pointer"
                title="Refresh Saved Queries (F5 / Ctrl+R)"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
              </button>
            </>
          ) : (
            <>
              {(cat === "table" || cat === "all" || cat === "view") && (
                <button
                  disabled={!selectedObj}
                  onClick={() => selectedObj && handleOpenObject(selectedObj)}
                  className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] disabled:opacity-35 flex items-center gap-1.5 font-medium cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-sky-400" /> Open
                </button>
              )}
              {cat === "function" && (
                <button
                  disabled={!selectedObj}
                  onClick={() => selectedObj && handleExecuteRoutine(selectedObj)}
                  className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] disabled:opacity-35 flex items-center gap-1.5 font-medium cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 text-emerald-400" /> Execute
                </button>
              )}
              <button
                disabled={!selectedObj}
                onClick={() => selectedObj && handleDesignObject(selectedObj)}
                className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] disabled:opacity-35 flex items-center gap-1.5 font-medium cursor-pointer"
              >
                <Wrench className="w-3.5 h-3.5 text-amber-400" />
                {cat === "view" ? "Design View" : "Design"}
              </button>

              {(cat === "table" || cat === "all") && (
                <button
                  onClick={openNewTable}
                  className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] flex items-center gap-1.5 font-medium cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-emerald-400" />
                  {conn.engine === "mongodb" ? "New Collection" : "New Table"}
                </button>
              )}
              {cat === "view" && conn.engine !== "mongodb" && (
                <button
                  onClick={() => openNewObjectScript("view")}
                  className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] flex items-center gap-1.5 font-medium cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-purple-400" /> New View
                </button>
              )}
              {cat === "function" && (
                <>
                  <button
                    onClick={() => openNewObjectScript("function")}
                    className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] flex items-center gap-1.5 font-medium cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-amber-400" /> New Function
                  </button>
                  <button
                    onClick={() => openNewObjectScript("procedure")}
                    className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] flex items-center gap-1.5 font-medium cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-amber-400" /> New Procedure
                  </button>
                </>
              )}
              {cat === "trigger" && (
                <button
                  onClick={() => openNewObjectScript("trigger")}
                  className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] flex items-center gap-1.5 font-medium cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-orange-400" /> New Trigger
                </button>
              )}

              <button
                disabled={!selectedObj}
                onClick={() => selectedObj && handleCopyObject(selectedObj)}
                title="Copy selected object (Ctrl+C)"
                className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] disabled:opacity-35 flex items-center gap-1.5 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5 text-teal-400" /> Copy
              </button>
              <button
                disabled={!copiedObject || pasting}
                onClick={handlePasteObject}
                title={
                  copiedObject
                    ? `Paste ${copiedObject.object.kind} "${copiedObject.object.name}" into ${browserContext.database} (Ctrl+V)`
                    : "Copy an object first to paste here"
                }
                className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] disabled:opacity-35 flex items-center gap-1.5 cursor-pointer"
              >
                <ClipboardPaste className="w-3.5 h-3.5 text-emerald-400" />
                {pasting
                  ? "Pasting..."
                  : copiedObject
                  ? `Paste (${copiedObject.object.name})`
                  : "Paste"}
              </button>
              {conn.engine !== "mongodb" && (
                <button
                  disabled={!selectedObj}
                  onClick={() => selectedObj && handleCopyDdl(selectedObj)}
                  className="h-7 px-2.5 rounded hover:bg-[var(--surface-hover)] disabled:opacity-35 flex items-center gap-1.5 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" /> Copy DDL
                </button>
              )}
              <button
                disabled={!selectedObj}
                onClick={() => selectedObj && handleDeleteObject(selectedObj)}
                className="h-7 px-2.5 rounded hover:bg-red-500/15 text-red-400 disabled:opacity-35 flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
              <button
                onClick={handleRefresh}
                className="h-7 px-2 rounded hover:bg-[var(--surface-hover)] cursor-pointer"
                title="Refresh Objects (F5 / Ctrl+R)"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
              </button>
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search objects..."
              className="h-7 pl-7 pr-2.5 w-44 rounded border border-[var(--border-strong)] bg-[var(--surface-canvas)] focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>

          {cat !== "query" && (
            <div className="flex rounded border border-[var(--border-strong)] overflow-hidden">
              <button
                onClick={() => setViewMode("list")}
                title="Details List View"
                className={`h-7 px-2 cursor-pointer ${
                  viewMode === "list"
                    ? "bg-sky-600 text-white"
                    : "hover:bg-[var(--surface-hover)]"
                }`}
              >
                <List className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setViewMode("grid")}
                title="Icon Grid View"
                className={`h-7 px-2 cursor-pointer ${
                  viewMode === "grid"
                    ? "bg-sky-600 text-white"
                    : "hover:bg-[var(--surface-hover)]"
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div
        ref={listContainerRef}
        tabIndex={0}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtxMenu({ x: e.clientX, y: e.clientY, type: "empty_objects" });
        }}
        className="flex-1 overflow-auto outline-none"
      >
        {cat === "query" ? (
          dbSavedQueries.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-2 p-6 text-center">
              <FileCode2 className="w-8 h-8 text-indigo-400/60" />
              <div>
                No saved queries for{" "}
                <strong className="text-zinc-700 dark:text-zinc-300">
                  {conn.name} / {browserContext.database}
                </strong>
              </div>
              <button
                onClick={openNewQuery}
                className="mt-1 h-7 px-3 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" /> New Query
              </button>
            </div>
          ) : (
            <div className="p-2 space-y-0.5">
              {dbSavedQueries.map((sq) => {
                const filename = formatSavedQueryFilename(sq);
                const isMongo = isMongoSavedQuery(sq);
                const isSel = selectedQueryPath === sq.path;
                return (
                  <div
                    key={sq.id}
                    onClick={() => setSelectedQueryPath(sq.path)}
                    onDoubleClick={() => handleOpenSavedQuery(sq)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setSelectedQueryPath(sq.path);
                      setCtxMenu({ x: e.clientX, y: e.clientY, type: "saved_query", query: sq });
                    }}
                    className={`group px-3 py-1.5 rounded flex items-center justify-between gap-2 cursor-pointer select-none ${
                      isSel
                        ? "bg-sky-600/25 text-zinc-900 dark:text-white"
                        : "hover:bg-sky-500/15"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isMongo ? (
                        <Braces className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <FileCode2 className="w-4 h-4 text-indigo-400 shrink-0" />
                      )}
                      <span className="font-medium truncate">{filename}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[0.72rem] text-zinc-500 font-mono">
                        {new Date(sq.updatedAt).toLocaleString()}
                      </span>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          title="Open Query"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenSavedQuery(sq);
                          }}
                          className="p-1 rounded hover:bg-[var(--surface-hover)] text-sky-400 cursor-pointer"
                        >
                          <FolderOpen className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Rename"
                          onClick={(e) => {
                            e.stopPropagation();
                            setQueryModal({ mode: "rename", query: sq });
                          }}
                          className="p-1 rounded hover:bg-[var(--surface-hover)] text-zinc-400 cursor-pointer"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Duplicate"
                          onClick={(e) => {
                            e.stopPropagation();
                            setQueryModal({ mode: "duplicate", query: sq });
                          }}
                          className="p-1 rounded hover:bg-[var(--surface-hover)] text-teal-400 cursor-pointer"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          title="Delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSavedQuery(sq);
                          }}
                          className="p-1 rounded hover:bg-red-500/15 text-red-400 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : objects.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-2 p-6 text-center">
            {cat === "trigger" ? (
              <Zap className="w-8 h-8 text-orange-400/60" />
            ) : cat === "view" ? (
              <Eye className="w-8 h-8 text-purple-400/60" />
            ) : cat === "function" ? (
              <FunctionSquare className="w-8 h-8 text-amber-400/60" />
            ) : (
              <Table2 className="w-8 h-8 text-sky-400/60" />
            )}
            <div>
              No {cat} objects found in{" "}
              <strong className="text-zinc-700 dark:text-zinc-300">
                {browserContext.database}
                {browserContext.schema && browserContext.schema !== browserContext.database
                  ? `.${browserContext.schema}`
                  : ""}
              </strong>
            </div>
            {(cat === "table" || cat === "view" || cat === "function" || cat === "trigger") && (
              <button
                onClick={() => {
                  if (cat === "table") openNewTable();
                  else openNewObjectScript(cat);
                }}
                className="mt-1 h-7 px-3 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" /> New{" "}
                {cat === "table" && conn.engine === "mongodb"
                  ? "Collection"
                  : cat.charAt(0).toUpperCase() + cat.slice(1)}
              </button>
            )}
          </div>
        ) : viewMode === "list" ? (
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-[var(--surface-panel)] border-b border-[var(--border-subtle)] select-none">
              <tr>
                <th
                  onClick={() => toggleSort("name")}
                  className="px-3 py-1.5 font-semibold text-zinc-600 dark:text-zinc-300 cursor-pointer hover:bg-[var(--surface-hover)]"
                >
                  Name{renderSortIcon("name")}
                </th>
                <th
                  onClick={() => toggleSort("kind")}
                  className="px-3 py-1.5 font-semibold text-zinc-600 dark:text-zinc-300 w-36 cursor-pointer hover:bg-[var(--surface-hover)]"
                >
                  Type{renderSortIcon("kind")}
                </th>
                <th
                  onClick={() => toggleSort("rowEstimate")}
                  className="px-3 py-1.5 font-semibold text-zinc-600 dark:text-zinc-300 w-32 text-right cursor-pointer hover:bg-[var(--surface-hover)]"
                >
                  Rows (Est.){renderSortIcon("rowEstimate")}
                </th>
                <th
                  onClick={() => toggleSort("comment")}
                  className="px-3 py-1.5 font-semibold text-zinc-600 dark:text-zinc-300 cursor-pointer hover:bg-[var(--surface-hover)]"
                >
                  Comment{renderSortIcon("comment")}
                </th>
              </tr>
            </thead>
            <tbody>
              {objects.map((obj, idx) => {
                const isSelected = obj.name === selectedName;
                return (
                  <tr
                    key={`${obj.kind}-${obj.name}`}
                    data-obj-index={idx}
                    onClick={() => handleSelectObject(obj)}
                    onDoubleClick={() => handleOpenObject(obj)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleSelectObject(obj);
                      setCtxMenu({ x: e.clientX, y: e.clientY, type: "object", object: obj });
                    }}
                    className={`h-[26px] border-b border-[var(--border-subtle)]/50 cursor-pointer select-none ${
                      isSelected
                        ? "bg-sky-600/25 text-zinc-900 dark:text-white"
                        : idx % 2 === 1
                        ? "bg-[var(--surface-panel)]/45 hover:bg-sky-500/10"
                        : "hover:bg-sky-500/10"
                    }`}
                  >
                    <td className="px-3 py-1 flex items-center gap-2 font-medium">
                      {renderObjectIcon(obj.kind, "sm")}
                      <span className="truncate">{obj.name}</span>
                    </td>
                    <td className="px-3 py-1 text-zinc-500 capitalize">
                      {obj.kind.replace("_", " ")}
                    </td>
                    <td className="px-3 py-1 text-right font-mono text-zinc-500">
                      {obj.rowEstimate != null ? obj.rowEstimate.toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-1 text-zinc-500 truncate max-w-xs">
                      {obj.comment ?? ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="p-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {objects.map((obj, idx) => {
              const isSelected = obj.name === selectedName;
              return (
                <div
                  key={`${obj.kind}-${obj.name}`}
                  data-obj-index={idx}
                  onClick={() => handleSelectObject(obj)}
                  onDoubleClick={() => handleOpenObject(obj)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleSelectObject(obj);
                    setCtxMenu({ x: e.clientX, y: e.clientY, type: "object", object: obj });
                  }}
                  className={`p-3 rounded-lg border flex flex-col items-center text-center gap-1.5 cursor-pointer select-none transition ${
                    isSelected
                      ? "border-sky-500 bg-sky-500/20"
                      : "border-transparent hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  {renderObjectIcon(obj.kind, "lg")}
                  <span className="text-xs font-medium truncate w-full">
                    {obj.name}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer Status Bar */}
      <div className="px-3 py-1 border-t border-[var(--border-subtle)] bg-[var(--surface-panel)] text-[0.74rem] text-zinc-500 flex items-center justify-between">
        <span>
          {cat === "query"
            ? `${dbSavedQueries.length} saved quer${dbSavedQueries.length === 1 ? "y" : "ies"} in ${browserContext.database}`
            : `${objects.length} ${cat}(s) in ${browserContext.database}${
                browserContext.schema && browserContext.schema !== browserContext.database
                  ? `.${browserContext.schema}`
                  : ""
              }`}
        </span>
        <span>
          {cat === "query"
            ? selectedSavedQuery
              ? `Selected: ${formatSavedQueryFilename(selectedSavedQuery)} • Double-click to open • Right-click for actions`
              : "Double-click to open • Right-click to rename, duplicate, or delete"
            : "Double-click to open • Single-click to inspect • Right-click for actions"}
        </span>
      </div>

      {/* Unified Context Menu for ObjectsBrowser */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          className="w-56"
        >
          {ctxMenu.type === "saved_query" && (
            <>
              <button
                onClick={() => {
                  handleOpenSavedQuery(ctxMenu.query);
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5 text-sky-400" /> Open Query
              </button>
              <button
                onClick={() => {
                  openNewQuery();
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-indigo-400" /> New Query
              </button>
              <button
                onClick={() => {
                  setQueryModal({ mode: "rename", query: ctxMenu.query });
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
              >
                <Edit3 className="w-3.5 h-3.5" /> Rename
              </button>
              <button
                onClick={() => {
                  setQueryModal({ mode: "duplicate", query: ctxMenu.query });
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5 text-teal-400" /> Duplicate
              </button>
              <div className="my-1 border-t border-[var(--border-subtle)]" />
              <button
                onClick={() => {
                  handleDeleteSavedQuery(ctxMenu.query);
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-red-500 hover:bg-red-500/10 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete
              </button>
            </>
          )}

          {ctxMenu.type === "empty_objects" && (
            <>
              {(cat === "table" || cat === "all") && (
                <button
                  onClick={() => {
                    openNewTable();
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-emerald-400" />{" "}
                  {conn.engine === "mongodb" ? "New Collection..." : "New Table..."}
                </button>
              )}
              {cat === "view" && (
                <button
                  onClick={() => {
                    openNewObjectScript("view");
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-purple-400" /> New View...
                </button>
              )}
              {cat === "function" && (
                <>
                  <button
                    onClick={() => {
                      openNewObjectScript("function");
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-amber-400" /> New Function...
                  </button>
                  <button
                    onClick={() => {
                      openNewObjectScript("procedure");
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-amber-400" /> New Procedure...
                  </button>
                </>
              )}
              {cat === "trigger" && (
                <button
                  onClick={() => {
                    openNewObjectScript("trigger");
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-orange-400" /> New Trigger...
                </button>
              )}
              {cat === "query" && (
                <button
                  onClick={() => {
                    openNewQuery();
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5 text-indigo-400" /> New Query
                </button>
              )}
              {cat !== "query" && copiedObject && (
                <button
                  onClick={() => {
                    handlePasteObject();
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <ClipboardPaste className="w-3.5 h-3.5 text-emerald-400" /> Paste "{copiedObject.object.name}"
                </button>
              )}
              <div className="my-1 border-t border-[var(--border-subtle)]" />
              <button
                onClick={() => {
                  handleRefresh();
                  setCtxMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh Objects (F5)
              </button>
            </>
          )}

          {ctxMenu.type === "object" && (() => {
            const obj = ctxMenu.object;
            const isTableLike = obj.kind === "table" || obj.kind === "collection";
            const isViewLike = obj.kind === "view" || obj.kind === "materialized_view";
            const isRoutine = obj.kind === "function" || obj.kind === "procedure";
            const isTrigger = obj.kind === "trigger";

            return (
              <>
                {isTableLike && (
                  <>
                    <button
                      onClick={() => {
                        handleOpenObject(obj);
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Table2 className="w-3.5 h-3.5 text-sky-400" />{" "}
                      {conn.engine === "mongodb" ? "Open Collection" : "Open Table"}
                    </button>
                    <button
                      onClick={() => {
                        handleDesignObject(obj);
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Wrench className="w-3.5 h-3.5 text-amber-400" />{" "}
                      {conn.engine === "mongodb" ? "Indexes & Validation" : "Design Table"}
                    </button>
                    <button
                      onClick={() => {
                        openNewTable();
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5 text-emerald-400" />{" "}
                      {conn.engine === "mongodb" ? "New Collection..." : "New Table..."}
                    </button>
                    <div className="my-1 border-t border-[var(--border-subtle)]" />
                    <button
                      onClick={() => {
                        setPromptModal({ mode: "rename_table", tableName: obj.name });
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />{" "}
                      {conn.engine === "mongodb" ? "Rename Collection..." : "Rename Table..."}
                    </button>
                    <button
                      onClick={() => {
                        setPromptModal({ mode: "duplicate_table", tableName: obj.name });
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5 text-sky-400" />{" "}
                      {conn.engine === "mongodb" ? "Duplicate Collection..." : "Duplicate Table..."}
                    </button>
                    <button
                      onClick={() => {
                        handleTruncateTable(obj);
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-amber-500 hover:bg-amber-500/10 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Empty / Truncate Table
                    </button>
                    <div className="my-1 border-t border-[var(--border-subtle)]" />
                    <button
                      onClick={() => {
                        openTab({
                          kind: "import_export",
                          title: `Import: ${obj.name}`,
                          connectionId: conn.id,
                          database: browserContext.database ?? undefined,
                          schema: browserContext.schema ?? undefined,
                          table: obj.name,
                          wizardMode: "import",
                        });
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Upload className="w-3.5 h-3.5 text-emerald-400" /> Import Wizard...
                    </button>
                    <button
                      onClick={() => {
                        openTab({
                          kind: "import_export",
                          title: `Export: ${obj.name}`,
                          connectionId: conn.id,
                          database: browserContext.database ?? undefined,
                          schema: browserContext.schema ?? undefined,
                          table: obj.name,
                          wizardMode: "export",
                        });
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5 text-indigo-400" /> Export Wizard...
                    </button>
                    {conn.engine !== "mongodb" && (
                      <button
                        onClick={() => {
                          openTab({
                            kind: "dump_backup",
                            title: `Dump: ${obj.name}`,
                            connectionId: conn.id,
                            database: browserContext.database ?? undefined,
                            schema: browserContext.schema ?? undefined,
                            table: obj.name,
                            wizardMode: "dump",
                          });
                          setCtxMenu(null);
                        }}
                        className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                      >
                        <HardDriveDownload className="w-3.5 h-3.5 text-blue-400" /> Dump SQL File...
                      </button>
                    )}
                  </>
                )}

                {isViewLike && (
                  <>
                    <button
                      onClick={() => {
                        handleOpenObject(obj);
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Eye className="w-3.5 h-3.5 text-purple-400" /> Open View Data
                    </button>
                    {conn.engine !== "mongodb" && (
                      <>
                        <button
                          onClick={() => {
                            handleDesignObject(obj);
                            setCtxMenu(null);
                          }}
                          className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                        >
                          <Wrench className="w-3.5 h-3.5 text-amber-400" /> Design View
                        </button>
                        <button
                          onClick={() => {
                            openNewObjectScript("view");
                            setCtxMenu(null);
                          }}
                          className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5 text-emerald-400" /> New View...
                        </button>
                      </>
                    )}
                  </>
                )}

                {isRoutine && (
                  <>
                    <button
                      onClick={() => {
                        handleExecuteRoutine(obj);
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Play className="w-3.5 h-3.5 text-emerald-400" /> Execute / Call...
                    </button>
                    <button
                      onClick={() => {
                        handleDesignObject(obj);
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Wrench className="w-3.5 h-3.5 text-amber-400" /> Design / Edit
                    </button>
                    <button
                      onClick={() => {
                        openNewObjectScript("function");
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5 text-amber-400" /> New Function...
                    </button>
                    <button
                      onClick={() => {
                        openNewObjectScript("procedure");
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5 text-amber-400" /> New Procedure...
                    </button>
                  </>
                )}

                {isTrigger && (
                  <>
                    <button
                      onClick={() => {
                        handleDesignObject(obj);
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Wrench className="w-3.5 h-3.5 text-orange-400" /> Design / Edit Trigger
                    </button>
                    <button
                      onClick={() => {
                        openNewObjectScript("trigger");
                        setCtxMenu(null);
                      }}
                      className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5 text-orange-400" /> New Trigger...
                    </button>
                  </>
                )}

                <div className="my-1 border-t border-[var(--border-subtle)]" />
                <button
                  onClick={() => {
                    handleCopyObject(obj);
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5 text-teal-400" /> Copy Object
                </button>
                {copiedObject && (
                  <button
                    onClick={() => {
                      handlePasteObject();
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    <ClipboardPaste className="w-3.5 h-3.5 text-emerald-400" /> Paste "{copiedObject.object.name}"
                  </button>
                )}
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(obj.name);
                    addLog("info", `Copied name "${obj.name}"`, undefined, true);
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5 text-zinc-400" /> Copy Name
                </button>
                {conn.engine !== "mongodb" && (
                  <button
                    onClick={() => {
                      handleCopyDdl(obj);
                      setCtxMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-[var(--surface-hover)] cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5" /> Copy DDL
                  </button>
                )}
                <div className="my-1 border-t border-[var(--border-subtle)]" />
                <button
                  onClick={() => {
                    handleDeleteObject(obj);
                    setCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-red-500 hover:bg-red-500/10 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Drop {obj.kind.replace("_", " ")}
                </button>
              </>
            );
          })()}
        </ContextMenu>
      )}

      {/* Inline Prompt Modal (Rename / Duplicate Table) */}
      {promptModal && (
        <InputPromptModal
          open={true}
          title={
            promptModal.mode === "rename_table"
              ? `Rename ${conn.engine === "mongodb" ? "Collection" : "Table"}`
              : `Duplicate ${conn.engine === "mongodb" ? "Collection" : "Table"}`
          }
          subtitle={`${conn.name} / ${browserContext.database}${
            browserContext.schema && browserContext.schema !== browserContext.database
              ? `.${browserContext.schema}`
              : ""
          }`}
          label={promptModal.mode === "rename_table" ? "New Name" : "Target Name"}
          initialValue={
            promptModal.mode === "rename_table"
              ? promptModal.tableName
              : `${promptModal.tableName}_copy`
          }
          confirmLabel={promptModal.mode === "rename_table" ? "Rename" : "Duplicate"}
          checkboxLabel={
            promptModal.mode === "duplicate_table" ? "Copy data rows" : undefined
          }
          initialCheckbox={true}
          onClose={() => setPromptModal(null)}
          onSubmit={handlePromptModalSubmit}
        />
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
          connectionName={conn.name}
          databaseName={browserContext.database}
          existingNames={dbSavedQueries
            .filter((sq) => sq.path !== queryModal.query.path)
            .map((sq) => sq.name)}
          allowOverwrite={false}
          onClose={() => setQueryModal(null)}
          onSubmit={handleSavedQueryModalSubmit}
        />
      )}
    </div>
  );
};
