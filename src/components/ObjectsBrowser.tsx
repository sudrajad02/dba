import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardPaste,
  Copy,
  Database,
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
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import type { DatabaseObject } from "../types/datavault";

export const ObjectsBrowser: React.FC = () => {
  const {
    connections,
    connectedIds,
    browserContext,
    objectsByKey,
    savedQueries,
    connectTo,
    loadObjects,
    openTab,
    openConnectionModal,
    openSafetyModal,
    setInspectedTableMeta,
    addLog,
    copiedObject,
    setCopiedObject,
    pasteCopiedObject,
  } = useWorkbenchStore();

  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [search, setSearch] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pasting, setPasting] = useState(false);
  const listContainerRef = useRef<HTMLDivElement | null>(null);

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
    if (!conn || !browserContext.database) return;
    setRefreshing(true);
    await loadObjects(
      conn.id,
      browserContext.database,
      browserContext.schema ?? browserContext.database
    );
    setRefreshing(false);
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
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
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
        const el = listContainerRef.current?.querySelector(
          `[data-obj-index="${nextIdx}"]`
        );
        if (el instanceof HTMLElement) {
          el.scrollIntoView({ block: "nearest" });
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
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
            title="Refresh Objects"
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
          <div className="p-3 space-y-1">
            {savedQueries.map((sq) => (
              <div
                key={sq.id}
                onDoubleClick={() =>
                  openTab({
                    kind: "query",
                    title: `${sq.name}.sql`,
                    connectionId: conn.id,
                    database: browserContext.database ?? undefined,
                    sql: sq.sql,
                  })
                }
                className="px-3 py-2 rounded hover:bg-sky-500/15 flex items-center justify-between cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <FileCode2 className="w-4 h-4 text-indigo-400" />
                  <span className="font-medium">{sq.name}.sql</span>
                </div>
                <span className="text-[0.72rem] text-zinc-500 font-mono">
                  {new Date(sq.updatedAt).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        ) : objects.length === 0 ? (
          <div className="h-full flex items-center justify-center text-zinc-500">
            No {browserContext.category} objects found in {browserContext.database}
          </div>
        ) : viewMode === "list" ? (
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 bg-zinc-100 dark:bg-[#25262a] border-b border-zinc-200 dark:border-[#32343a]">
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
          {objects.length} {browserContext.category}(s) in {browserContext.database}
          {browserContext.schema && browserContext.schema !== browserContext.database
            ? `.${browserContext.schema}`
            : ""}
        </span>
        <span>Double-click to open • Single-click to inspect</span>
      </div>
    </div>
  );
};
