import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  FileCode2,
  FunctionSquare,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Trash2,
  Zap,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { buildNewObjectTemplateSql } from "../lib/objectTemplates";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type { DbEngine, ObjectKind, QueryResultSet } from "../types/dba";

type DesignerObjectKind = "function" | "procedure" | "trigger" | "view" | "materialized_view";

interface DraftParam {
  id: string;
  mode: "IN" | "OUT" | "INOUT";
  name: string;
  dataType: string;
  defaultValue: string;
}

const makeParamId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function quoteIdent(engine: DbEngine, ident: string): string {
  if (engine === "mysql") return `\`${ident.replace(/`/g, "``")}\``;
  if (engine === "mssql") return `[${ident.replace(/\]/g, "]]")}]`;
  return `"${ident.replace(/"/g, '""')}"`;
}

function qualifiedName(engine: DbEngine, schema: string | undefined, name: string): string {
  const clean = name.trim() || "new_object";
  if (schema && engine !== "mysql") {
    return `${quoteIdent(engine, schema)}.${quoteIdent(engine, clean)}`;
  }
  return quoteIdent(engine, clean);
}

function generateRoutineDdl(opts: {
  engine: DbEngine;
  schema?: string;
  kind: "function" | "procedure";
  name: string;
  returnType: string;
  language: string;
  params: DraftParam[];
}): string {
  const { engine, schema, kind, name, returnType, language, params } = opts;
  const fq = qualifiedName(engine, schema, name || (kind === "function" ? "new_function" : "new_procedure"));
  const ret = returnType.trim() || "INT";

  if (engine === "mysql") {
    const paramList = params
      .filter((p) => p.name.trim())
      .map((p) => {
        const dt = p.dataType.trim() || "INT";
        if (kind === "procedure") {
          return `${p.mode} ${quoteIdent("mysql", p.name.trim())} ${dt}`;
        }
        return `${quoteIdent("mysql", p.name.trim())} ${dt}`;
      })
      .join(", ");
    if (kind === "function") {
      return `CREATE FUNCTION ${fq}(${paramList})\nRETURNS ${ret}\nDETERMINISTIC\nBEGIN\n  RETURN NULL;\nEND;\n`;
    }
    return `CREATE PROCEDURE ${fq}(${paramList})\nBEGIN\n  SELECT 1;\nEND;\n`;
  }

  if (engine === "mssql") {
    const paramList = params
      .filter((p) => p.name.trim())
      .map((p) => {
        const rawName = p.name.trim().startsWith("@") ? p.name.trim() : `@${p.name.trim()}`;
        const dt = p.dataType.trim() || "INT";
        const outKw = kind === "procedure" && (p.mode === "OUT" || p.mode === "INOUT") ? " OUTPUT" : "";
        const defKw = p.defaultValue.trim() ? ` = ${p.defaultValue.trim()}` : "";
        return `  ${rawName} ${dt}${defKw}${outKw}`;
      })
      .join(",\n");
    if (kind === "function") {
      return `CREATE OR ALTER FUNCTION ${fq}(\n${paramList}\n)\nRETURNS ${ret}\nAS\nBEGIN\n  RETURN NULL;\nEND;\n`;
    }
    return `CREATE OR ALTER PROCEDURE ${fq}${paramList ? `\n${paramList}` : ""}\nAS\nBEGIN\n  SET NOCOUNT ON;\n  SELECT 1 AS result;\nEND;\n`;
  }

  // PostgreSQL
  const lang = language.trim() || "plpgsql";
  const paramList = params
    .filter((p) => p.name.trim())
    .map((p) => {
      const modePrefix = p.mode === "IN" ? "" : `${p.mode} `;
      const dt = p.dataType.trim() || "integer";
      const defKw = p.defaultValue.trim() ? ` DEFAULT ${p.defaultValue.trim()}` : "";
      return `${modePrefix}${p.name.trim()} ${dt}${defKw}`;
    })
    .join(", ");

  if (kind === "function") {
    return `CREATE OR REPLACE FUNCTION ${fq}(${paramList})\nRETURNS ${ret}\nLANGUAGE ${lang}\nAS $$\nBEGIN\n  RETURN NULL;\nEND;\n$$;\n`;
  }
  return `CREATE OR REPLACE PROCEDURE ${fq}(${paramList})\nLANGUAGE ${lang}\nAS $$\nBEGIN\n  RAISE NOTICE 'Executed %', '${name || "new_procedure"}';\nEND;\n$$;\n`;
}

function generateTriggerDdl(opts: {
  engine: DbEngine;
  schema?: string;
  name: string;
  targetTable: string;
  timing: "BEFORE" | "AFTER" | "INSTEAD OF";
  events: { insert: boolean; update: boolean; delete: boolean };
  forEach: "ROW" | "STATEMENT";
  whenClause: string;
}): string {
  const { engine, schema, name, targetTable, timing, events, forEach, whenClause } = opts;
  const trigName = name.trim() || "trg_new_trigger";
  const tblName = targetTable.trim() || "target_table";
  const fqTable = qualifiedName(engine, schema, tblName);

  const eventList: string[] = [];
  if (events.insert) eventList.push("INSERT");
  if (events.update) eventList.push("UPDATE");
  if (events.delete) eventList.push("DELETE");
  if (eventList.length === 0) eventList.push("INSERT");

  if (engine === "mysql") {
    const mysqlTiming = timing === "INSTEAD OF" ? "BEFORE" : timing;
    return `CREATE TRIGGER ${quoteIdent("mysql", trigName)}\n${mysqlTiming} ${eventList[0]} ON ${fqTable}\nFOR EACH ROW\nBEGIN\n  -- trigger body\nEND;\n`;
  }

  if (engine === "mssql") {
    const mssqlTiming = timing === "BEFORE" ? "INSTEAD OF" : timing;
    return `CREATE OR ALTER TRIGGER ${qualifiedName("mssql", schema, trigName)}\nON ${fqTable}\n${mssqlTiming} ${eventList.join(", ")}\nAS\nBEGIN\n  SET NOCOUNT ON;\n  -- trigger body\nEND;\n`;
  }

  // PostgreSQL
  const fnName = `${trigName}_fn`;
  const fqFn = qualifiedName("postgres", schema, fnName);
  const whenSql = whenClause.trim() ? `\nWHEN (${whenClause.trim()})` : "";
  return `-- 1. Trigger function\nCREATE OR REPLACE FUNCTION ${fqFn}()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$;\n\n-- 2. Trigger binding\nCREATE TRIGGER ${quoteIdent("postgres", trigName)}\n${timing} ${eventList.join(" OR ")} ON ${fqTable}\nFOR EACH ${forEach}${whenSql}\nEXECUTE FUNCTION ${fqFn}();\n`;
}

function generateViewDdl(opts: {
  engine: DbEngine;
  schema?: string;
  name: string;
  materialized: boolean;
  existingSql?: string;
}): string {
  const { engine, schema, name, materialized, existingSql } = opts;
  const fq = qualifiedName(engine, schema, name.trim() || "new_view");
  // Try preserving the SELECT body if user already edited it
  let selectBody = "SELECT 1 AS id;";
  if (existingSql) {
    const m = existingSql.match(/\bAS\s+([\s\S]+)$/i);
    if (m && m[1]?.trim()) {
      selectBody = m[1].trim();
    }
  }
  if (engine === "postgres" && materialized) {
    return `CREATE MATERIALIZED VIEW ${fq} AS\n${selectBody}\n`;
  }
  if (engine === "mssql") {
    return `CREATE OR ALTER VIEW ${fq} AS\n${selectBody}\n`;
  }
  return `CREATE OR REPLACE VIEW ${fq} AS\n${selectBody}\n`;
}

function extractViewSelect(ddl: string): string | null {
  const m = ddl.match(/\bAS\s+(SELECT[\s\S]+|WITH[\s\S]+)$/i);
  if (!m) return null;
  return m[1].trim().replace(/;+\s*$/, "");
}

export const ObjectScriptDesigner: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
  const {
    connections,
    theme,
    activeTabId,
    objectsByKey,
    updateTab,
    openTab,
    loadObjects,
    openSafetyModal,
    openExecuteRoutineModal,
    addLog,
  } = useWorkbenchStore();

  const conn = connections.find((c) => c.id === tab.connectionId) ?? null;
  const engine: DbEngine = conn?.engine ?? "postgres";
  const database = tab.database;
  const schema = tab.schema;

  const initialKind: DesignerObjectKind = (tab.objectKind ?? "function") as DesignerObjectKind;
  const [objectKind, setObjectKind] = useState<DesignerObjectKind>(initialKind);
  const [isNew, setIsNew] = useState<boolean>(tab.isNewObject ?? !tab.objectName);
  const [objectName, setObjectName] = useState<string>(
    tab.objectName ??
      (initialKind === "trigger"
        ? "trg_new_trigger"
        : initialKind === "view" || initialKind === "materialized_view"
        ? "new_view"
        : initialKind === "procedure"
        ? "new_procedure"
        : "new_function")
  );
  const [originalName, setOriginalName] = useState<string | undefined>(tab.objectName);

  // Routine metadata
  const [returnType, setReturnType] = useState<string>(engine === "postgres" ? "integer" : "INT");
  const [language, setLanguage] = useState<string>("plpgsql");
  const [params, setParams] = useState<DraftParam[]>([
    { id: makeParamId(), mode: "IN", name: "p_id", dataType: engine === "postgres" ? "integer" : "INT", defaultValue: "" },
  ]);

  // Trigger metadata
  const [targetTable, setTargetTable] = useState<string>("");
  const [timing, setTiming] = useState<"BEFORE" | "AFTER" | "INSTEAD OF">("AFTER");
  const [events, setEvents] = useState({ insert: true, update: false, delete: false });
  const [forEach, setForEach] = useState<"ROW" | "STATEMENT">("ROW");
  const [whenClause, setWhenClause] = useState<string>("");

  // View metadata
  const [isMaterialized, setIsMaterialized] = useState<boolean>(initialKind === "materialized_view");

  // Editor & UI state
  const [ddl, setDdl] = useState<string>(() => {
    if (tab.sql && tab.sql.trim()) return tab.sql;
    if (tab.isNewObject) {
      const k =
        initialKind === "materialized_view"
          ? "view"
          : (initialKind as "view" | "function" | "procedure" | "trigger");
      return buildNewObjectTemplateSql(engine, k, schema);
    }
    return "";
  });
  const [showMetaForm, setShowMetaForm] = useState<boolean>(tab.isNewObject ?? false);
  const [loadingDdl, setLoadingDdl] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // View preview state
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [previewResult, setPreviewResult] = useState<QueryResultSet | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  // Available tables for Trigger Target Table dropdown
  const tableOptions = useMemo(() => {
    if (!tab.connectionId || !database) return [];
    const key = `${tab.connectionId}::${database}::${schema ?? database}`;
    const objs = objectsByKey[key] ?? [];
    return objs.filter((o) => o.kind === "table").map((o) => o.name);
  }, [objectsByKey, tab.connectionId, database, schema]);

  useEffect(() => {
    if (objectKind === "trigger" && !targetTable && tableOptions.length > 0) {
      setTargetTable(tableOptions[0]);
    }
  }, [objectKind, targetTable, tableOptions]);

  // Keep-alive Monaco layout sync
  useEffect(() => {
    if (activeTabId === tab.id) {
      const id = requestAnimationFrame(() => {
        editorRef.current?.layout();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [activeTabId, tab.id, showMetaForm, previewResult]);

  // Load existing DDL & routine parameters when editing an existing object
  const loadExistingObject = useCallback(async () => {
    if (!tab.connectionId || !originalName || isNew) return;
    setLoadingDdl(true);
    setErrorMsg(null);
    try {
      const loadedDdl = await api.getObjectDdl(
        tab.connectionId,
        originalName,
        objectKind as ObjectKind,
        database,
        schema
      );
      setDdl(loadedDdl);
      updateTab(tab.id, { dirty: false });

      if (objectKind === "function" || objectKind === "procedure") {
        try {
          const sig = await api.getRoutineParameters(
            tab.connectionId,
            originalName,
            objectKind as ObjectKind,
            database,
            schema
          );
          if (sig.returnType) setReturnType(sig.returnType);
          if (sig.language) setLanguage(sig.language);
          setParams(
            sig.parameters.map((p) => ({
              id: makeParamId(),
              mode:
                p.mode === "OUT" || p.mode === "INOUT"
                  ? p.mode
                  : "IN",
              name: p.name,
              dataType: p.dataType,
              defaultValue: p.defaultValue ?? "",
            }))
          );
        } catch {
          // Introspection optional for edit form
        }
      }
    } catch (err) {
      setErrorMsg(formatApiError(err));
    } finally {
      setLoadingDdl(false);
    }
  }, [tab.connectionId, tab.id, originalName, isNew, objectKind, database, schema, updateTab]);

  useEffect(() => {
    if (!isNew && originalName && !tab.sql) {
      loadExistingObject();
    }
  }, [isNew, originalName, tab.sql, loadExistingObject]);

  // Sync metadata form -> SQL DDL
  const handleSyncMetaToSql = () => {
    let generated = "";
    if (objectKind === "function" || objectKind === "procedure") {
      generated = generateRoutineDdl({
        engine,
        schema,
        kind: objectKind,
        name: objectName,
        returnType,
        language,
        params,
      });
    } else if (objectKind === "trigger") {
      generated = generateTriggerDdl({
        engine,
        schema,
        name: objectName,
        targetTable: targetTable || tableOptions[0] || "target_table",
        timing,
        events,
        forEach,
        whenClause,
      });
    } else {
      generated = generateViewDdl({
        engine,
        schema,
        name: objectName,
        materialized: isMaterialized,
        existingSql: ddl,
      });
    }
    setDdl(generated);
    updateTab(tab.id, { dirty: true });
    setStatusMsg("Synchronized metadata form into SQL editor.");
  };

  // Save DDL to database
  const executeSave = useCallback(
    async (confirmedProduction: boolean) => {
      if (!conn || !tab.connectionId) return;
      if (!ddl.trim()) {
        setErrorMsg("DDL cannot be empty.");
        return;
      }
      setSaving(true);
      setErrorMsg(null);
      setStatusMsg(null);
      try {
        const effectiveKind: ObjectKind =
          objectKind === "view" && isMaterialized && engine === "postgres"
            ? "materialized_view"
            : (objectKind as ObjectKind);

        // Try inferring name from DDL if user edited SQL directly
        const inferredName = objectName.trim() || originalName || "object";

        await api.saveObjectDdl({
          connectionId: tab.connectionId,
          database: database ?? null,
          schema: schema ?? null,
          name: inferredName,
          kind: effectiveKind,
          isNew,
          ddl,
          originalName: originalName ?? null,
          confirmedProduction,
        });

        setIsNew(false);
        setOriginalName(inferredName);
        setStatusMsg(`Saved ${effectiveKind.replace("_", " ")} "${inferredName}" at ${new Date().toLocaleTimeString()}`);
        updateTab(tab.id, {
          title: `Design: ${inferredName}`,
          objectName: inferredName,
          objectKind: effectiveKind as DesignerObjectKind,
          isNewObject: false,
          dirty: false,
        });
        addLog("success", `Saved ${effectiveKind} "${inferredName}"`, ddl, true);

        if (database) {
          await loadObjects(tab.connectionId, database, schema ?? database);
        }
      } catch (err) {
        const msg = formatApiError(err);
        setErrorMsg(msg);
        addLog("error", `Failed to save ${objectKind}: ${msg}`);
      } finally {
        setSaving(false);
      }
    },
    [
      conn,
      tab.connectionId,
      tab.id,
      ddl,
      objectKind,
      isMaterialized,
      engine,
      objectName,
      originalName,
      database,
      schema,
      isNew,
      updateTab,
      addLog,
      loadObjects,
    ]
  );

  const handleSave = useCallback(() => {
    if (!conn) return;
    if (conn.readOnly) {
      setErrorMsg("Connection is in Read-Only Mode.");
      return;
    }
    if (conn.environment === "production") {
      openSafetyModal({
        title: `Save ${objectKind.toUpperCase()} "${objectName}" on PRODUCTION`,
        warnings: [
          `Target connection "${conn.name}" is marked PRODUCTION!`,
          isNew
            ? `This will create a new ${objectKind} in ${database ?? "default"}.`
            : engine === "mysql"
            ? `MySQL Safe Swap will DROP & RECREATE "${originalName ?? objectName}" (with automatic restore on error).`
            : `This will replace the existing ${objectKind} definition in ${database ?? "default"}.`,
        ],
        sqlPreview: ddl,
        onConfirm: () => {
          executeSave(true);
        },
      });
      return;
    }
    executeSave(false);
  }, [conn, objectKind, objectName, isNew, database, engine, originalName, ddl, openSafetyModal, executeSave]);

  // Preview View Data (LIMIT 100)
  const handlePreviewView = async () => {
    if (!tab.connectionId) return;
    const selectSql = extractViewSelect(ddl);
    const previewQuery = selectSql
      ? engine === "mssql"
        ? `SELECT TOP 100 * FROM (${selectSql}) AS _dba_preview`
        : `SELECT * FROM (${selectSql}) AS _dba_preview LIMIT 100`
      : !isNew && originalName
      ? engine === "mssql"
        ? `SELECT TOP 100 * FROM ${qualifiedName(engine, schema, originalName)}`
        : `SELECT * FROM ${qualifiedName(engine, schema, originalName)} LIMIT 100`
      : null;

    if (!previewQuery) {
      setPreviewError("Could not extract a SELECT query from the view definition.");
      return;
    }

    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const qid =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `view-preview-${Date.now()}`;
      const res = await api.executeQuery(tab.connectionId, previewQuery, database, qid, true);
      setPreviewResult(res.resultSets[0] ?? null);
    } catch (err) {
      setPreviewError(formatApiError(err));
      setPreviewResult(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Keyboard shortcut Ctrl+S
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeTabId !== tab.id) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabId, tab.id, handleSave]);

  const resolvedMonacoTheme = useMemo(() => {
    if (theme === "light") return "vs";
    if (theme === "dark") return "vs-dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "vs-dark" : "vs";
  }, [theme]);

  const kindIcon =
    objectKind === "trigger" ? (
      <Zap className="w-4 h-4 text-orange-400" />
    ) : objectKind === "view" || objectKind === "materialized_view" ? (
      <Eye className="w-4 h-4 text-purple-400" />
    ) : (
      <FunctionSquare className="w-4 h-4 text-amber-400" />
    );

  const isRoutine = objectKind === "function" || objectKind === "procedure";
  const isView = objectKind === "view" || objectKind === "materialized_view";

  return (
    <div className="h-full flex flex-col bg-[var(--surface-canvas)] text-xs">
      {/* Top Toolbar */}
      <div className="px-3 py-1.5 bg-[var(--surface-panel)] border-b border-[var(--border-subtle)] flex flex-wrap items-center gap-2 shrink-0">
        <div className="flex items-center gap-1.5 mr-1">
          {kindIcon}
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            {isNew ? `New ${objectKind.replace("_", " ")}` : originalName ?? objectName}
          </span>
          <span className="px-1.5 py-0.5 rounded bg-[var(--surface-elevated)] font-mono text-[0.68rem] uppercase text-zinc-500">
            {engine}
          </span>
          {database && (
            <span className="text-zinc-500 font-mono text-[0.72rem]">
              {database}
              {schema && schema !== database ? `.${schema}` : ""}
            </span>
          )}
          {conn?.readOnly && (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 text-[0.68rem] font-semibold">
              READ-ONLY
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 ml-auto">
          <button
            type="button"
            onClick={() => setShowMetaForm((s) => !s)}
            className={`h-7 px-2.5 rounded border flex items-center gap-1.5 cursor-pointer ${
              showMetaForm
                ? "border-indigo-500/50 bg-indigo-500/15 text-indigo-400"
                : "border-[var(--border-strong)] hover:bg-[var(--surface-hover)] text-zinc-600 dark:text-zinc-300"
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            <span>Designer Form</span>
            {showMetaForm ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>

          {isRoutine && !isNew && tab.connectionId && (
            <button
              type="button"
              onClick={() =>
                openExecuteRoutineModal({
                  connectionId: tab.connectionId!,
                  database,
                  schema,
                  name: originalName ?? objectName,
                  kind: objectKind,
                })
              }
              className="h-7 px-2.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" /> Execute
            </button>
          )}

          {isView && (
            <button
              type="button"
              onClick={handlePreviewView}
              disabled={previewLoading}
              className="h-7 px-2.5 rounded bg-purple-600 hover:bg-purple-500 text-white font-medium flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            >
              {previewLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Eye className="w-3.5 h-3.5" />
              )}
              Preview Data
            </button>
          )}

          {!isNew && (
            <button
              type="button"
              onClick={loadExistingObject}
              disabled={loadingDdl}
              title="Reload DDL from database"
              className="h-7 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] text-zinc-600 dark:text-zinc-300 flex items-center gap-1 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingDdl ? "animate-spin" : ""}`} />
            </button>
          )}

          <button
            type="button"
            onClick={() =>
              openTab({
                kind: "query",
                title: `${objectName} SQL`,
                connectionId: tab.connectionId,
                database,
                schema,
                sql: ddl,
              })
            }
            title="Open DDL in Query Editor"
            className="h-7 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] text-zinc-600 dark:text-zinc-300 flex items-center gap-1 cursor-pointer"
          >
            <FileCode2 className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loadingDdl || Boolean(conn?.readOnly)}
            title="Save DDL to Database (Ctrl+S)"
            className="h-7 px-3 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
          >
            {saving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            Save
          </button>
        </div>
      </div>

      {/* Collapsible Hybrid Metadata Form */}
      {showMetaForm && (
        <div className="px-3 py-2.5 bg-[var(--surface-elevated)] border-b border-[var(--border-subtle)] space-y-2.5 shrink-0 max-h-64 overflow-y-auto">
          {isRoutine && (
            <>
              <div className="grid grid-cols-12 gap-2 items-end">
                <div className="col-span-4">
                  <label className="block text-[0.7rem] text-zinc-500 mb-0.5">Name</label>
                  <input
                    value={objectName}
                    onChange={(e) => setObjectName(e.target.value)}
                    placeholder="routine_name"
                    className="w-full h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-[0.7rem] text-zinc-500 mb-0.5">Type</label>
                  <select
                    value={objectKind}
                    disabled={!isNew}
                    onChange={(e) => setObjectKind(e.target.value as "function" | "procedure")}
                    className="w-full h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] disabled:opacity-60"
                  >
                    <option value="function">FUNCTION</option>
                    <option value="procedure">PROCEDURE</option>
                  </select>
                </div>
                {objectKind === "function" && (
                  <div className="col-span-3">
                    <label className="block text-[0.7rem] text-zinc-500 mb-0.5">Return Type</label>
                    <input
                      value={returnType}
                      onChange={(e) => setReturnType(e.target.value)}
                      placeholder="INT / TEXT / TABLE(...)"
                      className="w-full h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
                    />
                  </div>
                )}
                {engine === "postgres" && (
                  <div className="col-span-2">
                    <label className="block text-[0.7rem] text-zinc-500 mb-0.5">Language</label>
                    <select
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      className="w-full h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
                    >
                      <option value="plpgsql">plpgsql</option>
                      <option value="sql">sql</option>
                    </select>
                  </div>
                )}
                <div className="col-span-3 flex justify-end">
                  <button
                    type="button"
                    onClick={handleSyncMetaToSql}
                    className="h-7 px-2.5 rounded bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 font-medium flex items-center gap-1 cursor-pointer"
                  >
                    <Code2 className="w-3.5 h-3.5" /> Sync to SQL
                  </button>
                </div>
              </div>

              {/* Parameter Builder */}
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[0.7rem] font-semibold text-zinc-500 uppercase tracking-wide">
                    Parameters ({params.length})
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setParams((prev) => [
                        ...prev,
                        {
                          id: makeParamId(),
                          mode: "IN",
                          name: `p_${prev.length + 1}`,
                          dataType: engine === "postgres" ? "text" : "VARCHAR(255)",
                          defaultValue: "",
                        },
                      ])
                    }
                    className="h-6 px-2 rounded border border-[var(--border-strong)] hover:bg-[var(--surface-hover)] flex items-center gap-1 text-[0.72rem] cursor-pointer"
                  >
                    <Plus className="w-3 h-3" /> Add Parameter
                  </button>
                </div>
                {params.length > 0 && (
                  <div className="rounded border border-[var(--border-subtle)] overflow-hidden">
                    <table className="w-full text-left border-collapse">
                      <thead className="bg-[var(--surface-panel)] text-[0.68rem] text-zinc-500">
                        <tr>
                          <th className="px-2 py-1 w-24">Mode</th>
                          <th className="px-2 py-1">Name</th>
                          <th className="px-2 py-1">Data Type</th>
                          <th className="px-2 py-1">Default</th>
                          <th className="px-2 py-1 w-8"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border-subtle)] bg-[var(--surface-canvas)]">
                        {params.map((p) => (
                          <tr key={p.id}>
                            <td className="p-1">
                              <select
                                value={p.mode}
                                onChange={(e) =>
                                  setParams((prev) =>
                                    prev.map((x) =>
                                      x.id === p.id
                                        ? { ...x, mode: e.target.value as DraftParam["mode"] }
                                        : x
                                    )
                                  )
                                }
                                className="w-full h-6 px-1 rounded bg-[var(--surface-panel)] border border-[var(--border-strong)] font-mono text-[0.72rem]"
                              >
                                <option value="IN">IN</option>
                                <option value="OUT">OUT</option>
                                <option value="INOUT">INOUT</option>
                              </select>
                            </td>
                            <td className="p-1">
                              <input
                                value={p.name}
                                onChange={(e) =>
                                  setParams((prev) =>
                                    prev.map((x) =>
                                      x.id === p.id ? { ...x, name: e.target.value } : x
                                    )
                                  )
                                }
                                className="w-full h-6 px-1.5 rounded bg-[var(--surface-panel)] border border-[var(--border-strong)] font-mono text-[0.72rem]"
                              />
                            </td>
                            <td className="p-1">
                              <input
                                value={p.dataType}
                                onChange={(e) =>
                                  setParams((prev) =>
                                    prev.map((x) =>
                                      x.id === p.id ? { ...x, dataType: e.target.value } : x
                                    )
                                  )
                                }
                                className="w-full h-6 px-1.5 rounded bg-[var(--surface-panel)] border border-[var(--border-strong)] font-mono text-[0.72rem]"
                              />
                            </td>
                            <td className="p-1">
                              <input
                                value={p.defaultValue}
                                onChange={(e) =>
                                  setParams((prev) =>
                                    prev.map((x) =>
                                      x.id === p.id ? { ...x, defaultValue: e.target.value } : x
                                    )
                                  )
                                }
                                placeholder="optional"
                                className="w-full h-6 px-1.5 rounded bg-[var(--surface-panel)] border border-[var(--border-strong)] font-mono text-[0.72rem]"
                              />
                            </td>
                            <td className="p-1 text-center">
                              <button
                                type="button"
                                onClick={() =>
                                  setParams((prev) => prev.filter((x) => x.id !== p.id))
                                }
                                className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          {objectKind === "trigger" && (
            <div className="space-y-2">
              <div className="grid grid-cols-12 gap-2 items-end">
                <div className="col-span-3">
                  <label className="block text-[0.7rem] text-zinc-500 mb-0.5">Trigger Name</label>
                  <input
                    value={objectName}
                    onChange={(e) => setObjectName(e.target.value)}
                    className="w-full h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
                  />
                </div>
                <div className="col-span-3">
                  <label className="block text-[0.7rem] text-zinc-500 mb-0.5">Target Table</label>
                  {tableOptions.length > 0 ? (
                    <select
                      value={targetTable}
                      onChange={(e) => setTargetTable(e.target.value)}
                      className="w-full h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
                    >
                      {tableOptions.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={targetTable}
                      onChange={(e) => setTargetTable(e.target.value)}
                      placeholder="target_table"
                      className="w-full h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
                    />
                  )}
                </div>
                <div className="col-span-2">
                  <label className="block text-[0.7rem] text-zinc-500 mb-0.5">Timing</label>
                  <select
                    value={timing}
                    onChange={(e) => setTiming(e.target.value as "BEFORE" | "AFTER" | "INSTEAD OF")}
                    className="w-full h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)]"
                  >
                    <option value="BEFORE">BEFORE</option>
                    <option value="AFTER">AFTER</option>
                    <option value="INSTEAD OF">INSTEAD OF</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-[0.7rem] text-zinc-500 mb-0.5">For Each</label>
                  <select
                    value={forEach}
                    onChange={(e) => setForEach(e.target.value as "ROW" | "STATEMENT")}
                    className="w-full h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)]"
                  >
                    <option value="ROW">ROW</option>
                    <option value="STATEMENT">STATEMENT</option>
                  </select>
                </div>
                <div className="col-span-2 flex justify-end">
                  <button
                    type="button"
                    onClick={handleSyncMetaToSql}
                    className="h-7 px-2.5 rounded bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 font-medium flex items-center gap-1 cursor-pointer"
                  >
                    <Code2 className="w-3.5 h-3.5" /> Sync to SQL
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-3">
                  <span className="text-[0.7rem] text-zinc-500">Events:</span>
                  {(["insert", "update", "delete"] as const).map((ev) => (
                    <label key={ev} className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={events[ev]}
                        onChange={(e) =>
                          setEvents((prev) => ({ ...prev, [ev]: e.target.checked }))
                        }
                      />
                      <span className="uppercase font-mono text-[0.72rem]">{ev}</span>
                    </label>
                  ))}
                </div>
                {engine === "postgres" && (
                  <div className="flex items-center gap-2 flex-1 min-w-[200px]">
                    <span className="text-[0.7rem] text-zinc-500 shrink-0">WHEN (...):</span>
                    <input
                      value={whenClause}
                      onChange={(e) => setWhenClause(e.target.value)}
                      placeholder="e.g. OLD.status IS DISTINCT FROM NEW.status"
                      className="flex-1 h-6 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono text-[0.72rem]"
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {isView && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-64">
                <label className="block text-[0.7rem] text-zinc-500 mb-0.5">View Name</label>
                <input
                  value={objectName}
                  onChange={(e) => setObjectName(e.target.value)}
                  className="w-full h-7 px-2 rounded bg-[var(--surface-canvas)] border border-[var(--border-strong)] font-mono"
                />
              </div>
              {engine === "postgres" && (
                <label className="inline-flex items-center gap-1.5 h-7 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isMaterialized}
                    onChange={(e) => {
                      setIsMaterialized(e.target.checked);
                      setObjectKind(e.target.checked ? "materialized_view" : "view");
                    }}
                  />
                  <span>MATERIALIZED VIEW</span>
                </label>
              )}
              <button
                type="button"
                onClick={handleSyncMetaToSql}
                className="ml-auto h-7 px-2.5 rounded bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30 font-medium flex items-center gap-1 cursor-pointer"
              >
                <Code2 className="w-3.5 h-3.5" /> Sync to SQL
              </button>
            </div>
          )}
        </div>
      )}

      {/* Feedback Banner */}
      {errorMsg && (
        <div className="px-3 py-1.5 bg-red-500/10 border-b border-red-500/30 text-red-400 flex items-start gap-2 shrink-0">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="whitespace-pre-wrap break-words flex-1">{errorMsg}</span>
        </div>
      )}
      {statusMsg && !errorMsg && (
        <div className="px-3 py-1 bg-emerald-500/10 border-b border-emerald-500/25 text-emerald-400 flex items-center gap-2 shrink-0">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{statusMsg}</span>
        </div>
      )}

      {/* Main Monaco Editor */}
      <div className="flex-1 min-h-0 relative">
        {loadingDdl && (
          <div className="absolute inset-0 z-10 bg-[var(--surface-canvas)]/70 flex items-center justify-center gap-2 text-zinc-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading object DDL...
          </div>
        )}
        <Editor
          height="100%"
          language="sql"
          theme={resolvedMonacoTheme}
          value={ddl}
          onChange={(val) => {
            setDdl(val ?? "");
            updateTab(tab.id, { dirty: true });
          }}
          onMount={(editor) => {
            editorRef.current = editor;
          }}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            wordWrap: "on",
            tabSize: 2,
          }}
        />
      </div>

      {/* Inline View Data Preview Drawer */}
      {isView && (previewResult || previewError) && (
        <div className="h-56 border-t border-[var(--border-strong)] bg-[var(--surface-panel)] flex flex-col shrink-0">
          <div className="px-3 py-1 border-b border-[var(--border-subtle)] flex items-center justify-between text-[0.72rem]">
            <span className="font-semibold text-purple-400">
              View Preview {previewResult ? `(${previewResult.rows.length} rows • ${previewResult.executionMs}ms)` : ""}
            </span>
            <button
              type="button"
              onClick={() => {
                setPreviewResult(null);
                setPreviewError(null);
              }}
              className="text-zinc-500 hover:text-zinc-200 cursor-pointer"
            >
              Close
            </button>
          </div>
          {previewError ? (
            <div className="p-3 text-red-400 font-mono whitespace-pre-wrap overflow-auto">
              {previewError}
            </div>
          ) : previewResult ? (
            <div className="flex-1 overflow-auto">
              <table className="w-full text-left border-collapse font-mono text-[0.74rem]">
                <thead className="sticky top-0 bg-[var(--surface-elevated)] border-b border-[var(--border-subtle)]">
                  <tr>
                    {previewResult.columns.map((c, idx) => (
                      <th key={idx} className="px-2.5 py-1 font-semibold text-zinc-500 whitespace-nowrap">
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {previewResult.rows.map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-[var(--surface-hover)]">
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="px-2.5 py-1 whitespace-nowrap max-w-[260px] truncate">
                          {cell === null || cell === undefined ? (
                            <span className="text-zinc-500 italic">(Null)</span>
                          ) : typeof cell === "object" ? (
                            JSON.stringify(cell)
                          ) : (
                            String(cell)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};
