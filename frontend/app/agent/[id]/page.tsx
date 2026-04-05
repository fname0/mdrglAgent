"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, LogOut, Monitor, RefreshCw } from "lucide-react";
import { AgentStatusPill, TaskStatusBadge } from "@/components/status-pill";
import { JsonViewer } from "@/components/json-viewer";
import { TaskHistoryTable } from "@/components/task-history-table";
import { CustomScenariosPanel } from "@/components/custom-scenarios-panel";
import { RoutineTasksPanel } from "@/components/routine-tasks-panel";
import { ScheduledTasksPanel } from "@/components/scheduled-tasks-panel";
import { TaskModal } from "@/components/task-modal";
import { fetchAgentTasks, fetchAgents, getApiErrorMessage } from "@/lib/api";
import { clearToken } from "@/lib/auth";
import { Agent, AgentTask } from "@/lib/types";
import { useAuthGuard } from "@/lib/use-auth-guard";

function formatLastSeen(value: string): string {
  if (!value) {
    return "нет данных";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringSafe(value: unknown, fallback = "-"): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return fallback;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

type Severity = "ok" | "warn" | "crit" | "unknown";

function normalizeSeverity(value: unknown): Severity {
  if (typeof value !== "string") {
    return "unknown";
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "ok" || normalized === "warn" || normalized === "crit") {
    return normalized;
  }

  if (normalized.includes("ok") || normalized.includes("success")) {
    return "ok";
  }

  if (normalized.includes("warn")) {
    return "warn";
  }

  if (normalized.includes("crit") || normalized.includes("error") || normalized.includes("fail")) {
    return "crit";
  }

  return "unknown";
}

function severityStyles(severity: Severity): string {
  if (severity === "ok") {
    return "border-emerald-400/30 bg-emerald-500/10 text-emerald-300";
  }

  if (severity === "warn") {
    return "border-amber-400/30 bg-amber-500/10 text-amber-300";
  }

  if (severity === "crit") {
    return "border-rose-400/30 bg-rose-500/10 text-rose-300";
  }

  return "border-slate-400/30 bg-slate-500/10 text-slate-300";
}

function severityLabel(severity: Severity): string {
  if (severity === "ok") {
    return "ok";
  }

  if (severity === "warn") {
    return "warn";
  }

  if (severity === "crit") {
    return "crit";
  }

  return "n/a";
}

function readTaskDiagnostic(task: AgentTask | null): { severity: Severity; summary: string } {
  if (!task || !isRecord(task.result)) {
    return { severity: "unknown", summary: "Нет данных" };
  }

  const summaryRaw = task.result.summary;
  const summary = typeof summaryRaw === "string" && summaryRaw.trim().length > 0 ? summaryRaw : "Нет данных";

  return {
    severity: normalizeSeverity(task.result.severity),
    summary,
  };
}

function readResultFacts(task: AgentTask | null): unknown {
  if (!task || !isRecord(task.result)) {
    return null;
  }

  return task.result.facts ?? null;
}

function pickLatestTask(tasks: AgentTask[], taskType: string): AgentTask | null {
  for (const task of tasks) {
    if (task.task_type === taskType) {
      return task;
    }
  }

  return null;
}

interface SnapshotOverview {
  hostname: string;
  osName: string;
  osVersion: string;
  interfaceCount: number;
  ipCount: number;
  primaryIp: string;
  defaultGateway: string;
  dnsCount: number;
  collectedAt: string;
}

function extractSnapshotOverview(task: AgentTask | null): SnapshotOverview | null {
  const facts = readResultFacts(task);
  if (!isRecord(facts)) {
    return null;
  }

  const interfaces = Array.isArray(facts.network_interfaces) ? facts.network_interfaces : [];
  const ipAddresses = toStringArray(facts.ip_addresses);
  const dnsServers = toStringArray(facts.dns_servers);

  return {
    hostname: toStringSafe(facts.hostname),
    osName: toStringSafe(facts.os_name),
    osVersion: toStringSafe(facts.os_version),
    interfaceCount: interfaces.length,
    ipCount: ipAddresses.length,
    primaryIp: ipAddresses[0] ?? "-",
    defaultGateway: toStringSafe(facts.default_gateway),
    dnsCount: dnsServers.length,
    collectedAt: toStringSafe(facts.last_seen_at, ""),
  };
}

interface PortPreviewItem {
  protocol: string;
  endpoint: string;
  processName: string;
}

interface ListeningPortsOverview {
  total: number;
  tcp: number;
  udp: number;
  preview: PortPreviewItem[];
}

function extractListeningPortsOverview(task: AgentTask | null): ListeningPortsOverview | null {
  const facts = readResultFacts(task);
  if (!isRecord(facts) || !Array.isArray(facts.ports)) {
    return null;
  }

  let total = 0;
  let tcp = 0;
  let udp = 0;
  const preview: PortPreviewItem[] = [];

  for (const rawPort of facts.ports) {
    if (!isRecord(rawPort)) {
      continue;
    }

    total += 1;

    const protocolRaw = toStringSafe(rawPort.protocol, "unknown").toLowerCase();
    if (protocolRaw === "tcp") {
      tcp += 1;
    } else if (protocolRaw === "udp") {
      udp += 1;
    }

    const address = toStringSafe(rawPort.address);
    const numberPort = typeof rawPort.port === "number" ? rawPort.port : Number(rawPort.port);
    const endpoint = Number.isFinite(numberPort) ? `${address}:${numberPort}` : address;

    if (preview.length < 5) {
      preview.push({
        protocol: protocolRaw,
        endpoint,
        processName: toStringSafe(rawPort.process_name),
      });
    }
  }

  return {
    total,
    tcp,
    udp,
    preview,
  };
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-slate-100">{value}</p>
    </div>
  );
}

export default function AgentPage() {
  const params = useParams<{ id: string }>();
  const rawId = params?.id;
  const agentId = Array.isArray(rawId) ? rawId[0] : rawId;

  const router = useRouter();
  const isAuthorized = useAuthGuard();

  const [agent, setAgent] = useState<Agent | null>(null);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const latestSnapshotTask = useMemo(() => pickLatestTask(tasks, "agent_snapshot"), [tasks]);
  const latestListeningPortsTask = useMemo(() => pickLatestTask(tasks, "list_listening_ports"), [tasks]);

  const snapshotDiagnostic = useMemo(() => readTaskDiagnostic(latestSnapshotTask), [latestSnapshotTask]);
  const listeningDiagnostic = useMemo(() => readTaskDiagnostic(latestListeningPortsTask), [latestListeningPortsTask]);
  const snapshotFacts = useMemo(() => readResultFacts(latestSnapshotTask), [latestSnapshotTask]);
  const listeningFacts = useMemo(() => readResultFacts(latestListeningPortsTask), [latestListeningPortsTask]);
  const snapshotOverview = useMemo(() => extractSnapshotOverview(latestSnapshotTask), [latestSnapshotTask]);
  const listeningOverview = useMemo(() => extractListeningPortsOverview(latestListeningPortsTask), [latestListeningPortsTask]);

  const loadTasks = useCallback(
    async (silent: boolean) => {
      if (!agentId) {
        return;
      }

      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const payload = await fetchAgentTasks(agentId);
        setTasks(payload);
        setError(null);
      } catch (loadError) {
        setError(getApiErrorMessage(loadError, "Не удалось загрузить задачи агента."));
      } finally {
        if (silent) {
          setRefreshing(false);
        } else {
          setLoading(false);
        }
      }
    },
    [agentId],
  );

  const loadAgentInfo = useCallback(async () => {
    if (!agentId) {
      return;
    }

    try {
      const agents = await fetchAgents();
      const matched = agents.find((item) => item.id === agentId) ?? null;
      setAgent(matched);
    } catch {
      setAgent(null);
    }
  }, [agentId]);

  useEffect(() => {
    if (!isAuthorized || !agentId) {
      return;
    }

    void loadTasks(false);
    void loadAgentInfo();

    const timerId = window.setInterval(() => {
      void loadTasks(true);
    }, 5000);

    return () => window.clearInterval(timerId);
  }, [agentId, isAuthorized, loadAgentInfo, loadTasks]);

  function handleLogout() {
    clearToken();
    router.replace("/login");
  }

  if (!isAuthorized) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-400">Проверка сессии...</p>
      </main>
    );
  }

  if (!agentId) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-rose-300">Некорректный ID агента.</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-4 py-6 md:px-6 md:py-8">
      <div className="mx-auto w-full max-w-6xl space-y-6">
        <header className="rounded-2xl border border-slate-700/70 bg-panel/85 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <Link
                href="/dashboard"
                className="mb-3 inline-flex items-center gap-2 text-sm text-slate-300 transition hover:text-sky-200"
              >
                <ArrowLeft className="h-4 w-4" />
                Назад к дашборду
              </Link>

              <h1 className="text-2xl font-semibold text-slate-100">Агент: {agent?.hostname ?? agentId}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-400">
                <span>ID: {agentId}</span>
                {agent ? (
                  <>
                    <span>|</span>
                    <span>{agent.os}</span>
                    <span>|</span>
                    <span className="font-mono">{agent.ip}</span>
                    <span>|</span>
                    <span>Последний контакт: {formatLastSeen(agent.last_seen)}</span>
                    <AgentStatusPill status={agent.status} />
                  </>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={`/agent/${agentId}/remote`}
                className="inline-flex items-center gap-2 rounded-lg border border-violet-500/40 bg-violet-500/15 px-3 py-2 text-sm font-semibold text-violet-200 transition hover:bg-violet-500/25"
              >
                <Monitor className="h-4 w-4" />
                Удалённый доступ
              </Link>

              <button
                type="button"
                onClick={() => void loadTasks(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-400 hover:bg-slate-800"
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                Обновить
              </button>

              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/20"
              >
                <LogOut className="h-4 w-4" />
                Выйти
              </button>
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <details className="rounded-xl border border-slate-700/70 bg-panel/85">
            <summary className="cursor-pointer p-4">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-base font-semibold text-slate-100">Последний agent_snapshot</h2>
                <div className="flex items-center gap-2">
                  {latestSnapshotTask ? <TaskStatusBadge status={latestSnapshotTask.status} /> : null}
                  <span
                    className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold uppercase tracking-wide ${severityStyles(
                      snapshotDiagnostic.severity,
                    )}`}
                  >
                    {severityLabel(snapshotDiagnostic.severity)}
                  </span>
                </div>
              </div>
            </summary>

            <div className="px-4 pb-4">
              <p className="mt-2 text-sm text-slate-300">{snapshotDiagnostic.summary}</p>
              <p className="mt-1 text-xs text-slate-500">
                Обновлено: {formatLastSeen(latestSnapshotTask?.completed_at || latestSnapshotTask?.created_at || "")}
              </p>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <MetricCell label="Hostname" value={snapshotOverview?.hostname ?? "-"} />
                <MetricCell label="OS" value={snapshotOverview ? `${snapshotOverview.osName} ${snapshotOverview.osVersion}` : "-"} />
                <MetricCell label="Интерфейсы" value={snapshotOverview ? String(snapshotOverview.interfaceCount) : "-"} />
                <MetricCell label="IP адреса" value={snapshotOverview ? String(snapshotOverview.ipCount) : "-"} />
                <MetricCell label="Primary IP" value={snapshotOverview?.primaryIp ?? "-"} />
                <MetricCell label="Gateway / DNS" value={snapshotOverview ? `${snapshotOverview.defaultGateway} / ${snapshotOverview.dnsCount}` : "-"} />
              </div>

              {snapshotOverview?.collectedAt ? (
                <p className="mt-2 text-xs text-slate-500">last_seen_at: {formatLastSeen(snapshotOverview.collectedAt)}</p>
              ) : null}

              <details className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 p-2">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Raw facts JSON
                </summary>
                <div className="mt-2">
                  <JsonViewer value={snapshotFacts} />
                </div>
              </details>
            </div>
          </details>

          <details className="rounded-xl border border-slate-700/70 bg-panel/85">
            <summary className="cursor-pointer p-4">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-base font-semibold text-slate-100">Последний list_listening_ports</h2>
                <div className="flex items-center gap-2">
                  {latestListeningPortsTask ? <TaskStatusBadge status={latestListeningPortsTask.status} /> : null}
                  <span
                    className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold uppercase tracking-wide ${severityStyles(
                      listeningDiagnostic.severity,
                    )}`}
                  >
                    {severityLabel(listeningDiagnostic.severity)}
                  </span>
                </div>
              </div>
            </summary>

            <div className="px-4 pb-4">
              <p className="mt-2 text-sm text-slate-300">{listeningDiagnostic.summary}</p>
              <p className="mt-1 text-xs text-slate-500">
                Обновлено: {formatLastSeen(latestListeningPortsTask?.completed_at || latestListeningPortsTask?.created_at || "")}
              </p>

              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <MetricCell label="Всего" value={listeningOverview ? String(listeningOverview.total) : "-"} />
                <MetricCell label="TCP" value={listeningOverview ? String(listeningOverview.tcp) : "-"} />
                <MetricCell label="UDP" value={listeningOverview ? String(listeningOverview.udp) : "-"} />
              </div>

              {listeningOverview && listeningOverview.preview.length > 0 ? (
                <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Примеры сокетов</p>
                  <ul className="space-y-1 text-sm text-slate-300">
                    {listeningOverview.preview.map((item) => (
                      <li key={`${item.protocol}:${item.endpoint}:${item.processName}`} className="font-mono">
                        {item.protocol} {item.endpoint} ({item.processName})
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <details className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 p-2">
                <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Raw facts JSON
                </summary>
                <div className="mt-2">
                  <JsonViewer value={listeningFacts} />
                </div>
              </details>
            </div>
          </details>
        </section>

        <CustomScenariosPanel />
        <RoutineTasksPanel agentId={agentId} />
        <ScheduledTasksPanel agentId={agentId} />

        <TaskModal
          open={true}
          inline
          agent={agent}
          onClose={() => {}}
          onTaskCreated={() => {
            void loadTasks(true);
            void loadAgentInfo();
          }}
        />

        <TaskHistoryTable
          tasks={tasks}
          loading={loading}
          error={error}
          agentId={agentId}
          agentHostname={agent?.hostname}
        />
      </div>
    </main>
  );
}





