"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CustomScenarioRecord,
  CreateRoutineTaskPayload,
  RoutineTaskRecord,
  createRoutineTask,
  deleteRoutineTask,
  fetchCustomScenarios,
  fetchRoutineTasks,
  fetchTelegramStatus,
  getApiErrorMessage,
  startTelegramRegistration,
  updateRoutineTask,
} from "@/lib/api";
import { TaskType } from "@/lib/types";

interface RoutineTasksPanelProps {
  agentId: string;
}

interface ScenarioOption {
  value: TaskType;
  label: string;
}

type ServiceExpectedState = "" | "running" | "stopped" | "paused";
type PortProtocol = "tcp" | "udp";
type DockerExpectedState = "" | "running" | "exited" | "paused" | "restarting" | "created" | "dead";

const SCENARIO_OPTIONS: ScenarioOption[] = [
  { value: "tcp_connect_check", label: "Проверка TCP-порта" },
  { value: "http_check", label: "Проверка HTTP endpoint" },
  { value: "service_status_check", label: "Статус сервиса" },
  { value: "process_presence_check", label: "Наличие процесса" },
  { value: "port_owner_check", label: "Владелец порта" },
  { value: "process_resource_snapshot", label: "Ресурсы процесса" },
  { value: "docker_container_status_check", label: "Docker контейнер" },
  { value: "docker_compose_stack_check", label: "Docker compose stack" },
  { value: "docker_port_mapping_check", label: "Docker port mapping" },
];

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70";

function formatDate(value: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatScenarioLabel(taskType: string, payload?: unknown): string {
  if (taskType === "custom_scenario" && isRecord(payload)) {
    const scenarioName = payload.scenario_name;
    if (typeof scenarioName === "string" && scenarioName.trim().length > 0) {
      return `Кастомный: ${scenarioName.trim()}`;
    }
  }

  const matched = SCENARIO_OPTIONS.find((item) => item.value === taskType);
  return matched ? matched.label : taskType;
}

function InputField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">{props.label}</span>
      <input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        disabled={props.disabled}
        placeholder={props.placeholder}
        className={INPUT_CLASS}
      />
    </label>
  );
}

export function RoutineTasksPanel({ agentId }: RoutineTasksPanelProps) {
  const [telegramLoading, setTelegramLoading] = useState(true);
  const [telegramLinked, setTelegramLinked] = useState(false);
  const [telegramUsername, setTelegramUsername] = useState<string | null>(null);
  const [telegramChatMasked, setTelegramChatMasked] = useState<string | null>(null);
  const [registrationUrl, setRegistrationUrl] = useState<string | null>(null);
  const [registrationExpiresAt, setRegistrationExpiresAt] = useState("");

  const [routines, setRoutines] = useState<RoutineTaskRecord[]>([]);
  const [routinesLoading, setRoutinesLoading] = useState(true);
  const [customScenarios, setCustomScenarios] = useState<CustomScenarioRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const [taskType, setTaskType] = useState<TaskType>("tcp_connect_check");
  const [selectedCustomScenarioId, setSelectedCustomScenarioId] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("15");
  const [notifyOnWarn, setNotifyOnWarn] = useState(true);
  const [notifyOnCrit, setNotifyOnCrit] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const [host, setHost] = useState("");
  const [port, setPort] = useState("5432");
  const [url, setUrl] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("3");
  const [expectedStatuses, setExpectedStatuses] = useState("200");

  const [serviceName, setServiceName] = useState("");
  const [serviceExpectedState, setServiceExpectedState] = useState<ServiceExpectedState>("running");
  const [serviceRequireEnabled, setServiceRequireEnabled] = useState(true);

  const [processName, setProcessName] = useState("");
  const [processCmdlineContains, setProcessCmdlineContains] = useState("");
  const [processExpectedMinCount, setProcessExpectedMinCount] = useState("1");
  const [processExpectedMaxCount, setProcessExpectedMaxCount] = useState("");

  const [ownerPort, setOwnerPort] = useState("5432");
  const [ownerProtocol, setOwnerProtocol] = useState<PortProtocol>("tcp");
  const [ownerExpectedProcessName, setOwnerExpectedProcessName] = useState("");

  const [resourcePid, setResourcePid] = useState("");
  const [resourceProcessName, setResourceProcessName] = useState("");
  const [resourceCmdlineContains, setResourceCmdlineContains] = useState("");
  const [resourceSampleSeconds, setResourceSampleSeconds] = useState("2");
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

  const formLocked = submitting;
  const canCreateRoutine = telegramLinked && !submitting;
  const selectedScenarioLabel = useMemo(() => {
    if (taskType === "custom_scenario") {
      const selected = customScenarios.find((item) => item.id === selectedCustomScenarioId);
      return selected ? `Кастомный: ${selected.name}` : "Кастомный сценарий";
    }
    return formatScenarioLabel(taskType);
  }, [taskType, customScenarios, selectedCustomScenarioId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setTelegramLoading(true);
      setRoutinesLoading(true);
      try {
        const [statusPayload, routinesPayload, scenariosPayload] = await Promise.all([
          fetchTelegramStatus(),
          fetchRoutineTasks(agentId),
          fetchCustomScenarios(),
        ]);
        if (cancelled) return;
        setTelegramLinked(statusPayload.linked);
        setTelegramUsername(statusPayload.telegram_username);
        setTelegramChatMasked(statusPayload.chat_id_masked);
        setRoutines(routinesPayload);
        setCustomScenarios(scenariosPayload);
        if (scenariosPayload.length > 0) {
          const activeScenario = scenariosPayload.find((item) => item.is_active);
          const fallbackScenarioId = (activeScenario ?? scenariosPayload[0]).id;
          setSelectedCustomScenarioId((previous) => previous || fallbackScenarioId);
        }
      } catch (loadError) {
        if (!cancelled) setError(getApiErrorMessage(loadError, "Не удалось загрузить данные."));
      } finally {
        if (!cancelled) {
          setTelegramLoading(false);
          setRoutinesLoading(false);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    if (telegramLinked || !registrationUrl) return;
    const timerId = window.setInterval(async () => {
      try {
        const statusPayload = await fetchTelegramStatus();
        if (statusPayload.linked) {
          setTelegramLinked(true);
          setTelegramUsername(statusPayload.telegram_username);
          setTelegramChatMasked(statusPayload.chat_id_masked);
          setRegistrationUrl(null);
          setActionMessage("Telegram успешно подключен.");
        }
      } catch {
        // no-op
      }
    }, 4000);
    return () => window.clearInterval(timerId);
  }, [registrationUrl, telegramLinked]);

  async function refreshRoutines() {
    setRoutinesLoading(true);
    try {
      const [routinesPayload, scenariosPayload] = await Promise.all([
        fetchRoutineTasks(agentId),
        fetchCustomScenarios(),
      ]);
      setRoutines(routinesPayload);
      setCustomScenarios(scenariosPayload);
      if (scenariosPayload.length > 0) {
        const activeScenario = scenariosPayload.find((item) => item.is_active);
        const fallbackScenarioId = (activeScenario ?? scenariosPayload[0]).id;
        setSelectedCustomScenarioId((previous) => previous || fallbackScenarioId);
      }
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, "Не удалось загрузить рутинные задачи."));
    } finally {
      setRoutinesLoading(false);
    }
  }

  async function handleStartTelegramRegistration() {
    setError(null);
    setActionMessage(null);
    try {
      const payload = await startTelegramRegistration();
      if (payload.linked) {
        setTelegramLinked(true);
        setActionMessage("Telegram уже подключен.");
        return;
      }
      setRegistrationUrl(payload.registration_url);
      setRegistrationExpiresAt(payload.expires_at);
      setActionMessage("Откройте бота по ссылке и нажмите Start.");
    } catch (registerError) {
      setError(getApiErrorMessage(registerError, "Не удалось подготовить Telegram регистрацию."));
    }
  }

  function buildRoutinePayload(): Record<string, unknown> | null {
    if (taskType === "tcp_connect_check") {
      const normalizedHost = host.trim();
      if (!normalizedHost) return setError("Для tcp_connect_check обязательно поле host."), null;
      const normalizedPort = Number(port.trim());
      if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) return setError("Порт должен быть целым числом в диапазоне 1..65535."), null;
      const normalizedTimeout = Number(timeoutSeconds.trim());
      if (!Number.isInteger(normalizedTimeout) || normalizedTimeout < 1 || normalizedTimeout > 30) return setError("timeout_seconds должен быть целым числом в диапазоне 1..30."), null;
      return { host: normalizedHost, port: normalizedPort, timeout_seconds: normalizedTimeout };
    }
    if (taskType === "http_check") {
      const normalizedUrl = url.trim();
      if (!normalizedUrl) return setError("Для http_check обязательно поле url."), null;
      if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) return setError("URL должен начинаться с http:// или https://."), null;
      const normalizedTimeout = Number(timeoutSeconds.trim());
      if (!Number.isInteger(normalizedTimeout) || normalizedTimeout < 1 || normalizedTimeout > 30) return setError("timeout_seconds должен быть целым числом в диапазоне 1..30."), null;
      const text = expectedStatuses.trim();
      let parsedStatuses: number[] | undefined;
      if (text.length > 0) {
        parsedStatuses = text
          .split(",")
          .map((item) => Number(item.trim()))
          .filter((item) => Number.isInteger(item));
        if (parsedStatuses.length === 0 || parsedStatuses.some((code) => code < 100 || code > 599)) return setError("Коды expected_statuses должны быть целыми числами в диапазоне 100..599."), null;
      }
      return { url: normalizedUrl, timeout_seconds: normalizedTimeout, ...(parsedStatuses ? { expected_statuses: parsedStatuses } : {}) };
    }
    if (taskType === "custom_scenario") {
      const selectedScenario = customScenarios.find((item) => item.id === selectedCustomScenarioId);
      if (!selectedCustomScenarioId || !selectedScenario) return setError("Выберите существующий кастомный сценарий."), null;
      if (!selectedScenario.is_active) return setError("Выбранный кастомный сценарий отключен."), null;
      return { scenario_id: selectedCustomScenarioId };
    }
    if (taskType === "service_status_check") {
      const normalizedServiceName = serviceName.trim();
      if (!normalizedServiceName) return setError("Для service_status_check обязательно поле service_name."), null;
      return { service_name: normalizedServiceName, ...(serviceExpectedState ? { expected_state: serviceExpectedState } : {}), require_enabled: serviceRequireEnabled };
    }
    if (taskType === "process_presence_check") {
      const normalizedProcessName = processName.trim();
      if (!normalizedProcessName) return setError("Для process_presence_check обязательно поле process_name."), null;
      const minCount = Number(processExpectedMinCount.trim());
      if (!Number.isInteger(minCount) || minCount < 0 || minCount > 200) return setError("expected_min_count должен быть целым числом в диапазоне 0..200."), null;
      const maxText = processExpectedMaxCount.trim();
      let maxCount: number | undefined;
      if (maxText.length > 0) {
        const parsedMax = Number(maxText);
        if (!Number.isInteger(parsedMax) || parsedMax < 0 || parsedMax > 200 || parsedMax < minCount) return setError("expected_max_count должен быть целым числом 0..200 и >= expected_min_count."), null;
        maxCount = parsedMax;
      }
      const cmdlineFilter = processCmdlineContains.trim();
      return { process_name: normalizedProcessName, expected_min_count: minCount, ...(cmdlineFilter ? { cmdline_contains: cmdlineFilter } : {}), ...(maxCount !== undefined ? { expected_max_count: maxCount } : {}) };
    }
    if (taskType === "port_owner_check") {
      const parsedPort = Number(ownerPort.trim());
      if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return setError("Port должен быть целым числом в диапазоне 1..65535."), null;
      const expectedName = ownerExpectedProcessName.trim();
      return { port: parsedPort, protocol: ownerProtocol, ...(expectedName ? { expected_process_name: expectedName } : {}) };
    }
    if (taskType === "process_resource_snapshot") {
      const pidText = resourcePid.trim();
      const processNameText = resourceProcessName.trim();
      const cmdlineFilter = resourceCmdlineContains.trim();
      let parsedPid: number | undefined;
      if (pidText.length > 0) {
        parsedPid = Number(pidText);
        if (!Number.isInteger(parsedPid) || parsedPid < 1) return setError("PID должен быть целым числом больше 0."), null;
      }
      if (!parsedPid && processNameText.length === 0) return setError("Укажите pid или process_name для process_resource_snapshot."), null;
      const sampleSeconds = Number(resourceSampleSeconds.trim());
      if (!Number.isInteger(sampleSeconds) || sampleSeconds < 1 || sampleSeconds > 10) return setError("sample_seconds должен быть целым числом в диапазоне 1..10."), null;
      const cpuWarnText = resourceCpuWarnPercent.trim();
      let cpuWarnPercent: number | undefined;
      if (cpuWarnText.length > 0) {
        const parsedCpu = Number(cpuWarnText);
        if (Number.isNaN(parsedCpu) || parsedCpu <= 0 || parsedCpu > 100) return setError("cpu_warn_percent должен быть числом в диапазоне (0, 100]."), null;
        cpuWarnPercent = parsedCpu;
      }
      const rssWarnText = resourceRssWarnMb.trim();
      let rssWarnMb: number | undefined;
      if (rssWarnText.length > 0) {
        const parsedRss = Number(rssWarnText);
        if (!Number.isInteger(parsedRss) || parsedRss < 1) return setError("rss_warn_mb должен быть целым числом больше 0."), null;
        rssWarnMb = parsedRss;
      }
      return { sample_seconds: sampleSeconds, ...(parsedPid ? { pid: parsedPid } : {}), ...(processNameText ? { process_name: processNameText } : {}), ...(cmdlineFilter ? { cmdline_contains: cmdlineFilter } : {}), ...(cpuWarnPercent !== undefined ? { cpu_warn_percent: cpuWarnPercent } : {}), ...(rssWarnMb !== undefined ? { rss_warn_mb: rssWarnMb } : {}) };
    }
    if (taskType === "docker_container_status_check") {
      const normalizedName = dockerContainerName.trim();
      const normalizedId = dockerContainerId.trim();
      if (normalizedName.length === 0 && normalizedId.length === 0) return setError("Укажите container_name или container_id для docker_container_status_check."), null;
      return { ...(normalizedName ? { container_name: normalizedName } : {}), ...(normalizedId ? { container_id: normalizedId } : {}), ...(dockerExpectedState ? { expected_state: dockerExpectedState } : {}), require_healthy: dockerRequireHealthy };
    }
    if (taskType === "docker_compose_stack_check") {
      const normalizedProjectName = dockerProjectName.trim();
      if (normalizedProjectName.length === 0) return setError("Для docker_compose_stack_check обязательно поле project_name."), null;
      const expectedServices = dockerExpectedServices.split(",").map((item) => item.trim()).filter(Boolean);
      return { project_name: normalizedProjectName, ...(expectedServices.length > 0 ? { expected_services: expectedServices } : {}) };
    }
    if (taskType === "docker_port_mapping_check") {
      const normalizedName = dockerMappingContainerName.trim();
      const normalizedId = dockerMappingContainerId.trim();
      if (normalizedName.length === 0 && normalizedId.length === 0) return setError("Укажите container_name или container_id для docker_port_mapping_check."), null;
      const parsedHostPort = Number(dockerMappingHostPort.trim());
      if (!Number.isInteger(parsedHostPort) || parsedHostPort < 1 || parsedHostPort > 65535) return setError("host_port должен быть целым числом в диапазоне 1..65535."), null;
      const expectedPortText = dockerMappingExpectedContainerPort.trim();
      let expectedContainerPort: number | undefined;
      if (expectedPortText.length > 0) {
        const parsedExpectedPort = Number(expectedPortText);
        if (!Number.isInteger(parsedExpectedPort) || parsedExpectedPort < 1 || parsedExpectedPort > 65535) return setError("expected_container_port должен быть целым числом в диапазоне 1..65535."), null;
        expectedContainerPort = parsedExpectedPort;
      }
      return { ...(normalizedName ? { container_name: normalizedName } : {}), ...(normalizedId ? { container_id: normalizedId } : {}), host_port: parsedHostPort, protocol: dockerMappingProtocol, ...(expectedContainerPort !== undefined ? { expected_container_port: expectedContainerPort } : {}) };
    }
    return setError("Выберите поддерживаемый сценарий."), null;
  }

  async function handleCreateRoutine() {
    setError(null);
    setActionMessage(null);
    const parsedInterval = Number(intervalMinutes.trim());
    if (!Number.isInteger(parsedInterval) || parsedInterval < 1 || parsedInterval > 1440) {
      setError("Периодичность должна быть целым числом в диапазоне 1..1440 минут.");
      return;
    }
    const parsedPayload = buildRoutinePayload();
    if (!parsedPayload) return;
    const requestPayload: CreateRoutineTaskPayload = {
      agent_id: agentId,
      task_type: taskType,
      payload: parsedPayload,
      interval_minutes: parsedInterval,
      notify_on_warn: notifyOnWarn,
      notify_on_crit: notifyOnCrit,
    };
    setSubmitting(true);
    try {
      await createRoutineTask(requestPayload);
      setActionMessage(`Рутинная задача создана: ${selectedScenarioLabel}.`);
      await refreshRoutines();
    } catch (createError) {
      setError(getApiErrorMessage(createError, "Не удалось создать рутинную задачу."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleRoutine(item: RoutineTaskRecord) {
    setError(null);
    setActionMessage(null);
    try {
      await updateRoutineTask(item.id, { enabled: !item.enabled });
      setActionMessage(item.enabled ? "Рутинная задача приостановлена." : "Рутинная задача включена.");
      await refreshRoutines();
    } catch (updateError) {
      setError(getApiErrorMessage(updateError, "Не удалось изменить состояние рутинной задачи."));
    }
  }

  async function handleDeleteRoutine(item: RoutineTaskRecord) {
    setError(null);
    setActionMessage(null);
    if (!window.confirm("Удалить рутинную задачу?")) return;
    try {
      await deleteRoutineTask(item.id);
      setActionMessage("Рутинная задача удалена.");
      await refreshRoutines();
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, "Не удалось удалить рутинную задачу."));
    }
  }

  return (
    <details className="rounded-xl border border-slate-700/70 bg-panel/85">
      <summary className="cursor-pointer p-5">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Рутинные задачи и Telegram уведомления</h2>
          <p className="text-sm text-slate-400">Назначайте сценарии по расписанию. При `warn` или `crit` придет уведомление в Telegram.</p>
        </div>
      </summary>

      <div className="space-y-4 px-5 pb-5">
        {error && <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>}
        {actionMessage && <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{actionMessage}</div>}

        <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-4">
          <p className="text-sm font-semibold text-slate-200">Telegram</p>
          {telegramLoading ? (
            <p className="mt-2 text-sm text-slate-400">Проверяем статус Telegram...</p>
          ) : telegramLinked ? (
            <div className="mt-2 space-y-2 text-sm text-slate-300">
              <p>Подключено: <span className="font-medium text-emerald-300">да</span></p>
              <p>User: <span className="font-mono">{telegramUsername || "-"}</span></p>
              <p>Chat: <span className="font-mono">{telegramChatMasked || "-"}</span></p>
            </div>
          ) : (
            <div className="mt-2 space-y-3 text-sm text-slate-300">
              <p>Для рутинных уведомлений сначала подключите Telegram через бота.</p>
              <button type="button" onClick={() => void handleStartTelegramRegistration()} className="rounded-md border border-sky-400/40 bg-sky-500/20 px-3 py-1.5 text-xs font-semibold text-sky-200 transition hover:border-sky-300 hover:bg-sky-500/30">Подключить Telegram</button>
              {registrationUrl && (
                <div className="rounded-md border border-slate-700 bg-slate-900/70 p-3">
                  <p className="text-xs text-slate-400">Ссылка регистрации (действует до {formatDate(registrationExpiresAt)}):</p>
                  <a href={registrationUrl} target="_blank" rel="noreferrer" className="mt-1 block break-all text-xs text-sky-300 hover:text-sky-200">{registrationUrl}</a>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-4">
          <p className="text-sm font-semibold text-slate-200">Создать рутинную задачу</p>
          {!telegramLinked ? (
            <p className="mt-2 text-sm text-slate-400">Сначала подключите Telegram, затем настройте сценарий и периодичность.</p>
          ) : null}
          <div className="mt-3 space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Сценарий</span>
                  <select value={taskType} onChange={(event) => setTaskType(event.target.value as TaskType)} disabled={formLocked} className={INPUT_CLASS}>
                    {SCENARIO_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label>
                <InputField label="Периодичность (мин)" value={intervalMinutes} onChange={setIntervalMinutes} disabled={formLocked} />
              </div>

              {taskType === "tcp_connect_check" && <div className="grid gap-4 sm:grid-cols-3"><InputField label="Host" value={host} onChange={setHost} disabled={formLocked} placeholder="db.internal" /><InputField label="Port" value={port} onChange={setPort} disabled={formLocked} placeholder="5432" /><div className="sm:col-span-3"><InputField label="timeout_seconds" value={timeoutSeconds} onChange={setTimeoutSeconds} disabled={formLocked} placeholder="3" /></div></div>}
              {taskType === "http_check" && <div className="space-y-4"><InputField label="URL" value={url} onChange={setUrl} disabled={formLocked} placeholder="https://portal.local/health" /><div className="grid gap-4 sm:grid-cols-2"><InputField label="timeout_seconds" value={timeoutSeconds} onChange={setTimeoutSeconds} disabled={formLocked} placeholder="5" /><InputField label="expected_statuses" value={expectedStatuses} onChange={setExpectedStatuses} disabled={formLocked} placeholder="200,204" /></div></div>}
              {taskType === "custom_scenario" && <div className="space-y-4"><label className="block"><span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Сценарий</span><select value={selectedCustomScenarioId} onChange={(event) => setSelectedCustomScenarioId(event.target.value)} disabled={formLocked || customScenarios.length === 0} className={INPUT_CLASS}><option value="">Выберите сценарий</option>{customScenarios.map((item) => <option key={item.id} value={item.id} disabled={!item.is_active}>{item.is_active ? item.name : `${item.name} (disabled)`}</option>)}</select></label>{customScenarios.length === 0 ? <p className="text-xs text-slate-400">Сначала создайте кастомный сценарий в панели выше.</p> : null}</div>}
              {taskType === "service_status_check" && <div className="space-y-4"><InputField label="service_name" value={serviceName} onChange={setServiceName} disabled={formLocked} placeholder="postgresql" /><div className="grid gap-4 sm:grid-cols-2"><label className="block"><span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">expected_state</span><select value={serviceExpectedState} onChange={(event) => setServiceExpectedState(event.target.value as ServiceExpectedState)} disabled={formLocked} className={INPUT_CLASS}><option value="">any</option><option value="running">running</option><option value="stopped">stopped</option><option value="paused">paused</option></select></label><label className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-200"><input type="checkbox" checked={serviceRequireEnabled} onChange={(event) => setServiceRequireEnabled(event.target.checked)} disabled={formLocked} className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-sky-400" />require_enabled</label></div></div>}
              {taskType === "process_presence_check" && <div className="space-y-4"><InputField label="process_name" value={processName} onChange={setProcessName} disabled={formLocked} placeholder="python" /><InputField label="cmdline_contains" value={processCmdlineContains} onChange={setProcessCmdlineContains} disabled={formLocked} placeholder="worker.py" /><div className="grid gap-4 sm:grid-cols-2"><InputField label="expected_min_count" value={processExpectedMinCount} onChange={setProcessExpectedMinCount} disabled={formLocked} placeholder="1" /><InputField label="expected_max_count" value={processExpectedMaxCount} onChange={setProcessExpectedMaxCount} disabled={formLocked} placeholder="2" /></div></div>}
              {taskType === "port_owner_check" && <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><InputField label="port" value={ownerPort} onChange={setOwnerPort} disabled={formLocked} placeholder="5432" /><label className="block"><span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">protocol</span><select value={ownerProtocol} onChange={(event) => setOwnerProtocol(event.target.value as PortProtocol)} disabled={formLocked} className={INPUT_CLASS}><option value="tcp">tcp</option><option value="udp">udp</option></select></label></div><InputField label="expected_process_name" value={ownerExpectedProcessName} onChange={setOwnerExpectedProcessName} disabled={formLocked} placeholder="postgres" /></div>}
              {taskType === "process_resource_snapshot" && <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><InputField label="pid" value={resourcePid} onChange={setResourcePid} disabled={formLocked} placeholder="1234" /><InputField label="process_name" value={resourceProcessName} onChange={setResourceProcessName} disabled={formLocked} placeholder="java" /></div><InputField label="cmdline_contains" value={resourceCmdlineContains} onChange={setResourceCmdlineContains} disabled={formLocked} placeholder="api.jar" /><div className="grid gap-4 sm:grid-cols-3"><InputField label="sample_seconds" value={resourceSampleSeconds} onChange={setResourceSampleSeconds} disabled={formLocked} placeholder="2" /><InputField label="cpu_warn_percent" value={resourceCpuWarnPercent} onChange={setResourceCpuWarnPercent} disabled={formLocked} placeholder="85" /><InputField label="rss_warn_mb" value={resourceRssWarnMb} onChange={setResourceRssWarnMb} disabled={formLocked} placeholder="2048" /></div></div>}
              {taskType === "docker_container_status_check" && <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><InputField label="container_name" value={dockerContainerName} onChange={setDockerContainerName} disabled={formLocked} placeholder="madrigal-api" /><InputField label="container_id" value={dockerContainerId} onChange={setDockerContainerId} disabled={formLocked} placeholder="9b4c12f8d932" /></div><div className="grid gap-4 sm:grid-cols-2"><label className="block"><span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">expected_state</span><select value={dockerExpectedState} onChange={(event) => setDockerExpectedState(event.target.value as DockerExpectedState)} disabled={formLocked} className={INPUT_CLASS}><option value="">any</option><option value="running">running</option><option value="exited">exited</option><option value="paused">paused</option><option value="restarting">restarting</option><option value="created">created</option><option value="dead">dead</option></select></label><label className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-200"><input type="checkbox" checked={dockerRequireHealthy} onChange={(event) => setDockerRequireHealthy(event.target.checked)} disabled={formLocked} className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-sky-400" />require_healthy</label></div></div>}
              {taskType === "docker_compose_stack_check" && <div className="space-y-4"><InputField label="project_name" value={dockerProjectName} onChange={setDockerProjectName} disabled={formLocked} placeholder="madrigal" /><InputField label="expected_services" value={dockerExpectedServices} onChange={setDockerExpectedServices} disabled={formLocked} placeholder="api,worker,postgres" /></div>}
              {taskType === "docker_port_mapping_check" && <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><InputField label="container_name" value={dockerMappingContainerName} onChange={setDockerMappingContainerName} disabled={formLocked} placeholder="madrigal-api" /><InputField label="container_id" value={dockerMappingContainerId} onChange={setDockerMappingContainerId} disabled={formLocked} placeholder="9b4c12f8d932" /></div><div className="grid gap-4 sm:grid-cols-3"><InputField label="host_port" value={dockerMappingHostPort} onChange={setDockerMappingHostPort} disabled={formLocked} placeholder="8080" /><label className="block"><span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">protocol</span><select value={dockerMappingProtocol} onChange={(event) => setDockerMappingProtocol(event.target.value as PortProtocol)} disabled={formLocked} className={INPUT_CLASS}><option value="tcp">tcp</option><option value="udp">udp</option></select></label><InputField label="expected_container_port" value={dockerMappingExpectedContainerPort} onChange={setDockerMappingExpectedContainerPort} disabled={formLocked} placeholder="8000" /></div></div>}

              <div className="flex flex-wrap gap-4">
                <label className="inline-flex items-center gap-2 text-sm text-slate-200"><input type="checkbox" checked={notifyOnWarn} onChange={(event) => setNotifyOnWarn(event.target.checked)} disabled={formLocked} className="h-4 w-4" />notify on warn</label>
                <label className="inline-flex items-center gap-2 text-sm text-slate-200"><input type="checkbox" checked={notifyOnCrit} onChange={(event) => setNotifyOnCrit(event.target.checked)} disabled={formLocked} className="h-4 w-4" />notify on crit</label>
              </div>
              <button type="button" onClick={() => void handleCreateRoutine()} disabled={!canCreateRoutine} className="rounded-lg border border-sky-400/40 bg-sky-500/20 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:border-sky-300 hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60">{submitting ? "Создание..." : "Добавить рутинную задачу"}</button>
          </div>
        </div>

        <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-200">Активные рутинные задачи</p>
            <button type="button" onClick={() => void refreshRoutines()} className="rounded-md border border-slate-600 bg-slate-900/70 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:border-slate-500 hover:bg-slate-800">Обновить</button>
          </div>
          {routinesLoading ? (
            <p className="text-sm text-slate-400">Загрузка рутинных задач...</p>
          ) : routines.length === 0 ? (
            <p className="text-sm text-slate-400">Рутинные задачи пока не добавлены.</p>
          ) : (
            <div className="space-y-3">
              {routines.map((item) => (
                <article key={item.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                  <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                    <div className="space-y-1 text-sm text-slate-300">
                      <p className="font-semibold text-slate-100">{formatScenarioLabel(item.task_type, item.payload)}</p>
                      <p>Период: каждые {item.interval_minutes} мин</p>
                      <p>Следующий запуск: {formatDate(item.next_run_at)}</p>
                      <p>Последний запуск: {formatDate(item.last_run_at)}</p>
                      <p>Последний статус: <span className="font-mono">{item.last_task_status || "-"}</span>{item.last_task_severity ? ` / ${item.last_task_severity}` : ""}</p>
                      {item.last_task_summary ? <p className="text-xs text-slate-400">{item.last_task_summary}</p> : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => void handleToggleRoutine(item)} className="rounded-md border border-slate-600 bg-slate-900/70 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-slate-500 hover:bg-slate-800">{item.enabled ? "Пауза" : "Включить"}</button>
                      <button type="button" onClick={() => void handleDeleteRoutine(item)} className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/20">Удалить</button>
                    </div>
                  </div>
                  <details className="mt-2 rounded-md border border-slate-800 bg-slate-950/40 p-2">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">Payload</summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-slate-300">{JSON.stringify(item.payload, null, 2)}</pre>
                  </details>
                </article>
              ))}
            </div>
          )}
        </div>

      </div>
    </details>
  );
}

