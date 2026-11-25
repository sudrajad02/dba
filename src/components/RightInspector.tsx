import React, { useState } from "react";
import { Braces, Copy, FileCode2, Info, Sparkles, X } from "lucide-react";
import { useWorkbenchStore } from "../store/useWorkbenchStore";

export const RightInspector: React.FC = () => {
  const {
    inspectedCell,
    inspectedTableMeta,
    snippets,
    openTab,
    activeConnectionId,
    toggleRightInspector,
    addLog,
  } = useWorkbenchStore();

  const [tab, setTab] = useState<"cell" | "meta" | "snippets">("cell");

  const renderCellContent = () => {
    if (!inspectedCell) {
      return (
        <div className="p-4 text-zinc-500 text-xs">
          Click any cell in Data Viewer or Query Results to inspect JSON, long text, or binary hex.
        </div>
      );
    }

    let formatted = "";
    let isJson = false;
    const raw = inspectedCell.value;
    if (raw === null || raw === undefined) {
      formatted = "NULL";
    } else if (typeof raw === "object") {
      formatted = JSON.stringify(raw, null, 2);
      isJson = true;
    } else {
      const str = String(raw);
      if (
        (str.startsWith("{") && str.endsWith("}")) ||
        (str.startsWith("[") && str.endsWith("]"))
      ) {
        try {
          formatted = JSON.stringify(JSON.parse(str), null, 2);
          isJson = true;
        } catch {
          formatted = str;
        }
      } else {
        formatted = str;
      }
    }

    return (
      <div className="p-3 space-y-2.5 text-xs">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold text-zinc-900 dark:text-zinc-100">
              {inspectedCell.column}
            </div>
            <div className="text-[0.72rem] font-mono text-zinc-500">
              {inspectedCell.dataType} {isJson ? "• JSON" : ""}
            </div>
          </div>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(formatted);
              addLog("info", `Copied value of "${inspectedCell.column}"`);
            }}
            className="h-6 px-2 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-1 text-[0.8rem]"
          >
            <Copy className="w-3 h-3" /> Copy
          </button>
        </div>
        <pre className="p-2.5 rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 font-mono text-[0.8rem] overflow-auto max-h-[calc(100vh-220px)] whitespace-pre-wrap break-all">
          {formatted}
        </pre>
      </div>
    );
  };

  return (
    <aside className="w-72 shrink-0 h-full flex flex-col border-l border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/70">
      <div className="h-9 px-2 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-1 text-xs">
        <button
          onClick={() => setTab("cell")}
          className={`h-7 px-2 rounded flex items-center gap-1 ${
            tab === "cell"
              ? "bg-indigo-600/20 text-indigo-400 font-medium"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <Braces className="w-3.5 h-3.5" /> Cell
        </button>
        <button
          onClick={() => setTab("meta")}
          className={`h-7 px-2 rounded flex items-center gap-1 ${
            tab === "meta"
              ? "bg-indigo-600/20 text-indigo-400 font-medium"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <Info className="w-3.5 h-3.5" /> Schema
        </button>
        <button
          onClick={() => setTab("snippets")}
          className={`h-7 px-2 rounded flex items-center gap-1 ${
            tab === "snippets"
              ? "bg-indigo-600/20 text-indigo-400 font-medium"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" /> Snippets
        </button>

        <button
          onClick={toggleRightInspector}
          title="Close Inspector Panel"
          className="ml-auto p-1 rounded text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {tab === "cell" && renderCellContent()}

        {tab === "meta" && (
          <div className="p-3 space-y-3 text-xs">
            {!inspectedTableMeta ? (
              <div className="text-zinc-500">
                Open a table to inspect its columns, indexes, and foreign keys.
              </div>
            ) : (
              <>
                <div>
                  <div className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {inspectedTableMeta.name}
                  </div>
                  <div className="text-[0.8rem] text-zinc-500">
                    {inspectedTableMeta.columns.length} columns • {inspectedTableMeta.indexes.length} indexes • {inspectedTableMeta.foreignKeys.length} FKs
                  </div>
                </div>
                <div className="space-y-1">
                  {inspectedTableMeta.columns.map((c) => (
                    <div
                      key={c.name}
                      className="px-2 py-1 rounded bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 flex items-center justify-between"
                    >
                      <span className="font-mono truncate">
                        {c.isPrimaryKey ? "🔑 " : ""}
                        {c.name}
                      </span>
                      <span className="text-[0.72rem] font-mono text-zinc-500 ml-2">
                        {c.dataType}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {tab === "snippets" && (
          <div className="p-2.5 space-y-2 text-xs">
            {snippets.map((sn) => (
              <div
                key={sn.id}
                className="p-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 space-y-1.5"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                    {sn.name}
                  </span>
                  <button
                    onClick={() =>
                      openTab({
                        kind: "query",
                        title: sn.name,
                        connectionId: activeConnectionId ?? undefined,
                        sql: sn.body,
                      })
                    }
                    className="h-6 px-2 rounded bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 flex items-center gap-1 text-[0.8rem]"
                  >
                    <FileCode2 className="w-3 h-3" /> Open
                  </button>
                </div>
                <div className="text-[0.8rem] text-zinc-500">{sn.description}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
};
