import React, { useEffect, useMemo, useState } from "react";
import { Database, FileCode2, Plus, Search, Table2 } from "lucide-react";
import { useWorkbenchStore } from "../store/useWorkbenchStore";

interface PaletteItem {
  id: string;
  label: string;
  subtitle: string;
  kind: "action" | "connection" | "object" | "saved_query";
  run: () => void;
}

export const CommandPalette: React.FC = () => {
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    connections,
    objectsByKey,
    savedQueries,
    connectTo,
    openTab,
    openConnectionModal,
    activeConnectionId,
  } = useWorkbenchStore();

  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    if (commandPaletteOpen) {
      setQuery("");
      setSelectedIdx(0);
    }
  }, [commandPaletteOpen]);

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [
      {
        id: "act:new-query",
        label: "New SQL Query Tab",
        subtitle: "Ctrl+T",
        kind: "action",
        run: () =>
          openTab({
            kind: "query",
            title: "New Query",
            connectionId: activeConnectionId ?? undefined,
            sql: "",
          }),
      },
      {
        id: "act:new-conn",
        label: "New Database Connection",
        subtitle: "Configure PostgreSQL / MySQL / SQL Server / MongoDB",
        kind: "action",
        run: () => openConnectionModal(null),
      },
      {
        id: "act:import-export",
        label: "Import / Export Wizard",
        subtitle: "Stream CSV, JSON/JSONL, Excel (.xlsx), or SQL Insert/Upsert",
        kind: "action",
        run: () =>
          openTab({
            kind: "import_export",
            title: "Import / Export",
            connectionId: activeConnectionId ?? undefined,
            wizardMode: "export",
          }),
      },
      {
        id: "act:dump-backup",
        label: "SQL Dump, Execute SQL File & Native Backup",
        subtitle: "Built-in streaming dump + pg_dump / mysqldump / mongodump",
        kind: "action",
        run: () =>
          openTab({
            kind: "dump_backup",
            title: "Dump & Backup",
            connectionId: activeConnectionId ?? undefined,
            wizardMode: "dump",
          }),
      },
      {
        id: "act:data-transfer",
        label: "Data Transfer Wizard",
        subtitle: "Same-engine & cross-engine transfer with Type Mapping Matrix",
        kind: "action",
        run: () =>
          openTab({
            kind: "data_transfer",
            title: "Data Transfer",
            connectionId: activeConnectionId ?? undefined,
          }),
      },
      {
        id: "act:structure-sync",
        label: "Structure & Data Synchronization",
        subtitle: "Schema diff + DDL migration generator & streaming row-hash data sync",
        kind: "action",
        run: () =>
          openTab({
            kind: "sync",
            title: "Structure & Data Sync",
            connectionId: activeConnectionId ?? undefined,
            wizardMode: "structure_sync",
          }),
      },
      {
        id: "act:er-model",
        label: "Visual ER Diagram / Data Modeling",
        subtitle: "Reverse engineer schema, Crow's Foot editor, Forward SQL, export SVG/PNG/PDF",
        kind: "action",
        run: () =>
          openTab({
            kind: "er_model",
            title: "ER Diagram",
            connectionId: activeConnectionId ?? undefined,
          }),
      },
      {
        id: "act:query-builder",
        label: "Visual Query Builder",
        subtitle: "Drag tables, auto-detect JOINs, aggregations & live SQL preview",
        kind: "action",
        run: () =>
          openTab({
            kind: "query_builder",
            title: "Query Builder",
            connectionId: activeConnectionId ?? undefined,
          }),
      },
    ];

    for (const c of connections) {
      list.push({
        id: `conn:${c.id}`,
        label: `Connect: ${c.name}`,
        subtitle: `${c.engine.toUpperCase()} — ${c.host}:${c.port}`,
        kind: "connection",
        run: () => connectTo(c.id),
      });
    }

    for (const [key, objs] of Object.entries(objectsByKey)) {
      const [connId, db, schema] = key.split("::");
      const conn = connections.find((c) => c.id === connId);
      for (const obj of objs) {
        if (obj.kind === "table" || obj.kind === "view" || obj.kind === "collection") {
          list.push({
            id: `obj:${key}:${obj.name}`,
            label: obj.name,
            subtitle: `${conn?.name ?? connId} / ${db}${schema && schema !== db ? `.${schema}` : ""} (${obj.kind})`,
            kind: "object",
            run: () =>
              conn?.engine === "mongodb"
                ? openTab({
                    kind: "mongo_collection",
                    title: obj.name,
                    connectionId: connId,
                    database: db,
                    collection: obj.name,
                  })
                : openTab({
                    kind: "table",
                    title: obj.name,
                    connectionId: connId,
                    database: db,
                    schema: schema || undefined,
                    table: obj.name,
                  }),
          });
        }
      }
    }

    for (const sq of savedQueries) {
      list.push({
        id: `sq:${sq.id}`,
        label: `${sq.name}.sql`,
        subtitle: sq.folder ? `Saved Query (${sq.folder})` : "Saved Query",
        kind: "saved_query",
        run: () =>
          openTab({
            kind: "query",
            title: `${sq.name}.sql`,
            sql: sq.sql,
          }),
      });
    }

    const q = query.trim().toLowerCase();
    if (!q) return list.slice(0, 20);
    return list
      .filter(
        (i) =>
          i.label.toLowerCase().includes(q) || i.subtitle.toLowerCase().includes(q)
      )
      .slice(0, 25);
  }, [
    query,
    connections,
    objectsByKey,
    savedQueries,
    activeConnectionId,
    connectTo,
    openTab,
    openConnectionModal,
  ]);

  if (!commandPaletteOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/55  flex items-start justify-center pt-20 p-4"
      onClick={() => setCommandPaletteOpen(false)}
    >
      <div
        className="w-full max-w-xl rounded-md border border-[var(--border-strong)] bg-[var(--surface-panel)] shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3.5 py-2.5 border-b border-[var(--border-subtle)] flex items-center gap-2">
          <Search className="w-4 h-4 text-zinc-500" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCommandPaletteOpen(false);
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIdx((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIdx((i) => Math.max(0, i - 1));
              } else if (e.key === "Enter" && items[selectedIdx]) {
                items[selectedIdx].run();
                setCommandPaletteOpen(false);
              }
            }}
            placeholder="Jump to table, connection, saved query, or action..."
            className="flex-1 bg-transparent text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none"
          />
          <kbd className="text-[0.72rem] px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-800 text-zinc-500">
            ESC
          </kbd>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <div className="py-8 text-center text-xs text-zinc-500">No matches found</div>
          ) : (
            items.map((item, idx) => (
              <button
                key={item.id}
                onClick={() => {
                  item.run();
                  setCommandPaletteOpen(false);
                }}
                onMouseEnter={() => setSelectedIdx(idx)}
                className={`w-full px-3 py-2 rounded-lg text-left flex items-center gap-2.5 text-xs transition ${
                  idx === selectedIdx
                    ? "bg-indigo-600 text-white"
                    : "text-zinc-800 dark:text-zinc-200 hover:bg-[var(--surface-hover)]"
                }`}
              >
                {item.kind === "connection" && <Database className="w-4 h-4 shrink-0" />}
                {item.kind === "object" && <Table2 className="w-4 h-4 shrink-0" />}
                {item.kind === "saved_query" && <FileCode2 className="w-4 h-4 shrink-0" />}
                {item.kind === "action" && <Plus className="w-4 h-4 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{item.label}</div>
                  <div
                    className={`text-[0.8rem] truncate ${
                      idx === selectedIdx ? "text-blue-100" : "text-zinc-500"
                    }`}
                  >
                    {item.subtitle}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
