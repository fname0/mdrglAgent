"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Play, X } from "lucide-react";
import {
  CreateTaskPayload,
  CustomScenarioRecord,
  createTask,
  fetchCustomScenarios,
  fetchTaskById,
  getApiErrorMessage,
} from "@/lib/api";
import { JsonViewer } from "@/components/json-viewer";
import { TaskStatusBadge } from "@/components/status-pill";
import { Agent, AgentTask, TaskType } from "@/lib/types";

interface TaskModalProps {
  open: boolean;
  agent: Agent | null;
  onClose: () => void;
  onTaskCreated: () => void;
  inline?: boolean;
}

interface QuickFact {
  label: string;
  value: string;
}

const TASK_OPTIONS: Array<{ value: TaskType; label: string }> = [
  { value: "agent_snapshot", label: "Паспорт узла" },
  { value: "docker_runtime_access_check", label: "Docker runtime" },
  { value: "docker_container_status_check", label: "Docker контейнер" },
  { value: "docker_compose_stack_check", label: "Docker compose stack" },
  { value: "docker_port_mapping_check", label: "Docker port mapping" },
  { value: "process_port_inventory", label: "Инвентарь сетевых процессов" },
  { value: "custom_scenario", label: "Кастомный сценарий" },
  { value: "service_status_check", label: "Статус сервиса" },
  { value: "process_presence_check", label: "Наличие процесса" },
  { value: "port_owner_check", label: "Владелец порта" },
  { value: "process_resource_snapshot", label: "Ресурсы процесса" },
  { value: "tcp_connect_check", label: "Проверка TCP-порта" },
  { value: "http_check", label: "Проверка HTTP endpoint" },
  { value: "list_listening_ports", label: "Список listening портов" },
];

const DEFAULT_TCP_TIMEOUT_SECONDS = 3;
const DEFAULT_HTTP_TIMEOUT_SECONDS = 5;
const DEFAULT_SAMPLE_SECONDS = 2;
const DEFAULT_PROCESS_PORT_PATTERNS = "node, postgres, docker, nginx, python, redis, java";

type Severity = "ok" | "warn" | "crit" | "unknown";

type ServiceExpectedState = "" | "running" | "stopped" | "paused";

type PortProtocol = "tcp" | "udp";
type DockerExpectedState = "" | "running" | "exited" | "paused" | "restarting" | "created" | "dead";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toDisplayValue(value: unknown, fallback = "-"): string {
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

function normalizeStatus(status: string): string {
  const normalized = status.trim().toLowerCase();

  if (normalized.includes("success") || normalized.includes("done") || normalized.includes("completed")) {
    return "success";
  }

  if (normalized.includes("fail") || normalized.includes("error") || normalized.includes("cancel")) {
    return "failed";
  }

  if (normalized.includes("running") || normalized.includes("progress")) {
    return "running";
  }

  if (normalized.includes("pending") || normalized.includes("queued")) {
    return "pending";
  }

  return "unknown";
}

function isTerminalStatus(status: string): boolean {
  const normalized = normalizeStatus(status);
  return normalized === "success" || normalized === "failed";
}

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

function readDiagnostic(task: AgentTask | null): { severity: Severity; summary: string; facts: unknown } {
  if (!task || !isRecord(task.result)) {
    return { severity: "unknown", summary: "-", facts: null };
  }

  const severity = normalizeSeverity(task.result.severity);
  const summaryRaw = task.result.summary;
  const summary = typeof summaryRaw === "string" && summaryRaw.trim().length > 0 ? summaryRaw : "-";

  return {
    severity,
    summary,
    facts: task.result.facts ?? null,
  };
}

function readQuickFacts(task: AgentTask | null): QuickFact[] {
  if (!task || !isRecord(task.result)) {
    return [];
  }

  const facts = task.result.facts;
  if (!isRecord(facts)) {
    return [];
  }

  if (task.task_type === "service_status_check") {
    return [
      { label: "Сервис", value: toDisplayValue(facts.service_name) },
      { label: "State", value: toDisplayValue(facts.state) },
      { label: "Enabled", value: toDisplayValue(facts.enabled) },
      { label: "PID", value: toDisplayValue(facts.pid) },
      { label: "Start mode", value: toDisplayValue(facts.start_mode) },
    ];
  }

  if (task.task_type === "process_presence_check") {
    return [
      { label: "Процесс", value: toDisplayValue(facts.process_name) },
      { label: "Найдено", value: toDisplayValue(facts.running_count) },
      {
        label: "Ожидание",
        value: `${toDisplayValue(facts.expected_min_count, "0")}..${toDisplayValue(facts.expected_max_count, "∞")}`,
      },
      { label: "Match mode", value: toDisplayValue(facts.match_mode) },
    ];
  }

  if (task.task_type === "port_owner_check") {
    return [
      { label: "Порт", value: `${toDisplayValue(facts.port)} / ${toDisplayValue(facts.protocol)}` },
      { label: "Owner", value: toDisplayValue(facts.process_name) },
      { label: "PID", value: toDisplayValue(facts.pid) },
      { label: "Address", value: toDisplayValue(facts.address) },
    ];
  }

  if (task.task_type === "process_resource_snapshot") {
    return [
      { label: "Процесс", value: toDisplayValue(facts.process_name) },
      { label: "PID", value: toDisplayValue(facts.pid) },
      { label: "CPU", value: `${toDisplayValue(facts.cpu_percent)}%` },
      { label: "RSS", value: `${toDisplayValue(facts.rss_mb)} MB` },
      { label: "Threads", value: toDisplayValue(facts.thread_count) },
      { label: "Uptime", value: `${toDisplayValue(facts.uptime_seconds)}s` },
    ];
  }

  if (task.task_type === "docker_runtime_access_check") {
    return [
      { label: "Docker CLI", value: toDisplayValue(facts.docker_cli_available) },
      { label: "Daemon", value: toDisplayValue(facts.daemon_reachable) },
      { label: "Version", value: toDisplayValue(facts.server_version) },
      { label: "Containers", value: toDisplayValue(facts.container_count) },
    ];
  }

  if (task.task_type === "docker_container_status_check") {
    return [
      { label: "Container", value: toDisplayValue(facts.container_name) },
      { label: "State", value: toDisplayValue(facts.state) },
      { label: "Health", value: toDisplayValue(facts.health_status) },
      { label: "Restart", value: toDisplayValue(facts.restart_count) },
    ];
  }

  if (task.task_type === "docker_compose_stack_check") {
    return [
      { label: "Project", value: toDisplayValue(facts.project_name) },
      { label: "Services", value: toDisplayValue(facts.service_count) },
      { label: "Running", value: toDisplayValue(facts.running_count) },
      { label: "Unhealthy", value: toDisplayValue(facts.unhealthy_count) },
    ];
  }

  if (task.task_type === "docker_port_mapping_check") {
    return [
      { label: "Container", value: toDisplayValue(facts.container_name) },
      { label: "Host port", value: `${toDisplayValue(facts.host_port)} / ${toDisplayValue(facts.protocol)}` },
      { label: "Published", value: toDisplayValue(facts.published) },
      { label: "Container port", value: toDisplayValue(facts.container_port) },
    ];
  }

  if (task.task_type === "process_port_inventory") {
    return [
      { label: "Паттерны", value: toDisplayValue((facts.process_patterns as unknown[] | undefined)?.length, "0") },
      { label: "Совпадения", value: toDisplayValue(facts.total) },
      { label: "Exposed", value: toDisplayValue(facts.network_exposed_count) },
      { label: "Local only", value: toDisplayValue(facts.local_only_count) },
    ];
  }

  if (task.task_type === "custom_scenario") {
    return [
      { label: "Сценарий", value: toDisplayValue(facts.scenario_name) },
      { label: "Платформа", value: toDisplayValue(facts.platform) },
      { label: "Выполнено", value: `${toDisplayValue(facts.executed_steps, "0")}/${toDisplayValue(facts.configured_steps, "0")}` },
      { label: "Ошибок", value: toDisplayValue(facts.failed_steps, "0") },
    ];
  }

  return [];
}

function QuickFacts({ items }: { items: QuickFact[] }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {items.map((item) => (
        <div key={`${item.label}:${item.value}`} className="rounded-md border border-slate-800 bg-slate-950/40 px-2.5 py-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">{item.label}</p>
          <p className="mt-1 text-sm text-slate-200">{item.value}</p>
        </div>
      ))}
    </div>
  );
}

export function TaskModal({ open, agent, onClose, onTaskCreated, inline = false }: TaskModalProps) {
  const [taskType, setTaskType] = useState<TaskType>("agent_snapshot");
  const [customScenarios, setCustomScenarios] = useState<CustomScenarioRecord[]>([]);
  const [customScenariosLoading, setCustomScenariosLoading] = useState(false);
  const [selectedCustomScenarioId, setSelectedCustomScenarioId] = useState("");

  const [host, setHost] = useState("");
  const [port, setPort] = useState("5432");
  const [url, setUrl] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(DEFAULT_TCP_TIMEOUT_SECONDS));
  const [expectedStatuses, setExpectedStatuses] = useState("200");

  const [serviceName, setServiceName] = useState("");
  const [serviceExpectedState, setServiceExpectedState] = useState<ServiceExpectedState>("running");
  const [serviceRequireEnabled, setServiceRequireEnabled] = useState(true);

  const [processName, setProcessName] = useState("");
  const [processCmdlineContains, setProcessCmdlineContains] = useState("");
  const [processExpectedMinCount, setProcessExpectedMinCount] = useState("1");
  const [processExpectedMaxCount, setProcessExpectedMaxCount] = useState("");
  const [processPortPatterns, setProcessPortPatterns] = useState(DEFAULT_PROCESS_PORT_PATTERNS);

  const [ownerPort, setOwnerPort] = useState("5432");
  const [ownerProtocol, setOwnerProtocol] = useState<PortProtocol>("tcp");
  const [ownerExpectedProcessName, setOwnerExpectedProcessName] = useState("");

  const [resourcePid, setResourcePid] = useState("");
  const [resourceProcessName, setResourceProcessName] = useState("");
  const [resourceCmdlineContains, setResourceCmdlineContains] = useState("");
  const [resourceSampleSeconds, setResourceSampleSeconds] = useState(String(DEFAULT_SAMPLE_SECONDS));
  const [resourceCpuWarnPercent, setResourceCpuWarnPercent] = useState("85");
  const [resourceRssWarnMb, setResourceRssWarnMb] = useState("2048");

  const [dockerContainerName, setDockerContainerName] = useState("");
  const [dockerContainerId, setDockerContainerId] = useState("");
  const [dockerExpectedState, setDockerExpectedState] = useState<DockerExpectedState>("running");
  const [dockerRequireHealthy, setDockerRequireHealthy] = useState(false);

  const [dockerProjectName, setDockerProjectName] = useState("");
  const [dockerExpectedServices, setDockerExpectedServices] = useState("");

  const [dockerMappingContainerName, setDockerMappingContainerName] = useState("");
  const [dockerMappingContainerId, setDockerMappingContainerId] = useState("");
  const [dockerMappingHostPort, setDockerMappingHostPort] = useState("8080");
  const [dockerMappingProtocol, setDockerMappingProtocol] = useState<PortProtocol>("tcp");
  const [dockerMappingExpectedContainerPort, setDockerMappingExpectedContainerPort] = useState("");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [submittedTaskId, setSubmittedTaskId] = useState<string | null>(null);
  const [submittedTask, setSubmittedTask] = useState<AgentTask | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);

  const loadCustomScenarios = useCallback(async () => {
    setCustomScenariosLoading(true);
    try {
      const payload = await fetchCustomScenarios();
      setCustomScenarios(payload);

      if (payload.length === 0) {
        setSelectedCustomScenarioId("");
        return;
      }

      setSelectedCustomScenarioId((previous) => {
        if (previous && payload.some((item) => item.id === previous)) {
          return previous;
        }
        const activeScenario = payload.find((item) => item.is_active);
        return (activeScenario ?? payload[0]).id;
      });
    } catch {
      setCustomScenarios([]);
      setSelectedCustomScenarioId("");
    } finally {
      setCustomScenariosLoading(false);
    }
  }, []);

  const title = useMemo(() => {
    if (!agent) {
      return "Запуск задачи";
    }

    return `Диагностика: ${agent.hostname}`;
  }, [agent]);

  useEffect(() => {
    if (!open) {
      setSubmittedTaskId(null);
      setSubmittedTask(null);
      setWatchError(null);
      setError(null);
      setIsSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !agent) {
      return;
    }

    void loadCustomScenarios();
  }, [agent, loadCustomScenarios, open]);

  useEffect(() => {
    if (!open || !agent) {
      return;
    }

    const handleCustomScenariosChanged = () => {
      void loadCustomScenarios();
    };

    window.addEventListener("custom-scenarios:changed", handleCustomScenariosChanged);
    return () => {
      window.removeEventListener("custom-scenarios:changed", handleCustomScenariosChanged);
    };
  }, [agent, loadCustomScenarios, open]);

  useEffect(() => {
    if (!open || !submittedTaskId) {
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;

    const pollTask = async () => {
      try {
        const task = await fetchTaskById(submittedTaskId);

        if (cancelled) {
          return;
        }

        setSubmittedTask(task);
        setWatchError(null);

        if (isTerminalStatus(task.status) && timerId !== null) {
          window.clearInterval(timerId);
          timerId = null;
        }
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        setWatchError(getApiErrorMessage(loadError, "Не удалось обновить статус задачи."));
      }
    };

    void pollTask();

    timerId = window.setInterval(() => {
      void pollTask();
    }, 1000);

    return () => {
      cancelled = true;

      if (timerId !== null) {
        window.clearInterval(timerId);
      }
    };
  }, [open, submittedTaskId]);

  if ((!inline && !open) || !agent) {
    return null;
  }

  const isTcpCheck = taskType === "tcp_connect_check";
  const isHttpCheck = taskType === "http_check";
  const isCustomScenario = taskType === "custom_scenario";
  const isServiceStatusCheck = taskType === "service_status_check";
  const isProcessPortInventory = taskType === "process_port_inventory";
  const isProcessPresenceCheck = taskType === "process_presence_check";
  const isPortOwnerCheck = taskType === "port_owner_check";
  const isProcessResourceSnapshot = taskType === "process_resource_snapshot";
  const isDockerRuntimeAccessCheck = taskType === "docker_runtime_access_check";
  const isDockerContainerStatusCheck = taskType === "docker_container_status_check";
  const isDockerComposeStackCheck = taskType === "docker_compose_stack_check";
  const isDockerPortMappingCheck = taskType === "docker_port_mapping_check";

  const isTaskRunning = submittedTaskId !== null && (!submittedTask || !isTerminalStatus(submittedTask.status));
  const diagnostic = readDiagnostic(submittedTask);
  const quickFacts = readQuickFacts(submittedTask);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!agent) {
      return;
    }

    let payload: CreateTaskPayload;

    if (taskType === "tcp_connect_check") {
      const normalizedHost = host.trim();
      if (!normalizedHost) {
        setError("Для tcp_connect_check обязательно поле host.");
        return;
      }

      const normalizedPort = Number(port.trim());
      if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
        setError("Порт должен быть целым числом в диапазоне 1..65535.");
        return;
      }

      const normalizedTimeout = Number(timeoutSeconds.trim());
      if (!Number.isInteger(normalizedTimeout) || normalizedTimeout < 1 || normalizedTimeout > 30) {
        setError("timeout_seconds должен быть целым числом в диапазоне 1..30.");
        return;
      }

      payload = {
        agent_id: agent.id,
        task_type: "tcp_connect_check",
        payload: {
          host: normalizedHost,
          port: normalizedPort,
          timeout_seconds: normalizedTimeout,
        },
      };
    } else if (taskType === "http_check") {
      const normalizedUrl = url.trim();
      if (!normalizedUrl) {
        setError("Для http_check обязательно поле url.");
        return;
      }

      if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
        setError("URL должен начинаться с http:// или https://.");
        return;
      }

      const normalizedTimeout = Number(timeoutSeconds.trim());
      if (!Number.isInteger(normalizedTimeout) || normalizedTimeout < 1 || normalizedTimeout > 30) {
        setError("timeout_seconds должен быть целым числом в диапазоне 1..30.");
        return;
      }

      let parsedStatuses: number[] | undefined;
      const statusesText = expectedStatuses.trim();
      if (statusesText.length > 0) {
        parsedStatuses = statusesText
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => Number(item));

        if (parsedStatuses.length === 0) {
          setError("В expected_statuses укажите хотя бы один HTTP-код.");
          return;
        }

        for (const code of parsedStatuses) {
          if (!Number.isInteger(code) || code < 100 || code > 599) {
            setError("Коды expected_statuses должны быть целыми числами в диапазоне 100..599.");
            return;
          }
        }
      }

      payload = {
        agent_id: agent.id,
        task_type: "http_check",
        payload: {
          url: normalizedUrl,
          timeout_seconds: normalizedTimeout,
          ...(parsedStatuses ? { expected_statuses: parsedStatuses } : {}),
        },
      };
    } else if (taskType === "custom_scenario") {
      const selectedScenario = customScenarios.find((item) => item.id === selectedCustomScenarioId);
      if (!selectedCustomScenarioId || !selectedScenario) {
        setError("Выберите существующий кастомный сценарий.");
        return;
      }
      if (!selectedScenario.is_active) {
        setError("Выбранный кастомный сценарий отключен.");
        return;
      }

      payload = {
        agent_id: agent.id,
        task_type: "custom_scenario",
        payload: {
          scenario_id: selectedCustomScenarioId,
        },
      };
    } else if (taskType === "docker_runtime_access_check") {
      payload = {
        agent_id: agent.id,
        task_type: "docker_runtime_access_check",
        payload: {},
      };
    } else if (taskType === "docker_container_status_check") {
      const normalizedName = dockerContainerName.trim();
      const normalizedId = dockerContainerId.trim();

      if (normalizedName.length === 0 && normalizedId.length === 0) {
        setError("Укажите container_name или container_id для docker_container_status_check.");
        return;
      }

      payload = {
        agent_id: agent.id,
        task_type: "docker_container_status_check",
        payload: {
          ...(normalizedName ? { container_name: normalizedName } : {}),
          ...(normalizedId ? { container_id: normalizedId } : {}),
          ...(dockerExpectedState ? { expected_state: dockerExpectedState } : {}),
          require_healthy: dockerRequireHealthy,
        },
      };
    } else if (taskType === "docker_compose_stack_check") {
      const normalizedProjectName = dockerProjectName.trim();
      if (normalizedProjectName.length === 0) {
        setError("Для docker_compose_stack_check обязательно поле project_name.");
        return;
      }

      const expectedServices = dockerExpectedServices
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      payload = {
        agent_id: agent.id,
        task_type: "docker_compose_stack_check",
        payload: {
          project_name: normalizedProjectName,
          ...(expectedServices.length > 0 ? { expected_services: expectedServices } : {}),
        },
      };
    } else if (taskType === "docker_port_mapping_check") {
      const normalizedName = dockerMappingContainerName.trim();
      const normalizedId = dockerMappingContainerId.trim();
      if (normalizedName.length === 0 && normalizedId.length === 0) {
        setError("Укажите container_name или container_id для docker_port_mapping_check.");
        return;
      }

      const parsedHostPort = Number(dockerMappingHostPort.trim());
      if (!Number.isInteger(parsedHostPort) || parsedHostPort < 1 || parsedHostPort > 65535) {
        setError("host_port должен быть целым числом в диапазоне 1..65535.");
        return;
      }

      const expectedPortText = dockerMappingExpectedContainerPort.trim();
      let expectedContainerPort: number | undefined;
      if (expectedPortText.length > 0) {
        const parsedExpectedPort = Number(expectedPortText);
        if (!Number.isInteger(parsedExpectedPort) || parsedExpectedPort < 1 || parsedExpectedPort > 65535) {
          setError("expected_container_port должен быть целым числом в диапазоне 1..65535.");
          return;
        }
        expectedContainerPort = parsedExpectedPort;
      }

      payload = {
        agent_id: agent.id,
        task_type: "docker_port_mapping_check",
        payload: {
          ...(normalizedName ? { container_name: normalizedName } : {}),
          ...(normalizedId ? { container_id: normalizedId } : {}),
          host_port: parsedHostPort,
          protocol: dockerMappingProtocol,
          ...(expectedContainerPort !== undefined ? { expected_container_port: expectedContainerPort } : {}),
        },
      };
    } else if (taskType === "service_status_check") {
      const normalizedServiceName = serviceName.trim();
      if (!normalizedServiceName) {
        setError("Для service_status_check обязательно поле service_name.");
        return;
      }

      payload = {
        agent_id: agent.id,
        task_type: "service_status_check",
        payload: {
          service_name: normalizedServiceName,
          ...(serviceExpectedState ? { expected_state: serviceExpectedState } : {}),
          require_enabled: serviceRequireEnabled,
        },
      };
    } else if (taskType === "process_presence_check") {
      const normalizedProcessName = processName.trim();
      if (!normalizedProcessName) {
        setError("Для process_presence_check обязательно поле process_name.");
        return;
      }

      const minCount = Number(processExpectedMinCount.trim());
      if (!Number.isInteger(minCount) || minCount < 0 || minCount > 200) {
        setError("expected_min_count должен быть целым числом в диапазоне 0..200.");
        return;
      }

      const maxText = processExpectedMaxCount.trim();
      let maxCount: number | undefined;
      if (maxText.length > 0) {
        const parsedMax = Number(maxText);
        if (!Number.isInteger(parsedMax) || parsedMax < 0 || parsedMax > 200) {
          setError("expected_max_count должен быть целым числом в диапазоне 0..200.");
          return;
        }

        if (parsedMax < minCount) {
          setError("expected_max_count должен быть больше или равен expected_min_count.");
          return;
        }

        maxCount = parsedMax;
      }

      const cmdlineFilter = processCmdlineContains.trim();

      payload = {
        agent_id: agent.id,
        task_type: "process_presence_check",
        payload: {
          process_name: normalizedProcessName,
          expected_min_count: minCount,
          ...(cmdlineFilter ? { cmdline_contains: cmdlineFilter } : {}),
          ...(maxCount !== undefined ? { expected_max_count: maxCount } : {}),
        },
      };
    } else if (taskType === "port_owner_check") {
      const parsedPort = Number(ownerPort.trim());
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        setError("Port должен быть целым числом в диапазоне 1..65535.");
        return;
      }

      const expectedName = ownerExpectedProcessName.trim();

      payload = {
        agent_id: agent.id,
        task_type: "port_owner_check",
        payload: {
          port: parsedPort,
          protocol: ownerProtocol,
          ...(expectedName ? { expected_process_name: expectedName } : {}),
        },
      };
    } else if (taskType === "process_resource_snapshot") {
      const pidText = resourcePid.trim();
      const processNameText = resourceProcessName.trim();
      const cmdlineFilter = resourceCmdlineContains.trim();

      let parsedPid: number | undefined;
      if (pidText.length > 0) {
        parsedPid = Number(pidText);
        if (!Number.isInteger(parsedPid) || parsedPid < 1) {
          setError("PID должен быть целым числом больше 0.");
          return;
        }
      }

      if (!parsedPid && processNameText.length === 0) {
        setError("Укажите pid или process_name для process_resource_snapshot.");
        return;
      }

      const sampleSeconds = Number(resourceSampleSeconds.trim());
      if (!Number.isInteger(sampleSeconds) || sampleSeconds < 1 || sampleSeconds > 10) {
        setError("sample_seconds должен быть целым числом в диапазоне 1..10.");
        return;
      }

      const cpuWarnText = resourceCpuWarnPercent.trim();
      let cpuWarnPercent: number | undefined;
      if (cpuWarnText.length > 0) {
        const parsedCpu = Number(cpuWarnText);
        if (Number.isNaN(parsedCpu) || parsedCpu <= 0 || parsedCpu > 100) {
          setError("cpu_warn_percent должен быть числом в диапазоне (0, 100].");
          return;
        }
        cpuWarnPercent = parsedCpu;
      }

      const rssWarnText = resourceRssWarnMb.trim();
      let rssWarnMb: number | undefined;
      if (rssWarnText.length > 0) {
        const parsedRss = Number(rssWarnText);
        if (!Number.isInteger(parsedRss) || parsedRss < 1) {
          setError("rss_warn_mb должен быть целым числом больше 0.");
          return;
        }
        rssWarnMb = parsedRss;
      }

      payload = {
        agent_id: agent.id,
        task_type: "process_resource_snapshot",
        payload: {
          sample_seconds: sampleSeconds,
          ...(parsedPid ? { pid: parsedPid } : {}),
          ...(processNameText ? { process_name: processNameText } : {}),
          ...(cmdlineFilter ? { cmdline_contains: cmdlineFilter } : {}),
          ...(cpuWarnPercent !== undefined ? { cpu_warn_percent: cpuWarnPercent } : {}),
          ...(rssWarnMb !== undefined ? { rss_warn_mb: rssWarnMb } : {}),
        },
      };
    } else if (taskType === "list_listening_ports") {
      payload = {
        agent_id: agent.id,
        task_type: "list_listening_ports",
        payload: {},
      };
    } else if (taskType === "process_port_inventory") {
      const parsedPatterns = processPortPatterns
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      if (parsedPatterns.length === 0) {
        setError("Для process_port_inventory укажите хотя бы один process_patterns.");
        return;
      }

      payload = {
        agent_id: agent.id,
        task_type: "process_port_inventory",
        payload: {
          process_patterns: parsedPatterns,
        },
      };
    } else {
      payload = {
        agent_id: agent.id,
        task_type: "agent_snapshot",
        payload: {},
      };
    }

    setError(null);
    setWatchError(null);
    setIsSubmitting(true);

    try {
      const taskId = await createTask(payload);
      if (!taskId) {
        throw new Error("Сервер не вернул task_id.");
      }

      setSubmittedTaskId(taskId);
      setSubmittedTask(null);
      onTaskCreated();
    } catch (submitError) {
      const message = getApiErrorMessage(submitError, "Не удалось отправить задачу.");
      if (message.includes("422")) {
        setError("Невалидный формат payload (422).");
      } else {
        setError(message);
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleTaskTypeChange(nextType: TaskType) {
    setTaskType(nextType);

    if (nextType === "http_check") {
      setTimeoutSeconds(String(DEFAULT_HTTP_TIMEOUT_SECONDS));
    } else if (nextType === "tcp_connect_check") {
      setTimeoutSeconds(String(DEFAULT_TCP_TIMEOUT_SECONDS));
    } else if (nextType === "custom_scenario" && !selectedCustomScenarioId && customScenarios.length > 0) {
      const activeScenario = customScenarios.find((item) => item.is_active);
      setSelectedCustomScenarioId((activeScenario ?? customScenarios[0]).id);
    }
  }

  return (
    <div
      className={
        inline
          ? "rounded-xl border border-slate-700/70 bg-panel/85"
          : "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4 backdrop-blur-sm"
      }
    >
      <div className={inline ? "w-full p-6" : "w-full max-w-xl rounded-xl border border-slate-700 bg-panel p-6 shadow-2xl"}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-semibold text-slate-100">{title}</h3>
            <p className="mt-1 text-sm text-slate-400">Выберите тип диагностики и параметры запуска.</p>
          </div>
          {!inline && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-700 p-2 text-slate-300 transition hover:border-slate-500 hover:text-white"
              aria-label="Закрыть"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Сценарий</span>
            <select
              value={taskType}
              disabled={isSubmitting}
              onChange={(event) => handleTaskTypeChange(event.target.value as TaskType)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none ring-0 transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
            >
              {TASK_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {isTcpCheck && (
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block sm:col-span-2">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Host</span>
                <input
                  value={host}
                  disabled={isSubmitting}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="db.internal"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Port</span>
                <input
                  value={port}
                  disabled={isSubmitting}
                  onChange={(event) => setPort(event.target.value)}
                  placeholder="5432"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>

              <label className="block sm:col-span-3">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">timeout_seconds</span>
                <input
                  value={timeoutSeconds}
                  disabled={isSubmitting}
                  onChange={(event) => setTimeoutSeconds(event.target.value)}
                  placeholder="3"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>
            </div>
          )}

          {isHttpCheck && (
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">URL</span>
                <input
                  value={url}
                  disabled={isSubmitting}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://portal.local/health"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">timeout_seconds</span>
                  <input
                    value={timeoutSeconds}
                    disabled={isSubmitting}
                    onChange={(event) => setTimeoutSeconds(event.target.value)}
                    placeholder="5"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">expected_statuses</span>
                  <input
                    value={expectedStatuses}
                    disabled={isSubmitting}
                    onChange={(event) => setExpectedStatuses(event.target.value)}
                    placeholder="200,204"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>
              </div>
            </div>
          )}

          {isCustomScenario && (
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Кастомный сценарий
                </span>
                <select
                  value={selectedCustomScenarioId}
                  disabled={isSubmitting || customScenariosLoading || customScenarios.length === 0}
                  onChange={(event) => setSelectedCustomScenarioId(event.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none ring-0 transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                >
                  <option value="">Выберите сценарий</option>
                  {customScenarios.map((item) => (
                    <option key={item.id} value={item.id} disabled={!item.is_active}>
                      {item.is_active ? item.name : `${item.name} (disabled)`}
                    </option>
                  ))}
                </select>
              </label>
              {customScenariosLoading ? (
                <p className="text-xs text-slate-500">Загрузка кастомных сценариев...</p>
              ) : null}
              {!customScenariosLoading && customScenarios.length === 0 ? (
                <p className="text-xs text-slate-500">Сначала создайте кастомный сценарий в панели выше.</p>
              ) : null}
            </div>
          )}

          {isProcessPortInventory && (
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">process_patterns</span>
                <input
                  value={processPortPatterns}
                  disabled={isSubmitting}
                  onChange={(event) => setProcessPortPatterns(event.target.value)}
                  placeholder="node, postgres, docker, nginx, python, redis, java"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>
              <p className="text-xs text-slate-500">
                Фильтр по имени процесса. Укажи значения через запятую, например: `node, postgres, redis`.
              </p>
            </div>
          )}

          {isDockerRuntimeAccessCheck && (
            <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-3 text-sm text-slate-300">
              Проверка доступности Docker runtime на узле агента. Параметры не требуются.
            </div>
          )}

          {isDockerContainerStatusCheck && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">container_name</span>
                  <input
                    value={dockerContainerName}
                    disabled={isSubmitting}
                    onChange={(event) => setDockerContainerName(event.target.value)}
                    placeholder="madrigal-api"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">container_id</span>
                  <input
                    value={dockerContainerId}
                    disabled={isSubmitting}
                    onChange={(event) => setDockerContainerId(event.target.value)}
                    placeholder="9b4c12f8d932"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">expected_state</span>
                  <select
                    value={dockerExpectedState}
                    disabled={isSubmitting}
                    onChange={(event) => setDockerExpectedState(event.target.value as DockerExpectedState)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none ring-0 transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <option value="">any</option>
                    <option value="running">running</option>
                    <option value="exited">exited</option>
                    <option value="paused">paused</option>
                    <option value="restarting">restarting</option>
                    <option value="created">created</option>
                    <option value="dead">dead</option>
                  </select>
                </label>

                <label className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={dockerRequireHealthy}
                    disabled={isSubmitting}
                    onChange={(event) => setDockerRequireHealthy(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-sky-400"
                  />
                  require_healthy
                </label>
              </div>
            </div>
          )}

          {isDockerComposeStackCheck && (
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">project_name</span>
                <input
                  value={dockerProjectName}
                  disabled={isSubmitting}
                  onChange={(event) => setDockerProjectName(event.target.value)}
                  placeholder="madrigal"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">expected_services</span>
                <input
                  value={dockerExpectedServices}
                  disabled={isSubmitting}
                  onChange={(event) => setDockerExpectedServices(event.target.value)}
                  placeholder="api,worker,postgres"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>
            </div>
          )}

          {isDockerPortMappingCheck && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">container_name</span>
                  <input
                    value={dockerMappingContainerName}
                    disabled={isSubmitting}
                    onChange={(event) => setDockerMappingContainerName(event.target.value)}
                    placeholder="madrigal-api"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">container_id</span>
                  <input
                    value={dockerMappingContainerId}
                    disabled={isSubmitting}
                    onChange={(event) => setDockerMappingContainerId(event.target.value)}
                    placeholder="9b4c12f8d932"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">host_port</span>
                  <input
                    value={dockerMappingHostPort}
                    disabled={isSubmitting}
                    onChange={(event) => setDockerMappingHostPort(event.target.value)}
                    placeholder="8080"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">protocol</span>
                  <select
                    value={dockerMappingProtocol}
                    disabled={isSubmitting}
                    onChange={(event) => setDockerMappingProtocol(event.target.value as PortProtocol)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none ring-0 transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <option value="tcp">tcp</option>
                    <option value="udp">udp</option>
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">expected_container_port</span>
                  <input
                    value={dockerMappingExpectedContainerPort}
                    disabled={isSubmitting}
                    onChange={(event) => setDockerMappingExpectedContainerPort(event.target.value)}
                    placeholder="8000"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>
              </div>
            </div>
          )}

          {isServiceStatusCheck && (
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">service_name</span>
                <input
                  value={serviceName}
                  disabled={isSubmitting}
                  onChange={(event) => setServiceName(event.target.value)}
                  placeholder="postgresql"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">expected_state</span>
                  <select
                    value={serviceExpectedState}
                    disabled={isSubmitting}
                    onChange={(event) => setServiceExpectedState(event.target.value as ServiceExpectedState)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none ring-0 transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <option value="">any</option>
                    <option value="running">running</option>
                    <option value="stopped">stopped</option>
                    <option value="paused">paused</option>
                  </select>
                </label>

                <label className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={serviceRequireEnabled}
                    disabled={isSubmitting}
                    onChange={(event) => setServiceRequireEnabled(event.target.checked)}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-sky-400"
                  />
                  require_enabled
                </label>
              </div>
            </div>
          )}

          {isProcessPresenceCheck && (
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">process_name</span>
                <input
                  value={processName}
                  disabled={isSubmitting}
                  onChange={(event) => setProcessName(event.target.value)}
                  placeholder="python"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">cmdline_contains</span>
                <input
                  value={processCmdlineContains}
                  disabled={isSubmitting}
                  onChange={(event) => setProcessCmdlineContains(event.target.value)}
                  placeholder="worker.py"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">expected_min_count</span>
                  <input
                    value={processExpectedMinCount}
                    disabled={isSubmitting}
                    onChange={(event) => setProcessExpectedMinCount(event.target.value)}
                    placeholder="1"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">expected_max_count</span>
                  <input
                    value={processExpectedMaxCount}
                    disabled={isSubmitting}
                    onChange={(event) => setProcessExpectedMaxCount(event.target.value)}
                    placeholder="2"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>
              </div>
            </div>
          )}

          {isPortOwnerCheck && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">port</span>
                  <input
                    value={ownerPort}
                    disabled={isSubmitting}
                    onChange={(event) => setOwnerPort(event.target.value)}
                    placeholder="5432"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">protocol</span>
                  <select
                    value={ownerProtocol}
                    disabled={isSubmitting}
                    onChange={(event) => setOwnerProtocol(event.target.value as PortProtocol)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none ring-0 transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    <option value="tcp">tcp</option>
                    <option value="udp">udp</option>
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">expected_process_name</span>
                <input
                  value={ownerExpectedProcessName}
                  disabled={isSubmitting}
                  onChange={(event) => setOwnerExpectedProcessName(event.target.value)}
                  placeholder="postgres"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>
            </div>
          )}

          {isProcessResourceSnapshot && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">pid</span>
                  <input
                    value={resourcePid}
                    disabled={isSubmitting}
                    onChange={(event) => setResourcePid(event.target.value)}
                    placeholder="1234"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">process_name</span>
                  <input
                    value={resourceProcessName}
                    disabled={isSubmitting}
                    onChange={(event) => setResourceProcessName(event.target.value)}
                    placeholder="java"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">cmdline_contains</span>
                <input
                  value={resourceCmdlineContains}
                  disabled={isSubmitting}
                  onChange={(event) => setResourceCmdlineContains(event.target.value)}
                  placeholder="api.jar"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                />
              </label>

              <div className="grid gap-4 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">sample_seconds</span>
                  <input
                    value={resourceSampleSeconds}
                    disabled={isSubmitting}
                    onChange={(event) => setResourceSampleSeconds(event.target.value)}
                    placeholder="2"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">cpu_warn_percent</span>
                  <input
                    value={resourceCpuWarnPercent}
                    disabled={isSubmitting}
                    onChange={(event) => setResourceCpuWarnPercent(event.target.value)}
                    placeholder="85"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">rss_warn_mb</span>
                  <input
                    value={resourceRssWarnMb}
                    disabled={isSubmitting}
                    onChange={(event) => setResourceRssWarnMb(event.target.value)}
                    placeholder="2048"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  />
                </label>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>
          )}

          {submittedTaskId && (
            <section className="space-y-3 rounded-lg border border-slate-700/70 bg-slate-950/40 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Последний запуск</p>
                  <p className="mt-1 text-xs text-slate-500">
                    task_id: <span className="font-mono text-slate-300">{submittedTaskId}</span>
                  </p>
                </div>

                {submittedTask ? (
                  <TaskStatusBadge status={submittedTask.status} />
                ) : (
                  <span className="inline-flex rounded-md border border-amber-400/30 bg-amber-500/10 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-amber-300">
                    created
                  </span>
                )}
              </div>

              {watchError && (
                <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                  {watchError}
                </div>
              )}

              {submittedTask ? (
                <>
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold uppercase tracking-wide ${severityStyles(
                        diagnostic.severity,
                      )}`}
                    >
                      {severityLabel(diagnostic.severity)}
                    </span>
                    <span className="text-sm text-slate-200">{diagnostic.summary}</span>
                  </div>

                  <QuickFacts items={quickFacts} />

                  <details className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">Facts</summary>
                    <div className="mt-2">
                      <JsonViewer value={diagnostic.facts} />
                    </div>
                  </details>

                  <details className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">Полный result JSON</summary>
                    <div className="mt-2">
                      <JsonViewer value={submittedTask.result} />
                    </div>
                  </details>
                </>
              ) : (
                <p className="text-sm text-slate-300">Задача отправлена, ожидаем первый ответ от агента.</p>
              )}
            </section>
          )}

          <div className="flex items-center justify-end gap-2">
            {!inline && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-700 bg-slate-900/70 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
              >
                Закрыть
              </button>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 rounded-lg border border-sky-400/40 bg-sky-500/20 px-4 py-2.5 text-sm font-semibold text-sky-200 transition hover:border-sky-300 hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Play className="h-4 w-4" />
              {isSubmitting ? "Отправка..." : isTaskRunning ? "Запустить ещё" : "Запустить"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}



