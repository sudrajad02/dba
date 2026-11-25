import React, { useEffect, useState } from "react";
import { Check, Code2, Plus, Trash2 } from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  CheckConstraintMeta,
  ForeignKeyMeta,
  IndexMeta,
  TableDesignColumn,
  TableDesignDraft,
} from "../types/datavault";

const PG_TYPES = [
  "bigint",
  "integer",
  "serial",
  "bigserial",
  "varchar",
  "text",
  "boolean",
  "numeric",
  "double precision",
  "uuid",
  "jsonb",
  "timestamp",
  "timestamptz",
  "date",
  "bytea",
];

const MYSQL_TYPES = [
  "BIGINT",
  "INT",
  "VARCHAR",
  "TEXT",
  "BOOLEAN",
  "DECIMAL",
  "DOUBLE",
  "JSON",
  "DATETIME",
  "TIMESTAMP",
  "DATE",
  "BLOB",
];

const MSSQL_TYPES = [
  "BIGINT",
  "INT",
  "SMALLINT",
  "NVARCHAR",
  "VARCHAR",
  "NVARCHAR(MAX)",
  "BIT",
  "DECIMAL",
  "FLOAT",
  "UNIQUEIDENTIFIER",
  "DATETIME2",
  "DATETIMEOFFSET",
  "DATE",
  "VARBINARY(MAX)",
];

export const TableDesigner: React.FC<{ tab: WorkbenchTab }> = ({ tab }) => {
  const { connections, loadObjects, openSafetyModal, addLog } = useWorkbenchStore();
  const conn = connections.find((c) => c.id === tab.connectionId);
  const engine = conn?.engine ?? "postgres";
  const typeList =
    engine === "mysql" ? MYSQL_TYPES : engine === "mssql" ? MSSQL_TYPES : PG_TYPES;

  const [section, setSection] = useState<"columns" | "indexes" | "fks" | "checks">("columns");
  const [tableName, setTableName] = useState(tab.table ?? "new_table");
  const [columns, setColumns] = useState<TableDesignColumn[]>([
    {
      name: "id",
      dataType: engine === "postgres" ? "bigserial" : "BIGINT",
      nullable: false,
      isPrimaryKey: true,
      isAutoIncrement: engine === "mysql" || engine === "mssql",
    },
  ]);
  const [indexes, setIndexes] = useState<IndexMeta[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyMeta[]>([]);
  const [checks, setChecks] = useState<CheckConstraintMeta[]>([]);
  const [ddlPreview, setDdlPreview] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Load existing table structure if editing
  useEffect(() => {
    if (tab.isNewTable || !tab.connectionId || !tab.table) return;
    api
      .getTableMetadata(tab.connectionId, tab.table, tab.database, tab.schema)
      .then((meta) => {
        setTableName(meta.name);
        setColumns(
          meta.columns.map((c) => ({
            name: c.name,
            originalName: c.name,
            dataType: c.udtName || c.dataType,
            length: c.maxLength ? String(c.maxLength) : "",
            nullable: c.nullable,
            defaultValue: c.defaultValue ?? "",
            isPrimaryKey: c.isPrimaryKey,
            isAutoIncrement: c.isAutoIncrement,
            comment: c.comment ?? "",
          }))
        );
        setIndexes(meta.indexes);
        setForeignKeys(meta.foreignKeys);
        setChecks(meta.checks);
      })
      .catch((err) => setError(formatApiError(err)));
  }, [tab.isNewTable, tab.connectionId, tab.database, tab.schema, tab.table]);

  // Live DDL Preview
  useEffect(() => {
    const draft: TableDesignDraft = {
      isNewTable: tab.isNewTable ?? true,
      schema: tab.schema ?? null,
      tableName,
      columns,
      indexes,
      foreignKeys,
      checks,
    };
    api
      .previewTableDdl(engine, draft)
      .then(setDdlPreview)
      .catch(() => {});
  }, [engine, tab.isNewTable, tab.schema, tableName, columns, indexes, foreignKeys, checks]);

  const executeApply = async (confirmed = false) => {
    if (!tab.connectionId || !ddlPreview.trim()) return;
    setError(null);
    try {
      await api.executeDdl(tab.connectionId, ddlPreview, tab.database, confirmed);
      addLog("success", `Applied DDL for table "${tableName}"`);
      if (tab.database) {
        await loadObjects(tab.connectionId, tab.database, tab.schema ?? tab.database);
      }
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const handleApply = () => {
    if (conn?.environment === "production") {
      openSafetyModal({
        title: `Apply Table DDL (${tableName})`,
        warnings: [`Executing DDL on PRODUCTION connection "${conn.name}".`],
        sqlPreview: ddlPreview,
        onConfirm: () => executeApply(true),
      });
    } else {
      executeApply(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-white dark:bg-zinc-950 text-xs">
      {/* Header */}
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/70 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-zinc-500">Table Name:</span>
          <input
            value={tableName}
            onChange={(e) => setTableName(e.target.value)}
            className="h-7 px-2.5 rounded bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono font-semibold"
          />
          <div className="flex items-center gap-1 ml-3">
            {(["columns", "indexes", "fks", "checks"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSection(s)}
                className={`h-7 px-2.5 rounded capitalize ${
                  section === s
                    ? "bg-indigo-600 text-white font-medium"
                    : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
                }`}
              >
                {s === "fks" ? "Foreign Keys" : s}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={handleApply}
          className="h-7 px-3.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white font-medium flex items-center gap-1.5"
        >
          <Check className="w-3.5 h-3.5" />
          Apply DDL
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-red-400 font-mono">
          {error}
        </div>
      )}

      {/* Designer Editor Area */}
      <div className="flex-1 overflow-auto p-3">
        {section === "columns" && (
          <div className="space-y-2">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-800 text-zinc-500">
                  <th className="py-1.5 px-2">Column Name</th>
                  <th className="py-1.5 px-2">Data Type</th>
                  <th className="py-1.5 px-2 w-24">Length</th>
                  <th className="py-1.5 px-2 text-center">PK</th>
                  <th className="py-1.5 px-2 text-center">Nullable</th>
                  <th className="py-1.5 px-2 text-center">Auto Inc</th>
                  <th className="py-1.5 px-2">Default</th>
                  <th className="py-1.5 px-2 w-8" />
                </tr>
              </thead>
              <tbody>
                {columns.map((col, idx) => (
                  <tr
                    key={idx}
                    className="border-b border-zinc-200/60 dark:border-zinc-800/60"
                  >
                    <td className="p-1">
                      <input
                        value={col.name}
                        onChange={(e) =>
                          setColumns((prev) =>
                            prev.map((c, i) =>
                              i === idx ? { ...c, name: e.target.value } : c
                            )
                          )
                        }
                        className="w-full h-7 px-2 rounded bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 font-mono"
                      />
                    </td>
                    <td className="p-1">
                      <select
                        value={col.dataType}
                        onChange={(e) =>
                          setColumns((prev) =>
                            prev.map((c, i) =>
                              i === idx ? { ...c, dataType: e.target.value } : c
                            )
                          )
                        }
                        className="w-full h-7 px-2 rounded bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 font-mono"
                      >
                        {!typeList.includes(col.dataType) && (
                          <option value={col.dataType}>{col.dataType}</option>
                        )}
                        {typeList.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-1">
                      <input
                        value={col.length ?? ""}
                        onChange={(e) =>
                          setColumns((prev) =>
                            prev.map((c, i) =>
                              i === idx ? { ...c, length: e.target.value } : c
                            )
                          )
                        }
                        placeholder="255"
                        className="w-full h-7 px-2 rounded bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 font-mono"
                      />
                    </td>
                    <td className="p-1 text-center">
                      <input
                        type="checkbox"
                        checked={col.isPrimaryKey}
                        onChange={(e) =>
                          setColumns((prev) =>
                            prev.map((c, i) =>
                              i === idx
                                ? { ...c, isPrimaryKey: e.target.checked, nullable: e.target.checked ? false : c.nullable }
                                : c
                            )
                          )
                        }
                      />
                    </td>
                    <td className="p-1 text-center">
                      <input
                        type="checkbox"
                        checked={col.nullable}
                        onChange={(e) =>
                          setColumns((prev) =>
                            prev.map((c, i) =>
                              i === idx ? { ...c, nullable: e.target.checked } : c
                            )
                          )
                        }
                      />
                    </td>
                    <td className="p-1 text-center">
                      <input
                        type="checkbox"
                        checked={col.isAutoIncrement}
                        onChange={(e) =>
                          setColumns((prev) =>
                            prev.map((c, i) =>
                              i === idx ? { ...c, isAutoIncrement: e.target.checked } : c
                            )
                          )
                        }
                      />
                    </td>
                    <td className="p-1">
                      <input
                        value={col.defaultValue ?? ""}
                        onChange={(e) =>
                          setColumns((prev) =>
                            prev.map((c, i) =>
                              i === idx ? { ...c, defaultValue: e.target.value } : c
                            )
                          )
                        }
                        placeholder="NULL / NOW()"
                        className="w-full h-7 px-2 rounded bg-zinc-50 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 font-mono"
                      />
                    </td>
                    <td className="p-1 text-center">
                      <button
                        onClick={() =>
                          setColumns((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="text-zinc-500 hover:text-red-400"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <button
              onClick={() =>
                setColumns((prev) => [
                  ...prev,
                  {
                    name: `col_${prev.length + 1}`,
                    dataType: engine === "mysql" ? "VARCHAR" : "varchar",
                    length: "255",
                    nullable: true,
                    isPrimaryKey: false,
                    isAutoIncrement: false,
                  },
                ])
              }
              className="h-7 px-2.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add Column
            </button>
          </div>
        )}

        {section === "indexes" && (
          <div className="space-y-2">
            {indexes.map((idx, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={idx.name}
                  onChange={(e) =>
                    setIndexes((prev) =>
                      prev.map((x, k) => (k === i ? { ...x, name: e.target.value } : x))
                    )
                  }
                  placeholder="idx_name"
                  className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 font-mono"
                />
                <input
                  value={idx.columns.join(", ")}
                  onChange={(e) =>
                    setIndexes((prev) =>
                      prev.map((x, k) =>
                        k === i
                          ? {
                              ...x,
                              columns: e.target.value
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                            }
                          : x
                      )
                    )
                  }
                  placeholder="col1, col2"
                  className="flex-1 h-7 px-2 rounded bg-zinc-900 border border-zinc-700 font-mono"
                />
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={idx.isUnique}
                    onChange={(e) =>
                      setIndexes((prev) =>
                        prev.map((x, k) =>
                          k === i ? { ...x, isUnique: e.target.checked } : x
                        )
                      )
                    }
                  />
                  Unique
                </label>
                <button
                  onClick={() => setIndexes((prev) => prev.filter((_, k) => k !== i))}
                  className="text-zinc-500 hover:text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                setIndexes((prev) => [
                  ...prev,
                  {
                    name: `idx_${tableName}_${prev.length + 1}`,
                    columns: [columns[0]?.name ?? "id"],
                    isUnique: false,
                    isPrimary: false,
                    method: "btree",
                  },
                ])
              }
              className="h-7 px-2.5 rounded border border-zinc-700 flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add Index
            </button>
          </div>
        )}

        {section === "fks" && (
          <div className="space-y-2">
            {foreignKeys.map((fk, i) => (
              <div key={i} className="grid grid-cols-6 gap-2 items-center">
                <input
                  value={fk.name}
                  onChange={(e) =>
                    setForeignKeys((prev) =>
                      prev.map((x, k) => (k === i ? { ...x, name: e.target.value } : x))
                    )
                  }
                  placeholder="fk_name"
                  className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 font-mono"
                />
                <input
                  value={fk.columns.join(", ")}
                  onChange={(e) =>
                    setForeignKeys((prev) =>
                      prev.map((x, k) =>
                        k === i
                          ? { ...x, columns: e.target.value.split(",").map((s) => s.trim()) }
                          : x
                      )
                    )
                  }
                  placeholder="column"
                  className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 font-mono"
                />
                <input
                  value={fk.refTable}
                  onChange={(e) =>
                    setForeignKeys((prev) =>
                      prev.map((x, k) => (k === i ? { ...x, refTable: e.target.value } : x))
                    )
                  }
                  placeholder="ref_table"
                  className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 font-mono"
                />
                <input
                  value={fk.refColumns.join(", ")}
                  onChange={(e) =>
                    setForeignKeys((prev) =>
                      prev.map((x, k) =>
                        k === i
                          ? { ...x, refColumns: e.target.value.split(",").map((s) => s.trim()) }
                          : x
                      )
                    )
                  }
                  placeholder="ref_col"
                  className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 font-mono"
                />
                <select
                  value={fk.onDelete}
                  onChange={(e) =>
                    setForeignKeys((prev) =>
                      prev.map((x, k) => (k === i ? { ...x, onDelete: e.target.value } : x))
                    )
                  }
                  className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700"
                >
                  <option value="NO ACTION">ON DELETE NO ACTION</option>
                  <option value="CASCADE">ON DELETE CASCADE</option>
                  <option value="SET NULL">ON DELETE SET NULL</option>
                  <option value="RESTRICT">ON DELETE RESTRICT</option>
                </select>
                <button
                  onClick={() => setForeignKeys((prev) => prev.filter((_, k) => k !== i))}
                  className="text-zinc-500 hover:text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                setForeignKeys((prev) => [
                  ...prev,
                  {
                    name: `fk_${tableName}_${prev.length + 1}`,
                    columns: [""],
                    refSchema: tab.schema ?? null,
                    refTable: "",
                    refColumns: ["id"],
                    onUpdate: "NO ACTION",
                    onDelete: "CASCADE",
                  },
                ])
              }
              className="h-7 px-2.5 rounded border border-zinc-700 flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add Foreign Key
            </button>
          </div>
        )}

        {section === "checks" && (
          <div className="space-y-2">
            {checks.map((chk, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={chk.name}
                  onChange={(e) =>
                    setChecks((prev) =>
                      prev.map((x, k) => (k === i ? { ...x, name: e.target.value } : x))
                    )
                  }
                  placeholder="chk_name"
                  className="h-7 px-2 rounded bg-zinc-900 border border-zinc-700 font-mono"
                />
                <input
                  value={chk.expression}
                  onChange={(e) =>
                    setChecks((prev) =>
                      prev.map((x, k) =>
                        k === i ? { ...x, expression: e.target.value } : x
                      )
                    )
                  }
                  placeholder="price >= 0"
                  className="flex-1 h-7 px-2 rounded bg-zinc-900 border border-zinc-700 font-mono"
                />
                <button
                  onClick={() => setChecks((prev) => prev.filter((_, k) => k !== i))}
                  className="text-zinc-500 hover:text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                setChecks((prev) => [
                  ...prev,
                  { name: `chk_${tableName}_${prev.length + 1}`, expression: "" },
                ])
              }
              className="h-7 px-2.5 rounded border border-zinc-700 flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" /> Add Check Constraint
            </button>
          </div>
        )}
      </div>

      {/* Live DDL Preview Pane */}
      <div className="h-44 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-950 flex flex-col">
        <div className="px-3 py-1.5 border-b border-zinc-800 text-[0.8rem] font-semibold text-zinc-400 flex items-center gap-1.5">
          <Code2 className="w-3.5 h-3.5 text-cyan-500 dark:text-cyan-400" />
          Live DDL Preview ({engine.toUpperCase()})
        </div>
        <pre className="flex-1 p-3 overflow-auto font-mono text-[0.8rem] text-neutral-200 whitespace-pre-wrap">
          {ddlPreview}
        </pre>
      </div>
    </div>
  );
};
