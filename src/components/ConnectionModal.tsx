import React, { useEffect, useState } from "react";
import {
  CheckCircle2,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  Shield,
  Terminal,
  X,
  XCircle,
} from "lucide-react";
import { api, formatApiError } from "../lib/tauri";
import { useWorkbenchStore } from "../store/useWorkbenchStore";
import type {
  ConnectionProfile,
  ConnectionTestResult,
  DbEngine,
  EnvironmentTag,
  SshAuthMethod,
  SslMode,
} from "../types/dba";

const DEFAULT_PORTS: Record<DbEngine, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
  mongodb: 27017,
};

export const ConnectionModal: React.FC = () => {
  const {
    connectionModalOpen,
    editingConnection,
    closeConnectionModal,
    refreshConnections,
    connectTo,
  } = useWorkbenchStore();

  const [tab, setTab] = useState<"general" | "ssh" | "ssl">("general");
  const [uriInput, setUriInput] = useState("");
  const [name, setName] = useState("");
  const [engine, setEngine] = useState<DbEngine>("postgres");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState(5432);
  const [database, setDatabase] = useState("postgres");
  const [username, setUsername] = useState("postgres");
  const [password, setPassword] = useState("");
  const [groupPath, setGroupPath] = useState("");
  const [environment, setEnvironment] = useState<EnvironmentTag>("local");
  const [readOnly, setReadOnly] = useState(false);

  // SSL
  const [sslMode, setSslMode] = useState<SslMode>("prefer");
  const [caCertPath, setCaCertPath] = useState("");

  // SSH
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState(22);
  const [sshUsername, setSshUsername] = useState("");
  const [sshAuthMethod, setSshAuthMethod] = useState<SshAuthMethod>("privatekey");
  const [sshKeyPath, setSshKeyPath] = useState("~/.ssh/id_ed25519");
  const [sshJumpHost, setSshJumpHost] = useState("");
  const [sshSecret, setSshSecret] = useState("");

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connectionModalOpen) return;
    setTab("general");
    setUriInput("");
    setTestResult(null);
    setError(null);
    setPassword("");
    setSshSecret("");

    if (editingConnection) {
      setName(editingConnection.name);
      setEngine(editingConnection.engine);
      setHost(editingConnection.host);
      setPort(editingConnection.port);
      setDatabase(editingConnection.database ?? "");
      setUsername(editingConnection.username);
      setGroupPath(editingConnection.groupPath ?? "");
      setEnvironment(editingConnection.environment);
      setReadOnly(editingConnection.readOnly);
      setSslMode(editingConnection.ssl?.mode ?? "prefer");
      setCaCertPath(editingConnection.ssl?.caCertPath ?? "");
      setSshEnabled(editingConnection.ssh?.enabled ?? false);
      setSshHost(editingConnection.ssh?.host ?? "");
      setSshPort(editingConnection.ssh?.port || 22);
      setSshUsername(editingConnection.ssh?.username ?? "");
      setSshAuthMethod(editingConnection.ssh?.authMethod ?? "privatekey");
      setSshKeyPath(editingConnection.ssh?.privateKeyPath ?? "~/.ssh/id_ed25519");
      setSshJumpHost(editingConnection.ssh?.jumpHost ?? "");
    } else {
      setName("");
      setEngine("postgres");
      setHost("127.0.0.1");
      setPort(5432);
      setDatabase("postgres");
      setUsername("postgres");
      setGroupPath("");
      setEnvironment("local");
      setReadOnly(false);
      setSslMode("prefer");
      setCaCertPath("");
      setSshEnabled(false);
      setSshHost("");
      setSshPort(22);
      setSshUsername("");
      setSshAuthMethod("privatekey");
      setSshKeyPath("~/.ssh/id_ed25519");
      setSshJumpHost("");
    }
  }, [connectionModalOpen, editingConnection]);

  if (!connectionModalOpen) return null;

  const buildProfile = (): ConnectionProfile => {
    const now = new Date().toISOString();
    return {
      id: editingConnection?.id ?? "",
      name: name.trim() || `${engine}@${host}`,
      engine,
      host: host.trim(),
      port: Number(port) || DEFAULT_PORTS[engine],
      database: database.trim() || null,
      username: username.trim(),
      keyringRef: editingConnection?.keyringRef ?? null,
      groupPath: groupPath.trim() || null,
      environment,
      color: null,
      readOnly,
      ssl: {
        mode: sslMode,
        caCertPath: caCertPath.trim() || null,
        clientCertPath: null,
        clientKeyPath: null,
      },
      ssh: {
        enabled: sshEnabled,
        host: sshHost.trim(),
        port: Number(sshPort) || 22,
        username: sshUsername.trim(),
        authMethod: sshAuthMethod,
        privateKeyPath: sshKeyPath.trim() || null,
        jumpHost: sshJumpHost.trim() || null,
        keyringRef: editingConnection?.ssh?.keyringRef ?? null,
      },
      createdAt: editingConnection?.createdAt ?? now,
      updatedAt: now,
    };
  };

  const handleImportUri = async () => {
    if (!uriInput.trim()) return;
    setError(null);
    try {
      const parsed = await api.parseUri(uriInput.trim());
      setEngine(parsed.engine);
      setHost(parsed.host);
      setPort(parsed.port);
      setUsername(parsed.username);
      if (parsed.password) setPassword(parsed.password);
      setDatabase(parsed.database ?? "");
      if (parsed.sslMode) setSslMode(parsed.sslMode);
      if (!name) setName(`${parsed.engine}-${parsed.host}`);
    } catch (err) {
      setError(formatApiError(err));
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await api.testConnection({
        profile: buildProfile(),
        password: password || null,
        sshSecret: sshSecret || null,
      });
      setTestResult(res);
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (connectNow: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveConnection({
        profile: buildProfile(),
        password: password || null,
        sshSecret: sshSecret || null,
      });
      await refreshConnections();
      closeConnectionModal();
      if (connectNow) {
        await connectTo(saved.id);
      }
    } catch (err) {
      setError(formatApiError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60  flex items-center justify-center p-4">
      <div className="w-full max-w-2xl rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {editingConnection ? "Edit Connection Profile" : "New Database Connection"}
            </h2>
            <p className="text-[0.8rem] text-zinc-500">
              Secrets are stored securely in Linux OS Keyring (never plaintext JSON).
            </p>
          </div>
          <button
            onClick={closeConnectionModal}
            className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 text-zinc-500"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Quick URI Import */}
        <div className="px-5 py-2.5 bg-zinc-50 dark:bg-zinc-950/60 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
          <Link2 className="w-4 h-4 text-indigo-500 dark:text-indigo-400 shrink-0" />
          <input
            value={uriInput}
            onChange={(e) => setUriInput(e.target.value)}
            placeholder="Quick URI Import: postgres://user:pass@host:5432/dbname?sslmode=require"
            className="flex-1 h-7 px-2.5 text-xs rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono"
          />
          <button
            onClick={handleImportUri}
            className="h-7 px-3 rounded text-xs font-medium bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200"
          >
            Parse URI
          </button>
        </div>

        {/* Engine Selector */}
        <div className="px-5 pt-3 flex items-center gap-2">
          {(
            [
              { id: "postgres", label: "PostgreSQL", ready: true },
              { id: "mysql", label: "MySQL / MariaDB", ready: true },
              { id: "mssql", label: "SQL Server", ready: true },
              { id: "mongodb", label: "MongoDB", ready: true },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setEngine(item.id);
                setPort(DEFAULT_PORTS[item.id]);
                if (item.id === "postgres" && ["root", "sa", ""].includes(username)) setUsername("postgres");
                if (item.id === "mysql" && ["postgres", "sa", ""].includes(username)) setUsername("root");
                if (item.id === "mssql" && ["postgres", "root", ""].includes(username)) setUsername("sa");
                if (item.id === "mongodb" && ["postgres", "root", "sa"].includes(username)) setUsername("");
                if (item.id === "mssql" && ["postgres", "admin"].includes(database)) setDatabase("master");
                if (item.id === "mongodb" && ["postgres", "master"].includes(database)) setDatabase("admin");
              }}
              className={`flex-1 py-2 px-2.5 rounded-lg border text-xs font-medium transition ${
                engine === item.id
                  ? "border-indigo-500 bg-indigo-500/15 text-indigo-500 dark:text-indigo-400"
                  : "border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:border-zinc-400"
              }`}
            >
              <div>{item.label}</div>
            </button>
          ))}
        </div>

        {/* Sub Tabs */}
        <div className="px-5 pt-3 flex gap-4 border-b border-zinc-200 dark:border-zinc-800 text-xs">
          {(
            [
              { id: "general", label: "General", icon: KeyRound },
              { id: "ssh", label: "SSH Tunnel", icon: Terminal },
              { id: "ssl", label: "SSL / TLS", icon: Lock },
            ] as const
          ).map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`pb-2 flex items-center gap-1.5 border-b-2 transition ${
                  tab === t.id
                    ? "border-indigo-500 text-indigo-500 dark:text-indigo-400 font-medium"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Form Body */}
        <div className="p-5 overflow-y-auto space-y-3.5 text-xs">
          {tab === "general" && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-zinc-500 mb-1">Connection Name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Local Postgres"
                    className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700"
                  />
                </div>
                <div>
                  <label className="block text-zinc-500 mb-1">Folder / Group</label>
                  <input
                    value={groupPath}
                    onChange={(e) => setGroupPath(e.target.value)}
                    placeholder="e.g. Work / Production"
                    className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-zinc-500 mb-1">Host</label>
                  <input
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-zinc-500 mb-1">Port</label>
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                    className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-zinc-500 mb-1">Username</label>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-zinc-500 mb-1">
                    Password {editingConnection?.keyringRef ? "(saved in Keyring)" : ""}
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={editingConnection?.keyringRef ? "•••••••• (unchanged)" : ""}
                    className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-zinc-500 mb-1">Default Database</label>
                  <input
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder="Optional"
                    className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-zinc-500 mb-1">Environment Tag</label>
                  <select
                    value={environment}
                    onChange={(e) => setEnvironment(e.target.value as EnvironmentTag)}
                    className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700"
                  >
                    <option value="local">Local (Green)</option>
                    <option value="dev">Development (Green)</option>
                    <option value="staging">Staging (Amber)</option>
                    <option value="production">Production (Red + Safety Guard)</option>
                  </select>
                </div>
              </div>

              <label className="flex items-center gap-2 pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={readOnly}
                  onChange={(e) => setReadOnly(e.target.checked)}
                  className="rounded border-zinc-600"
                />
                <Shield className="w-3.5 h-3.5 text-sky-400" />
                <span className="text-zinc-700 dark:text-zinc-300">
                  Enable <strong>Read-Only Mode</strong> (blocks all INSERT/UPDATE/DELETE/DDL)
                </span>
              </label>
            </>
          )}

          {tab === "ssh" && (
            <>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sshEnabled}
                  onChange={(e) => setSshEnabled(e.target.checked)}
                />
                <span className="font-medium">Connect through SSH Tunnel</span>
              </label>
              {sshEnabled && (
                <div className="space-y-3 pt-1">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <label className="block text-zinc-500 mb-1">SSH Host</label>
                      <input
                        value={sshHost}
                        onChange={(e) => setSshHost(e.target.value)}
                        placeholder="bastion.example.com"
                        className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-zinc-500 mb-1">SSH Port</label>
                      <input
                        type="number"
                        value={sshPort}
                        onChange={(e) => setSshPort(Number(e.target.value))}
                        className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-zinc-500 mb-1">SSH Username</label>
                      <input
                        value={sshUsername}
                        onChange={(e) => setSshUsername(e.target.value)}
                        className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-zinc-500 mb-1">Auth Method</label>
                      <select
                        value={sshAuthMethod}
                        onChange={(e) => setSshAuthMethod(e.target.value as SshAuthMethod)}
                        className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700"
                      >
                        <option value="privatekey">Private Key (id_ed25519 / id_rsa)</option>
                        <option value="password">Password</option>
                      </select>
                    </div>
                  </div>
                  {sshAuthMethod === "privatekey" && (
                    <div>
                      <label className="block text-zinc-500 mb-1">Private Key Path</label>
                      <input
                        value={sshKeyPath}
                        onChange={(e) => setSshKeyPath(e.target.value)}
                        className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                      />
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-zinc-500 mb-1">
                        Jump / Bastion Host (optional)
                      </label>
                      <input
                        value={sshJumpHost}
                        onChange={(e) => setSshJumpHost(e.target.value)}
                        placeholder="user@jump.host"
                        className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-zinc-500 mb-1">
                        SSH Passphrase / Password
                      </label>
                      <input
                        type="password"
                        value={sshSecret}
                        onChange={(e) => setSshSecret(e.target.value)}
                        className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700"
                      />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === "ssl" && (
            <div className="space-y-3">
              <div>
                <label className="block text-zinc-500 mb-1">SSL / TLS Mode</label>
                <select
                  value={sslMode}
                  onChange={(e) => setSslMode(e.target.value as SslMode)}
                  className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700"
                >
                  <option value="disable">Disable</option>
                  <option value="prefer">Prefer (Default)</option>
                  <option value="require">Require</option>
                  <option value="verify-ca">Verify CA</option>
                  <option value="verify-full">Verify Full</option>
                </select>
              </div>
              <div>
                <label className="block text-zinc-500 mb-1">Custom CA Certificate Path (PEM)</label>
                <input
                  value={caCertPath}
                  onChange={(e) => setCaCertPath(e.target.value)}
                  placeholder="/path/to/ca-cert.pem"
                  className="w-full h-8 px-2.5 rounded bg-zinc-50 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 font-mono"
                />
              </div>
            </div>
          )}

          {error && (
            <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
              {error}
            </div>
          )}

          {testResult && (
            <div
              className={`p-2.5 rounded-lg border text-xs flex items-start gap-2 ${
                testResult.ok
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                  : "bg-red-500/10 border-red-500/30 text-red-400"
              }`}
            >
              {testResult.ok ? (
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              ) : (
                <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
              )}
              <div>
                <div className="font-medium">
                  {testResult.message} ({testResult.latencyMs}ms)
                </div>
                {testResult.serverVersion && (
                  <div className="opacity-80 mt-0.5 font-mono text-[0.8rem]">
                    {testResult.serverVersion}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 flex items-center justify-between">
          <button
            onClick={handleTest}
            disabled={testing}
            className="h-8 px-3.5 rounded-md text-xs font-medium border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center gap-1.5"
          >
            {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Test Connection
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={() => handleSave(false)}
              disabled={saving}
              className="h-8 px-3.5 rounded-md text-xs font-medium bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700"
            >
              Save
            </button>
            <button
              onClick={() => handleSave(true)}
              disabled={saving}
              className="h-8 px-4 rounded-md text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white"
            >
              Save & Connect
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
