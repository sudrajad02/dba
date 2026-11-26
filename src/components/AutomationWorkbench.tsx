import React, { useCallback, useEffect, useState } from "react";
import {
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock,
  Play,
  Plus,
  RefreshCw,
  Save,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore, type WorkbenchTab } from "../store/useWorkbenchStore";
import type {
  BatchJob,
  BatchStep,
  BatchStepKind,
  JobExecutionLog,
  SchedulePreset,
  SystemdTimerStatus,
} from "../types/dba";

function makeId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const STEP_KIND_LABELS: Record<BatchStepKind, string> = {
  run_query: "Run SQL Query",
  sql_dump: "SQL Dump / Backup",
  export_table: "Export Table",
  data_transfer: "Data Transfer",
  structure_sync: "Structure Sync",
  data_sync: "Data Sync",
  data_gen: "Data Generation",
};

const PRESET_CALENDAR: Record<SchedulePreset, string> = {
  manual: "",
  hourly: "hourly",
  daily: "*-*-* 02:00:00",
  weekly: "Mon *-*-* 03:00:00",
  custom: "*-*-* 00:00:00",
};

function createEmptyJob(): BatchJob {
  return {
    id: makeId(),
    name: "New Batch Job",
    description: "",
    stopOnError: true,
    steps: [],
    schedule: {
      enabled: false,
      preset: "manual",
      onCalendar: "*-*-* 02:00:00",
      notifyOnSuccess: true,
      notifyOnFailure: true,
    },
    updatedAt: new Date().toISOString(),
  };
}

export const AutomationWorkbench: React.FC<{ tab: WorkbenchTab }> = () => {
  const { connections, savedQueries, addLog } = useWorkbenchStore();

  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [activeJob, setActiveJob] = useState<BatchJob>(createEmptyJob());
  const [timerStatus, setTimerStatus] = useState<SystemdTimerStatus | null>(null);
  const [logs, setLogs] = useState<JobExecutionLog[]>([]);
  const [selectedLog, setSelectedLog] = useState<JobExecutionLog | null>(null);
  const [subTab, setSubTab] = useState<"steps" | "schedule" | "logs">("steps");
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshJobs = useCallback(async () => {
    try {
      const list = await api.listBatchJobs();
      setJobs(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  const refreshLogs = useCallback(async (jobId?: string) => {
    try {
      const list = await api.listJobLogs(jobId, 50);
      setLogs(list);
      if (list.length > 0) setSelectedLog(list[0]);
    } catch {
      // ignore
    }
  }, []);

  const refreshTimer = useCallback(async (jobId: string) => {
    try {
      const st = await api.getSystemdTimerStatus(jobId);
      setTimerStatus(st);
    } catch {
      setTimerStatus(null);
    }
  }, []);

  useEffect(() => {
    refreshJobs().then((list) => {
      if (list.length > 0) {
        setActiveJob(list[0]);
        refreshTimer(list[0].id);
        refreshLogs(list[0].id);
      } else {
        refreshLogs();
      }
    });
  }, [refreshJobs, refreshLogs, refreshTimer]);

  const selectJob = (job: BatchJob) => {
    setActiveJob(job);
    setError(null);
    setStatusMsg(null);
    refreshTimer(job.id);
    refreshLogs(job.id);
  };

  const handleNewJob = () => {
    const fresh = createEmptyJob();
    setActiveJob(fresh);
    setTimerStatus(null);
    setError(null);
    setStatusMsg(null);
  };

  const handleSaveJob = async () => {
    setSaving(true);
    setError(null);
    setStatusMsg(null);
    try {
      const saved = await api.saveBatchJob(activeJob);
      setActiveJob(saved);
      await refreshJobs();
      setStatusMsg(`Saved batch job "${saved.name}" to workspace/jobs/.`);
      addLog("success", `Saved batch job "${saved.name}".`);
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteJob = async (id: string) => {
    try {
      await api.deleteBatchJob(id);
      const list = await refreshJobs();
      if (activeJob.id === id) {
        if (list.length > 0) selectJob(list[0]);
        else handleNewJob();
      }
      addLog("info", "Deleted batch job and removed any systemd timer.");
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const handleSyncTimer = async () => {
    setError(null);
    setStatusMsg(null);
    try {
      const saved = await api.saveBatchJob(activeJob);
      setActiveJob(saved);
      await refreshJobs();
      const st = await api.syncBatchJobTimer(saved);
      setTimerStatus(st);
      setStatusMsg(st.message);
      addLog("info", `systemd timer sync (${saved.name}): ${st.message}`);
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const handleRemoveTimer = async () => {
    setError(null);
    try {
      const st = await api.removeBatchJobTimer(activeJob.id);
      setTimerStatus(st);
      const updated: BatchJob = {
        ...activeJob,
        schedule: { ...activeJob.schedule, enabled: false, preset: "manual" },
      };
      setActiveJob(updated);
      await api.saveBatchJob(updated);
      await refreshJobs();
      setStatusMsg(st.message);
    } catch (e) {
      setError(formatApiError(e));
    }
  };

  const handleRunNow = async () => {
    setRunning(true);
    setError(null);
    setStatusMsg(null);
    try {
      const saved = await api.saveBatchJob(activeJob);
      setActiveJob(saved);
      await refreshJobs();
      const log = await api.runBatchJob(saved.id, true);
      await refreshLogs(saved.id);
      setSelectedLog(log);
      setSubTab("logs");
      setStatusMsg(
        log.status === "success"
          ? `Batch job "${saved.name}" completed successfully.`
          : `Batch job "${saved.name}" finished with errors.`
      );
      addLog(
        log.status === "success" ? "success" : "error",
        `Batch job "${saved.name}" ${log.status}.`
      );
    } catch (e) {
      setError(formatApiError(e));
    } finally {
      setRunning(false);
    }
  };

  const addStep = (kind: BatchStepKind) => {
    const defaultConn = connections[0];
    let config: Record<string, unknown> = {};
    if (kind === "run_query") {
      config = {
        connectionId: defaultConn?.id ?? "",
        database: defaultConn?.database ?? "",
        sql: "SELECT 1;",
      };
    } else if (kind === "sql_dump") {
      config = {
        connectionId: defaultConn?.id ?? "",
        database: defaultConn?.database ?? "",
        schema: defaultConn?.engine === "postgres" ? "public" : "",
        tables: [],
        outputPath: `/tmp/dba-backup-${Date.now()}.sql`,
        includeStructure: true,
        includeData: true,
        includeDrop: false,
        chunkSize: 500,
      };
    } else if (kind === "export_table") {
      config = {
        connectionId: defaultConn?.id ?? "",
        database: defaultConn?.database ?? "",
        schema: defaultConn?.engine === "postgres" ? "public" : "",
        table: "",
        format: "csv",
        outputPath: `/tmp/dba-export-${Date.now()}.csv`,
        delimiter: ",",
        includeHeaders: true,
      };
    } else if (kind === "structure_sync") {
      config = {
        sourceConnectionId: defaultConn?.id ?? "",
        sourceDatabase: defaultConn?.database ?? "",
        sourceSchema: "public",
        targetConnectionId: connections[1]?.id ?? defaultConn?.id ?? "",
        targetDatabase: connections[1]?.database ?? defaultConn?.database ?? "",
        targetSchema: "public",
        includeDrops: false,
      };
    } else if (kind === "data_sync") {
      config = {
        sourceConnectionId: defaultConn?.id ?? "",
        sourceDatabase: defaultConn?.database ?? "",
        sourceSchema: "public",
        targetConnectionId: connections[1]?.id ?? defaultConn?.id ?? "",
        targetDatabase: connections[1]?.database ?? defaultConn?.database ?? "",
        targetSchema: "public",
        tables: [],
        includeDeletes: false,
      };
    } else if (kind === "data_transfer") {
      config = {
        sourceConnectionId: defaultConn?.id ?? "",
        sourceDatabase: defaultConn?.database ?? "",
        sourceSchema: "public",
        targetConnectionId: connections[1]?.id ?? defaultConn?.id ?? "",
        targetDatabase: connections[1]?.database ?? defaultConn?.database ?? "",
        targetSchema: "public",
        tables: [],
        mode: "create_if_not_exists",
        typeMappings: [],
        errorPolicy: "stop_on_error",
        confirmedProduction: true,
      };
    } else if (kind === "data_gen") {
      config = {
        connectionId: defaultConn?.id ?? "",
        database: defaultConn?.database ?? "",
        schema: "public",
        table: "",
        rowCount: 1000,
        batchSize: 500,
        truncateBefore: false,
        rules: [],
        confirmedProduction: true,
      };
    }

    const newStep: BatchStep = {
      id: makeId(),
      name: `${STEP_KIND_LABELS[kind]} #${activeJob.steps.length + 1}`,
      kind,
      enabled: true,
      config,
    };
    setActiveJob((j) => ({ ...j, steps: [...j.steps, newStep] }));
  };

  const updateStep = (id: string, patch: Partial<BatchStep>) => {
    setActiveJob((j) => ({
      ...j,
      steps: j.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  };

  const updateStepConfig = (id: string, key: string, value: unknown) => {
    setActiveJob((j) => ({
      ...j,
      steps: j.steps.map((s) =>
        s.id === id ? { ...s, config: { ...s.config, [key]: value } } : s
      ),
    }));
  };

  const removeStep = (id: string) => {
    setActiveJob((j) => ({
      ...j,
      steps: j.steps.filter((s) => s.id !== id),
    }));
  };

  return (
    <div className="h-full flex bg-white dark:bg-[#1e1f22] text-xs overflow-hidden">
      {/* Left Sidebar: Saved Batch Jobs */}
      <div className="w-64 border-r border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#23252a] flex flex-col shrink-0">
        <div className="px-3 py-2.5 border-b border-zinc-200 dark:border-[#32343a] flex items-center justify-between">
          <span className="font-semibold flex items-center gap-1.5">
            <Clock className="w-4 h-4 text-lime-400" />
            Batch Jobs ({jobs.length})
          </span>
          <button
            onClick={handleNewJob}
            className="h-6 px-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white flex items-center gap-1 cursor-pointer"
          >
            <Plus className="w-3 h-3" /> New
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {jobs.length === 0 ? (
            <div className="text-zinc-500 text-center py-6 px-2">
              No batch jobs yet. Create one to automate backups, queries, syncs, or transfers via Linux{" "}
              <code className="font-mono">systemd --user</code> timers.
            </div>
          ) : (
            jobs.map((j) => {
              const isSel = j.id === activeJob.id;
              return (
                <div
                  key={j.id}
                  onClick={() => selectJob(j)}
                  className={`p-2 rounded border cursor-pointer flex items-center justify-between gap-1 ${
                    isSel
                      ? "border-indigo-500 bg-indigo-500/10"
                      : "border-zinc-200 dark:border-[#35373c] bg-white dark:bg-[#1e1f22] hover:bg-zinc-100 dark:hover:bg-[#2a2c32]"
                  }`}
                >
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{j.name}</div>
                    <div className="text-[0.68rem] text-zinc-500 flex items-center gap-1.5">
                      <span>{j.steps.length} step(s)</span>
                      {j.schedule.enabled && (
                        <span className="px-1 rounded bg-lime-500/20 text-lime-400 font-semibold">
                          {j.schedule.preset}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteJob(j.id);
                    }}
                    className="p-1 text-zinc-400 hover:text-red-400 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Right Main Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Action Bar */}
        <div className="px-4 py-2.5 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#25262a] flex items-center justify-between gap-3 flex-wrap shrink-0">
          <div className="flex items-center gap-2 flex-1 min-w-[220px]">
            <input
              value={activeJob.name}
              onChange={(e) => setActiveJob((j) => ({ ...j, name: e.target.value }))}
              placeholder="Batch Job Name"
              className="h-7 px-2.5 w-60 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-semibold text-sm"
            />
            <label className="flex items-center gap-1.5 text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={activeJob.stopOnError}
                onChange={(e) =>
                  setActiveJob((j) => ({ ...j, stopOnError: e.target.checked }))
                }
              />
              <span>Stop on error</span>
            </label>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveJob}
              disabled={saving}
              className="h-7 px-3 rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center gap-1.5 cursor-pointer"
            >
              <Save className="w-3.5 h-3.5 text-sky-400" />
              <span>{saving ? "Saving..." : "Save Job"}</span>
            </button>
            <button
              onClick={handleRunNow}
              disabled={running || activeJob.steps.length === 0}
              className="h-7 px-3 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium flex items-center gap-1.5 cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{running ? "Running..." : "Run Now"}</span>
            </button>
          </div>
        </div>

        {/* Sub-Navigation Tabs */}
        <div className="px-4 py-1.5 border-b border-zinc-200 dark:border-[#32343a] flex items-center gap-2 shrink-0">
          {(
            [
              ["steps", `Pipeline Steps (${activeJob.steps.length})`],
              ["schedule", "systemd Schedule & Notifications"],
              ["logs", `Execution Logs (${logs.length})`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setSubTab(id)}
              className={`px-3 py-1 rounded font-medium cursor-pointer ${
                subTab === id
                  ? "bg-indigo-600 text-white"
                  : "text-zinc-500 hover:bg-zinc-200 dark:hover:bg-[#32343a]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <div className="mx-4 mt-2 p-2 rounded bg-red-500/10 border border-red-500/30 text-red-400 flex items-center gap-2">
            <XCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {statusMsg && (
          <div className="mx-4 mt-2 p-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{statusMsg}</span>
          </div>
        )}

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {subTab === "steps" && (
            <div className="space-y-4 max-w-4xl">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-zinc-500 font-semibold">Add Step:</span>
                {(Object.keys(STEP_KIND_LABELS) as BatchStepKind[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => addStep(k)}
                    className="h-7 px-2.5 rounded border border-zinc-300 dark:border-[#3b3d44] hover:bg-zinc-200 dark:hover:bg-[#32343a] flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3 h-3 text-emerald-400" />
                    <span>{STEP_KIND_LABELS[k]}</span>
                  </button>
                ))}
              </div>

              {activeJob.steps.length === 0 ? (
                <div className="p-8 rounded-lg border border-dashed border-zinc-300 dark:border-[#3b3d44] text-center text-zinc-500">
                  Add one or more steps above to build your automated batch pipeline.
                </div>
              ) : (
                <div className="space-y-3">
                  {activeJob.steps.map((step, idx) => (
                    <div
                      key={step.id}
                      className="p-3 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#23252a] space-y-2.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 flex-1">
                          <span className="px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-400 font-mono font-semibold">
                            #{idx + 1}
                          </span>
                          <input
                            type="checkbox"
                            checked={step.enabled}
                            onChange={(e) =>
                              updateStep(step.id, { enabled: e.target.checked })
                            }
                          />
                          <input
                            value={step.name}
                            onChange={(e) =>
                              updateStep(step.id, { name: e.target.value })
                            }
                            className="h-7 px-2 flex-1 max-w-xs rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-medium"
                          />
                          <span className="px-2 py-0.5 rounded bg-zinc-200 dark:bg-[#32343a] text-[0.68rem]">
                            {STEP_KIND_LABELS[step.kind]}
                          </span>
                        </div>
                        <button
                          onClick={() => removeStep(step.id)}
                          className="p-1 text-zinc-400 hover:text-red-400 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Friendly step config editor */}
                      {step.kind === "run_query" ? (
                        <div className="space-y-2">
                          <div className="grid grid-cols-3 gap-2">
                            <select
                              value={String(step.config.connectionId ?? "")}
                              onChange={(e) =>
                                updateStepConfig(step.id, "connectionId", e.target.value)
                              }
                              className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                            >
                              <option value="">Select Connection...</option>
                              {connections.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name} ({c.engine})
                                </option>
                              ))}
                            </select>
                            <input
                              value={String(step.config.database ?? "")}
                              onChange={(e) =>
                                updateStepConfig(step.id, "database", e.target.value)
                              }
                              placeholder="Database (optional)"
                              className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                            />
                            <select
                              value=""
                              onChange={(e) => {
                                const q = savedQueries.find((x) => x.path === e.target.value);
                                if (q) updateStepConfig(step.id, "sql", q.sql);
                              }}
                              className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                            >
                              <option value="">Load Saved Query...</option>
                              {savedQueries.map((q) => (
                                <option key={q.path} value={q.path}>
                                  {q.folder ? `${q.folder}/${q.name}` : q.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <textarea
                            rows={3}
                            value={String(step.config.sql ?? "")}
                            onChange={(e) => updateStepConfig(step.id, "sql", e.target.value)}
                            className="w-full p-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-[#1e1f22] text-emerald-300 font-mono text-[0.72rem]"
                          />
                        </div>
                      ) : step.kind === "sql_dump" ? (
                        <div className="grid grid-cols-2 gap-2">
                          <select
                            value={String(step.config.connectionId ?? "")}
                            onChange={(e) =>
                              updateStepConfig(step.id, "connectionId", e.target.value)
                            }
                            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                          >
                            <option value="">Select Connection...</option>
                            {connections.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name} ({c.engine})
                              </option>
                            ))}
                          </select>
                          <input
                            value={String(step.config.database ?? "")}
                            onChange={(e) =>
                              updateStepConfig(step.id, "database", e.target.value)
                            }
                            placeholder="Database"
                            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                          />
                          <input
                            value={String(step.config.schema ?? "")}
                            onChange={(e) =>
                              updateStepConfig(step.id, "schema", e.target.value)
                            }
                            placeholder="Schema (e.g. public)"
                            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                          />
                          <input
                            value={String(step.config.outputPath ?? "")}
                            onChange={(e) =>
                              updateStepConfig(step.id, "outputPath", e.target.value)
                            }
                            placeholder="/path/to/backup.sql"
                            className="h-7 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                          />
                        </div>
                      ) : (
                        <div className="space-y-1">
                          <div className="text-[0.68rem] text-zinc-400">
                            Step Configuration JSON:
                          </div>
                          <textarea
                            rows={5}
                            value={JSON.stringify(step.config, null, 2)}
                            onChange={(e) => {
                              try {
                                const parsed = JSON.parse(e.target.value);
                                updateStep(step.id, { config: parsed });
                              } catch {
                                // ignore invalid JSON while typing
                              }
                            }}
                            className="w-full p-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-[#1e1f22] text-sky-300 font-mono text-[0.7rem]"
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {subTab === "schedule" && (
            <div className="max-w-3xl space-y-4">
              <div className="p-4 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#23252a] space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm flex items-center gap-2">
                    <CalendarClock className="w-4 h-4 text-lime-400" />
                    <span>Linux systemd --user Timer Schedule</span>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer font-medium">
                    <input
                      type="checkbox"
                      checked={activeJob.schedule.enabled}
                      onChange={(e) =>
                        setActiveJob((j) => ({
                          ...j,
                          schedule: {
                            ...j.schedule,
                            enabled: e.target.checked,
                            preset:
                              e.target.checked && j.schedule.preset === "manual"
                                ? "daily"
                                : j.schedule.preset,
                          },
                        }))
                      }
                    />
                    <span>Enable Background Schedule</span>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-zinc-400 block">Schedule Preset</label>
                    <select
                      value={activeJob.schedule.preset}
                      onChange={(e) => {
                        const preset = e.target.value as SchedulePreset;
                        setActiveJob((j) => ({
                          ...j,
                          schedule: {
                            ...j.schedule,
                            preset,
                            enabled: preset !== "manual",
                            onCalendar:
                              preset === "custom"
                                ? j.schedule.onCalendar || "*-*-* 02:00:00"
                                : PRESET_CALENDAR[preset],
                          },
                        }));
                      }}
                      className="w-full h-8 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22]"
                    >
                      <option value="manual">Manual Only</option>
                      <option value="hourly">Hourly (hourly)</option>
                      <option value="daily">Daily at 02:00 (*-*-* 02:00:00)</option>
                      <option value="weekly">Weekly Monday 03:00 (Mon *-*-* 03:00:00)</option>
                      <option value="custom">Custom systemd OnCalendar</option>
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-zinc-400 block">
                      OnCalendar Expression
                    </label>
                    <input
                      value={activeJob.schedule.onCalendar}
                      onChange={(e) =>
                        setActiveJob((j) => ({
                          ...j,
                          schedule: {
                            ...j.schedule,
                            preset: "custom",
                            onCalendar: e.target.value,
                          },
                        }))
                      }
                      placeholder="e.g. *-*-* 02:00:00 or *:0/15"
                      className="w-full h-8 px-2 rounded border border-zinc-300 dark:border-[#3b3d44] bg-white dark:bg-[#1e1f22] font-mono"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-4 pt-1">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activeJob.schedule.notifyOnSuccess}
                      onChange={(e) =>
                        setActiveJob((j) => ({
                          ...j,
                          schedule: {
                            ...j.schedule,
                            notifyOnSuccess: e.target.checked,
                          },
                        }))
                      }
                    />
                    <Bell className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Desktop notification on success</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={activeJob.schedule.notifyOnFailure}
                      onChange={(e) =>
                        setActiveJob((j) => ({
                          ...j,
                          schedule: {
                            ...j.schedule,
                            notifyOnFailure: e.target.checked,
                          },
                        }))
                      }
                    />
                    <Bell className="w-3.5 h-3.5 text-red-400" />
                    <span>Desktop notification on failure</span>
                  </label>
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <button
                    onClick={handleSyncTimer}
                    className="h-8 px-3 rounded bg-lime-600 hover:bg-lime-500 text-white font-medium flex items-center gap-1.5 cursor-pointer"
                  >
                    <CalendarClock className="w-3.5 h-3.5" />
                    <span>Install / Sync systemd Timer</span>
                  </button>
                  <button
                    onClick={handleRemoveTimer}
                    className="h-8 px-3 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 flex items-center gap-1.5 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Remove Timer</span>
                  </button>
                </div>
              </div>

              {timerStatus && (
                <div className="p-4 rounded-lg border border-zinc-200 dark:border-[#35373c] bg-zinc-50 dark:bg-[#23252a] space-y-2">
                  <div className="font-semibold flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Terminal className="w-4 h-4 text-sky-400" />
                      Unit Status: <code className="font-mono">{timerStatus.unitName}</code>
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[0.68rem] font-semibold ${
                        timerStatus.active
                          ? "bg-emerald-500/20 text-emerald-400"
                          : timerStatus.installed
                          ? "bg-amber-500/20 text-amber-400"
                          : "bg-zinc-500/20 text-zinc-400"
                      }`}
                    >
                      {timerStatus.active
                        ? "ACTIVE"
                        : timerStatus.installed
                        ? "INSTALLED"
                        : "NOT INSTALLED"}
                    </span>
                  </div>
                  <div className="text-zinc-400">{timerStatus.message}</div>
                  {timerStatus.nextTrigger && (
                    <div className="text-zinc-300 font-mono text-[0.72rem]">
                      Next Trigger: {timerStatus.nextTrigger}
                    </div>
                  )}
                  <div className="text-[0.68rem] text-zinc-500 font-mono space-y-0.5">
                    <div>Service: {timerStatus.servicePath}</div>
                    <div>Timer: {timerStatus.timerPath}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {subTab === "logs" && (
            <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 h-full min-h-[340px]">
              <div className="border border-zinc-200 dark:border-[#35373c] rounded-lg flex flex-col overflow-hidden">
                <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#23252a] flex items-center justify-between">
                  <span className="font-semibold">Recent Runs</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => refreshLogs(activeJob.id)}
                      className="text-sky-400 hover:underline cursor-pointer flex items-center gap-1"
                    >
                      <RefreshCw className="w-3 h-3" /> Refresh
                    </button>
                    <button
                      onClick={async () => {
                        await api.clearJobLogs(activeJob.id);
                        setLogs([]);
                        setSelectedLog(null);
                      }}
                      className="text-zinc-400 hover:text-red-400 cursor-pointer"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
                  {logs.length === 0 ? (
                    <div className="text-zinc-500 text-center py-6">
                      No execution logs recorded yet.
                    </div>
                  ) : (
                    logs.map((l) => (
                      <button
                        key={l.id}
                        onClick={() => setSelectedLog(l)}
                        className={`w-full text-left p-2 rounded border cursor-pointer ${
                          selectedLog?.id === l.id
                            ? "border-indigo-500 bg-indigo-500/10"
                            : "border-zinc-200 dark:border-[#32343a] hover:bg-zinc-100 dark:hover:bg-[#2a2c32]"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={`font-semibold uppercase text-[0.65rem] ${
                              l.status === "success"
                                ? "text-emerald-400"
                                : "text-red-400"
                            }`}
                          >
                            {l.status}
                          </span>
                          <span className="text-[0.65rem] text-zinc-500 font-mono">
                            {new Date(l.startedAt).toLocaleString()}
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="border border-zinc-200 dark:border-[#35373c] rounded-lg flex flex-col overflow-hidden">
                <div className="px-3 py-2 border-b border-zinc-200 dark:border-[#32343a] bg-zinc-50 dark:bg-[#23252a] font-semibold">
                  Execution Output
                </div>
                <pre className="flex-1 p-3 bg-[#1e1f22] text-emerald-300 font-mono text-[0.72rem] overflow-auto whitespace-pre-wrap">
                  {selectedLog
                    ? selectedLog.output
                    : "-- Select a run on the left to inspect logs."}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
