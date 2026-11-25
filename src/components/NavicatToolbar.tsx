import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeftRight,
  BarChart3,
  Clock,
  Columns2,
  Copy,
  Database,
  Download,
  Eye,
  FileCode2,
  FunctionSquare,
  GitCompare,
  HardDriveDownload,
  Minus,
  Monitor,
  Moon,
  Network,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Plug,
  Rows2,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Table2,
  Wand2,
  Wrench,
  X,
} from "lucide-react";
import { useWorkbenchStore } from "../store/useWorkbenchStore";

interface RibbonButtonProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  badge?: string;
  title?: string;
  onClick?: () => void;
}

const RibbonButton: React.FC<RibbonButtonProps> = ({
  icon,
  label,
  active,
  disabled,
  badge,
  title,
  onClick,
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`relative flex flex-col items-center justify-center gap-1 px-3 py-1.5 min-w-[68px] rounded-md transition select-none ${
      disabled
        ? "opacity-40 cursor-not-allowed"
        : active
        ? "bg-indigo-500/20 text-indigo-400 ring-1 ring-indigo-500/40"
        : "text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200/80 dark:hover:bg-[#35373d] cursor-pointer"
    }`}
  >
    <div className="flex items-center justify-center">{icon}</div>
    <span className="text-[0.7rem] font-medium leading-none whitespace-nowrap">
      {label}
    </span>
    {badge && (
      <span className="absolute top-0.5 right-1 px-1 rounded bg-zinc-700/80 text-[0.55rem] text-zinc-300 font-semibold">
        {badge}
      </span>
    )}
  </button>
);

export const NavicatToolbar: React.FC = () => {
  const {
    connections,
    connectedIds,
    activeConnectionId,
    browserContext,
    setBrowserContext,
    openConnectionModal,
    openTab,
    theme,
    setTheme,
    uiFontSize,
    setUiFontSize,
    leftSidebarOpen,
    rightInspectorOpen,
    bottomDrawerOpen,
    toggleLeftSidebar,
    toggleRightInspector,
    toggleBottomDrawer,
    splitMode,
    setSplitMode,
    setCommandPaletteOpen,
    addLog,
  } = useWorkbenchStore();

  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const isProd = activeConn?.environment === "production";
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      const win = getCurrentWindow();
      win.isMaximized().then(setIsMaximized).catch(() => {});
      win
        .onResized(() => {
          win.isMaximized().then(setIsMaximized).catch(() => {});
        })
        .then((fn) => {
          unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // Running outside Tauri webview (e.g. browser dev preview)
    }
    return () => {
      unlisten?.();
    };
  }, []);

  const handleMinimize = () => {
    try {
      getCurrentWindow().minimize().catch(() => {});
    } catch {}
  };

  const handleToggleMaximize = () => {
    try {
      getCurrentWindow().toggleMaximize().catch(() => {});
    } catch {}
  };

  const handleCloseWindow = () => {
    try {
      getCurrentWindow().close().catch(() => {});
    } catch {}
  };

  const cycleTheme = () => {
    const next = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
    setTheme(next);
  };

  const handleNewQuery = () => {
    if (activeConn?.engine === "mongodb") {
      openTab({
        kind: "mongo_query",
        title: `MQL — ${activeConn.name}`,
        connectionId: activeConn.id,
        database: browserContext.database ?? activeConn.database ?? undefined,
        mongoMode: "mql",
      });
      return;
    }
    openTab({
      kind: "query",
      title: activeConn ? `Query — ${activeConn.name}` : "New Query",
      connectionId: activeConn?.id,
      database: browserContext.database ?? activeConn?.database ?? undefined,
      sql: "-- Write SQL here (Ctrl+Enter to execute)\n",
    });
  };

  const handleNewTable = () => {
    if (!activeConn || !connectedIds.has(activeConn.id)) {
      openConnectionModal(null);
      return;
    }
    if (activeConn.engine === "mongodb") {
      openTab({
        kind: "mongo_query",
        title: `Pipeline — ${activeConn.name}`,
        connectionId: activeConn.id,
        database: browserContext.database ?? activeConn.database ?? undefined,
        mongoMode: "pipeline",
      });
      return;
    }
    openTab({
      kind: "designer",
      title: "New Table",
      connectionId: activeConn.id,
      database: browserContext.database ?? activeConn.database ?? undefined,
      schema:
        browserContext.schema ??
        (activeConn.engine === "postgres"
          ? "public"
          : activeConn.engine === "mssql"
          ? "dbo"
          : activeConn.database ?? undefined),
      isNewTable: true,
    });
  };

  const notifyPhase = (feature: string, phase: string) => {
    addLog("info", `${feature} is scheduled for ${phase} (PRD Roadmap).`);
  };

  return (
    <header className="flex flex-col shrink-0 select-none">
      {isProd && (
        <div className="h-6 px-3 bg-red-600 text-white text-[0.75rem] font-semibold tracking-wide flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>
              PRODUCTION: {activeConn.name} ({activeConn.host}:{activeConn.port})
            </span>
          </div>
          <span className="uppercase opacity-90">
            {activeConn.readOnly ? "Read-Only Enforced" : "Safety Guard Active"}
          </span>
        </div>
      )}

      {/* Tier 1: Compact Utility & Status Bar */}
      <div
        data-tauri-drag-region
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input, select")) return;
          handleToggleMaximize();
        }}
        className="h-8 pl-2.5 pr-1 flex items-center justify-between border-b border-zinc-200 dark:border-[#32343a] bg-zinc-100 dark:bg-[#1e1f22] text-xs"
      >
        <div data-tauri-drag-region className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 font-bold text-zinc-900 dark:text-zinc-100">
            <Database className="w-4 h-4 text-sky-400" />
            <span>DBa</span>
          </div>
          {activeConn && (
            <div className="flex items-center gap-1.5 pl-2 border-l border-zinc-300 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400">
              <span className="font-medium text-zinc-800 dark:text-zinc-200">
                {activeConn.name}
              </span>
              {browserContext.database && (
                <>
                  <span>/</span>
                  <span className="text-sky-500 dark:text-sky-400 font-mono">
                    {browserContext.database}
                  </span>
                </>
              )}
              {browserContext.schema &&
                browserContext.schema !== browserContext.database && (
                  <>
                    <span>/</span>
                    <span className="font-mono">{browserContext.schema}</span>
                  </>
                )}
              {activeConn.readOnly && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-sky-500/15 text-sky-500 dark:text-sky-400 text-[0.68rem] font-semibold">
                  <ShieldCheck className="w-3 h-3" /> RO
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setCommandPaletteOpen(true)}
            className="h-6 px-2.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#26282c] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 flex items-center gap-2 cursor-pointer"
          >
            <Search className="w-3 h-3" />
            <span>Quick Jump...</span>
            <kbd className="text-[0.65rem] px-1 rounded bg-zinc-200 dark:bg-zinc-800">
              Ctrl+K
            </kbd>
          </button>

          <div className="flex items-center rounded border border-zinc-300 dark:border-[#3b3d44] overflow-hidden">
            <button
              onClick={() => setUiFontSize(uiFontSize - 1)}
              title="Decrease UI Font Size"
              className="h-6 px-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300"
            >
              A-
            </button>
            <span className="px-1 text-[0.68rem] font-mono text-zinc-500">
              {uiFontSize}
            </span>
            <button
              onClick={() => setUiFontSize(uiFontSize + 1)}
              title="Increase UI Font Size"
              className="h-6 px-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300"
            >
              A+
            </button>
          </div>

          <button
            onClick={() =>
              setSplitMode(splitMode === "vertical" ? "none" : "vertical")
            }
            title="Split Side-by-Side"
            className={`p-1 rounded ${
              splitMode === "vertical"
                ? "bg-indigo-500/20 text-indigo-500 dark:text-indigo-400"
                : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
            }`}
          >
            <Columns2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() =>
              setSplitMode(splitMode === "horizontal" ? "none" : "horizontal")
            }
            title="Split Top-Bottom"
            className={`p-1 rounded ${
              splitMode === "horizontal"
                ? "bg-indigo-500/20 text-indigo-500 dark:text-indigo-400"
                : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
            }`}
          >
            <Rows2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={cycleTheme}
            title={`Theme: ${theme}`}
            className="p-1 rounded text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
          >
            {theme === "dark" ? (
              <Moon className="w-3.5 h-3.5" />
            ) : theme === "light" ? (
              <Sun className="w-3.5 h-3.5" />
            ) : (
              <Monitor className="w-3.5 h-3.5" />
            )}
          </button>

          <div className="w-px h-3.5 bg-zinc-300 dark:bg-zinc-700 mx-0.5" />

          <button
            onClick={toggleLeftSidebar}
            title="Toggle Navigation Pane"
            className={`p-1 rounded ${
              leftSidebarOpen
                ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-white"
                : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
            }`}
          >
            <PanelLeft className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={toggleBottomDrawer}
            title="Toggle Console & History"
            className={`p-1 rounded ${
              bottomDrawerOpen
                ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-white"
                : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
            }`}
          >
            <PanelBottom className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={toggleRightInspector}
            title="Toggle Information Pane"
            className={`p-1 rounded ${
              rightInspectorOpen
                ? "bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-white"
                : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
            }`}
          >
            <PanelRight className="w-3.5 h-3.5" />
          </button>

          <div className="w-px h-3.5 bg-zinc-300 dark:bg-zinc-700 mx-1" />

          {/* Window Controls */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleMinimize}
              title="Minimize"
              aria-label="Minimize window"
              className="h-6 w-7 flex items-center justify-center rounded text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition cursor-pointer"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleToggleMaximize}
              title={isMaximized ? "Restore" : "Maximize"}
              aria-label={isMaximized ? "Restore window" : "Maximize window"}
              className="h-6 w-7 flex items-center justify-center rounded text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition cursor-pointer"
            >
              {isMaximized ? (
                <Copy className="w-3 h-3" />
              ) : (
                <Square className="w-3 h-3" />
              )}
            </button>
            <button
              onClick={handleCloseWindow}
              title="Close"
              aria-label="Close window"
              className="h-6 w-7 flex items-center justify-center rounded text-zinc-600 dark:text-zinc-300 hover:bg-red-500 hover:text-white transition cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Tier 2: Iconic Navicat Ribbon Toolbar */}
      <div className="px-2 py-1 flex items-center gap-0.5 overflow-x-auto border-b border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#25262a]">
        <RibbonButton
          icon={<Plug className="w-5 h-5 text-emerald-500 dark:text-emerald-400" />}
          label="Connection"
          title="New Database Connection"
          onClick={() => openConnectionModal(null)}
        />
        <RibbonButton
          icon={<FileCode2 className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />}
          label="New Query"
          title="New SQL Query (Ctrl+T)"
          onClick={handleNewQuery}
        />

        <div className="w-px h-9 bg-zinc-300 dark:bg-[#3a3c42] mx-1.5" />

        <RibbonButton
          icon={<Table2 className="w-5 h-5 text-sky-500 dark:text-sky-400" />}
          label="Table"
          active={browserContext.category === "table"}
          title="Show Tables in Objects Pane"
          onClick={() => setBrowserContext({ category: "table" }, true)}
        />
        <RibbonButton
          icon={<Eye className="w-5 h-5 text-purple-500 dark:text-purple-400" />}
          label="View"
          active={browserContext.category === "view"}
          title="Show Views in Objects Pane"
          onClick={() => setBrowserContext({ category: "view" }, true)}
        />
        <RibbonButton
          icon={<FunctionSquare className="w-5 h-5 text-amber-500 dark:text-amber-400" />}
          label="Function"
          active={browserContext.category === "function"}
          title="Show Functions & Procedures"
          onClick={() => setBrowserContext({ category: "function" }, true)}
        />
        <RibbonButton
          icon={<Wrench className="w-5 h-5 text-cyan-500 dark:text-cyan-400" />}
          label="New Table"
          title="Open GUI Table Designer"
          onClick={handleNewTable}
        />

        <div className="w-px h-9 bg-zinc-300 dark:bg-[#3a3c42] mx-1.5" />

        <RibbonButton
          icon={<Download className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />}
          label="Import/Export"
          title="Import / Export Wizard (CSV, JSON, Excel .xlsx, SQL)"
          onClick={() =>
            openTab({
              kind: "import_export",
              title: "Import / Export",
              connectionId: activeConn?.id,
              database: browserContext.database ?? activeConn?.database ?? undefined,
              schema: browserContext.schema ?? undefined,
              wizardMode: "export",
            })
          }
        />
        <RibbonButton
          icon={<ArrowLeftRight className="w-5 h-5 text-teal-500 dark:text-teal-400" />}
          label="Transfer"
          title="Same-Engine & Cross-Engine Data Transfer Wizard"
          onClick={() =>
            openTab({
              kind: "data_transfer",
              title: "Data Transfer",
              connectionId: activeConn?.id,
              database: browserContext.database ?? activeConn?.database ?? undefined,
              schema: browserContext.schema ?? undefined,
            })
          }
        />
        <RibbonButton
          icon={<HardDriveDownload className="w-5 h-5 text-blue-500 dark:text-blue-400" />}
          label="Backup"
          title="SQL Dump, Execute SQL File & Native CLI Backup/Restore"
          onClick={() =>
            openTab({
              kind: "dump_backup",
              title: "Dump & Backup",
              connectionId: activeConn?.id,
              database: browserContext.database ?? activeConn?.database ?? undefined,
              schema: browserContext.schema ?? undefined,
              wizardMode: "dump",
            })
          }
        />
        <RibbonButton
          icon={<GitCompare className="w-5 h-5 text-orange-500 dark:text-orange-400" />}
          label="Sync"
          title="Structure & Data Synchronization"
          onClick={() =>
            openTab({
              kind: "sync",
              title: "Structure & Data Sync",
              connectionId: activeConn?.id,
              database: browserContext.database ?? activeConn?.database ?? undefined,
              schema: browserContext.schema ?? undefined,
              wizardMode: "structure_sync",
            })
          }
        />
        <RibbonButton
          icon={<Network className="w-5 h-5 text-pink-500 dark:text-pink-400" />}
          label="Model"
          title="Visual ER Diagram & Data Modeling"
          onClick={() =>
            openTab({
              kind: "er_model",
              title: "ER Diagram",
              connectionId: activeConn?.id,
              database: browserContext.database ?? activeConn?.database ?? undefined,
              schema: browserContext.schema ?? undefined,
            })
          }
        />
        <RibbonButton
          icon={<Wand2 className="w-5 h-5 text-violet-500 dark:text-violet-400" />}
          label="Query Builder"
          title="Visual Query Builder (Tables, JOINs, Live SQL)"
          onClick={() =>
            openTab({
              kind: "query_builder",
              title: "Query Builder",
              connectionId: activeConn?.id,
              database: browserContext.database ?? activeConn?.database ?? undefined,
              schema: browserContext.schema ?? undefined,
            })
          }
        />
        <RibbonButton
          icon={<Clock className="w-5 h-5 text-lime-500 dark:text-lime-400" />}
          label="Automation"
          title="Batch Jobs & Scheduled Automation via systemd --user"
          onClick={() =>
            openTab({
              kind: "automation",
              title: "Automation",
              connectionId: activeConn?.id,
              database: browserContext.database ?? activeConn?.database ?? undefined,
            })
          }
        />
        <RibbonButton
          icon={<BarChart3 className="w-5 h-5 text-cyan-500 dark:text-cyan-400" />}
          label="Charts"
          title="Multi-Chart Analytics Dashboard Builder"
          onClick={() =>
            openTab({
              kind: "charts",
              title: "Charts Dashboard",
              connectionId: activeConn?.id,
              database: browserContext.database ?? activeConn?.database ?? undefined,
            })
          }
        />
        <RibbonButton
          icon={<Sparkles className="w-5 h-5 text-amber-500 dark:text-amber-400" />}
          label="Data Gen"
          title="FK-Aware Dummy / Mock Data Generation Engine"
          onClick={() =>
            openTab({
              kind: "data_gen",
              title: "Data Generator",
              connectionId: activeConn?.id,
              database: browserContext.database ?? activeConn?.database ?? undefined,
              schema: browserContext.schema ?? undefined,
            })
          }
        />
      </div>
    </header>
  );
};
