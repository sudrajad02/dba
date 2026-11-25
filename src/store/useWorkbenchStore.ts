import { create } from "zustand";
import { api, formatApiError } from "../lib/tauri";
import type {
  CodeSnippet,
  ConnectionProfile,
  DatabaseInfo,
  DatabaseObject,
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
  category: "all" | "table" | "view" | "function" | "query";
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

export interface SafetyModalState {
  open: boolean;
  title: string;
  warnings: string[];
  sqlPreview: string;
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
  setActiveTab: (id: string) => void;
  setSecondaryTab: (id: string | null) => void;
  updateTab: (id: string, patch: Partial<WorkbenchTab>) => void;

  // Inspector & Drawer
  inspectedCell: InspectedCell | null;
  setInspectedCell: (cell: InspectedCell | null) => void;
  inspectedTableMeta: TableMetadata | null;
  setInspectedTableMeta: (meta: TableMetadata | null) => void;
  consoleLogs: ConsoleLogEntry[];
  toasts: ConsoleLogEntry[];
  addLog: (level: ConsoleLogEntry["level"], message: string, sql?: string) => void;
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
  openConnectionModal: (profile?: ConnectionProfile | null) => void;
  closeConnectionModal: () => void;

  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  safetyModal: SafetyModalState | null;
  openSafetyModal: (modal: Omit<SafetyModalState, "open">) => void;
  closeSafetyModal: () => void;

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

export const useWorkbenchStore = create<WorkbenchStore>((set, get) => ({
  theme: (localStorage.getItem("dv_theme") as ThemeMode) || "dark",
  setTheme: (theme) => {
    localStorage.setItem("dv_theme", theme);
    set({ theme });
  },
  uiFontSize: Number(localStorage.getItem("dv_font_size")) || 18,
  setUiFontSize: (px) => {
    const clamped = Math.max(14, Math.min(24, px));
    localStorage.setItem("dv_font_size", String(clamped));
    set({ uiFontSize: clamped });
  },
  leftSidebarOpen: true,
  rightInspectorOpen: false,
  bottomDrawerOpen: false,
  bottomDrawerTab: "console",
  splitMode: "none",
  toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
  toggleRightInspector: () =>
    set((s) => ({ rightInspectorOpen: !s.rightInspectorOpen })),
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

  consoleLogs: [],
  toasts: [],
  addLog: (level, message, sql) => {
    const entry: ConsoleLogEntry = {
      id: makeId(),
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
      sql,
    };
    set((s) => ({
      consoleLogs: [entry, ...s.consoleLogs.slice(0, 199)],
      toasts: level === "error" ? [...s.toasts.slice(-3), entry] : s.toasts,
    }));
    if (level === "error") {
      window.setTimeout(() => {
        set((s) => ({
          toasts: s.toasts.filter((t) => t.id !== entry.id),
        }));
      }, 7000);
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
  openConnectionModal: (profile = null) =>
    set({ connectionModalOpen: true, editingConnection: profile }),
  closeConnectionModal: () =>
    set({ connectionModalOpen: false, editingConnection: null }),

  commandPaletteOpen: false,
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

  safetyModal: null,
  openSafetyModal: (modal) => set({ safetyModal: { ...modal, open: true } }),
  closeSafetyModal: () => set({ safetyModal: null }),

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
      // Restore crash-recovered unsaved SQL tabs if any
      const recovered = await api.loadRecoveryState("open_query_tabs");
      if (recovered) {
        const parsed: WorkbenchTab[] = JSON.parse(recovered);
        if (Array.isArray(parsed) && parsed.length > 0) {
          set((s) => ({
            tabs: [...s.tabs, ...parsed],
          }));
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
    try {
      await api.disconnectDb(connectionId);
      set((s) => {
        const next = new Set(s.connectedIds);
        next.delete(connectionId);
        return { connectedIds: next };
      });
      get().addLog("info", `Disconnected from ${connectionId}`);
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
    const queryTabs = get().tabs.filter((t) => t.kind === "query" && t.sql?.trim());
    api
      .saveRecoveryState("open_query_tabs", JSON.stringify(queryTabs.slice(0, 10)))
      .catch(() => {});
  },
}));
