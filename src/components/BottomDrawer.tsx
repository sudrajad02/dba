import React, { useState } from "react";
import { Clock, Search, Terminal, Trash2, X } from "lucide-react";
import { useWorkbenchStore } from "../store/useWorkbenchStore";

export const BottomDrawer: React.FC = () => {
  const {
    bottomDrawerOpen,
    bottomDrawerTab,
    bottomDrawerHeight,
    setBottomDrawerTab,
    toggleBottomDrawer,
    consoleLogs,
    clearLogs,
    queryHistory,
    refreshHistory,
    openTab,
  } = useWorkbenchStore();

  const [historySearch, setHistorySearch] = useState("");

  if (!bottomDrawerOpen) return null;

  return (
    <div
      style={{ height: bottomDrawerHeight }}
      className="shrink-0 border-t border-[var(--border-subtle)] bg-[var(--surface-panel)] flex flex-col text-xs"
    >
      <div className="h-8 px-2.5 border-b border-[var(--border-subtle)] flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setBottomDrawerTab("console")}
            className={`h-6 px-2.5 rounded flex items-center gap-1.5 ${
              bottomDrawerTab === "console"
                ? "bg-indigo-600/20 text-indigo-500 dark:text-indigo-400 font-medium"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            Console ({consoleLogs.length})
          </button>
          <button
            onClick={() => {
              setBottomDrawerTab("history");
              refreshHistory(historySearch);
            }}
            className={`h-6 px-2.5 rounded flex items-center gap-1.5 ${
              bottomDrawerTab === "history"
                ? "bg-indigo-600/20 text-indigo-500 dark:text-indigo-400 font-medium"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            Query History ({queryHistory.length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          {bottomDrawerTab === "history" && (
            <div className="relative">
              <Search className="w-3 h-3 text-zinc-500 absolute left-2 top-1/2 -translate-y-1/2" />
              <input
                value={historySearch}
                onChange={(e) => {
                  setHistorySearch(e.target.value);
                  refreshHistory(e.target.value);
                }}
                placeholder="Search history..."
                className="h-6 pl-6 pr-2 w-48 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] text-[0.8rem]"
              />
            </div>
          )}
          {bottomDrawerTab === "console" && (
            <button
              onClick={clearLogs}
              title="Clear Console"
              className="p-1 text-zinc-500 hover:text-zinc-300"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={toggleBottomDrawer}
            className="p-1 text-zinc-500 hover:text-zinc-300"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 font-mono text-[0.8rem]">
        {bottomDrawerTab === "console" ? (
          consoleLogs.length === 0 ? (
            <div className="text-zinc-500 p-2">No console output yet.</div>
          ) : (
            <div className="space-y-1">
              {consoleLogs.map((log) => (
                <div key={log.id} className="flex items-start gap-2">
                  <span className="text-zinc-500 shrink-0">[{log.timestamp}]</span>
                  <span
                    className={
                      log.level === "error"
                        ? "text-red-400"
                        : log.level === "warn"
                        ? "text-amber-400"
                        : log.level === "success"
                        ? "text-emerald-400"
                        : "text-zinc-300"
                    }
                  >
                    {log.message}
                  </span>
                </div>
              ))}
            </div>
          )
        ) : (
          <div className="space-y-1">
            {queryHistory.map((h) => (
              <div
                key={h.id}
                onClick={() =>
                  openTab({
                    kind: "query",
                    title: `History (${h.connectionName})`,
                    connectionId: h.connectionId,
                    database: h.database ?? undefined,
                    sql: h.sql,
                  })
                }
                className="px-2 py-1.5 rounded hover:bg-[var(--surface-hover)] cursor-pointer flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${
                      h.status === "ok" ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  />
                  <span className="text-indigo-500 dark:text-indigo-400 shrink-0">{h.connectionName}</span>
                  <span className="truncate text-zinc-800 dark:text-zinc-200">{h.sql}</span>
                </div>
                <span className="text-zinc-500 shrink-0">
                  {h.durationMs}ms • {new Date(h.executedAt).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
