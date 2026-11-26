import React, { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeftRight,
  BarChart3,
  Check,
  ChevronDown,
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
  Layers,
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
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Table2,
  Wand2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import { ContextMenu } from "./ContextMenu";
import type { DbEngine } from "../types/dba";

type TopMenuKey = "file" | "edit" | "view" | "tools" | "connection" | "ribbon_tools";

interface RibbonButtonProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  hasDropdown?: boolean;
  title?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

const RibbonButton: React.FC<RibbonButtonProps> = ({
  icon,
  label,
  active,
  disabled,
  hasDropdown,
  title,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`relative flex flex-col items-center justify-center gap-0.5 px-2.5 py-1 min-w-[60px] rounded-md transition select-none shrink-0 ${
      disabled
        ? "opacity-40 cursor-not-allowed"
        : active
        ? "bg-indigo-500/20 text-indigo-500 dark:text-indigo-400 ring-1 ring-indigo-500/40"
        : "text-zinc-700 dark:text-zinc-200 hover:bg-[var(--surface-hover)] cursor-pointer"
    }`}
  >
    <div className="flex items-center justify-center">{icon}</div>
    <span className="text-[0.68rem] font-medium leading-tight whitespace-nowrap flex items-center gap-0.5">
      {label}
      {hasDropdown && <ChevronDown className="w-2.5 h-2.5 opacity-70" />}
    </span>
  </button>
);

const ENGINE_OPTIONS: { id: DbEngine; label: string; color: string }[] = [
  { id: "postgres", label: "PostgreSQL", color: "text-sky-500 dark:text-sky-400" },
  { id: "mysql", label: "MySQL / MariaDB", color: "text-teal-500 dark:text-teal-400" },
  { id: "mssql", label: "SQL Server", color: "text-rose-500 dark:text-rose-400" },
  { id: "mongodb", label: "MongoDB", color: "text-emerald-500 dark:text-emerald-400" },
];

export const NavicatToolbar: React.FC = () => {
  const {
    connections,
    connectedIds,
    activeConnectionId,
    activeTabId,
    tabs,
    browserContext,
    setBrowserContext,
    openConnectionModal,
    openTab,
    requestCloseTab,
    requestCloseAllTabs,
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
  } = useWorkbenchStore();

  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const isProd = activeConn?.environment === "production";
  const [isMaximized, setIsMaximized] = useState(false);
  const [openMenu, setOpenMenu] = useState<{
    key: TopMenuKey;
    x: number;
    y: number;
  } | null>(null);
  const ribbonRef = useRef<HTMLDivElement | null>(null);

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

  const openDropdownFromButton = (
    key: TopMenuKey,
    e: React.MouseEvent<HTMLButtonElement>
  ) => {
    e.stopPropagation();
    if (openMenu?.key === key) {
      setOpenMenu(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setOpenMenu({ key, x: rect.left, y: rect.bottom + 2 });
  };

  const handleMenuHoverSwitch = (
    key: "file" | "edit" | "view" | "tools",
    e: React.MouseEvent<HTMLButtonElement>
  ) => {
    if (!openMenu) return;
    if (["file", "edit", "view", "tools"].includes(openMenu.key) && openMenu.key !== key) {
      const rect = e.currentTarget.getBoundingClientRect();
      setOpenMenu({ key, x: rect.left, y: rect.bottom + 2 });
    }
  };

  const dispatchMenuAction = (action: "save" | "save_as" | "format_sql") => {
    window.dispatchEvent(new CustomEvent("dba:menu-action", { detail: { action } }));
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

  const openToolTab = (
    kind:
      | "import_export"
      | "data_transfer"
      | "dump_backup"
      | "sync"
      | "er_model"
      | "query_builder"
      | "automation"
      | "charts"
      | "data_gen"
  ) => {
    const base = {
      connectionId: activeConn?.id,
      database: browserContext.database ?? activeConn?.database ?? undefined,
      schema: browserContext.schema ?? undefined,
    };
    switch (kind) {
      case "import_export":
        openTab({ kind, title: "Import / Export", ...base, wizardMode: "export" });
        break;
      case "data_transfer":
        openTab({ kind, title: "Data Transfer", ...base });
        break;
      case "dump_backup":
        openTab({ kind, title: "Dump & Backup", ...base, wizardMode: "dump" });
        break;
      case "sync":
        openTab({ kind, title: "Structure & Data Sync", ...base, wizardMode: "structure_sync" });
        break;
      case "er_model":
        openTab({ kind, title: "ER Diagram", ...base });
        break;
      case "query_builder":
        openTab({ kind, title: "Query Builder", ...base });
        break;
      case "automation":
        openTab({
          kind,
          title: "Automation",
          connectionId: activeConn?.id,
          database: browserContext.database ?? activeConn?.database ?? undefined,
        });
        break;
      case "charts":
        openTab({
          kind,
          title: "Charts Dashboard",
          connectionId: activeConn?.id,
          database: browserContext.database ?? activeConn?.database ?? undefined,
        });
        break;
      case "data_gen":
        openTab({ kind, title: "Data Generator", ...base });
        break;
    }
  };

  const isObjectsActive = activeTabId === "objects";
  const hasClosableTabs = tabs.some((t) => t.id !== "objects");

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

      {/* Tier 1: Title Bar + Classic Navicat Menu Bar */}
      <div
        data-tauri-drag-region
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input, select")) return;
          handleToggleMaximize();
        }}
        className="h-8 pl-2.5 pr-1 flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-canvas)] text-xs"
      >
        <div data-tauri-drag-region className="flex items-center gap-1.5 min-w-0">
          <div className="flex items-center gap-1.5 font-bold text-zinc-900 dark:text-zinc-100 pr-1.5 shrink-0">
            <Database className="w-4 h-4 text-sky-400" />
            <span>DBa</span>
          </div>

          {/* Classic Menu Bar */}
          <nav className="flex items-center gap-0.5 shrink-0" aria-label="Main menu">
            {(
              [
                { key: "file", label: "File" },
                { key: "edit", label: "Edit" },
                { key: "view", label: "View" },
                { key: "tools", label: "Tools" },
              ] as const
            ).map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={(e) => openDropdownFromButton(item.key, e)}
                onMouseEnter={(e) => handleMenuHoverSwitch(item.key, e)}
                className={`h-6 px-2 rounded text-[0.78rem] transition cursor-pointer ${
                  openMenu?.key === item.key
                    ? "bg-indigo-500/20 text-indigo-500 dark:text-indigo-300 font-medium"
                    : "text-zinc-700 dark:text-zinc-300 hover:bg-[var(--surface-hover)]"
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Active Connection / Database / Schema Breadcrumb */}
          {activeConn && (
            <div className="flex items-center gap-1.5 pl-2 ml-1 border-l border-[var(--border-strong)] text-zinc-500 dark:text-zinc-400 min-w-0 truncate">
              <span className="font-medium text-zinc-800 dark:text-zinc-200 truncate max-w-[160px]">
                {activeConn.name}
              </span>
              {browserContext.database && (
                <>
                  <span>/</span>
                  <span className="text-sky-600 dark:text-sky-400 font-mono truncate max-w-[140px]">
                    {browserContext.database}
                  </span>
                </>
              )}
              {browserContext.schema &&
                browserContext.schema !== browserContext.database && (
                  <>
                    <span>/</span>
                    <span className="font-mono truncate max-w-[100px]">
                      {browserContext.schema}
                    </span>
                  </>
                )}
              {activeConn.readOnly && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-sky-500/15 text-sky-600 dark:text-sky-400 text-[0.68rem] font-semibold shrink-0">
                  <ShieldCheck className="w-3 h-3" /> RO
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setCommandPaletteOpen(true)}
            className="h-6 px-2 rounded border border-[var(--border-strong)] bg-[var(--surface-panel)] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 flex items-center gap-1.5 cursor-pointer"
          >
            <Search className="w-3 h-3" />
            <span className="hidden sm:inline">Quick Jump...</span>
            <kbd className="text-[0.65rem] px-1 rounded bg-[var(--surface-elevated)] text-zinc-500 dark:text-zinc-400">
              Ctrl+K
            </kbd>
          </button>

          <div className="flex items-center rounded border border-[var(--border-strong)] overflow-hidden">
            <button
              type="button"
              onClick={() => setUiFontSize(uiFontSize - 1)}
              title="Decrease UI Font Size"
              className="h-6 px-1.5 hover:bg-[var(--surface-hover)] text-zinc-600 dark:text-zinc-300 cursor-pointer"
            >
              A-
            </button>
            <button
              type="button"
              onClick={() => setUiFontSize(14)}
              title="Reset UI Font Size to 14px"
              className="px-1 text-[0.68rem] font-mono text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 cursor-pointer"
            >
              {uiFontSize}
            </button>
            <button
              type="button"
              onClick={() => setUiFontSize(uiFontSize + 1)}
              title="Increase UI Font Size"
              className="h-6 px-1.5 hover:bg-[var(--surface-hover)] text-zinc-600 dark:text-zinc-300 cursor-pointer"
            >
              A+
            </button>
          </div>

          <button
            type="button"
            onClick={() =>
              setSplitMode(splitMode === "vertical" ? "none" : "vertical")
            }
            title="Split Side-by-Side"
            className={`p-1 rounded cursor-pointer ${
              splitMode === "vertical"
                ? "bg-indigo-500/20 text-indigo-500 dark:text-indigo-400"
                : "text-zinc-500 hover:bg-[var(--surface-hover)]"
            }`}
          >
            <Columns2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() =>
              setSplitMode(splitMode === "horizontal" ? "none" : "horizontal")
            }
            title="Split Top-Bottom"
            className={`p-1 rounded cursor-pointer ${
              splitMode === "horizontal"
                ? "bg-indigo-500/20 text-indigo-500 dark:text-indigo-400"
                : "text-zinc-500 hover:bg-[var(--surface-hover)]"
            }`}
          >
            <Rows2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={cycleTheme}
            title={`Theme: ${theme}`}
            className="p-1 rounded text-zinc-500 hover:bg-[var(--surface-hover)] cursor-pointer"
          >
            {theme === "dark" ? (
              <Moon className="w-3.5 h-3.5" />
            ) : theme === "light" ? (
              <Sun className="w-3.5 h-3.5" />
            ) : (
              <Monitor className="w-3.5 h-3.5" />
            )}
          </button>

          <div className="w-px h-3.5 bg-[var(--border-strong)] mx-0.5" />

          <button
            type="button"
            onClick={toggleLeftSidebar}
            title="Toggle Navigation Pane"
            className={`p-1 rounded cursor-pointer ${
              leftSidebarOpen
                ? "bg-[var(--surface-elevated)] text-zinc-900 dark:text-white"
                : "text-zinc-500 hover:bg-[var(--surface-hover)]"
            }`}
          >
            <PanelLeft className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={toggleBottomDrawer}
            title="Toggle Console & History"
            className={`p-1 rounded cursor-pointer ${
              bottomDrawerOpen
                ? "bg-[var(--surface-elevated)] text-zinc-900 dark:text-white"
                : "text-zinc-500 hover:bg-[var(--surface-hover)]"
            }`}
          >
            <PanelBottom className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={toggleRightInspector}
            title="Toggle Information Pane"
            className={`p-1 rounded cursor-pointer ${
              rightInspectorOpen
                ? "bg-[var(--surface-elevated)] text-zinc-900 dark:text-white"
                : "text-zinc-500 hover:bg-[var(--surface-hover)]"
            }`}
          >
            <PanelRight className="w-3.5 h-3.5" />
          </button>

          <div className="w-px h-3.5 bg-[var(--border-strong)] mx-1" />

          {/* Window Controls */}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={handleMinimize}
              title="Minimize"
              aria-label="Minimize window"
              className="h-6 w-7 flex items-center justify-center rounded text-zinc-600 dark:text-zinc-300 hover:bg-[var(--surface-hover)] transition cursor-pointer"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleToggleMaximize}
              title={isMaximized ? "Restore" : "Maximize"}
              aria-label={isMaximized ? "Restore window" : "Maximize window"}
              className="h-6 w-7 flex items-center justify-center rounded text-zinc-600 dark:text-zinc-300 hover:bg-[var(--surface-hover)] transition cursor-pointer"
            >
              {isMaximized ? (
                <Copy className="w-3 h-3" />
              ) : (
                <Square className="w-3 h-3" />
              )}
            </button>
            <button
              type="button"
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

      {/* Tier 2: Clean Navicat 16/17 Iconic Ribbon Toolbar */}
      <div
        ref={ribbonRef}
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && ribbonRef.current) {
            ribbonRef.current.scrollLeft += e.deltaY;
          }
        }}
        className="px-2 py-1 flex items-center gap-0.5 tab-bar-scroll border-b border-[var(--border-subtle)] bg-[var(--surface-panel)]"
      >
        {/* Group 1: Core */}
        <RibbonButton
          icon={<Plug className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />}
          label="Connection"
          hasDropdown
          active={openMenu?.key === "connection"}
          title="New Database Connection (Choose Engine)"
          onClick={(e) => openDropdownFromButton("connection", e)}
        />
        <RibbonButton
          icon={<FileCode2 className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />}
          label="New Query"
          title="New SQL / MQL Query (Ctrl+T)"
          onClick={handleNewQuery}
        />

        <div className="w-px h-8 bg-[var(--border-strong)] mx-1 shrink-0" />

        {/* Group 2: Object Categories */}
        {(() => {
          const hasActiveDb = Boolean(
            browserContext.connectionId &&
              browserContext.database &&
              connectedIds.has(browserContext.connectionId)
          );
          return (
            <>
              <RibbonButton
                icon={<Table2 className="w-4 h-4 text-sky-500 dark:text-sky-400" />}
                label="Table"
                disabled={!hasActiveDb}
                active={hasActiveDb && isObjectsActive && browserContext.category === "table"}
                title={
                  hasActiveDb
                    ? "Show Tables in Objects Pane"
                    : "Select a database to view Tables"
                }
                onClick={() => hasActiveDb && setBrowserContext({ category: "table" }, true)}
              />
              <RibbonButton
                icon={<Eye className="w-4 h-4 text-purple-500 dark:text-purple-400" />}
                label="View"
                disabled={!hasActiveDb}
                active={hasActiveDb && isObjectsActive && browserContext.category === "view"}
                title={
                  hasActiveDb
                    ? "Show Views in Objects Pane"
                    : "Select a database to view Views"
                }
                onClick={() => hasActiveDb && setBrowserContext({ category: "view" }, true)}
              />
              <RibbonButton
                icon={<FunctionSquare className="w-4 h-4 text-amber-500 dark:text-amber-400" />}
                label="Function"
                disabled={!hasActiveDb}
                active={hasActiveDb && isObjectsActive && browserContext.category === "function"}
                title={
                  hasActiveDb
                    ? "Show Functions & Procedures"
                    : "Select a database to view Functions"
                }
                onClick={() => hasActiveDb && setBrowserContext({ category: "function" }, true)}
              />
              <RibbonButton
                icon={<Zap className="w-4 h-4 text-orange-500 dark:text-orange-400" />}
                label="Trigger"
                disabled={!hasActiveDb}
                active={hasActiveDb && isObjectsActive && browserContext.category === "trigger"}
                title={
                  hasActiveDb
                    ? "Show Triggers in Objects Pane"
                    : "Select a database to view Triggers"
                }
                onClick={() => hasActiveDb && setBrowserContext({ category: "trigger" }, true)}
              />
              <RibbonButton
                icon={<FileCode2 className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />}
                label="Query"
                disabled={!hasActiveDb}
                active={hasActiveDb && isObjectsActive && browserContext.category === "query"}
                title={
                  hasActiveDb
                    ? "Show Saved Queries in Objects Pane"
                    : "Select a database to view Queries"
                }
                onClick={() => hasActiveDb && setBrowserContext({ category: "query" }, true)}
              />
            </>
          );
        })()}

        <div className="w-px h-8 bg-[var(--border-strong)] mx-1 shrink-0" />

        {/* Group 3: Power Tools */}
        <RibbonButton
          icon={<Network className="w-4 h-4 text-pink-500 dark:text-pink-400" />}
          label="Model"
          title="Visual ER Diagram & Data Modeling"
          onClick={() => openToolTab("er_model")}
        />
        <RibbonButton
          icon={<HardDriveDownload className="w-4 h-4 text-blue-500 dark:text-blue-400" />}
          label="Backup"
          title="SQL Dump, Execute SQL File & Native CLI Backup/Restore"
          onClick={() => openToolTab("dump_backup")}
        />
        <RibbonButton
          icon={<GitCompare className="w-4 h-4 text-orange-500 dark:text-orange-400" />}
          label="Sync"
          title="Structure & Data Synchronization"
          onClick={() => openToolTab("sync")}
        />
        <RibbonButton
          icon={<ArrowLeftRight className="w-4 h-4 text-teal-500 dark:text-teal-400" />}
          label="Transfer"
          title="Same-Engine & Cross-Engine Data Transfer Wizard"
          onClick={() => openToolTab("data_transfer")}
        />
        <RibbonButton
          icon={<Download className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />}
          label="Import/Export"
          title="Import / Export Wizard (CSV, JSON, Excel .xlsx, SQL)"
          onClick={() => openToolTab("import_export")}
        />
        <RibbonButton
          icon={<Wrench className="w-4 h-4 text-cyan-500 dark:text-cyan-400" />}
          label="Tools"
          hasDropdown
          active={openMenu?.key === "ribbon_tools"}
          title="More Power Tools (Query Builder, Charts, Automation, Data Generator)"
          onClick={(e) => openDropdownFromButton("ribbon_tools", e)}
        />
      </div>

      {/* Dropdown Menus via Shared Portal ContextMenu */}
      {openMenu && (
        <ContextMenu
          x={openMenu.x}
          y={openMenu.y}
          onClose={() => setOpenMenu(null)}
          className="w-56"
        >
          {openMenu.key === "connection" && (
            <>
              <div className="px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-wider text-zinc-500">
                New Connection
              </div>
              {ENGINE_OPTIONS.map((eng) => (
                <button
                  key={eng.id}
                  type="button"
                  onClick={() => {
                    openConnectionModal(null, eng.id);
                    setOpenMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
                >
                  {eng.id === "mongodb" ? (
                    <Layers className={`w-3.5 h-3.5 ${eng.color}`} />
                  ) : eng.id === "mssql" ? (
                    <Server className={`w-3.5 h-3.5 ${eng.color}`} />
                  ) : (
                    <Database className={`w-3.5 h-3.5 ${eng.color}`} />
                  )}
                  <span>{eng.label}</span>
                </button>
              ))}
            </>
          )}

          {openMenu.key === "ribbon_tools" && (
            <>
              <button
                type="button"
                onClick={() => {
                  openToolTab("query_builder");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <Wand2 className="w-3.5 h-3.5 text-violet-400" />
                <span>Visual Query Builder</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  openToolTab("charts");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <BarChart3 className="w-3.5 h-3.5 text-cyan-400" />
                <span>Charts Dashboard</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  openToolTab("automation");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <Clock className="w-3.5 h-3.5 text-lime-400" />
                <span>Automation</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  openToolTab("data_gen");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>Data Generator</span>
              </button>
            </>
          )}

          {openMenu.key === "file" && (
            <>
              <div className="px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-wider text-zinc-500">
                New Connection
              </div>
              {ENGINE_OPTIONS.map((eng) => (
                <button
                  key={eng.id}
                  type="button"
                  onClick={() => {
                    openConnectionModal(null, eng.id);
                    setOpenMenu(null);
                  }}
                  className="w-full pl-5 pr-3 py-1 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
                >
                  <Database className={`w-3.5 h-3.5 ${eng.color}`} />
                  <span>{eng.label}</span>
                </button>
              ))}
              <div className="my-1 border-t border-[var(--border-subtle)]" />
              <button
                type="button"
                onClick={() => {
                  handleNewQuery();
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>New Query</span>
                <span className="text-[0.68rem] text-zinc-500 font-mono">Ctrl+T</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  dispatchMenuAction("save");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Save</span>
                <span className="text-[0.68rem] text-zinc-500 font-mono">Ctrl+S</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  dispatchMenuAction("save_as");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Save As...</span>
              </button>
              <div className="my-1 border-t border-[var(--border-subtle)]" />
              <button
                type="button"
                disabled={!activeTabId || activeTabId === "objects"}
                onClick={() => {
                  if (activeTabId && activeTabId !== "objects") {
                    requestCloseTab(activeTabId);
                  }
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-between cursor-pointer"
              >
                <span>Close Tab</span>
                <span className="text-[0.68rem] text-zinc-500 font-mono">Ctrl+W</span>
              </button>
              <button
                type="button"
                disabled={!hasClosableTabs}
                onClick={() => {
                  requestCloseAllTabs();
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                Close All Tabs
              </button>
              <div className="my-1 border-t border-[var(--border-subtle)]" />
              <button
                type="button"
                onClick={() => {
                  setOpenMenu(null);
                  handleCloseWindow();
                }}
                className="w-full px-3 py-1.5 text-left text-red-500 hover:bg-red-500/10 cursor-pointer"
              >
                Exit
              </button>
            </>
          )}

          {openMenu.key === "edit" && (
            <>
              <button
                type="button"
                onClick={() => {
                  document.execCommand("cut");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Cut</span>
                <span className="text-[0.68rem] text-zinc-500 font-mono">Ctrl+X</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  document.execCommand("copy");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Copy</span>
                <span className="text-[0.68rem] text-zinc-500 font-mono">Ctrl+C</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  document.execCommand("paste");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Paste</span>
                <span className="text-[0.68rem] text-zinc-500 font-mono">Ctrl+V</span>
              </button>
              <div className="my-1 border-t border-[var(--border-subtle)]" />
              <button
                type="button"
                onClick={() => {
                  dispatchMenuAction("format_sql");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Format SQL</span>
                <span className="text-[0.68rem] text-zinc-500 font-mono">Ctrl+Shift+F</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setCommandPaletteOpen(true);
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Find / Quick Jump...</span>
                <span className="text-[0.68rem] text-zinc-500 font-mono">Ctrl+K</span>
              </button>
            </>
          )}

          {openMenu.key === "view" && (
            <>
              <button
                type="button"
                onClick={() => {
                  toggleLeftSidebar();
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Navigation Pane</span>
                {leftSidebarOpen && <Check className="w-3.5 h-3.5 text-indigo-400" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  toggleRightInspector();
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Information Pane</span>
                {rightInspectorOpen && <Check className="w-3.5 h-3.5 text-indigo-400" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  toggleBottomDrawer();
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Console & History Drawer</span>
                {bottomDrawerOpen && <Check className="w-3.5 h-3.5 text-indigo-400" />}
              </button>
              <div className="my-1 border-t border-[var(--border-subtle)]" />
              <button
                type="button"
                onClick={() => {
                  setSplitMode(splitMode === "vertical" ? "none" : "vertical");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Split Side-by-Side</span>
                {splitMode === "vertical" && <Check className="w-3.5 h-3.5 text-indigo-400" />}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSplitMode(splitMode === "horizontal" ? "none" : "horizontal");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Split Top-Bottom</span>
                {splitMode === "horizontal" && <Check className="w-3.5 h-3.5 text-indigo-400" />}
              </button>
              <div className="my-1 border-t border-[var(--border-subtle)]" />
              <div className="px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-wider text-zinc-500">
                Theme
              </div>
              {(["dark", "light", "system"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setTheme(mode);
                    setOpenMenu(null);
                  }}
                  className="w-full pl-5 pr-3 py-1 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between capitalize cursor-pointer"
                >
                  <span>{mode}</span>
                  {theme === mode && <Check className="w-3.5 h-3.5 text-indigo-400" />}
                </button>
              ))}
              <div className="my-1 border-t border-[var(--border-subtle)]" />
              <button
                type="button"
                onClick={() => setUiFontSize(uiFontSize + 1)}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Zoom In</span>
                <span className="text-[0.68rem] text-zinc-500 font-mono">A+</span>
              </button>
              <button
                type="button"
                onClick={() => setUiFontSize(uiFontSize - 1)}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Zoom Out</span>
                <span className="text-[0.68rem] text-zinc-500 font-mono">A-</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setUiFontSize(14);
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center justify-between cursor-pointer"
              >
                <span>Reset Zoom (14px)</span>
                <span className="text-[0.68rem] text-zinc-500 font-mono">{uiFontSize}px</span>
              </button>
            </>
          )}

          {openMenu.key === "tools" && (
            <>
              <button
                type="button"
                onClick={() => {
                  openToolTab("data_transfer");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <ArrowLeftRight className="w-3.5 h-3.5 text-teal-400" />
                <span>Data Transfer</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  openToolTab("sync");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <GitCompare className="w-3.5 h-3.5 text-orange-400" />
                <span>Structure & Data Sync</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  openToolTab("dump_backup");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <HardDriveDownload className="w-3.5 h-3.5 text-blue-400" />
                <span>Dump & Backup</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  openToolTab("import_export");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-indigo-400" />
                <span>Import / Export</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  openToolTab("er_model");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <Network className="w-3.5 h-3.5 text-pink-400" />
                <span>ER Diagram Model</span>
              </button>
              <div className="my-1 border-t border-[var(--border-subtle)]" />
              <button
                type="button"
                onClick={() => {
                  openToolTab("query_builder");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <Wand2 className="w-3.5 h-3.5 text-violet-400" />
                <span>Visual Query Builder</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  openToolTab("charts");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <BarChart3 className="w-3.5 h-3.5 text-cyan-400" />
                <span>Charts Dashboard</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  openToolTab("automation");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <Clock className="w-3.5 h-3.5 text-lime-400" />
                <span>Automation</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  openToolTab("data_gen");
                  setOpenMenu(null);
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-[var(--surface-hover)] flex items-center gap-2 cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                <span>Data Generator</span>
              </button>
            </>
          )}
        </ContextMenu>
      )}
    </header>
  );
};
