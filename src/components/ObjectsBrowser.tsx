import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  ClipboardPaste,
  Copy,
  Database,
  Edit3,
  Eye,
  FileCode2,
  FolderOpen,
  FunctionSquare,
  LayoutGrid,
  List,
  Plus,
  RefreshCw,
  Search,
  Table2,
  Trash2,
  Wrench,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import {
  buildTabFromSavedQuery,
  formatSavedQueryFilename,
  isMongoSavedQuery,
} from "../lib/savedQueries";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { SaveQueryModal } from "./SaveQueryModal";
import type { DatabaseObject, SavedQuery } from "../types/dba";

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
    loadObjects,
    openTab,
    updateTab,
    openConnectionModal,
    openSafetyModal,
    setInspectedTableMeta,
    addLog,
    refreshSavedQueries,
    copiedObject,
    setCopiedObject,
    pasteCopiedObject,
  } = useWorkbenchStore();

  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [search, setSearch] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [selectedQueryPath, setSelectedQueryPath] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [queryCtxMenu, setQueryCtxMenu] = useState<{
    x: number;
    y: number;
    query: SavedQuery;
  } | null>(null);
  const [queryModal, setQueryModal] = useState<{
    mode: "rename" | "duplicate";
    query: SavedQuery;
  } | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const queryCtxMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!queryCtxMenu) return;
    const onDown = (e: MouseEvent) => {
      if (queryCtxMenuRef.current && !queryCtxMenuRef.current.contains(e.target as Node)) {
        setQueryCtxMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setQueryCtxMenu(null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [queryCtxMenu]);

  const conn = connections.find((c) => c.id === browserContext.connectionId);
  const objKey =
    browserContext.connectionId && browserContext.database
      ? `${browserContext.connectionId}::${browserContext.database}::${
          browserContext.schema ?? browserContext.database
        }`
      : null;

  const objects = useMemo(() => {
    if (!objKey) return [];
    const raw = objectsByKey[objKey] ?? [];
    const q = search.trim().toLowerCase();
    return raw.filter((o) => {
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
      if (q && !o.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [objKey, objectsByKey, browserContext.category, search]);

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
      // Sync any open tab referencing the old path
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

  const handleSelectObject = async (obj: DatabaseObject) => {
    setSelectedName(obj.name);
    if (
      conn &&
      browserContext.database &&
      (obj.kind === "table" || obj.kind === "view")
    ) {
      api
        .getTableMetadata(
          conn.id,
          obj.name,
          browserContext.database,
          browserContext.schema ?? undefined
        )
        .then((meta) => setInspectedTableMeta(meta))
        .catch(() => {});
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

  const handleDesignObject = (obj: DatabaseObject) => {
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
    openTab({
      kind: "designer",
      title: `Design: ${obj.name}`,
      connectionId: conn.id,
      database: browserContext.database,
      schema: browserContext.schema ?? undefined,
      table: obj.name,
      isNewTable: false,
    });
  };

  const handleRefresh = async () => {
    if (!conn || !browserContext.database || refreshing) return;
    setRefreshing(true);
    try {
      await loadObjects(
        conn.id,
        browserContext.database,
        browserContext.schema ?? browserContext.database
      );
      if (
        selectedObj &&
        (selectedObj.kind === "table" || selectedObj.kind === "view")
      ) {
        api
          .getTableMetadata(
            conn.id,
            selectedObj.name,
            browserContext.database,
            browserContext.schema ?? undefined
          )
          .then((meta) => setInspectedTableMeta(meta))
          .catch(() => {});
      }
    } finally {
      setRefreshing(false);
    }
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
          addLog("warn", `Dropped ${obj.kind} ${obj.name}`);
          await handleRefresh();
        } catch (err) {
          addLog("error", formatApiError(err));
        }
      },
    });
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
        addLog("success", `Copied DDL for ${obj.kind} "${obj.name}"`);
      }
    } catch (err) {
      addLog("error", formatApiError(err));
    }
  };

  useEffect(() => {
    // Only capture ObjectsBrowser shortcuts (F5, Ctrl+R, Ctrl+C/V, arrows) when Objects tab is active
    if (activeTabId !== "objects") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (queryModal) return;
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
        if (browserContext.category === "query") {
          refreshSavedQueries();
        } else {
          handleRefresh();
        }
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

  if (!conn || !browserContext.database) {
    return (
      <div className="h-full flex flex-col bg-white dark:bg-[#1e1f22]">
        <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex items-center justify-between text-xs">
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

        <div className="flex-1 overflow-auto p-4">
          {connections.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-zinc-500 gap-3">
              <Database className="w-12 h-12 text-sky-400/70" />
              <div className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">
                No Connections Configured
              </div>
              <p className="text-xs max-w-sm">
                Click <strong>Connection</strong> in the top toolbar to add a PostgreSQL or MySQL/MariaDB server.
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
                    className="p-3.5 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#26282c] hover:border-sky-500/70 transition cursor-pointer flex items-start gap-3"
                  >
                    <div
                      className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                        c.engine === "postgres"
                          ? "bg-sky-500/15 text-sky-400"
                          : "bg-teal-500/15 text-teal-400"
                      }`}
                    >
                      <Database className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full ${
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
                        <span className="text-[0.68rem] uppercase px-1.5 py-0.2 rounded bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
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
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#1e1f22] text-xs">
      <div className="px-2.5 py-1.5 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            disabled={!selectedObj}
            onClick={() => selectedObj && handleOpenObject(selectedObj)}
            className="h-7 px-2.5 rounded hover:bg-zinc-200 dark:hover:bg-[#35373d] disabled:opacity-35 flex items-center gap-1.5 font-medium"
          >
            <FolderOpen className="w-3.5 h-3.5 text-sky-400" />
            Open
          </button>
          <button
            disabled={!selectedObj || (selectedObj.kind !== "table" && selectedObj.kind !== "collection")}
            onClick={() => selectedObj && handleDesignObject(selectedObj)}
            className="h-7 px-2.5 rounded hover:bg-zinc-200 dark:hover:bg-[#35373d] disabled:opacity-35 flex items-center gap-1.5 font-medium"
          >
            <Wrench className="w-3.5 h-3.5 text-amber-400" />
            Design
          </button>
          <button
            onClick={() =>
              openTab({
                kind: "designer",
                title: "New Table",
                connectionId: conn.id,
                database: browserContext.database ?? undefined,
                schema: browserContext.schema ?? undefined,
                isNewTable: true,
              })
            }
            className="h-7 px-2.5 rounded hover:bg-zinc-200 dark:hover:bg-[#35373d] flex items-center gap-1.5 font-medium"
          >
            <Plus className="w-3.5 h-3.5 text-emerald-400" />
            New Table
          </button>
          <button
            disabled={!selectedObj}
            onClick={() => selectedObj && handleCopyObject(selectedObj)}
            title="Copy selected object (Ctrl+C)"
            className="h-7 px-2.5 rounded hover:bg-zinc-200 dark:hover:bg-[#35373d] disabled:opacity-35 flex items-center gap-1.5"
          >
            <Copy className="w-3.5 h-3.5 text-teal-400" />
            Copy
          </button>
          <button
            disabled={!copiedObject || pasting}
            onClick={handlePasteObject}
            title={
              copiedObject
                ? `Paste ${copiedObject.object.kind} "${copiedObject.object.name}" into ${browserContext.database} (Ctrl+V)`
                : "Copy an object first to paste here"
            }
            className="h-7 px-2.5 rounded hover:bg-zinc-200 dark:hover:bg-[#35373d] disabled:opacity-35 flex items-center gap-1.5"
          >
            <ClipboardPaste className="w-3.5 h-3.5 text-emerald-400" />
            {pasting
              ? "Pasting..."
              : copiedObject
              ? `Paste (${copiedObject.object.name})`
              : "Paste"}
          </button>
          <button
            disabled={!selectedObj}
            onClick={() => selectedObj && handleCopyDdl(selectedObj)}
            className="h-7 px-2.5 rounded hover:bg-zinc-200 dark:hover:bg-[#35373d] disabled:opacity-35 flex items-center gap-1.5"
          >
            <Copy className="w-3.5 h-3.5" />
            Copy DDL
          </button>
          <button
            disabled={!selectedObj}
            onClick={() => selectedObj && handleDeleteObject(selectedObj)}
            className="h-7 px-2.5 rounded hover:bg-red-500/15 text-red-400 disabled:opacity-35 flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </button>
          <button
            onClick={handleRefresh}
            className="h-7 px-2 rounded hover:bg-zinc-200 dark:hover:bg-[#35373d]"
            title="Refresh Objects (F5 / Ctrl+R)"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search objects..."
              className="h-7 pl-7 pr-2.5 w-44 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] focus:outline-none focus:ring-1 focus:ring-sky-500"
            />
          </div>

          <div className="flex rounded border border-zinc-300 dark:border-[#3b3d44] overflow-hidden">
            <button
              onClick={() => setViewMode("list")}
              title="Details List View"
              className={`h-7 px-2 ${
                viewMode === "list"
                  ? "bg-sky-600 text-white"
                  : "hover:bg-zinc-200 dark:hover:bg-[#35373d]"
              }`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode("grid")}
              title="Icon Grid View"
              className={`h-7 px-2 ${
                viewMode === "grid"
                  ? "bg-sky-600 text-white"
                  : "hover:bg-zinc-200 dark:hover:bg-[#35373d]"
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      <div ref={listContainerRef} tabIndex={0} className="flex-1 overflow-auto outline-none">
        {browserContext.category === "query" ? (
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
                onClick={() =>
                  conn.engine === "mongodb"
                    ? openTab({
                        kind: "mongo_query",
                        title: `MQL — ${conn.name}`,
                        connectionId: conn.id,
                        database: browserContext.database ?? undefined,
                        mongoMode: "mql",
                      })
                    : openTab({
                        kind: "query",
                        title: `Query — ${conn.name}`,
                        connectionId: conn.id,
                        database: browserContext.database ?? undefined,
                        schema: browserContext.schema ?? undefined,
                        sql: "",
                      })
                }
                className="mt-1 h-7 px-3 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-1.5"
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
                      setSelectedQueryPath(sq.path);
                      const x = Math.min(e.clientX, window.innerWidth - 190);
                      const y = Math.min(e.clientY, window.innerHeight - 160);
                      setQueryCtxMenu({ x: Math.max(8, x), y: Math.max(8, y), query: sq });
                    }}
                    className={`group px-3 py-2 rounded flex items-center justify-between gap-2 cursor-pointer select-none ${
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
                          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-sky-400"
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
                          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400"
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
                          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-teal-400"
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
                          className="p-1 rounded hover:bg-red-500/15 text-red-400"
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
          <div className="h-full flex items-center justify-center text-zinc-500">
            No {browserContext.category} objects found in {browserContext.database}
          </div>
        ) : viewMode === "list" ? (
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-zinc-100 dark:bg-[#25262a] border-b border-zinc-200 dark:border-[#32343a]">
              <tr>
                <th className="px-3 py-2 font-semibold text-zinc-600 dark:text-zinc-300">
                  Name
                </th>
                <th className="px-3 py-2 font-semibold text-zinc-600 dark:text-zinc-300 w-32">
                  Type
                </th>
                <th className="px-3 py-2 font-semibold text-zinc-600 dark:text-zinc-300 w-32 text-right">
                  Rows (Est.)
                </th>
                <th className="px-3 py-2 font-semibold text-zinc-600 dark:text-zinc-300">
                  Comment
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
                    className={`border-b border-zinc-200/50 dark:border-[#2c2e33] cursor-pointer select-none ${
                      isSelected
                        ? "bg-sky-600/25 text-zinc-900 dark:text-white"
                        : idx % 2 === 1
                        ? "bg-zinc-50/50 dark:bg-[#222327] hover:bg-sky-500/10"
                        : "hover:bg-sky-500/10"
                    }`}
                  >
                    <td className="px-3 py-1.5 flex items-center gap-2 font-medium">
                      {obj.kind === "table" && (
                        <Table2 className="w-4 h-4 text-sky-400 shrink-0" />
                      )}
                      {(obj.kind === "view" || obj.kind === "materialized_view") && (
                        <Eye className="w-4 h-4 text-purple-400 shrink-0" />
                      )}
                      {(obj.kind === "function" || obj.kind === "procedure") && (
                        <FunctionSquare className="w-4 h-4 text-amber-400 shrink-0" />
                      )}
                      <span>{obj.name}</span>
                    </td>
                    <td className="px-3 py-1.5 text-zinc-500 capitalize">
                      {obj.kind.replace("_", " ")}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-zinc-500">
                      {obj.rowEstimate != null ? obj.rowEstimate.toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-zinc-500 truncate max-w-xs">
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
                  className={`p-3 rounded-lg border flex flex-col items-center text-center gap-1.5 cursor-pointer select-none transition ${
                    isSelected
                      ? "border-sky-500 bg-sky-500/20"
                      : "border-transparent hover:bg-zinc-100 dark:hover:bg-[#2a2c31]"
                  }`}
                >
                  {obj.kind === "table" ? (
                    <Table2 className="w-8 h-8 text-sky-400" />
                  ) : obj.kind === "view" || obj.kind === "materialized_view" ? (
                    <Eye className="w-8 h-8 text-purple-400" />
                  ) : (
                    <FunctionSquare className="w-8 h-8 text-amber-400" />
                  )}
                  <span className="text-xs font-medium truncate w-full">
                    {obj.name}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="px-3 py-1 border-t border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] text-[0.75rem] text-zinc-500 flex items-center justify-between">
        <span>
          {browserContext.category === "query"
            ? `${dbSavedQueries.length} saved quer${dbSavedQueries.length === 1 ? "y" : "ies"} in ${browserContext.database}`
            : `${objects.length} ${browserContext.category}(s) in ${browserContext.database}${
                browserContext.schema && browserContext.schema !== browserContext.database
                  ? `.${browserContext.schema}`
                  : ""
              }`}
        </span>
        <span>
          {browserContext.category === "query"
            ? selectedSavedQuery
              ? `Selected: ${formatSavedQueryFilename(selectedSavedQuery)} • Double-click to open • Right-click for actions`
              : "Double-click to open • Right-click to rename, duplicate, or delete"
            : "Double-click to open • Single-click to inspect"}
        </span>
      </div>

      {queryCtxMenu && (
        <div
          ref={queryCtxMenuRef}
          style={{ top: queryCtxMenu.y, left: queryCtxMenu.x }}
          className="fixed z-50 w-44 py-1 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
        >
          <button
            onClick={() => {
              handleOpenSavedQuery(queryCtxMenu.query);
              setQueryCtxMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <FolderOpen className="w-3.5 h-3.5 text-sky-400" /> Open Query
          </button>
          <button
            onClick={() => {
              setQueryModal({ mode: "rename", query: queryCtxMenu.query });
              setQueryCtxMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Edit3 className="w-3.5 h-3.5" /> Rename
          </button>
          <button
            onClick={() => {
              setQueryModal({ mode: "duplicate", query: queryCtxMenu.query });
              setQueryCtxMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <Copy className="w-3.5 h-3.5 text-teal-400" /> Duplicate
          </button>
          <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
          <button
            onClick={() => {
              handleDeleteSavedQuery(queryCtxMenu.query);
              setQueryCtxMenu(null);
            }}
            className="w-full px-3 py-1.5 text-left flex items-center gap-2 text-red-500 hover:bg-red-500/10"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
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
