import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  BarChart3,
  Braces,
  Clock,
  Database,
  Download,
  FileCode2,
  GitCompare,
  HardDriveDownload,
  Layers,
  Network,
  Sparkles,
  Table2,
  Wand2,
  Wrench,
  X,
} from "lucide-react";
import { AutomationWorkbench } from "./components/AutomationWorkbench";
import { BottomDrawer } from "./components/BottomDrawer";
import { ChartDashboardBuilder } from "./components/ChartDashboardBuilder";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectionModal } from "./components/ConnectionModal";
import { DataGenWizard } from "./components/DataGenWizard";
import { DataTransferWizard } from "./components/DataTransferWizard";
import { DataViewer } from "./components/DataViewer";
import { DumpBackupWizard } from "./components/DumpBackupWizard";
import { ErDiagramDesigner } from "./components/ErDiagramDesigner";
import { ImportExportWizard } from "./components/ImportExportWizard";
import { MongoCollectionDesigner } from "./components/MongoCollectionDesigner";
import { MongoQueryEditor } from "./components/MongoQueryEditor";
import { MongoViewer } from "./components/MongoViewer";
import { NavicatToolbar } from "./components/NavicatToolbar";
import { ObjectExplorer } from "./components/ObjectExplorer";
import { ObjectsBrowser } from "./components/ObjectsBrowser";
import { QueryEditor } from "./components/QueryEditor";
import { RightInspector } from "./components/RightInspector";
import { SafetyConfirmModal } from "./components/SafetyConfirmModal";
import { SyncWizard } from "./components/SyncWizard";
import { TableDesigner } from "./components/TableDesigner";
import { ToastContainer } from "./components/ToastContainer";
import { VisualQueryBuilder } from "./components/VisualQueryBuilder";
import { useWorkbenchStore, type WorkbenchTab } from "./store/useWorkbenchStore";

const TabContent: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
  switch (tab.kind) {
    case "table":
      return <DataViewer tab={tab} />;
    case "query":
      return <QueryEditor tab={tab} />;
    case "designer":
      return <TableDesigner tab={tab} />;
    case "mongo_collection":
      return <MongoViewer tab={tab} />;
    case "mongo_query":
      return <MongoQueryEditor tab={tab} />;
    case "mongo_designer":
      return <MongoCollectionDesigner tab={tab} />;
    case "import_export":
      return <ImportExportWizard tab={tab} />;
    case "dump_backup":
      return <DumpBackupWizard tab={tab} />;
    case "data_transfer":
      return <DataTransferWizard tab={tab} />;
    case "sync":
      return <SyncWizard tab={tab} />;
    case "er_model":
      return <ErDiagramDesigner tab={tab} />;
    case "query_builder":
      return <VisualQueryBuilder tab={tab} />;
    case "automation":
      return <AutomationWorkbench tab={tab} />;
    case "charts":
      return <ChartDashboardBuilder tab={tab} />;
    case "data_gen":
      return <DataGenWizard tab={tab} />;
    default:
      return <ObjectsBrowser />;
  }
};

export function App() {
  const {
    theme,
    uiFontSize,
    leftSidebarOpen,
    rightInspectorOpen,
    tabs,
    activeTabId,
    secondaryTabId,
    splitMode,
    setActiveTab,
    setSecondaryTab,
    closeTab,
    reorderTabs,
    closeOtherTabs,
    closeTabsToRight,
    closeAllTabs,
    openTab,
    connections,
    activeConnectionId,
    setCommandPaletteOpen,
    bootstrap,
  } = useWorkbenchStore();

  // Chrome-like tab drag-and-drop & context menu state
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  const tabElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const suppressClickRef = useRef(false);
  const [dragState, setDragState] = useState<{
    draggingId: string;
    insertBeforeIdx: number;
  } | null>(null);
  const [tabCtxMenu, setTabCtxMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
  } | null>(null);
  const tabCtxMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!tabCtxMenu) return;
    const onOutside = (e: MouseEvent) => {
      if (tabCtxMenuRef.current && !tabCtxMenuRef.current.contains(e.target as Node)) {
        setTabCtxMenu(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTabCtxMenu(null);
    };
    window.addEventListener("mousedown", onOutside);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onOutside);
      window.removeEventListener("keydown", onKey);
    };
  }, [tabCtxMenu]);

  const handleTabPointerDown = (e: React.PointerEvent<HTMLDivElement>, tabId: string) => {
    if (e.button !== 0 || tabId === "objects") return;
    if ((e.target as HTMLElement).closest("button")) return;

    const startX = e.clientX;
    const startY = e.clientY;
    let isDragging = false;
    let latestInsertIdx = tabs.findIndex((t) => t.id === tabId);
    let scrollRaf: number | null = null;
    let lastClientX = startX;

    const computeInsertBeforeIdx = (clientX: number): number => {
      // Index 0 ("objects") is always pinned; valid insertion slots are 1..tabs.length
      for (let i = 1; i < tabs.length; i++) {
        const el = tabElsRef.current.get(tabs[i].id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const midX = rect.left + rect.width / 2;
        if (clientX < midX) {
          return i;
        }
      }
      return tabs.length;
    };

    const tickAutoScroll = () => {
      const bar = tabBarRef.current;
      if (!bar || !isDragging) {
        scrollRaf = null;
        return;
      }
      const rect = bar.getBoundingClientRect();
      const edge = 36;
      if (lastClientX < rect.left + edge) {
        bar.scrollLeft -= 8;
      } else if (lastClientX > rect.right - edge) {
        bar.scrollLeft += 8;
      }
      scrollRaf = window.requestAnimationFrame(tickAutoScroll);
    };

    const onPointerMove = (ev: PointerEvent) => {
      lastClientX = ev.clientX;
      if (!isDragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
        isDragging = true;
        if (scrollRaf === null) {
          scrollRaf = window.requestAnimationFrame(tickAutoScroll);
        }
      }
      latestInsertIdx = computeInsertBeforeIdx(ev.clientX);
      setDragState({ draggingId: tabId, insertBeforeIdx: latestInsertIdx });
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      if (scrollRaf !== null) {
        window.cancelAnimationFrame(scrollRaf);
        scrollRaf = null;
      }
      setDragState(null);
    };

    const onPointerUp = () => {
      if (isDragging) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        const fromIdx = tabs.findIndex((t) => t.id === tabId);
        if (fromIdx > 0) {
          const toIndex =
            latestInsertIdx > fromIdx ? latestInsertIdx - 1 : latestInsertIdx;
          reorderTabs(tabId, Math.max(1, toIndex));
        }
      }
      cleanup();
    };

    const onPointerCancel = () => {
      cleanup();
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  };

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    document.documentElement.style.setProperty("--dv-root-font-size", `${uiFontSize}px`);
  }, [uiFontSize]);

  useEffect(() => {
    const root = document.documentElement;
    const apply = (dark: boolean) => {
      root.classList.toggle("dark", dark);
    };
    if (theme === "dark") apply(true);
    else if (theme === "light") apply(false);
    else {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      apply(mq.matches);
      const handler = (e: MediaQueryListEvent) => apply(e.matches);
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        setCommandPaletteOpen(true);
      } else if (key === "t") {
        e.preventDefault();
        openTab({
          kind: "query",
          title: "New Query",
          connectionId: activeConnectionId ?? undefined,
          sql: "",
        });
      } else if (key === "w" && activeTabId && activeTabId !== "objects") {
        e.preventDefault();
        closeTab(activeTabId);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setCommandPaletteOpen, openTab, activeConnectionId, activeTabId, closeTab]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const secondaryTab = tabs.find((t) => t.id === secondaryTabId);

  // Detect duplicate table/collection names opened across different databases/connections
  const duplicateObjectTitles = new Map<string, Set<string>>();
  for (const t of tabs) {
    if (t.kind === "table" || t.kind === "mongo_collection") {
      const objName = t.table ?? t.collection ?? t.title;
      const originKey = `${t.connectionId ?? ""}::${t.database ?? ""}::${t.schema ?? ""}`;
      if (!duplicateObjectTitles.has(objName)) {
        duplicateObjectTitles.set(objName, new Set());
      }
      duplicateObjectTitles.get(objName)!.add(originKey);
    }
  }

  const getTabTooltip = (t: WorkbenchTab): string | undefined => {
    if (
      t.kind === "table" ||
      t.kind === "mongo_collection" ||
      t.kind === "designer" ||
      t.kind === "mongo_designer"
    ) {
      const conn = connections.find((c) => c.id === t.connectionId);
      const connLabel = conn?.name ?? t.connectionId ?? "Unknown Connection";
      const dbPart = t.database
        ? t.schema && t.schema !== t.database
          ? `${t.database}.${t.schema}`
          : t.database
        : conn?.database ?? "";
      const objName = t.table ?? t.collection ?? t.title;
      return dbPart ? `${connLabel} / ${dbPart} / ${objName}` : `${connLabel} / ${objName}`;
    }
    return t.title;
  };

  const getTabDbBadge = (t: WorkbenchTab): string | null => {
    if (t.kind !== "table" && t.kind !== "mongo_collection") return null;
    const objName = t.table ?? t.collection ?? t.title;
    const origins = duplicateObjectTitles.get(objName);
    if (!origins || origins.size < 2) return null;
    const conn = connections.find((c) => c.id === t.connectionId);
    const dbName = t.database ?? conn?.database ?? "";
    // Check if same database name exists across multiple connections for this object
    const sameDbDifferentConn = tabs.some(
      (other) =>
        other.id !== t.id &&
        (other.kind === "table" || other.kind === "mongo_collection") &&
        (other.table ?? other.collection ?? other.title) === objName &&
        (other.database ?? "") === dbName &&
        other.connectionId !== t.connectionId
    );
    if (sameDbDifferentConn && conn?.name) {
      return dbName ? `@${conn.name}/${dbName}` : `@${conn.name}`;
    }
    return dbName ? `@${dbName}` : conn?.name ? `@${conn.name}` : null;
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-white dark:bg-[#1e1f22] text-zinc-900 dark:text-zinc-100 overflow-hidden">
      <NavicatToolbar />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {leftSidebarOpen && <ObjectExplorer />}

        <main className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          <div
            ref={tabBarRef}
            className="h-9 px-1.5 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-100 dark:bg-[#25262a] flex items-end gap-0.5 overflow-x-auto select-none relative"
          >
            {tabs.map((t, idx) => {
              const isActive = t.id === activeTab?.id;
              const isDragging = dragState?.draggingId === t.id;
              const showDropBefore =
                dragState !== null &&
                dragState.insertBeforeIdx === idx &&
                idx >= 1;
              const showDropAfterLast =
                dragState !== null &&
                idx === tabs.length - 1 &&
                dragState.insertBeforeIdx === tabs.length;

              return (
                <React.Fragment key={t.id}>
                  {showDropBefore && (
                    <div className="w-0.5 h-7 self-center rounded-full bg-indigo-500 shrink-0 -mx-0.5 z-10 pointer-events-none" />
                  )}
                  <div
                    ref={(el) => {
                      if (el) tabElsRef.current.set(t.id, el);
                      else tabElsRef.current.delete(t.id);
                    }}
                    title={getTabTooltip(t)}
                    onPointerDown={(e) => handleTabPointerDown(e, t.id)}
                    onClick={() => {
                      if (suppressClickRef.current) return;
                      setActiveTab(t.id);
                    }}
                    onMouseDown={(e) => {
                      if (e.button === 1 && t.id !== "objects") {
                        e.preventDefault();
                      }
                    }}
                    onAuxClick={(e) => {
                      if (e.button === 1 && t.id !== "objects") {
                        e.preventDefault();
                        closeTab(t.id);
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const menuW = 192;
                      const menuH = 148;
                      const x = Math.min(e.clientX, window.innerWidth - menuW - 8);
                      const y = Math.min(e.clientY, window.innerHeight - menuH - 8);
                      setTabCtxMenu({ x: Math.max(8, x), y: Math.max(8, y), tabId: t.id });
                    }}
                    className={`group h-8 px-3 rounded-t-md text-xs flex items-center gap-1.5 cursor-pointer shrink-0 transition border-t border-x ${
                      isActive
                        ? "bg-white dark:bg-[#1e1f22] text-zinc-900 dark:text-zinc-100 border-zinc-300 dark:border-[#35373c] font-semibold -mb-px pb-px"
                        : "border-transparent text-zinc-500 hover:bg-zinc-200/70 dark:hover:bg-[#2d2f34]"
                    } ${isDragging ? "opacity-50 scale-[0.98] ring-1 ring-indigo-500/60" : ""}`}
                  >
                    {t.kind === "objects" && <Database className="w-3.5 h-3.5 text-sky-400" />}
                    {t.kind === "table" && <Table2 className="w-3.5 h-3.5 text-sky-400" />}
                    {t.kind === "query" && <FileCode2 className="w-3.5 h-3.5 text-emerald-400" />}
                    {t.kind === "designer" && <Wrench className="w-3.5 h-3.5 text-amber-400" />}
                    {t.kind === "mongo_collection" && <Layers className="w-3.5 h-3.5 text-emerald-400" />}
                    {t.kind === "mongo_query" && <Braces className="w-3.5 h-3.5 text-emerald-400" />}
                    {t.kind === "mongo_designer" && <Wrench className="w-3.5 h-3.5 text-emerald-400" />}
                    {t.kind === "import_export" && <Download className="w-3.5 h-3.5 text-indigo-400" />}
                    {t.kind === "dump_backup" && <HardDriveDownload className="w-3.5 h-3.5 text-blue-400" />}
                    {t.kind === "data_transfer" && <ArrowLeftRight className="w-3.5 h-3.5 text-teal-400" />}
                    {t.kind === "sync" && <GitCompare className="w-3.5 h-3.5 text-orange-400" />}
                    {t.kind === "er_model" && <Network className="w-3.5 h-3.5 text-pink-400" />}
                    {t.kind === "query_builder" && <Wand2 className="w-3.5 h-3.5 text-violet-400" />}
                    {t.kind === "automation" && <Clock className="w-3.5 h-3.5 text-lime-400" />}
                    {t.kind === "charts" && <BarChart3 className="w-3.5 h-3.5 text-cyan-400" />}
                    {t.kind === "data_gen" && <Sparkles className="w-3.5 h-3.5 text-amber-400" />}
                    <span className="max-w-[180px] truncate">
                      {t.title}
                      {t.dirty ? " •" : ""}
                    </span>
                    {(() => {
                      const badge = getTabDbBadge(t);
                      return badge ? (
                        <span className="max-w-[110px] truncate px-1 py-0.2 rounded text-[0.65rem] font-normal bg-zinc-200/80 dark:bg-zinc-700/80 text-zinc-600 dark:text-zinc-300">
                          {badge}
                        </span>
                      ) : null;
                    })()}
                    {t.id !== "objects" && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(t.id);
                        }}
                        className="p-0.5 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 opacity-60 group-hover:opacity-100"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                  {showDropAfterLast && (
                    <div className="w-0.5 h-7 self-center rounded-full bg-indigo-500 shrink-0 -mx-0.5 z-10 pointer-events-none" />
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {tabCtxMenu && (() => {
            const targetIdx = tabs.findIndex((t) => t.id === tabCtxMenu.tabId);
            const isObjects = tabCtxMenu.tabId === "objects";
            const hasClosableOthers = tabs.some(
              (t) => t.id !== "objects" && t.id !== tabCtxMenu.tabId
            );
            const hasTabsToRight = targetIdx !== -1 && targetIdx < tabs.length - 1;
            const hasClosableAny = tabs.some((t) => t.id !== "objects");

            return (
              <div
                ref={tabCtxMenuRef}
                style={{ top: tabCtxMenu.y, left: tabCtxMenu.x }}
                className="fixed z-50 w-48 py-1 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs"
              >
                <button
                  type="button"
                  disabled={isObjects}
                  onClick={() => {
                    closeTab(tabCtxMenu.tabId);
                    setTabCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="button"
                  disabled={!hasClosableOthers}
                  onClick={() => {
                    closeOtherTabs(tabCtxMenu.tabId);
                    setTabCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  Close Others
                </button>
                <button
                  type="button"
                  disabled={!hasTabsToRight}
                  onClick={() => {
                    closeTabsToRight(tabCtxMenu.tabId);
                    setTabCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  Close Tabs to the Right
                </button>
                <div className="my-1 border-t border-zinc-200 dark:border-zinc-800" />
                <button
                  type="button"
                  disabled={!hasClosableAny}
                  onClick={() => {
                    closeAllTabs();
                    setTabCtxMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left text-red-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  Close All
                </button>
              </div>
            );
          })()}

          <div
            className={`flex-1 flex min-h-0 overflow-hidden ${
              splitMode === "horizontal" ? "flex-col" : "flex-row"
            }`}
          >
            <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
              {activeTab && <TabContent key={activeTab.id} tab={activeTab} />}
            </div>

            {splitMode !== "none" && (
              <div
                className={`flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden ${
                  splitMode === "horizontal"
                    ? "border-t border-zinc-300 dark:border-[#35373c]"
                    : "border-l border-zinc-300 dark:border-[#35373c]"
                }`}
              >
                <div className="h-7 px-2 bg-zinc-100 dark:bg-[#25262a] border-b border-zinc-200 dark:border-[#32343a] flex items-center justify-between text-[0.75rem]">
                  <span className="text-zinc-500">Split Pane:</span>
                  <select
                    value={secondaryTabId ?? ""}
                    onChange={(e) => setSecondaryTab(e.target.value || null)}
                    className="h-5 px-1.5 rounded bg-white dark:bg-[#1e1f22] border border-zinc-300 dark:border-[#3b3d44] text-[0.75rem]"
                  >
                    {tabs.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden">
                  {secondaryTab ? (
                    <TabContent key={`split-${secondaryTab.id}`} tab={secondaryTab} />
                  ) : (
                    <div className="h-full flex items-center justify-center text-xs text-zinc-500">
                      Open another tab to compare side-by-side
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <BottomDrawer />
        </main>

        {rightInspectorOpen && <RightInspector />}
      </div>

      <ConnectionModal />
      <CommandPalette />
      <SafetyConfirmModal />
      <ToastContainer />
    </div>
  );
}

export default App;
