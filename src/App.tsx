import React, { useEffect } from "react";
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
    openTab,
    activeConnectionId,
    setCommandPaletteOpen,
    bootstrap,
  } = useWorkbenchStore();

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

  return (
    <div className="h-screen w-screen flex flex-col bg-white dark:bg-[#1e1f22] text-zinc-900 dark:text-zinc-100 overflow-hidden">
      <NavicatToolbar />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {leftSidebarOpen && <ObjectExplorer />}

        <main className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          <div className="h-9 px-1.5 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-100 dark:bg-[#25262a] flex items-end gap-0.5 overflow-x-auto select-none">
            {tabs.map((t) => {
              const isActive = t.id === activeTab?.id;
              return (
                <div
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={`group h-8 px-3 rounded-t-md text-xs flex items-center gap-1.5 cursor-pointer shrink-0 transition border-t border-x ${
                    isActive
                      ? "bg-white dark:bg-[#1e1f22] text-zinc-900 dark:text-zinc-100 border-zinc-300 dark:border-[#35373c] font-semibold -mb-px pb-px"
                      : "border-transparent text-zinc-500 hover:bg-zinc-200/70 dark:hover:bg-[#2d2f34]"
                  }`}
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
                  {t.id !== "objects" && (
                    <button
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
              );
            })}
          </div>

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
    </div>
  );
}

export default App;
