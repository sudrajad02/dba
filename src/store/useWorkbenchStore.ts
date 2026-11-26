import { create } from "zustand";
import { api, formatApiError } from "../lib/tauri";
import type {
  CodeSnippet,
  ConnectionProfile,
  DatabaseInfo,
  DatabaseObject,
  DbEngine,
  FilterCondition,
  QueryHistoryEntry,
  SavedQuery,
  SchemaInfo,
  TableMetadata,
} from "../types/dba";

export type ThemeMode = "dark" | "light" | "system";
export type SplitMode = "none" | "horizontal" | "vertical";
export type TabKind =
  | "objects"
  | "table"
  | "query"
  | "designer"
  | "mongo_collection"
  | "mongo_query"
  | "mongo_designer"
  | "import_export"
  | "dump_backup"
  | "data_transfer"
  | "sync"
  | "er_model"
  | "query_builder"
  | "automation"
  | "charts"
  | "data_gen";

export interface BrowserContext {
  connectionId: string | null;
  database: string | null;
  schema: string | null;
  category: "all" | "table" | "view" | "function" | "trigger" | "query";
}

export interface CopiedDbObject {
  connectionId: string;
  database: string;
  schema: string | null;
  object: DatabaseObject;
}

export interface WorkbenchTab {
  id: string;
  kind: TabKind;
  title: string;
  connectionId?: string;
  database?: string;
  schema?: string;
  table?: string;
  collection?: string;
  sql?: string;
  savedQueryPath?: string;
  mongoMode?: "mql" | "pipeline";
  wizardMode?:
    | "export"
    | "import"
    | "dump"
    | "execute_sql"
    | "native_cli"
    | "structure_sync"
    | "data_sync";
  isNewTable?: boolean;
  initialFilters?: FilterCondition[];
  dirty?: boolean;
}

export interface ConsoleLogEntry {
  id: string;
  timestamp: string;
  level: "info" | "success" | "warn" | "error";
  message: string;
  sql?: string;
}

export interface InspectedCell {
  column: string;
  dataType: string;
  value: unknown;
}

export interface InspectedObjectInfo {
  connectionId: string;
  database: string;
  schema?: string | null;
  object: DatabaseObject;
  tableMeta?: TableMetadata | null;
  ddl?: string | null;
  loading?: boolean;
}

export interface SafetyModalState {
  open: boolean;
  title: string;
  warnings: string[];
  sqlPreview: string;
  onConfirm: () => void;
}

export interface UnsavedCloseModalState {
  title: string;
  message: string;
  dirtyTabTitles: string[];
  onConfirm: () => void;
}

interface WorkbenchStore {
  // Theme & Layout
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  uiFontSize: number;
  setUiFontSize: (px: number) => void;
  leftSidebarOpen: boolean;
  rightInspectorOpen: boolean;
  bottomDrawerOpen: boolean;
  bottomDrawerTab: "console" | "history";
  leftSidebarWidth: number;
  rightInspectorWidth: number;
  bottomDrawerHeight: number;
  setLeftSidebarWidth: (px: number) => void;
  setRightInspectorWidth: (px: number) => void;
  setBottomDrawerHeight: (px: number) => void;
  splitMode: SplitMode;
  toggleLeftSidebar: () => void;
  toggleRightInspector: () => void;
  toggleBottomDrawer: () => void;
  setBottomDrawerTab: (tab: "console" | "history") => void;
  setSplitMode: (mode: SplitMode) => void;

  // Connections & Tree Cache
  connections: ConnectionProfile[];
  connectedIds: Set<string>;
  databasesByConn: Record<string, DatabaseInfo[]>;
  schemasByConnDb: Record<string, SchemaInfo[]>;
  objectsByKey: Record<string, DatabaseObject[]>;
  activeConnectionId: string | null;
  setActiveConnectionId: (id: string | null) => void;
  browserContext: BrowserContext;
  setBrowserContext: (patch: Partial<BrowserContext>, focusObjectsTab?: boolean) => void;
  copiedObject: CopiedDbObject | null;
  setCopiedObject: (item: CopiedDbObject | null) => void;
  pasteCopiedObject: (
    targetConnectionId: string,
    targetDatabase: string,
    targetSchema: string | null,
    confirmedProduction?: boolean
  ) => Promise<void>;

  // Tabs
  tabs: WorkbenchTab[];
  activeTabId: string | null;
  secondaryTabId: string | null;
  openTab: (tab: Omit<WorkbenchTab, "id"> & { id?: string }) => string;
  closeTab: (id: string) => void;
  requestCloseTab: (id: string) => void;
  reorderTabs: (fromId: string, toIndex: number) => void;
  closeOtherTabs: (keepId: string) => void;
  requestCloseOtherTabs: (keepId: string) => void;
  closeTabsToRight: (id: string) => void;
  requestCloseTabsToRight: (id: string) => void;
  closeAllTabs: () => void;
  requestCloseAllTabs: () => void;
  setActiveTab: (id: string) => void;
  setSecondaryTab: (id: string | null) => void;
  updateTab: (id: string, patch: Partial<WorkbenchTab>) => void;

  // Inspector & Drawer
  inspectedCell: InspectedCell | null;
  setInspectedCell: (cell: InspectedCell | null) => void;
  inspectedTableMeta: TableMetadata | null;
  setInspectedTableMeta: (meta: TableMetadata | null) => void;
  inspectedObject: InspectedObjectInfo | null;
  setInspectedObject: (info: InspectedObjectInfo | null) => void;
  inspectDatabaseObject: (
    connectionId: string,
    database: string,
    schema: string | null | undefined,
    object: DatabaseObject
  ) => Promise<void>;
  consoleLogs: ConsoleLogEntry[];
  toasts: ConsoleLogEntry[];
  addLog: (
    level: ConsoleLogEntry["level"],
    message: string,
    sql?: string,
    showToast?: boolean
  ) => void;
  dismissToast: (id: string) => void;
  clearLogs: () => void;

  // History, Saved Queries, Snippets
  queryHistory: QueryHistoryEntry[];
  savedQueries: SavedQuery[];
  snippets: CodeSnippet[];
  refreshHistory: (search?: string) => Promise<void>;
  refreshSavedQueries: () => Promise<void>;
  refreshSnippets: () => Promise<void>;

  // Modals
  connectionModalOpen: boolean;
  editingConnection: ConnectionProfile | null;
  initialConnectionEngine: DbEngine | null;
  openConnectionModal: (
    profile?: ConnectionProfile | null,
    initialEngine?: DbEngine | null
  ) => void;
  closeConnectionModal: () => void;

  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  safetyModal: SafetyModalState | null;
  openSafetyModal: (modal: Omit<SafetyModalState, "open">) => void;
  closeSafetyModal: () => void;

  unsavedCloseModal: UnsavedCloseModalState | null;
  closeUnsavedCloseModal: () => void;

  // Async Actions
  bootstrap: () => Promise<void>;
  refreshConnections: () => Promise<void>;
  connectTo: (connectionId: string) => Promise<boolean>;
  disconnectFrom: (connectionId: string) => Promise<void>;
  loadDatabases: (connectionId: string) => Promise<DatabaseInfo[]>;
  loadSchemas: (connectionId: string, database: string) => Promise<SchemaInfo[]>;
  loadObjects: (
    connectionId: string,
    database: string,
    schema?: string
  ) => Promise<DatabaseObject[]>;
  persistOpenQueryTabs: () => void;
}

const makeId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const readClampedNumber = (key: string, fallback: number, min: number, max: number): number => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  } catch {
    return fallback;
  }
};

const readBool = (key: string, fallback: boolean): boolean => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "true";
  } catch {
    return fallback;
  }
};

let persistRecoveryTimer: number | null = null;

export const useWorkbenchStore = create<WorkbenchStore>((set, get) => ({
  theme: (localStorage.getItem("dv_theme") as ThemeMode) || "dark",
  setTheme: (theme) => {
    localStorage.setItem("dv_theme", theme);
    set({ theme });
  },
  uiFontSize: readClampedNumber("dv_font_size", 14, 12, 22),
  setUiFontSize: (px) => {
    const clamped = Math.max(12, Math.min(22, px));
    localStorage.setItem("dv_font_size", String(clamped));
    set({ uiFontSize: clamped });
  },
  leftSidebarOpen: true,
  rightInspectorOpen: readBool("dv_right_inspector_open", false),
  bottomDrawerOpen: false,
  bottomDrawerTab: "console",
  leftSidebarWidth: readClampedNumber("dv_left_sidebar_width", 256, 180, 520),
  rightInspectorWidth: readClampedNumber("dv_right_inspector_width", 300, 240, 560),
  bottomDrawerHeight: readClampedNumber("dv_bottom_drawer_height", 208, 120, 500),
  setLeftSidebarWidth: (px) => {
    const clamped = Math.max(180, Math.min(520, Math.round(px)));
    localStorage.setItem("dv_left_sidebar_width", String(clamped));
    set({ leftSidebarWidth: clamped });
  },
  setRightInspectorWidth: (px) => {
    const clamped = Math.max(240, Math.min(560, Math.round(px)));
    localStorage.setItem("dv_right_inspector_width", String(clamped));
    set({ rightInspectorWidth: clamped });
  },
  setBottomDrawerHeight: (px) => {
    const clamped = Math.max(120, Math.min(500, Math.round(px)));
    localStorage.setItem("dv_bottom_drawer_height", String(clamped));
    set({ bottomDrawerHeight: clamped });
  },
  splitMode: "none",
  toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
  toggleRightInspector: () =>
    set((s) => {
      const next = !s.rightInspectorOpen;
      localStorage.setItem("dv_right_inspector_open", String(next));
      return { rightInspectorOpen: next };
    }),
  toggleBottomDrawer: () =>
    set((s) => ({ bottomDrawerOpen: !s.bottomDrawerOpen })),
  setBottomDrawerTab: (tab) => set({ bottomDrawerTab: tab, bottomDrawerOpen: true }),
  setSplitMode: (splitMode) =>
    set((s) => {
      if (splitMode === "none") return { splitMode, secondaryTabId: null };
      const other = s.tabs.find((t) => t.id !== s.activeTabId)?.id ?? s.activeTabId;
      return { splitMode, secondaryTabId: other };
    }),

  connections: [],
  connectedIds: new Set(),
  databasesByConn: {},
  schemasByConnDb: {},
  objectsByKey: {},
  activeConnectionId: null,
  setActiveConnectionId: (id) => set({ activeConnectionId: id }),
  browserContext: {
    connectionId: null,
    database: null,
    schema: null,
    category: "table",
  },
  setBrowserContext: (patch, focusObjectsTab = true) =>
    set((s) => ({
      browserContext: { ...s.browserContext, ...patch },
      activeConnectionId:
        patch.connectionId !== undefined ? patch.connectionId : s.activeConnectionId,
      activeTabId: focusObjectsTab ? "objects" : s.activeTabId,
    })),

  copiedObject: null,
  setCopiedObject: (copiedObject) => set({ copiedObject }),
  pasteCopiedObject: async (
    targetConnectionId,
    targetDatabase,
    targetSchema,
    confirmedProduction = false
  ) => {
    const state = get();
    const copied = state.copiedObject;
    if (!copied) return;

    const tgtConn = state.connections.find((c) => c.id === targetConnectionId);
    const srcConn = state.connections.find((c) => c.id === copied.connectionId);
    if (!tgtConn || !srcConn) return;

    const isTable =
      copied.object.kind === "table" || copied.object.kind === "collection";
    const sameLocation =
      copied.connectionId === targetConnectionId &&
      copied.database === targetDatabase &&
      (copied.schema ?? copied.database) === (targetSchema ?? targetDatabase);

    if (isTable && sameLocation) {
      const targetName = window.prompt(
        `Paste "${copied.object.name}" into same database as:`,
        `${copied.object.name}_copy`
      );
      if (!targetName || !targetName.trim()) return;
      try {
        await api.duplicateTable(
          targetConnectionId,
          copied.object.name,
          targetName.trim(),
          true,
          targetDatabase,
          targetSchema ?? undefined
        );
        state.addLog(
          "success",
          `Pasted table "${copied.object.name}" as "${targetName.trim()}"`
        );
        await state.loadObjects(
          targetConnectionId,
          targetDatabase,
          targetSchema ?? targetDatabase
        );
      } catch (err) {
        state.addLog("error", `Paste failed: ${formatApiError(err)}`);
      }
      return;
    }

    if (tgtConn.environment === "production" && !confirmedProduction) {
      state.openSafetyModal({
        title: `Paste ${copied.object.kind} "${copied.object.name}" to PRODUCTION`,
        warnings: [
          `Target connection "${tgtConn.name}" is marked PRODUCTION!`,
          `Copy ${copied.object.kind} "${copied.object.name}" from ${srcConn.name}/${copied.database} to ${tgtConn.name}/${targetDatabase}.`,
        ],
        sqlPreview: `PASTE ${copied.object.kind.toUpperCase()} ${copied.object.name} -> ${targetDatabase}`,
        onConfirm: () => {
          state.pasteCopiedObject(
            targetConnectionId,
            targetDatabase,
            targetSchema,
            true
          );
        },
      });
      return;
    }

    try {
      if (!state.connectedIds.has(copied.connectionId)) {
        await state.connectTo(copied.connectionId);
      }
      if (!state.connectedIds.has(targetConnectionId)) {
        await state.connectTo(targetConnectionId);
      }
      const res = await api.runDataTransfer({
        jobId: `paste-${Date.now()}`,
        sourceConnectionId: copied.connectionId,
        sourceDatabase: copied.database,
        sourceSchema: copied.schema ?? copied.database,
        targetConnectionId,
        targetDatabase,
        targetSchema: targetSchema ?? targetDatabase,
        tables: isTable
          ? [
              {
                sourceTable: copied.object.name,
                targetTable: copied.object.name,
                includeData: true,
              },
            ]
          : [],
        objects: isTable
          ? []
          : [{ name: copied.object.name, kind: copied.object.kind }],
        mode: "create_if_not_exists",
        typeMappings: [],
        batchSize: 250,
        errorPolicy: "stop_on_error",
        confirmedProduction,
      });

      if (res.ok) {
        state.addLog(
          "success",
          `Pasted ${copied.object.kind} "${copied.object.name}" into ${targetDatabase}`
        );
        await state.loadObjects(
          targetConnectionId,
          targetDatabase,
          targetSchema ?? targetDatabase
        );
      } else {
        const firstErr =
          res.tables.find((t) => !t.ok)?.error ??
          res.objects?.find((o) => !o.ok)?.error ??
          res.summary;
        state.addLog("error", `Paste failed: ${firstErr}`);
      }
    } catch (err) {
      state.addLog("error", `Paste failed: ${formatApiError(err)}`);
    }
  },

  tabs: [
    {
      id: "objects",
      kind: "objects",
      title: "Objects",
    },
  ],
  activeTabId: "objects",
  secondaryTabId: null,

  openTab: (tabInput) => {
    const state = get();
    // Reuse already-open saved query tab by path
    if (tabInput.savedQueryPath) {
      const existingSaved = state.tabs.find(
        (t) => t.savedQueryPath === tabInput.savedQueryPath
      );
      if (existingSaved) {
        set({ activeTabId: existingSaved.id });
        return existingSaved.id;
      }
    }
    // Reuse existing table/designer/mongo tab if identical
    if (
      tabInput.kind === "table" ||
      tabInput.kind === "designer" ||
      tabInput.kind === "mongo_collection" ||
      tabInput.kind === "mongo_designer"
    ) {
      const existing = state.tabs.find(
        (t) =>
          t.kind === tabInput.kind &&
          t.connectionId === tabInput.connectionId &&
          t.database === tabInput.database &&
          t.schema === tabInput.schema &&
          t.table === tabInput.table &&
          t.collection === tabInput.collection &&
          !tabInput.initialFilters?.length
      );
      if (existing) {
        set({ activeTabId: existing.id });
        return existing.id;
      }
    }

    const id = tabInput.id || makeId();
    const newTab: WorkbenchTab = { ...tabInput, id };
    set({
      tabs: [...state.tabs, newTab],
      activeTabId: id,
      activeConnectionId: newTab.connectionId ?? state.activeConnectionId,
    });
    if (newTab.kind === "query") {
      get().persistOpenQueryTabs();
    }
    return id;
  },

  closeTab: (id) => {
    if (id === "objects") return; // Navicat pins Objects as the first tab
    const state = get();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const remaining = state.tabs.filter((t) => t.id !== id);
    let nextActive = state.activeTabId;
    if (state.activeTabId === id) {
      nextActive = remaining[Math.max(0, idx - 1)]?.id ?? "objects";
    }
    let nextSecondary = state.secondaryTabId;
    if (state.secondaryTabId === id) {
      nextSecondary = remaining.find((t) => t.id !== nextActive)?.id ?? null;
    }
    set({
      tabs: remaining,
      activeTabId: nextActive,
      secondaryTabId: nextSecondary,
    });
    get().persistOpenQueryTabs();
  },

  requestCloseTab: (id) => {
    if (id === "objects") return;
    const state = get();
    const target = state.tabs.find((t) => t.id === id);
    if (!target) return;
    if (!target.dirty) {
      state.closeTab(id);
      return;
    }
    set({
      unsavedCloseModal: {
        title: "Unsaved Changes",
        message: `Tab "${target.title}" has unsaved changes. Discard and close?`,
        dirtyTabTitles: [target.title],
        onConfirm: () => {
          set({ unsavedCloseModal: null });
          get().closeTab(id);
        },
      },
    });
  },

  reorderTabs: (fromId, toIndex) => {
    if (fromId === "objects") return;
    const state = get();
    const fromIdx = state.tabs.findIndex((t) => t.id === fromId);
    if (fromIdx <= 0) return;
    const clampedTarget = Math.max(1, Math.min(toIndex, state.tabs.length - 1));
    if (fromIdx === clampedTarget) return;
    const next = [...state.tabs];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(clampedTarget, 0, moved);
    set({ tabs: next });
    get().persistOpenQueryTabs();
  },

  closeOtherTabs: (keepId) => {
    const state = get();
    const remaining = state.tabs.filter((t) => t.id === "objects" || t.id === keepId);
    const keepExists = remaining.some((t) => t.id === keepId);
    const nextActive = keepExists ? keepId : "objects";
    const nextSecondary =
      state.secondaryTabId && remaining.some((t) => t.id === state.secondaryTabId)
        ? state.secondaryTabId
        : null;
    set({
      tabs: remaining,
      activeTabId: nextActive,
      secondaryTabId: nextSecondary,
    });
    get().persistOpenQueryTabs();
  },

  requestCloseOtherTabs: (keepId) => {
    const state = get();
    const dirtyTargets = state.tabs.filter(
      (t) => t.id !== "objects" && t.id !== keepId && t.dirty
    );
    if (dirtyTargets.length === 0) {
      state.closeOtherTabs(keepId);
      return;
    }
    set({
      unsavedCloseModal: {
        title: "Unsaved Changes",
        message:
          dirtyTargets.length === 1
            ? `Tab "${dirtyTargets[0].title}" has unsaved changes. Discard and close?`
            : `${dirtyTargets.length} tabs have unsaved changes. Discard all and close?`,
        dirtyTabTitles: dirtyTargets.map((t) => t.title),
        onConfirm: () => {
          set({ unsavedCloseModal: null });
          get().closeOtherTabs(keepId);
        },
      },
    });
  },

  closeTabsToRight: (id) => {
    const state = get();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const remaining = state.tabs.slice(0, idx + 1);
    const nextActive = remaining.some((t) => t.id === state.activeTabId)
      ? state.activeTabId
      : id;
    const nextSecondary =
      state.secondaryTabId && remaining.some((t) => t.id === state.secondaryTabId)
        ? state.secondaryTabId
        : null;
    set({
      tabs: remaining,
      activeTabId: nextActive,
      secondaryTabId: nextSecondary,
    });
    get().persistOpenQueryTabs();
  },

  requestCloseTabsToRight: (id) => {
    const state = get();
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const dirtyTargets = state.tabs.slice(idx + 1).filter((t) => t.dirty);
    if (dirtyTargets.length === 0) {
      state.closeTabsToRight(id);
      return;
    }
    set({
      unsavedCloseModal: {
        title: "Unsaved Changes",
        message:
          dirtyTargets.length === 1
            ? `Tab "${dirtyTargets[0].title}" has unsaved changes. Discard and close?`
            : `${dirtyTargets.length} tabs to the right have unsaved changes. Discard all and close?`,
        dirtyTabTitles: dirtyTargets.map((t) => t.title),
        onConfirm: () => {
          set({ unsavedCloseModal: null });
          get().closeTabsToRight(id);
        },
      },
    });
  },

  closeAllTabs: () => {
    const state = get();
    const objectsTab = state.tabs.find((t) => t.id === "objects");
    set({
      tabs: objectsTab ? [objectsTab] : [{ id: "objects", kind: "objects", title: "Objects" }],
      activeTabId: "objects",
      secondaryTabId: null,
    });
    get().persistOpenQueryTabs();
  },

  requestCloseAllTabs: () => {
    const state = get();
    const dirtyTargets = state.tabs.filter((t) => t.id !== "objects" && t.dirty);
    if (dirtyTargets.length === 0) {
      state.closeAllTabs();
      return;
    }
    set({
      unsavedCloseModal: {
        title: "Unsaved Changes",
        message:
          dirtyTargets.length === 1
            ? `Tab "${dirtyTargets[0].title}" has unsaved changes. Discard and close?`
            : `${dirtyTargets.length} tabs have unsaved changes. Discard all and close?`,
        dirtyTabTitles: dirtyTargets.map((t) => t.title),
        onConfirm: () => {
          set({ unsavedCloseModal: null });
          get().closeAllTabs();
        },
      },
    });
  },

  setActiveTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    set((s) => ({
      activeTabId: id,
      activeConnectionId: tab?.connectionId ?? s.activeConnectionId,
    }));
  },

  setSecondaryTab: (id) => set({ secondaryTabId: id }),

  updateTab: (id, patch) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
    if (patch.sql !== undefined) {
      get().persistOpenQueryTabs();
    }
  },

  inspectedCell: null,
  setInspectedCell: (cell) => set({ inspectedCell: cell }),
  inspectedTableMeta: null,
  setInspectedTableMeta: (meta) => set({ inspectedTableMeta: meta }),
  inspectedObject: null,
  setInspectedObject: (info) => set({ inspectedObject: info }),
  inspectDatabaseObject: async (connectionId, database, schema, object) => {
    const cleanSchema = schema ?? null;
    const reqKey = `${connectionId}::${database}::${cleanSchema ?? ""}::${object.kind}::${object.name}`;
    set({
      inspectedObject: {
        connectionId,
        database,
        schema: cleanSchema,
        object,
        tableMeta: null,
        ddl: null,
        loading: true,
      },
    });

    const isCurrent = () => {
      const cur = get().inspectedObject;
      if (!cur) return false;
      const curKey = `${cur.connectionId}::${cur.database}::${cur.schema ?? ""}::${cur.object.kind}::${cur.object.name}`;
      return curKey === reqKey;
    };

    try {
      let tableMeta: TableMetadata | null = null;
      let ddl: string | null = null;

      if (
        object.kind === "table" ||
        object.kind === "view" ||
        object.kind === "materialized_view"
      ) {
        try {
          tableMeta = await api.getTableMetadata(
            connectionId,
            object.name,
            database,
            cleanSchema ?? undefined
          );
          ddl = tableMeta.ddl ?? null;
        } catch {
          tableMeta = null;
        }
      }

      if (!ddl && object.kind !== "collection") {
        try {
          ddl = await api.getObjectDdl(
            connectionId,
            object.name,
            object.kind,
            database,
            cleanSchema ?? undefined
          );
        } catch {
          ddl = null;
        }
      }

      if (!isCurrent()) return;
      set({
        inspectedObject: {
          connectionId,
          database,
          schema: cleanSchema,
          object,
          tableMeta,
          ddl,
          loading: false,
        },
        ...(tableMeta ? { inspectedTableMeta: tableMeta } : {}),
      });
    } catch {
      if (!isCurrent()) return;
      set((s) =>
        s.inspectedObject
          ? { inspectedObject: { ...s.inspectedObject, loading: false } }
          : s
      );
    }
  },

  consoleLogs: [],
  toasts: [],
  addLog: (level, message, sql, showToast) => {
    const entry: ConsoleLogEntry = {
      id: makeId(),
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
      sql,
    };
    const shouldToast = showToast ?? level === "error";
    set((s) => ({
      consoleLogs: [entry, ...s.consoleLogs.slice(0, 199)],
      toasts: shouldToast ? [...s.toasts.slice(-3), entry] : s.toasts,
    }));
    if (shouldToast) {
      window.setTimeout(() => {
        set((s) => ({
          toasts: s.toasts.filter((t) => t.id !== entry.id),
        }));
      }, level === "error" ? 7000 : 3200);
    }
  },
  dismissToast: (id) =>
    set((s) => ({
      toasts: s.toasts.filter((t) => t.id !== id),
    })),
  clearLogs: () => set({ consoleLogs: [] }),

  queryHistory: [],
  savedQueries: [],
  snippets: [],
  refreshHistory: async (search) => {
    try {
      const items = await api.searchQueryHistory(search, 120);
      set({ queryHistory: items });
    } catch {
      // ignore if outside tauri
    }
  },
  refreshSavedQueries: async () => {
    try {
      const items = await api.listSavedQueries();
      set({ savedQueries: items });
    } catch {
      // ignore
    }
  },
  refreshSnippets: async () => {
    try {
      const items = await api.listSnippets();
      set({ snippets: items });
    } catch {
      // ignore
    }
  },

  connectionModalOpen: false,
  editingConnection: null,
  initialConnectionEngine: null,
  openConnectionModal: (profile = null, initialEngine = null) =>
    set({
      connectionModalOpen: true,
      editingConnection: profile,
      initialConnectionEngine: profile ? null : initialEngine,
    }),
  closeConnectionModal: () =>
    set({
      connectionModalOpen: false,
      editingConnection: null,
      initialConnectionEngine: null,
    }),

  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

  safetyModal: null,
  openSafetyModal: (modal) => set({ safetyModal: { ...modal, open: true } }),
  closeSafetyModal: () => set({ safetyModal: null }),

  unsavedCloseModal: null,
  closeUnsavedCloseModal: () => set({ unsavedCloseModal: null }),

  bootstrap: async () => {
    await get().refreshConnections();
    await Promise.all([
      get().refreshHistory(),
      get().refreshSavedQueries(),
      get().refreshSnippets(),
    ]);
    try {
      const ids = await api.getConnectedIds();
      set({ connectedIds: new Set(ids) });
      // Restore crash-recovered unsaved SQL tabs if any (deduplicated by id for React StrictMode)
      const recovered = await api.loadRecoveryState("open_query_tabs");
      if (recovered) {
        const parsed: WorkbenchTab[] = JSON.parse(recovered);
        if (Array.isArray(parsed) && parsed.length > 0) {
          set((s) => {
            const seen = new Set(s.tabs.map((t) => t.id));
            const uniqueNew: WorkbenchTab[] = [];
            for (const item of parsed) {
              if (item && item.id && !seen.has(item.id)) {
                seen.add(item.id);
                uniqueNew.push(item);
              }
            }
            return uniqueNew.length > 0 ? { tabs: [...s.tabs, ...uniqueNew] } : s;
          });
        }
      }
    } catch {
      // ignore
    }
  },

  refreshConnections: async () => {
    try {
      const list = await api.listConnections();
      set({ connections: list });
    } catch (err) {
      get().addLog("error", `Failed to load connections: ${formatApiError(err)}`);
    }
  },

  connectTo: async (connectionId) => {
    const profile = get().connections.find((c) => c.id === connectionId);
    try {
      const res = await api.connectDb(connectionId);
      set((s) => {
        const next = new Set(s.connectedIds);
        next.add(connectionId);
        return { connectedIds: next, activeConnectionId: connectionId };
      });
      get().addLog(
        "success",
        `Connected to ${profile?.name ?? connectionId} (${res.latencyMs}ms)${
          res.serverVersion ? ` — ${res.serverVersion.slice(0, 60)}` : ""
        }`
      );
      await get().loadDatabases(connectionId);
      return true;
    } catch (err) {
      get().addLog(
        "error",
        `Connection failed (${profile?.name ?? connectionId}): ${formatApiError(err)}`
      );
      set({ bottomDrawerOpen: true, bottomDrawerTab: "console" });
      return false;
    }
  },

  disconnectFrom: async (connectionId) => {
    const profile = get().connections.find((c) => c.id === connectionId);
    try {
      await api.disconnectDb(connectionId);
      set((s) => {
        const nextConnected = new Set(s.connectedIds);
        nextConnected.delete(connectionId);

        // Close all tabs belonging to the disconnected connection (keep Objects tab & other connections)
        const remainingTabs = s.tabs.filter(
          (t) => t.id === "objects" || t.connectionId !== connectionId
        );
        const activeStillExists = remainingTabs.some((t) => t.id === s.activeTabId);
        const nextActiveTabId = activeStillExists
          ? s.activeTabId
          : remainingTabs[remainingTabs.length - 1]?.id ?? "objects";

        const secondaryStillExists =
          s.secondaryTabId !== null && remainingTabs.some((t) => t.id === s.secondaryTabId);
        const nextSecondaryTabId = secondaryStillExists ? s.secondaryTabId : null;
        const nextSplitMode =
          s.splitMode !== "none" && !nextSecondaryTabId ? "none" : s.splitMode;

        // Reset browserContext if it pointed to this connection
        const nextBrowserContext =
          s.browserContext.connectionId === connectionId
            ? { connectionId: null, database: null, schema: null, category: "table" as const }
            : s.browserContext;

        // Reset activeConnectionId if it pointed to this connection
        const nextActiveConnId =
          s.activeConnectionId === connectionId
            ? Array.from(nextConnected)[0] ?? null
            : s.activeConnectionId;

        // Clear cached databases, schemas, and objects for this connection
        const nextDatabasesByConn = { ...s.databasesByConn };
        delete nextDatabasesByConn[connectionId];

        const prefix = `${connectionId}::`;
        const nextSchemasByConnDb: Record<string, SchemaInfo[]> = {};
        for (const [k, v] of Object.entries(s.schemasByConnDb)) {
          if (!k.startsWith(prefix)) nextSchemasByConnDb[k] = v;
        }
        const nextObjectsByKey: Record<string, DatabaseObject[]> = {};
        for (const [k, v] of Object.entries(s.objectsByKey)) {
          if (!k.startsWith(prefix)) nextObjectsByKey[k] = v;
        }

        // Clear inspector / clipboard if referencing this connection
        const clearInspector = s.inspectedObject?.connectionId === connectionId;
        const clearCopied = s.copiedObject?.connectionId === connectionId;

        return {
          connectedIds: nextConnected,
          tabs: remainingTabs,
          activeTabId: nextActiveTabId,
          secondaryTabId: nextSecondaryTabId,
          splitMode: nextSplitMode,
          browserContext: nextBrowserContext,
          activeConnectionId: nextActiveConnId,
          databasesByConn: nextDatabasesByConn,
          schemasByConnDb: nextSchemasByConnDb,
          objectsByKey: nextObjectsByKey,
          ...(clearInspector ? { inspectedObject: null, inspectedTableMeta: null } : {}),
          ...(clearCopied ? { copiedObject: null } : {}),
        };
      });
      get().addLog("info", `Disconnected from ${profile?.name ?? connectionId}`);
    } catch (err) {
      get().addLog("error", formatApiError(err));
    }
  },

  loadDatabases: async (connectionId) => {
    try {
      const dbs = await api.listDatabases(connectionId);
      set((s) => ({
        databasesByConn: { ...s.databasesByConn, [connectionId]: dbs },
      }));
      return dbs;
    } catch (err) {
      get().addLog("error", `List databases failed: ${formatApiError(err)}`);
      return [];
    }
  },

  loadSchemas: async (connectionId, database) => {
    const key = `${connectionId}::${database}`;
    try {
      const schemas = await api.listSchemas(connectionId, database);
      set((s) => ({
        schemasByConnDb: { ...s.schemasByConnDb, [key]: schemas },
      }));
      return schemas;
    } catch (err) {
      get().addLog("error", `List schemas failed: ${formatApiError(err)}`);
      return [];
    }
  },

  loadObjects: async (connectionId, database, schema) => {
    const key = `${connectionId}::${database}::${schema ?? ""}`;
    try {
      const objects = await api.listObjects(connectionId, database, schema);
      set((s) => ({
        objectsByKey: { ...s.objectsByKey, [key]: objects },
      }));
      return objects;
    } catch (err) {
      get().addLog("error", `List objects failed: ${formatApiError(err)}`);
      return [];
    }
  },

  persistOpenQueryTabs: () => {
    if (persistRecoveryTimer !== null) {
      window.clearTimeout(persistRecoveryTimer);
    }
    persistRecoveryTimer = window.setTimeout(() => {
      persistRecoveryTimer = null;
      const queryTabs = get().tabs.filter((t) => t.kind === "query" && t.sql?.trim());
      api
        .saveRecoveryState("open_query_tabs", JSON.stringify(queryTabs.slice(0, 10)))
        .catch(() => {});
    }, 600);
  },
}));
