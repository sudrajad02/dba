import React, { useCallback, useEffect, useState } from "react";
import {
  BarChart3,
  Download,
  FileImage,
  FolderOpen,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  ChartCardConfig,
  ChartDashboard,
  ChartType,
  QueryResultSet,
} from "../types/dba";

const SERIES_COLORS = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#06b6d4",
  "#8b5cf6",
  "#ef4444",
  "#84cc16",
];

function makeId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildChartSvgString(
  chart: ChartCardConfig,
  rs: QueryResultSet
): string {
  const w = 640;
  const h = 300;
  const padL = 56;
  const padR = 20;
  const padT = 26;
  const padB = 46;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const colIdx = new Map(rs.columns.map((c, i) => [c.name, i]));
  const xIdx = colIdx.get(chart.xColumn) ?? 0;
  const yCols =
    chart.yColumns.length > 0
      ? chart.yColumns
      : rs.columns.slice(1, 2).map((c) => c.name);
  const yIdxs = yCols.map((y) => colIdx.get(y) ?? 1);
  const rows = rs.rows.slice(0, 60);

  if (rows.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#18191c"/><text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="#a1a1aa" font-family="sans-serif" font-size="13">No rows returned</text></svg>`;
  }

  if (chart.chartType === "kpi") {
    const val = rows[0]?.[yIdxs[0] ?? 0] ?? rows[0]?.[0] ?? 0;
    const label = yCols[0] || rs.columns[0]?.name || "Value";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <rect width="100%" height="100%" fill="#18191c"/>
      <text x="${w / 2}" y="${h / 2 - 14}" text-anchor="middle" fill="#a1a1aa" font-family="sans-serif" font-size="14">${escXml(label)}</text>
      <text x="${w / 2}" y="${h / 2 + 34}" text-anchor="middle" fill="#34d399" font-family="monospace" font-weight="bold" font-size="48">${escXml(String(val))}</text>
    </svg>`;
  }

  if (chart.chartType === "pie" || chart.chartType === "donut") {
    const cx = w * 0.36;
    const cy = h * 0.52;
    const r = Math.min(w, h) * 0.36;
    const innerR = chart.chartType === "donut" ? r * 0.52 : 0;
    const items = rows.slice(0, 12).map((row, idx) => ({
      label: String(row[xIdx] ?? `#${idx + 1}`),
      value: Math.max(0, toNum(row[yIdxs[0] ?? 1])),
      color: SERIES_COLORS[idx % SERIES_COLORS.length],
    }));
    const total = items.reduce((acc, it) => acc + it.value, 0) || 1;
    let angle = -Math.PI / 2;
    const slices = items
      .map((it) => {
        const sweep = (it.value / total) * Math.PI * 2;
        const a1 = angle;
        const a2 = angle + sweep;
        angle = a2;
        const x1 = cx + r * Math.cos(a1);
        const y1 = cy + r * Math.sin(a1);
        const x2 = cx + r * Math.cos(a2);
        const y2 = cy + r * Math.sin(a2);
        const large = sweep > Math.PI ? 1 : 0;
        if (innerR > 0) {
          const ix1 = cx + innerR * Math.cos(a2);
          const iy1 = cy + innerR * Math.sin(a2);
          const ix2 = cx + innerR * Math.cos(a1);
          const iy2 = cy + innerR * Math.sin(a1);
          return `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${innerR} ${innerR} 0 ${large} 0 ${ix2} ${iy2} Z" fill="${it.color}"><title>${escXml(it.label)}: ${it.value}</title></path>`;
        }
        return `<path d="M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z" fill="${it.color}"><title>${escXml(it.label)}: ${it.value}</title></path>`;
      })
      .join("\n");

    const legend = items
      .map((it, i) => {
        const ly = 36 + i * 20;
        const pct = ((it.value / total) * 100).toFixed(1);
        return `<rect x="${w * 0.68}" y="${ly - 9}" width="10" height="10" rx="2" fill="${it.color}"/>
        <text x="${w * 0.68 + 16}" y="${ly}" fill="#e4e4e7" font-family="sans-serif" font-size="11">${escXml(it.label.slice(0, 18))} (${pct}%)</text>`;
      })
      .join("\n");

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <rect width="100%" height="100%" fill="#18191c"/>
      ${slices}
      ${legend}
    </svg>`;
  }

  // Cartesian charts: bar, stacked_bar, line, area, scatter
  let maxVal = 1;
  if (chart.chartType === "stacked_bar") {
    for (const row of rows) {
      const sum = yIdxs.reduce((acc, yi) => acc + Math.max(0, toNum(row[yi])), 0);
      if (sum > maxVal) maxVal = sum;
    }
  } else {
    for (const row of rows) {
      for (const yi of yIdxs) {
        const v = toNum(row[yi]);
        if (v > maxVal) maxVal = v;
      }
    }
  }

  // Gridlines & Y labels
  const ticks = 4;
  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const val = (maxVal / ticks) * i;
    const y = padT + plotH - (i / ticks) * plotH;
    grid += `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="#2e3038" stroke-width="1"/>`;
    grid += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" fill="#a1a1aa" font-family="monospace" font-size="10">${Math.round(val * 100) / 100}</text>`;
  }

  // X labels
  const stepX = plotW / Math.max(rows.length, 1);
  const labelEvery = Math.max(1, Math.ceil(rows.length / 8));
  let xLabels = "";
  rows.forEach((row, i) => {
    if (i % labelEvery === 0) {
      const x = padL + i * stepX + stepX / 2;
      const txt = String(row[xIdx] ?? "").slice(0, 12);
      xLabels += `<text x="${x}" y="${h - 14}" text-anchor="middle" fill="#a1a1aa" font-family="monospace" font-size="10">${escXml(txt)}</text>`;
    }
  });

  let shapes = "";
  if (chart.chartType === "bar") {
    const groupW = stepX * 0.78;
    const barW = Math.max(3, groupW / Math.max(yIdxs.length, 1));
    rows.forEach((row, i) => {
      const gx = padL + i * stepX + (stepX - groupW) / 2;
      yIdxs.forEach((yi, si) => {
        const val = Math.max(0, toNum(row[yi]));
        const bh = (val / maxVal) * plotH;
        const bx = gx + si * barW;
        const by = padT + plotH - bh;
        shapes += `<rect x="${bx}" y="${by}" width="${Math.max(2, barW - 2)}" height="${bh}" rx="2" fill="${SERIES_COLORS[si % SERIES_COLORS.length]}"><title>${escXml(String(row[xIdx] ?? ""))} · ${escXml(yCols[si] ?? "")}: ${val}</title></rect>`;
      });
    });
  } else if (chart.chartType === "stacked_bar") {
    const barW = Math.max(4, stepX * 0.65);
    rows.forEach((row, i) => {
      const bx = padL + i * stepX + (stepX - barW) / 2;
      let accH = 0;
      yIdxs.forEach((yi, si) => {
        const val = Math.max(0, toNum(row[yi]));
        const bh = (val / maxVal) * plotH;
        const by = padT + plotH - accH - bh;
        accH += bh;
        shapes += `<rect x="${bx}" y="${by}" width="${barW}" height="${bh}" fill="${SERIES_COLORS[si % SERIES_COLORS.length]}"><title>${escXml(String(row[xIdx] ?? ""))} · ${escXml(yCols[si] ?? "")}: ${val}</title></rect>`;
      });
    });
  } else if (chart.chartType === "scatter") {
    rows.forEach((row, i) => {
      const cx = padL + i * stepX + stepX / 2;
      yIdxs.forEach((yi, si) => {
        const val = toNum(row[yi]);
        const cy = padT + plotH - (val / maxVal) * plotH;
        shapes += `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${SERIES_COLORS[si % SERIES_COLORS.length]}" opacity="0.85"><title>${escXml(String(row[xIdx] ?? ""))}: ${val}</title></circle>`;
      });
    });
  } else {
    // Line / Area
    yIdxs.forEach((yi, si) => {
      const color = SERIES_COLORS[si % SERIES_COLORS.length];
      const pts = rows.map((row, i) => {
        const x = padL + i * stepX + stepX / 2;
        const y = padT + plotH - (toNum(row[yi]) / maxVal) * plotH;
        return [x, y] as const;
      });
      const d = pts.map(([x, y], idx) => `${idx === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
      if (chart.chartType === "area" && pts.length > 0) {
        const areaD = `${d} L ${pts[pts.length - 1][0]} ${padT + plotH} L ${pts[0][0]} ${padT + plotH} Z`;
        shapes += `<path d="${areaD}" fill="${color}" fill-opacity="0.22"/>`;
      }
      shapes += `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.2"/>`;
      pts.forEach(([x, y], i) => {
        shapes += `<circle cx="${x}" cy="${y}" r="3" fill="${color}"><title>${escXml(String(rows[i][xIdx] ?? ""))} · ${escXml(yCols[si] ?? "")}: ${toNum(rows[i][yi])}</title></circle>`;
      });
    });
  }

  // Top legend
  const legend = yCols
    .map(
      (col, si) =>
        `<rect x="${padL + si * 115}" y="6" width="10" height="10" rx="2" fill="${SERIES_COLORS[si % SERIES_COLORS.length]}"/>
        <text x="${padL + si * 115 + 14}" y="15" fill="#d4d4d8" font-family="sans-serif" font-size="11">${escXml(col.slice(0, 14))}</text>`
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="100%" height="100%" fill="#18191c"/>
    ${grid}
    ${shapes}
    ${xLabels}
    ${legend}
  </svg>`;
}

export const ChartDashboardBuilder: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
  const { connections, connectedIds, savedQueries, connectTo, addLog } =
    useWorkbenchStore();

  const [dashboards, setDashboards] = useState<ChartDashboard[]>([]);
  const [dashboard, setDashboard] = useState<ChartDashboard>({
    id: makeId(),
    name: "Analytics Dashboard",
    description: "",
    charts: [],
    updatedAt: new Date().toISOString(),
  });
  const [resultsByChart, setResultsByChart] = useState<Record<string, QueryResultSet>>({});
  const [errorsByChart, setErrorsByChart] = useState<Record<string, string>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [editingChartId, setEditingChartId] = useState<string | null>(null);
  const [showDrawer, setShowDrawer] = useState(false);

  const refreshDashboards = useCallback(async () => {
    try {
      const list = await api.listDashboards();
      setDashboards(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    refreshDashboards();
  }, [refreshDashboards]);

  const runChart = async (chart: ChartCardConfig) => {
    if (!chart.connectionId || !chart.sql.trim()) return;
    setLoadingIds((s) => new Set(s).add(chart.id));
    setErrorsByChart((prev) => {
      const next = { ...prev };
      delete next[chart.id];
      return next;
    });
    try {
      if (!connectedIds.has(chart.connectionId)) {
        await connectTo(chart.connectionId);
      }
      const res = await api.executeQuery(
        chart.connectionId,
        chart.sql,
        chart.database || undefined,
        undefined,
        false
      );
      const rs = res.resultSets[0];
      if (rs) {
        setResultsByChart((prev) => ({ ...prev, [chart.id]: rs }));
        // Auto-select X/Y columns if unset
        if (!chart.xColumn && rs.columns.length > 0) {
          const xCol = rs.columns[0].name;
          const yCol = rs.columns[1]?.name ?? rs.columns[0].name;
          setDashboard((d) => ({
            ...d,
            charts: d.charts.map((c) =>
              c.id === chart.id
                ? { ...c, xColumn: xCol, yColumns: c.yColumns.length ? c.yColumns : [yCol] }
                : c
            ),
          }));
        }
      }
    } catch (e) {
      setErrorsByChart((prev) => ({ ...prev, [chart.id]: formatApiError(e) }));
    } finally {
      setLoadingIds((s) => {
        const next = new Set(s);
        next.delete(chart.id);
        return next;
      });
    }
  };

  const handleRefreshAll = async () => {
    for (const c of dashboard.charts) {
      await runChart(c);
    }
    addLog("info", `Refreshed ${dashboard.charts.length} chart(s) in "${dashboard.name}".`);
  };

  const handleAddChart = () => {
    const defaultConn =
      connections.find((c) => c.id === tab.connectionId) ?? connections[0];
    const newChart: ChartCardConfig = {
      id: makeId(),
      title: `Chart #${dashboard.charts.length + 1}`,
      chartType: "bar",
      connectionId: defaultConn?.id ?? "",
      database: tab.database ?? defaultConn?.database ?? null,
      savedQueryPath: null,
      sql: "SELECT 'Jan' AS month, 120 AS sales, 80 AS profit\nUNION ALL SELECT 'Feb', 180, 110\nUNION ALL SELECT 'Mar', 240, 155;",
      xColumn: "month",
      yColumns: ["sales", "profit"],
      seriesColumn: null,
      colSpan: 1,
    };
    setDashboard((d) => ({ ...d, charts: [...d.charts, newChart] }));
    setEditingChartId(newChart.id);
  };

  const handleSaveDashboard = async () => {
    try {
      const saved = await api.saveDashboard(dashboard);
      setDashboard(saved);
      await refreshDashboards();
      addLog("success", `Saved dashboard "${saved.name}" to workspace/charts/.`);
    } catch (e) {
      addLog("error", formatApiError(e));
    }
  };

  const exportChartSvg = (chart: ChartCardConfig) => {
    const rs = resultsByChart[chart.id];
    if (!rs) return;
    const svg = buildChartSvgString(chart, rs);
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${chart.title.replace(/\s+/g, "_")}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportChartPng = (chart: ChartCardConfig) => {
    const rs = resultsByChart[chart.id];
    if (!rs) return;
    const svg = buildChartSvgString(chart, rs);
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width * 2;
      canvas.height = img.height * 2;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0);
        const a = document.createElement("a");
        a.href = canvas.toDataURL("image/png");
        a.download = `${chart.title.replace(/\s+/g, "_")}.png`;
        a.click();
      }
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const editingChart =
    dashboard.charts.find((c) => c.id === editingChartId) ?? null;

  const updateChart = (id: string, patch: Partial<ChartCardConfig>) => {
    setDashboard((d) => ({
      ...d,
      charts: d.charts.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#1e1f22] text-xs overflow-hidden">
      {/* Top Bar */}
      <div className="px-4 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex items-center justify-between gap-2 flex-wrap shrink-0">
        <div className="flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-cyan-400" />
          <input
            value={dashboard.name}
            onChange={(e) => setDashboard((d) => ({ ...d, name: e.target.value }))}
            className="h-7 px-2 w-52 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-semibold text-sm"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleAddChart}
            className="h-7 px-2.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-1 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" /> Add Chart
          </button>
          <button
            onClick={handleRefreshAll}
            disabled={dashboard.charts.length === 0}
            className="h-7 px-2.5 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium flex items-center gap-1 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh All
          </button>
          <button
            onClick={handleSaveDashboard}
            className="h-7 px-2.5 rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center gap-1 cursor-pointer"
          >
            <Save className="w-3.5 h-3.5 text-sky-400" /> Save
          </button>
          <button
            onClick={() => setShowDrawer((v) => !v)}
            className="h-7 px-2.5 rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center gap-1 cursor-pointer"
          >
            <FolderOpen className="w-3.5 h-3.5" /> Dashboards ({dashboards.length})
          </button>
        </div>
      </div>

      {/* Main Workspace */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Saved Dashboards Drawer */}
        {showDrawer && (
          <div className="w-60 border-r border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#23252a] p-2.5 overflow-y-auto shrink-0 space-y-2">
            <div className="flex items-center justify-between font-semibold">
              <span>Saved Dashboards</span>
              <button onClick={() => setShowDrawer(false)}>
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            {dashboards.length === 0 ? (
              <div className="text-zinc-500 text-center py-4">No saved dashboards.</div>
            ) : (
              dashboards.map((d) => (
                <div
                  key={d.id}
                  className="p-2 rounded border border-zinc-200 dark:border-[#35373c] bg-white dark:bg-[#1e1f22] flex items-center justify-between gap-1"
                >
                  <button
                    onClick={() => {
                      setDashboard(d);
                      setShowDrawer(false);
                      setEditingChartId(null);
                    }}
                    className="text-left flex-1 min-w-0 cursor-pointer"
                  >
                    <div className="font-semibold truncate">{d.name}</div>
                    <div className="text-[0.68rem] text-zinc-500">
                      {d.charts.length} chart(s)
                    </div>
                  </button>
                  <button
                    onClick={async () => {
                      await api.deleteDashboard(d.id);
                      refreshDashboards();
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

        {/* Chart Grid */}
        <div className="flex-1 overflow-y-auto p-4 bg-zinc-100/50 dark:bg-[#16171a]">
          {dashboard.charts.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-zinc-500 gap-2">
              <BarChart3 className="w-10 h-10 opacity-30" />
              <p className="text-sm font-medium text-zinc-400">
                Multi-Chart Analytics Dashboard
              </p>
              <p>
                Click <strong>+ Add Chart</strong> to bind a SQL query to Bar, Line, Area,
                Pie/Donut, Scatter, or KPI visualizations.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {dashboard.charts.map((chart) => {
                const rs = resultsByChart[chart.id];
                const err = errorsByChart[chart.id];
                const isBusy = loadingIds.has(chart.id);
                const svgHtml = rs ? buildChartSvgString(chart, rs) : null;
                return (
                  <div
                    key={chart.id}
                    className={`rounded-lg border overflow-hidden bg-white dark:bg-[#1e1f22] flex flex-col ${
                      editingChartId === chart.id
                        ? "border-indigo-500 ring-1 ring-indigo-500/40"
                        : "border-zinc-200 dark:border-[#35373c]"
                    } ${chart.colSpan === 2 ? "xl:col-span-2" : ""}`}
                  >
                    <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-semibold truncate">{chart.title}</span>
                        <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400 uppercase text-[0.62rem] font-semibold">
                          {chart.chartType.replace("_", " ")}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => runChart(chart)}
                          disabled={isBusy}
                          title="Run Query & Refresh Chart"
                          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-[#32343a] text-emerald-400 cursor-pointer"
                        >
                          <Play className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => exportChartSvg(chart)}
                          disabled={!rs}
                          title="Export SVG"
                          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-[#32343a] disabled:opacity-30 cursor-pointer"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => exportChartPng(chart)}
                          disabled={!rs}
                          title="Export PNG"
                          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-[#32343a] disabled:opacity-30 cursor-pointer"
                        >
                          <FileImage className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() =>
                            setEditingChartId(
                              editingChartId === chart.id ? null : chart.id
                            )
                          }
                          title="Configure Chart"
                          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-[#32343a] text-sky-400 cursor-pointer"
                        >
                          <Settings2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            setDashboard((d) => ({
                              ...d,
                              charts: d.charts.filter((c) => c.id !== chart.id),
                            }));
                            if (editingChartId === chart.id) setEditingChartId(null);
                          }}
                          title="Remove Chart"
                          className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-[#32343a] text-zinc-400 hover:text-red-400 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="p-2 min-h-[260px] flex items-center justify-center bg-[#18191c]">
                      {err ? (
                        <div className="p-3 text-red-400 text-center max-w-md">{err}</div>
                      ) : isBusy ? (
                        <div className="text-zinc-400 flex items-center gap-2">
                          <RefreshCw className="w-4 h-4 animate-spin" /> Running query...
                        </div>
                      ) : svgHtml ? (
                        <div
                          className="w-full"
                          dangerouslySetInnerHTML={{ __html: svgHtml }}
                        />
                      ) : (
                        <button
                          onClick={() => runChart(chart)}
                          className="px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1.5 cursor-pointer"
                        >
                          <Play className="w-3.5 h-3.5" /> Run Query to Render Chart
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Right Chart Config Inspector */}
        {editingChart && (
          <div className="w-80 border-l border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#23252a] p-3 overflow-y-auto shrink-0 space-y-3">
            <div className="flex items-center justify-between font-semibold text-sm">
              <span>Chart Settings</span>
              <button onClick={() => setEditingChartId(null)} className="cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1">
              <label className="text-zinc-400 block">Title</label>
              <input
                value={editingChart.title}
                onChange={(e) => updateChart(editingChart.id, { title: e.target.value })}
                className="w-full h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-zinc-400 block">Chart Type</label>
                <select
                  value={editingChart.chartType}
                  onChange={(e) =>
                    updateChart(editingChart.id, {
                      chartType: e.target.value as ChartType,
                    })
                  }
                  className="w-full h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                >
                  <option value="bar">Bar</option>
                  <option value="stacked_bar">Stacked Bar</option>
                  <option value="line">Line</option>
                  <option value="area">Area</option>
                  <option value="pie">Pie</option>
                  <option value="donut">Donut</option>
                  <option value="scatter">Scatter</option>
                  <option value="kpi">KPI Card</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-zinc-400 block">Card Width</label>
                <select
                  value={editingChart.colSpan}
                  onChange={(e) =>
                    updateChart(editingChart.id, { colSpan: Number(e.target.value) })
                  }
                  className="w-full h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                >
                  <option value={1}>Half Width (1 col)</option>
                  <option value={2}>Full Width (2 cols)</option>
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-zinc-400 block">Connection</label>
              <select
                value={editingChart.connectionId}
                onChange={(e) =>
                  updateChart(editingChart.id, { connectionId: e.target.value })
                }
                className="w-full h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
              >
                <option value="">Select Connection...</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.engine})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-zinc-400 block">Bind Saved Query (Optional)</label>
              <select
                value={editingChart.savedQueryPath ?? ""}
                onChange={(e) => {
                  const sq = savedQueries.find((q) => q.path === e.target.value);
                  if (sq) {
                    updateChart(editingChart.id, {
                      savedQueryPath: sq.path,
                      sql: sq.sql,
                      title: sq.name,
                    });
                  }
                }}
                className="w-full h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
              >
                <option value="">-- Custom SQL --</option>
                {savedQueries.map((q) => (
                  <option key={q.path} value={q.path}>
                    {q.folder ? `${q.folder}/${q.name}` : q.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-zinc-400 block">SQL Query</label>
              <textarea
                rows={5}
                value={editingChart.sql}
                onChange={(e) => updateChart(editingChart.id, { sql: e.target.value })}
                className="w-full p-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-[#1e1f22] text-emerald-300 font-mono text-[0.72rem]"
              />
            </div>

            <button
              onClick={() => runChart(editingChart)}
              className="w-full h-7 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" /> Execute & Preview
            </button>

            {/* Axis mapping */}
            {resultsByChart[editingChart.id] && (
              <div className="space-y-2 pt-2 border-t border-zinc-200 dark:border-[#32343a]">
                <div className="space-y-1">
                  <label className="text-zinc-400 block">X-Axis / Category Column</label>
                  <select
                    value={editingChart.xColumn}
                    onChange={(e) =>
                      updateChart(editingChart.id, { xColumn: e.target.value })
                    }
                    className="w-full h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                  >
                    {resultsByChart[editingChart.id].columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-zinc-400 block">Y-Axis / Value Series</label>
                  <div className="space-y-1 max-h-32 overflow-y-auto p-1.5 rounded border border-zinc-200 dark:border-[#35373c] bg-white dark:bg-[#1e1f22]">
                    {resultsByChart[editingChart.id].columns.map((c) => {
                      const checked = editingChart.yColumns.includes(c.name);
                      return (
                        <label
                          key={c.name}
                          className="flex items-center gap-2 cursor-pointer font-mono"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...editingChart.yColumns, c.name]
                                : editingChart.yColumns.filter((y) => y !== c.name);
                              updateChart(editingChart.id, { yColumns: next });
                            }}
                          />
                          <span>{c.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
