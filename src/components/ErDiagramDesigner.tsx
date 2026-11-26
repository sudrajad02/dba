import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Code2,
  Database,
  Download,
  FileImage,
  FolderOpen,
  GitCompare,
  KeyRound,
  LayoutGrid,
  Link2,
  Maximize2,
  Network,
  Plus,
  Printer,
  Save,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  DbEngine,
  ErCardinality,
  ErModel,
  ErRelationship,
  ErTableNode,
  StructureSyncPlan,
} from "../types/dba";

const CARD_WIDTH = 250;
const HEADER_H = 34;
const ROW_H = 24;

const TABLE_COLORS = [
  "#3b82f6",
  "#10b981",
  "#8b5cf6",
  "#f59e0b",
  "#06b6d4",
  "#ec4899",
  "#ef4444",
];

function makeId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function tableHeight(t: ErTableNode) {
  return HEADER_H + Math.max(t.columns.length, 1) * ROW_H + 10;
}

function buildExportSvg(model: ErModel): string {
  if (model.tables.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="100%" height="100%" fill="#18191c"/><text x="30" y="100" fill="#a1a1aa" font-family="sans-serif" font-size="14">Empty ER Model</text></svg>`;
  }
  const maxX =
    Math.max(...model.tables.map((t) => t.x + CARD_WIDTH)) + 80;
  const maxY =
    Math.max(...model.tables.map((t) => t.y + tableHeight(t))) + 80;
  const w = Math.max(800, Math.ceil(maxX));
  const h = Math.max(500, Math.ceil(maxY));

  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const tableMap = new Map(model.tables.map((t) => [t.id, t]));
  const lines = model.relationships
    .map((r) => {
      const s = tableMap.get(r.sourceTableId);
      const t = tableMap.get(r.targetTableId);
      if (!s || !t) return "";
      const x1 = s.x + CARD_WIDTH / 2;
      const y1 = s.y + HEADER_H + ROW_H;
      const x2 = t.x + CARD_WIDTH / 2;
      const y2 = t.y + HEADER_H + ROW_H;
      const mx = (x1 + x2) / 2;
      const label =
        r.cardinality === "one_to_one"
          ? "1:1"
          : r.cardinality === "many_to_many"
          ? "N:M"
          : "N:1";
      return `<path d="M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" fill="none" stroke="#818cf8" stroke-width="2" />
      <text x="${mx}" y="${(y1 + y2) / 2 - 4}" fill="#c7d2fe" font-family="monospace" font-size="11" text-anchor="middle">${esc(label)}</text>`;
    })
    .join("\n");

  const nodes = model.tables
    .map((t) => {
      const th = tableHeight(t);
      const colColor = t.color || "#3b82f6";
      const rows = t.columns
        .map((c, idx) => {
          const ry = t.y + HEADER_H + 16 + idx * ROW_H;
          const prefix = c.isPrimaryKey ? "PK " : "";
          return `<text x="${t.x + 10}" y="${ry}" fill="${c.isPrimaryKey ? "#fbbf24" : "#e4e4e7"}" font-family="monospace" font-size="11">${esc(prefix + c.name)}</text>
          <text x="${t.x + CARD_WIDTH - 10}" y="${ry}" fill="#a1a1aa" font-family="monospace" font-size="10" text-anchor="end">${esc(c.dataType)}${c.nullable ? "?" : ""}</text>`;
        })
        .join("\n");
      return `<g>
        <rect x="${t.x}" y="${t.y}" width="${CARD_WIDTH}" height="${th}" rx="6" fill="#23252a" stroke="#3f4149" stroke-width="1.5"/>
        <rect x="${t.x}" y="${t.y}" width="${CARD_WIDTH}" height="${HEADER_H}" rx="6" fill="${esc(colColor)}"/>
        <text x="${t.x + 10}" y="${t.y + 21}" fill="#ffffff" font-family="sans-serif" font-weight="bold" font-size="12">${esc(t.name)}</text>
        ${rows}
      </g>`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="100%" height="100%" fill="#18191c"/>
    ${lines}
    ${nodes}
  </svg>`;
}

export const ErDiagramDesigner: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
  const {
    connections,
    connectedIds,
    databasesByConn,
    schemasByConnDb,
    activeTabId,
    connectTo,
    loadDatabases,
    loadSchemas,
    openTab,
    openSafetyModal,
    addLog,
  } = useWorkbenchStore();

  const sqlConns = connections.filter((c) => c.engine !== "mongodb");

  const [connId, setConnId] = useState(tab.connectionId ?? sqlConns[0]?.id ?? "");
  const [database, setDatabase] = useState(tab.database ?? "");
  const [schema, setSchema] = useState(tab.schema ?? "");

  const [model, setModel] = useState<ErModel>({
    id: makeId(),
    name: "Untitled ER Model",
    engine:
      sqlConns.find((c) => c.id === (tab.connectionId ?? sqlConns[0]?.id))
        ?.engine ?? "postgres",
    database: tab.database ?? null,
    schema: tab.schema ?? "public",
    tables: [],
    relationships: [],
    updatedAt: new Date().toISOString(),
  });

  const [savedModels, setSavedModels] = useState<ErModel[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [selectedRelId, setSelectedRelId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  const zoomAtPoint = useCallback((nextZoomRaw: number, clientX?: number, clientY?: number) => {
    const el = canvasRef.current;
    const oldZoom = zoomRef.current;
    const newZoom = Math.min(3.0, Math.max(0.25, +nextZoomRaw.toFixed(4)));
    if (newZoom === oldZoom) return;
    if (el) {
      const rect = el.getBoundingClientRect();
      const mouseX = clientX !== undefined ? clientX - rect.left : rect.width / 2;
      const mouseY = clientY !== undefined ? clientY - rect.top : rect.height / 2;
      const oldPan = panRef.current;
      const worldX = (mouseX - oldPan.x) / oldZoom;
      const worldY = (mouseY - oldPan.y) / oldZoom;
      const nextPan = {
        x: mouseX - worldX * newZoom,
        y: mouseY - worldY * newZoom,
      };
      zoomRef.current = newZoom;
      panRef.current = nextPan;
      setZoom(newZoom);
      setPan(nextPan);
    } else {
      zoomRef.current = newZoom;
      setZoom(newZoom);
    }
  }, []);

  const handleFitToView = useCallback(() => {
    const el = canvasRef.current;
    if (!el || model.tables.length === 0) {
      zoomRef.current = 1;
      panRef.current = { x: 0, y: 0 };
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    const rect = el.getBoundingClientRect();
    const minX = Math.min(...model.tables.map((t) => t.x));
    const minY = Math.min(...model.tables.map((t) => t.y));
    const maxX = Math.max(...model.tables.map((t) => t.x + CARD_WIDTH));
    const maxY = Math.max(...model.tables.map((t) => t.y + tableHeight(t)));
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const pad = 48;
    const scaleX = (rect.width - pad * 2) / contentW;
    const scaleY = (rect.height - pad * 2) / contentH;
    const nextZoom = Math.min(1.5, Math.max(0.25, +Math.min(scaleX, scaleY).toFixed(3)));
    const nextPan = {
      x: (rect.width - contentW * nextZoom) / 2 - minX * nextZoom,
      y: (rect.height - contentH * nextZoom) / 2 - minY * nextZoom,
    };
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
  }, [model.tables]);

  // Native wheel listener with passive: false for Ctrl/Cmd+Wheel & trackpad pinch zoom-to-cursor + scroll-to-pan
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.0025);
        zoomAtPoint(zoomRef.current * factor, e.clientX, e.clientY);
      } else {
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        const nextPan = {
          x: panRef.current.x - dx,
          y: panRef.current.y - dy,
        };
        panRef.current = nextPan;
        setPan(nextPan);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAtPoint]);

  // Keyboard shortcuts when ER Diagram tab is active: Ctrl/Cmd + =/+, -, 0
  useEffect(() => {
    if (activeTabId !== tab.id) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomAtPoint(zoomRef.current + 0.15);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomAtPoint(zoomRef.current - 0.15);
      } else if (e.key === "0") {
        e.preventDefault();
        zoomAtPoint(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabId, tab.id, zoomAtPoint]);

  // Forward Engineer / Sync modal
  const [ddlPreview, setDdlPreview] = useState<string | null>(null);
  const [syncPlan, setSyncPlan] = useState<StructureSyncPlan | null>(null);
  const [showModelsDrawer, setShowModelsDrawer] = useState(false);

  // Dragging state
  const dragRef = useRef<{
    kind: "table" | "pan";
    tableId?: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const conn = sqlConns.find((c) => c.id === connId);
  const dbs = databasesByConn[connId] ?? [];
  const effDb = database || conn?.database || dbs[0]?.name || "";
  const schemas = schemasByConnDb[`${connId}::${effDb}`] ?? [];
  const effSchema =
    schema ||
    (conn?.engine === "postgres"
      ? "public"
      : conn?.engine === "mssql"
      ? "dbo"
      : effDb);

  const refreshSavedModels = useCallback(async () => {
    try {
      setSavedModels(await api.listErModels());
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    refreshSavedModels();
  }, [refreshSavedModels]);

  const initConn = async (cid: string) => {
    if (!cid) return;
    if (!connectedIds.has(cid)) await connectTo(cid);
    const dbList = await loadDatabases(cid);
    const c = sqlConns.find((x) => x.id === cid);
    const d = c?.database || dbList[0]?.name || "";
    setDatabase(d);
    if (d && (c?.engine === "postgres" || c?.engine === "mssql")) {
      const sc = await loadSchemas(cid, d);
      const pref = c.engine === "mssql" ? "dbo" : "public";
      setSchema(sc.find((s) => s.name === pref)?.name ?? sc[0]?.name ?? pref);
    } else {
      setSchema(d);
    }
  };

  const handleReverseEngineer = async () => {
    if (!connId) return;
    setLoading(true);
    setError(null);
    try {
      if (!connectedIds.has(connId)) await connectTo(connId);
      const rev = await api.reverseEngineerSchema({
        connectionId: connId,
        database: effDb || null,
        schema: effSchema || null,
        modelName: `${effDb || conn?.name || "model"}${effSchema && effSchema !== effDb ? `.${effSchema}` : ""}`,
      });
      setModel(rev);
      setSelectedTableId(rev.tables[0]?.id ?? null);
      setSelectedRelId(null);
      setPan({ x: 0, y: 0 });
      setZoom(1);
      addLog(
        "success",
        `Reverse-engineered ${rev.tables.length} tables and ${rev.relationships.length} relationships.`
      );
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setLoading(false);
    }
  };

  const handleAutoLayout = async () => {
    try {
      const laid = await api.autoLayoutErModel(model);
      setModel(laid);
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const handleSaveModel = async () => {
    try {
      const saved = await api.saveErModel(model);
      setModel(saved);
      await refreshSavedModels();
      addLog("success", `Saved ER Model "${saved.name}" to workspace/models/.`);
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const handleForwardEngineer = async (targetEngine: DbEngine) => {
    try {
      const res = await api.forwardEngineerModel({
        model,
        targetEngine,
        includeDrops: false,
      });
      setDdlPreview(res.ddl);
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const handleSyncToDb = async () => {
    if (!connId) {
      setError("Select a target connection first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (!connectedIds.has(connId)) await connectTo(connId);
      const plan = await api.diffErModelToDb({
        model,
        targetConnectionId: connId,
        targetDatabase: effDb || null,
        targetSchema: effSchema || null,
        includeDrops: false,
      });
      setSyncPlan(plan);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setLoading(false);
    }
  };

  const applyModelSync = async (confirmedProd: boolean) => {
    if (!syncPlan || !connId) return;
    const stmts = syncPlan.tables.flatMap((t) => t.ddlStatements);
    if (stmts.length === 0) return;
    try {
      const res = await api.executeSyncScript({
        connectionId: connId,
        database: effDb || null,
        statements: stmts,
        stopOnError: true,
        confirmedProduction: confirmedProd,
      });
      addLog(res.ok ? "success" : "error", `ER Model Sync: ${res.summary}`);
      setSyncPlan(null);
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const handleAddTable = () => {
    const id = makeId();
    const idx = model.tables.length;
    const newTable: ErTableNode = {
      id,
      name: `table_${idx + 1}`,
      schema: model.schema ?? "public",
      x: 60 + (idx % 4) * 290,
      y: 60 + Math.floor(idx / 4) * 200,
      color: TABLE_COLORS[idx % TABLE_COLORS.length],
      group: null,
      columns: [
        {
          name: "id",
          dataType: model.engine === "postgres" ? "BIGSERIAL" : "BIGINT",
          nullable: false,
          isPrimaryKey: true,
          isAutoIncrement: true,
        },
        {
          name: "name",
          dataType: "VARCHAR",
          length: "255",
          nullable: false,
          isPrimaryKey: false,
          isAutoIncrement: false,
        },
      ],
      indexes: [],
    };
    setModel((m) => ({ ...m, tables: [...m.tables, newTable] }));
    setSelectedTableId(id);
    setSelectedRelId(null);
  };

  const handleAddRelationship = () => {
    if (model.tables.length < 2) {
      setError("Add at least two tables to create a relationship.");
      return;
    }
    const src =
      model.tables.find((t) => t.id === selectedTableId) ?? model.tables[0];
    const tgt = model.tables.find((t) => t.id !== src.id) ?? model.tables[1];
    const rel: ErRelationship = {
      id: makeId(),
      name: `fk_${src.name}_${tgt.name}`,
      sourceTableId: src.id,
      sourceColumn: src.columns[0]?.name ?? "id",
      targetTableId: tgt.id,
      targetColumn: tgt.columns.find((c) => c.isPrimaryKey)?.name ?? tgt.columns[0]?.name ?? "id",
      cardinality: "one_to_many",
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
    };
    setModel((m) => ({ ...m, relationships: [...m.relationships, rel] }));
    setSelectedRelId(rel.id);
    setSelectedTableId(null);
  };

  const handleExportSvg = () => {
    const svg = buildExportSvg(model);
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${model.name.replace(/\s+/g, "_")}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPng = () => {
    const svg = buildExportSvg(model);
    const img = new Image();
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width * 2;
      canvas.height = img.height * 2;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0);
        const pngUrl = canvas.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = pngUrl;
        a.download = `${model.name.replace(/\s+/g, "_")}.png`;
        a.click();
      }
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const handleExportPdf = () => {
    const svg = buildExportSvg(model);
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(
      `<!DOCTYPE html><html><head><title>${model.name}</title><style>body{margin:0;background:#18191c;display:flex;justify-content:center;align-items:center;}svg{max-width:100%;height:auto;}</style></head><body>${svg}<script>window.onload=()=>window.print();</script></body></html>`
    );
    win.document.close();
  };

  const onCanvasMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "pan") {
      setPan({
        x: d.origX + (e.clientX - d.startX),
        y: d.origY + (e.clientY - d.startY),
      });
    } else if (d.kind === "table" && d.tableId) {
      const dx = (e.clientX - d.startX) / zoom;
      const dy = (e.clientY - d.startY) / zoom;
      setModel((m) => ({
        ...m,
        tables: m.tables.map((t) =>
          t.id === d.tableId
            ? { ...t, x: Math.max(0, Math.round(d.origX + dx)), y: Math.max(0, Math.round(d.origY + dy)) }
            : t
        ),
      }));
    }
  };

  const onCanvasMouseUp = () => {
    dragRef.current = null;
  };

  const selectedTable = model.tables.find((t) => t.id === selectedTableId) ?? null;
  const selectedRel = model.relationships.find((r) => r.id === selectedRelId) ?? null;

  const updateSelectedTable = (patch: Partial<ErTableNode>) => {
    if (!selectedTableId) return;
    setModel((m) => ({
      ...m,
      tables: m.tables.map((t) =>
        t.id === selectedTableId ? { ...t, ...patch } : t
      ),
    }));
  };

  const updateSelectedRel = (patch: Partial<ErRelationship>) => {
    if (!selectedRelId) return;
    setModel((m) => ({
      ...m,
      relationships: m.relationships.map((r) =>
        r.id === selectedRelId ? { ...r, ...patch } : r
      ),
    }));
  };

  const tableMap = new Map(model.tables.map((t) => [t.id, t]));

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#1e1f22] text-xs overflow-hidden">
      {/* Top Toolbar */}
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex items-center justify-between gap-2 flex-wrap shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Network className="w-4 h-4 text-pink-400" />
          <input
            value={model.name}
            onChange={(e) => setModel((m) => ({ ...m, name: e.target.value }))}
            className="h-7 px-2 w-44 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-semibold"
          />
          <select
            value={connId}
            onChange={(e) => {
              setConnId(e.target.value);
              initConn(e.target.value);
            }}
            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
          >
            <option value="">Connection...</option>
            {sqlConns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {dbs.length > 0 && (
            <select
              value={effDb}
              onChange={(e) => setDatabase(e.target.value)}
              className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
            >
              {dbs.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          )}
          {schemas.length > 0 && (
            <select
              value={effSchema}
              onChange={(e) => setSchema(e.target.value)}
              className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
            >
              {schemas.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={handleReverseEngineer}
            disabled={loading || !connId}
            className="h-7 px-2.5 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium flex items-center gap-1 cursor-pointer"
          >
            <Database className="w-3.5 h-3.5" />
            <span>{loading ? "Loading..." : "Reverse Engineer"}</span>
          </button>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={handleAddTable}
            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center gap-1 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 text-emerald-400" /> Table
          </button>
          <button
            onClick={handleAddRelationship}
            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center gap-1 cursor-pointer"
          >
            <Link2 className="w-3.5 h-3.5 text-sky-400" /> Relation
          </button>
          <button
            onClick={handleAutoLayout}
            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center gap-1 cursor-pointer"
          >
            <LayoutGrid className="w-3.5 h-3.5" /> Auto-Layout
          </button>
          <button
            onClick={() => handleForwardEngineer(model.engine)}
            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center gap-1 cursor-pointer"
          >
            <Code2 className="w-3.5 h-3.5 text-amber-400" /> Forward SQL
          </button>
          <button
            onClick={handleSyncToDb}
            disabled={!connId || model.tables.length === 0}
            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#32343a] disabled:opacity-40 flex items-center gap-1 cursor-pointer"
          >
            <GitCompare className="w-3.5 h-3.5 text-orange-400" /> Sync to DB
          </button>
          <button
            onClick={handleSaveModel}
            className="h-7 px-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white flex items-center gap-1 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" /> Save
          </button>
          <button
            onClick={() => setShowModelsDrawer((v) => !v)}
            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center gap-1 cursor-pointer"
          >
            <FolderOpen className="w-3.5 h-3.5" /> Models ({savedModels.length})
          </button>
          <div className="flex items-center rounded border border-zinc-300 dark:border-[#3b3d44] overflow-hidden">
            <button
              onClick={handleExportSvg}
              title="Export SVG"
              className="h-7 px-2 hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center gap-1 cursor-pointer"
            >
              <Download className="w-3 h-3" /> SVG
            </button>
            <button
              onClick={handleExportPng}
              title="Export PNG"
              className="h-7 px-2 hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center gap-1 border-l border-zinc-300 dark:border-[#3b3d44] cursor-pointer"
            >
              <FileImage className="w-3 h-3" /> PNG
            </button>
            <button
              onClick={handleExportPdf}
              title="Export / Print PDF"
              className="h-7 px-2 hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center gap-1 border-l border-zinc-300 dark:border-[#3b3d44] cursor-pointer"
            >
              <Printer className="w-3 h-3" /> PDF
            </button>
          </div>
          <div className="flex items-center rounded border border-zinc-300 dark:border-[#3b3d44] overflow-hidden">
            <button
              onClick={() => zoomAtPoint(zoomRef.current - 0.15)}
              title="Zoom Out (Ctrl+-)"
              className="h-7 px-1.5 hover:bg-zinc-200 dark:hover:bg-[#32343a] cursor-pointer"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => zoomAtPoint(1)}
              title="Reset zoom to 100% (Ctrl+0)"
              className="h-7 px-1.5 font-mono text-[0.7rem] hover:bg-zinc-200 dark:hover:bg-[#32343a] cursor-pointer"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              onClick={() => zoomAtPoint(zoomRef.current + 0.15)}
              title="Zoom In (Ctrl++)"
              className="h-7 px-1.5 hover:bg-zinc-200 dark:hover:bg-[#32343a] cursor-pointer"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleFitToView}
              title="Fit to View"
              className="h-7 px-1.5 border-l border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#32343a] cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mx-3 mt-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Workspace Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden relative">
        {/* Saved Models Drawer */}
        {showModelsDrawer && (
          <div className="w-60 border-r border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#23252a] p-2.5 overflow-y-auto shrink-0 space-y-2">
            <div className="flex items-center justify-between font-semibold">
              <span>Saved ER Models</span>
              <button onClick={() => setShowModelsDrawer(false)}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {savedModels.length === 0 ? (
              <div className="text-zinc-500 py-4 text-center">No saved models yet.</div>
            ) : (
              savedModels.map((m) => (
                <div
                  key={m.id}
                  className="p-2 rounded border border-zinc-200 dark:border-[#35373c] bg-white dark:bg-[#1e1f22] flex items-center justify-between gap-1"
                >
                  <button
                    onClick={() => {
                      setModel(m);
                      setSelectedTableId(null);
                      setSelectedRelId(null);
                      setShowModelsDrawer(false);
                    }}
                    className="text-left flex-1 min-w-0 cursor-pointer"
                  >
                    <div className="font-semibold truncate">{m.name}</div>
                    <div className="text-[0.68rem] text-zinc-500">
                      {m.tables.length} tables · {m.relationships.length} rels
                    </div>
                  </button>
                  <button
                    onClick={async () => {
                      await api.deleteErModel(m.id);
                      refreshSavedModels();
                    }}
                    className="p-1 text-zinc-400 hover:text-red-400 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* Interactive Canvas */}
        <div
          ref={canvasRef}
          className="flex-1 relative overflow-hidden bg-[#16171a] select-none cursor-grab active:cursor-grabbing"
          style={{
            backgroundImage:
              "radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)",
            backgroundSize: `${20 * zoom}px ${20 * zoom}px`,
            backgroundPosition: `${pan.x}px ${pan.y}px`,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedTableId(null);
              setSelectedRelId(null);
              dragRef.current = {
                kind: "pan",
                startX: e.clientX,
                startY: e.clientY,
                origX: pan.x,
                origY: pan.y,
              };
            }
          }}
          onMouseMove={onCanvasMouseMove}
          onMouseUp={onCanvasMouseUp}
          onMouseLeave={onCanvasMouseUp}
        >
          {model.tables.length === 0 && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 gap-2 pointer-events-none">
              <Network className="w-10 h-10 opacity-30" />
              <p className="text-sm font-medium text-zinc-400">
                Visual ER Diagram Canvas
              </p>
              <p className="text-xs">
                Click <strong>Reverse Engineer</strong> to pull a live schema, or{" "}
                <strong>+ Table</strong> to model from scratch.
              </p>
            </div>
          )}

          <div
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "0 0",
            }}
            className="absolute inset-0"
          >
            {/* Crow's Foot Relationship SVG Layer */}
            <svg
              className="absolute inset-0 overflow-visible pointer-events-none"
              width="4000"
              height="4000"
            >
              <defs>
                <marker
                  id="crow-many"
                  viewBox="0 0 12 12"
                  refX="10"
                  refY="6"
                  markerWidth="10"
                  markerHeight="10"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M 0 6 L 12 1 M 0 6 L 12 6 M 0 6 L 12 11"
                    stroke="#818cf8"
                    strokeWidth="1.5"
                    fill="none"
                  />
                </marker>
                <marker
                  id="crow-one"
                  viewBox="0 0 10 12"
                  refX="6"
                  refY="6"
                  markerWidth="8"
                  markerHeight="10"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M 5 1 L 5 11 M 8 1 L 8 11"
                    stroke="#818cf8"
                    strokeWidth="1.5"
                    fill="none"
                  />
                </marker>
              </defs>
              {model.relationships.map((rel) => {
                const s = tableMap.get(rel.sourceTableId);
                const t = tableMap.get(rel.targetTableId);
                if (!s || !t) return null;
                const sColIdx = Math.max(
                  0,
                  s.columns.findIndex((c) => c.name === rel.sourceColumn)
                );
                const tColIdx = Math.max(
                  0,
                  t.columns.findIndex((c) => c.name === rel.targetColumn)
                );
                const sRight = s.x + CARD_WIDTH;
                const tRight = t.x + CARD_WIDTH;
                const x1 = s.x < t.x ? sRight : s.x;
                const x2 = s.x < t.x ? t.x : tRight;
                const y1 = s.y + HEADER_H + 14 + sColIdx * ROW_H;
                const y2 = t.y + HEADER_H + 14 + tColIdx * ROW_H;
                const cx = (x1 + x2) / 2;
                const isSel = rel.id === selectedRelId;
                const startMarker =
                  rel.cardinality === "one_to_one"
                    ? "url(#crow-one)"
                    : "url(#crow-many)";
                const endMarker =
                  rel.cardinality === "many_to_many"
                    ? "url(#crow-many)"
                    : "url(#crow-one)";
                const cardLabel =
                  rel.cardinality === "one_to_one"
                    ? "1 : 1"
                    : rel.cardinality === "many_to_many"
                    ? "N : M"
                    : "N : 1";

                return (
                  <g
                    key={rel.id}
                    className="pointer-events-auto cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedRelId(rel.id);
                      setSelectedTableId(null);
                    }}
                  >
                    <path
                      d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
                      fill="none"
                      stroke={isSel ? "#f472b6" : "#818cf8"}
                      strokeWidth={isSel ? 3 : 2}
                      markerStart={startMarker}
                      markerEnd={endMarker}
                    />
                    <rect
                      x={cx - 22}
                      y={(y1 + y2) / 2 - 10}
                      width="44"
                      height="18"
                      rx="4"
                      fill="#1e1f22"
                      stroke={isSel ? "#f472b6" : "#4f46e5"}
                      strokeWidth="1"
                    />
                    <text
                      x={cx}
                      y={(y1 + y2) / 2 + 3}
                      textAnchor="middle"
                      fill="#e0e7ff"
                      fontSize="10"
                      fontFamily="monospace"
                    >
                      {cardLabel}
                    </text>
                  </g>
                );
              })}
            </svg>

            {/* Draggable Table Entity Cards */}
            {model.tables.map((t) => {
              const isSel = t.id === selectedTableId;
              const fkCols = new Set(
                model.relationships
                  .filter((r) => r.sourceTableId === t.id)
                  .map((r) => r.sourceColumn)
              );
              return (
                <div
                  key={t.id}
                  style={{ left: t.x, top: t.y, width: CARD_WIDTH }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    setSelectedTableId(t.id);
                    setSelectedRelId(null);
                    dragRef.current = {
                      kind: "table",
                      tableId: t.id,
                      startX: e.clientX,
                      startY: e.clientY,
                      origX: t.x,
                      origY: t.y,
                    };
                  }}
                  className={`absolute rounded-md overflow-hidden bg-[#23252a] shadow-lg border transition-shadow ${
                    isSel
                      ? "border-pink-500 ring-2 ring-pink-500/40 z-20"
                      : "border-[#3a3c44] z-10"
                  }`}
                >
                  <div
                    style={{ backgroundColor: t.color || "#3b82f6" }}
                    className="h-[34px] px-2.5 flex items-center justify-between text-white font-semibold cursor-move"
                  >
                    <span className="truncate font-mono text-[0.78rem]">
                      {t.name}
                    </span>
                    {t.group && (
                      <span className="text-[0.6rem] bg-black/25 px-1.5 py-0.5 rounded">
                        {t.group}
                      </span>
                    )}
                  </div>
                  <div className="py-1 divide-y divide-zinc-800/70">
                    {t.columns.map((c, idx) => (
                      <div
                        key={idx}
                        className="h-[24px] px-2.5 flex items-center justify-between gap-2 text-[0.72rem]"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          {c.isPrimaryKey ? (
                            <KeyRound className="w-3 h-3 text-amber-400 shrink-0" />
                          ) : fkCols.has(c.name) ? (
                            <Link2 className="w-3 h-3 text-indigo-400 shrink-0" />
                          ) : (
                            <span className="w-3 inline-block shrink-0" />
                          )}
                          <span
                            className={`font-mono truncate ${
                              c.isPrimaryKey
                                ? "text-amber-200 font-semibold"
                                : "text-zinc-200"
                            }`}
                          >
                            {c.name}
                          </span>
                        </div>
                        <span className="font-mono text-[0.66rem] text-zinc-400 shrink-0">
                          {c.dataType}
                          {c.length ? `(${c.length})` : ""}
                          {c.nullable ? "?" : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Property Inspector for Selected Table or Relationship */}
        {(selectedTable || selectedRel) && (
          <div className="w-80 border-l border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#23252a] p-3 overflow-y-auto shrink-0 space-y-3">
            {selectedTable && (
              <>
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">Table Inspector</span>
                  <button
                    onClick={() => {
                      setModel((m) => ({
                        ...m,
                        tables: m.tables.filter((t) => t.id !== selectedTable.id),
                        relationships: m.relationships.filter(
                          (r) =>
                            r.sourceTableId !== selectedTable.id &&
                            r.targetTableId !== selectedTable.id
                        ),
                      }));
                      setSelectedTableId(null);
                    }}
                    className="text-red-400 hover:text-red-300 flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                </div>

                <div className="space-y-2">
                  <label className="block">
                    <span className="text-zinc-400 text-[0.68rem]">Table Name</span>
                    <input
                      value={selectedTable.name}
                      onChange={(e) => updateSelectedTable({ name: e.target.value })}
                      className="mt-0.5 w-full h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-zinc-400 text-[0.68rem]">Group</span>
                      <input
                        value={selectedTable.group ?? ""}
                        onChange={(e) =>
                          updateSelectedTable({ group: e.target.value || null })
                        }
                        placeholder="e.g. Billing"
                        className="mt-0.5 w-full h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                      />
                    </label>
                    <div>
                      <span className="text-zinc-400 text-[0.68rem]">Color</span>
                      <div className="mt-1 flex items-center gap-1">
                        {TABLE_COLORS.map((col) => (
                          <button
                            key={col}
                            onClick={() => updateSelectedTable({ color: col })}
                            style={{ backgroundColor: col }}
                            className={`w-4 h-4 rounded-full cursor-pointer ${
                              selectedTable.color === col ? "ring-2 ring-white" : ""
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t border-zinc-200 dark:border-[#32343a] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">
                      Columns ({selectedTable.columns.length})
                    </span>
                    <button
                      onClick={() =>
                        updateSelectedTable({
                          columns: [
                            ...selectedTable.columns,
                            {
                              name: `col_${selectedTable.columns.length + 1}`,
                              dataType: "VARCHAR",
                              length: "255",
                              nullable: true,
                              isPrimaryKey: false,
                              isAutoIncrement: false,
                            },
                          ],
                        })
                      }
                      className="text-indigo-400 hover:underline flex items-center gap-0.5 cursor-pointer"
                    >
                      <Plus className="w-3 h-3" /> Add Column
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {selectedTable.columns.map((c, idx) => (
                      <div
                        key={idx}
                        className="p-2 rounded border border-zinc-200 dark:border-[#35373c] bg-white dark:bg-[#1e1f22] space-y-1.5"
                      >
                        <div className="flex items-center gap-1">
                          <input
                            value={c.name}
                            onChange={(e) => {
                              const cols = [...selectedTable.columns];
                              cols[idx] = { ...c, name: e.target.value };
                              updateSelectedTable({ columns: cols });
                            }}
                            className="flex-1 h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-transparent font-mono"
                          />
                          <button
                            onClick={() =>
                              updateSelectedTable({
                                columns: selectedTable.columns.filter((_, i) => i !== idx),
                              })
                            }
                            className="text-zinc-400 hover:text-red-400 cursor-pointer"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <input
                            value={c.dataType}
                            onChange={(e) => {
                              const cols = [...selectedTable.columns];
                              cols[idx] = { ...c, dataType: e.target.value };
                              updateSelectedTable({ columns: cols });
                            }}
                            className="flex-1 h-6 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-transparent font-mono text-[0.7rem]"
                          />
                          <label className="flex items-center gap-1 text-[0.68rem]">
                            <input
                              type="checkbox"
                              checked={c.isPrimaryKey}
                              onChange={(e) => {
                                const cols = [...selectedTable.columns];
                                cols[idx] = { ...c, isPrimaryKey: e.target.checked };
                                updateSelectedTable({ columns: cols });
                              }}
                            />
                            PK
                          </label>
                          <label className="flex items-center gap-1 text-[0.68rem]">
                            <input
                              type="checkbox"
                              checked={c.nullable}
                              onChange={(e) => {
                                const cols = [...selectedTable.columns];
                                cols[idx] = { ...c, nullable: e.target.checked };
                                updateSelectedTable({ columns: cols });
                              }}
                            />
                            Null
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {selectedRel && (
              <>
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">Relationship Inspector</span>
                  <button
                    onClick={() => {
                      setModel((m) => ({
                        ...m,
                        relationships: m.relationships.filter(
                          (r) => r.id !== selectedRel.id
                        ),
                      }));
                      setSelectedRelId(null);
                    }}
                    className="text-red-400 hover:text-red-300 flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </button>
                </div>

                <label className="block">
                  <span className="text-zinc-400 text-[0.68rem]">Constraint Name</span>
                  <input
                    value={selectedRel.name}
                    onChange={(e) => updateSelectedRel({ name: e.target.value })}
                    className="mt-0.5 w-full h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                  />
                </label>

                <label className="block">
                  <span className="text-zinc-400 text-[0.68rem]">Cardinality</span>
                  <select
                    value={selectedRel.cardinality}
                    onChange={(e) =>
                      updateSelectedRel({
                        cardinality: e.target.value as ErCardinality,
                      })
                    }
                    className="mt-0.5 w-full h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                  >
                    <option value="one_to_one">1 : 1 (One to One)</option>
                    <option value="one_to_many">N : 1 (Many to One / 1:N)</option>
                    <option value="many_to_many">N : M (Many to Many)</option>
                  </select>
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-zinc-400 text-[0.68rem]">Source Table</span>
                    <select
                      value={selectedRel.sourceTableId}
                      onChange={(e) =>
                        updateSelectedRel({ sourceTableId: e.target.value })
                      }
                      className="mt-0.5 w-full h-7 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                    >
                      {model.tables.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-zinc-400 text-[0.68rem]">Source Column</span>
                    <input
                      value={selectedRel.sourceColumn}
                      onChange={(e) =>
                        updateSelectedRel({ sourceColumn: e.target.value })
                      }
                      className="mt-0.5 w-full h-7 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-zinc-400 text-[0.68rem]">Target Table</span>
                    <select
                      value={selectedRel.targetTableId}
                      onChange={(e) =>
                        updateSelectedRel({ targetTableId: e.target.value })
                      }
                      className="mt-0.5 w-full h-7 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                    >
                      {model.tables.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-zinc-400 text-[0.68rem]">Target Column</span>
                    <input
                      value={selectedRel.targetColumn}
                      onChange={(e) =>
                        updateSelectedRel({ targetColumn: e.target.value })
                      }
                      className="mt-0.5 w-full h-7 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                    />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-zinc-400 text-[0.68rem]">ON UPDATE</span>
                    <select
                      value={selectedRel.onUpdate}
                      onChange={(e) => updateSelectedRel({ onUpdate: e.target.value })}
                      className="mt-0.5 w-full h-7 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                    >
                      <option value="NO ACTION">NO ACTION</option>
                      <option value="CASCADE">CASCADE</option>
                      <option value="RESTRICT">RESTRICT</option>
                      <option value="SET NULL">SET NULL</option>
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-zinc-400 text-[0.68rem]">ON DELETE</span>
                    <select
                      value={selectedRel.onDelete}
                      onChange={(e) => updateSelectedRel({ onDelete: e.target.value })}
                      className="mt-0.5 w-full h-7 px-1.5 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                    >
                      <option value="NO ACTION">NO ACTION</option>
                      <option value="CASCADE">CASCADE</option>
                      <option value="RESTRICT">RESTRICT</option>
                      <option value="SET NULL">SET NULL</option>
                    </select>
                  </label>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Forward Engineering SQL Modal */}
      {ddlPreview !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setDdlPreview(null)}
        >
          <div
            className="w-full max-w-3xl max-h-[80vh] flex flex-col rounded-md border border-zinc-700 bg-[#1e1f22] overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
              <span className="font-semibold text-sm">
                Forward Engineered DDL ({model.engine.toUpperCase()})
              </span>
              <div className="flex items-center gap-2">
                {(["postgres", "mysql", "mssql"] as DbEngine[]).map((eng) => (
                  <button
                    key={eng}
                    onClick={() => {
                      setModel((m) => ({ ...m, engine: eng }));
                      handleForwardEngineer(eng);
                    }}
                    className={`px-2 py-0.5 rounded uppercase text-[0.68rem] cursor-pointer ${
                      model.engine === eng
                        ? "bg-indigo-600 text-white"
                        : "bg-zinc-800 text-zinc-400"
                    }`}
                  >
                    {eng}
                  </button>
                ))}
                <button
                  onClick={() => {
                    openTab({
                      kind: "query",
                      title: `${model.name} DDL`,
                      connectionId: connId || undefined,
                      database: effDb || undefined,
                      sql: ddlPreview,
                    });
                    setDdlPreview(null);
                  }}
                  className="px-2.5 py-1 rounded bg-emerald-600 text-white cursor-pointer"
                >
                  Open in Query Editor
                </button>
                <button onClick={() => setDdlPreview(null)}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 font-mono text-xs bg-zinc-950 text-emerald-300 whitespace-pre-wrap">
              {ddlPreview || "-- No tables in model."}
            </pre>
          </div>
        </div>
      )}

      {/* Sync Model to Live DB Modal */}
      {syncPlan && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setSyncPlan(null)}
        >
          <div
            className="w-full max-w-3xl max-h-[80vh] flex flex-col rounded-md border border-zinc-700 bg-[#1e1f22] overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
              <span className="font-semibold text-sm">
                Sync ER Model to DB — {syncPlan.summary}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (conn?.environment === "production") {
                      openSafetyModal({
                        title: "Sync ER Model to PRODUCTION",
                        warnings: [
                          `Target "${conn.name}" is PRODUCTION.`,
                          `Applying model diff will modify live database structure.`,
                        ],
                        sqlPreview: syncPlan.fullScript,
                        onConfirm: () => applyModelSync(true),
                      });
                    } else {
                      applyModelSync(false);
                    }
                  }}
                  disabled={!syncPlan.fullScript.trim()}
                  className="px-3 py-1 rounded bg-emerald-600 disabled:opacity-40 text-white cursor-pointer"
                >
                  Apply to DB
                </button>
                <button onClick={() => setSyncPlan(null)}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto p-4 font-mono text-xs bg-zinc-950 text-amber-300 whitespace-pre-wrap">
              {syncPlan.fullScript || "-- Target database already matches this ER model."}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
