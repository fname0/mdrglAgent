"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CreateScheduledTaskPayload,
  CustomScenarioRecord,
  ScheduledTaskRecord,
  createScheduledTask,
  deleteScheduledTask,
  fetchCustomScenarios,
  fetchScheduledTasks,
  getApiErrorMessage,
} from "@/lib/api";
import { TaskType } from "@/lib/types";

interface ScheduledTasksPanelProps {
  agentId: string;
}

interface ScenarioOption {
  value: TaskType;
  label: string;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatDate(value: string): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(date);
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

export function ScheduledTasksPanel({ agentId }: ScheduledTasksPanelProps) {
  const [scheduledTasks, setScheduledTasks] = useState<ScheduledTaskRecord[]>([]);
  const [customScenarios, setCustomScenarios] = useState<CustomScenarioRecord[]>([]);
  const [scheduledLoading, setScheduledLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const [taskType, setTaskType] = useState<TaskType>("tcp_connect_check");
  const [selectedCustomScenarioId, setSelectedCustomScenarioId] = useState("");
  const [runInMinutes, setRunInMinutes] = useState("15");
  const [rawPayloadJson, setRawPayloadJson] = useState("{}");

  const selectedScenarioLabel = useMemo(() => {
    if (taskType === "custom_scenario") {
      const selected = customScenarios.find((item) => item.id === selectedCustomScenarioId);
      return selected ? `Кастомный: ${selected.name}` : "Кастомный сценарий";
    }

    return formatScenarioLabel(taskType);
  }, [customScenarios, selectedCustomScenarioId, taskType]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setScheduledLoading(true);
      try {
        const [scheduledPayload, scenariosPayload] = await Promise.all([
          fetchScheduledTasks(agentId),
          fetchCustomScenarios(),
        ]);

        if (cancelled) return;
        setScheduledTasks(scheduledPayload);
        setCustomScenarios(scenariosPayload);
        if (scenariosPayload.length > 0) {
          const activeScenario = scenariosPayload.find((item) => item.is_active);
          const fallbackScenarioId = (activeScenario ?? scenariosPayload[0]).id;
          setSelectedCustomScenarioId((previous) => previous || fallbackScenarioId);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(getApiErrorMessage(loadError, "Не удалось загрузить запланированные диагностики."));
        }
      } finally {
        if (!cancelled) {
          setScheduledLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  async function refreshScheduled() {
    setScheduledLoading(true);
    try {
      const [scheduledPayload, scenariosPayload] = await Promise.all([
        fetchScheduledTasks(agentId),
        fetchCustomScenarios(),
      ]);
      setScheduledTasks(scheduledPayload);
      setCustomScenarios(scenariosPayload);
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, "Не удалось загрузить запланированные диагностики."));
    } finally {
      setScheduledLoading(false);
    }
  }

  function buildScheduledPayload(): Record<string, unknown> | null {
    if (taskType === "custom_scenario") {
      const selectedScenario = customScenarios.find((item) => item.id === selectedCustomScenarioId);
      if (!selectedCustomScenarioId || !selectedScenario) {
        setError("Выберите существующий кастомный сценарий.");
        return null;
      }
      if (!selectedScenario.is_active) {
        setError("Выбранный кастомный сценарий отключен.");
        return null;
      }
      return { scenario_id: selectedCustomScenarioId };
    }

    try {
      const parsed = JSON.parse(rawPayloadJson);
      if (!isRecord(parsed)) {
        setError("Payload должен быть JSON-объектом.");
        return null;
      }
      return parsed;
    } catch {
      setError("Некорректный JSON payload.");
      return null;
    }
  }

  async function handleCreateScheduled() {
    setError(null);
    setActionMessage(null);
    const parsedRunInMinutes = Number(runInMinutes.trim());
    if (!Number.isInteger(parsedRunInMinutes) || parsedRunInMinutes < 1 || parsedRunInMinutes > 1440) {
      setError("Запуск должен быть целым числом в диапазоне 1..1440 минут.");
      return;
    }

    const payload = buildScheduledPayload();
    if (!payload) return;

    const requestPayload: CreateScheduledTaskPayload = {
      agent_id: agentId,
      task_type: taskType,
      payload,
      run_in_minutes: parsedRunInMinutes,
    };

    setSubmitting(true);
    try {
      await createScheduledTask(requestPayload);
      setActionMessage(`Запланирована диагностика: ${selectedScenarioLabel}.`);
      await refreshScheduled();
    } catch (createError) {
      setError(getApiErrorMessage(createError, "Не удалось запланировать диагностику."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeleteScheduled(item: ScheduledTaskRecord) {
    setError(null);
    setActionMessage(null);
    if (!window.confirm("Удалить запланированную диагностику?")) return;

    try {
      await deleteScheduledTask(item.id);
      setActionMessage("Запланированная диагностика удалена.");
      await refreshScheduled();
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, "Не удалось удалить запланированную диагностику."));
    }
  }

  return (
    <details className="rounded-xl border border-slate-700/70 bg-panel/85">
      <summary className="cursor-pointer p-5">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Запланированные диагностики</h2>
          <p className="text-sm text-slate-400">Разовый запуск сценария. Если Telegram привязан, после выполнения придет уведомление.</p>
        </div>
      </summary>

      <div className="space-y-4 px-5 pb-5">
        {error && <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>}
        {actionMessage && <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">{actionMessage}</div>}

        <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-4">
          <p className="text-sm font-semibold text-slate-200">Запланировать разовый запуск</p>
          <div className="mt-3 space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Сценарий</span>
                <select value={taskType} onChange={(event) => setTaskType(event.target.value as TaskType)} disabled={submitting} className={INPUT_CLASS}>
                  {SCENARIO_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Запуск через (мин)</span>
                <input value={runInMinutes} onChange={(event) => setRunInMinutes(event.target.value)} disabled={submitting} className={INPUT_CLASS} placeholder="15" />
              </label>
            </div>

            {taskType === "custom_scenario" ? (
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Кастомный сценарий</span>
                <select value={selectedCustomScenarioId} onChange={(event) => setSelectedCustomScenarioId(event.target.value)} disabled={submitting || customScenarios.length === 0} className={INPUT_CLASS}>
                  <option value="">Выберите сценарий</option>
                  {customScenarios.map((item) => <option key={item.id} value={item.id} disabled={!item.is_active}>{item.is_active ? item.name : `${item.name} (disabled)`}</option>)}
                </select>
              </label>
            ) : (
              <label className="block">
                <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-400">Payload (JSON)</span>
                <textarea
                  value={rawPayloadJson}
                  onChange={(event) => setRawPayloadJson(event.target.value)}
                  disabled={submitting}
                  className="min-h-24 w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 font-mono text-xs text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70"
                  placeholder='{"host":"db.internal","port":5432,"timeout_seconds":3}'
                />
              </label>
            )}

            <button type="button" onClick={() => void handleCreateScheduled()} disabled={submitting} className="rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-200 transition hover:border-emerald-300 hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60">
              {submitting ? "Планируем..." : "Запланировать запуск"}
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-slate-700 bg-slate-950/40 p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-slate-200">Список запланированных запусков</p>
            <button type="button" onClick={() => void refreshScheduled()} className="rounded-md border border-slate-600 bg-slate-900/70 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:border-slate-500 hover:bg-slate-800">Обновить</button>
          </div>

          {scheduledLoading ? (
            <p className="text-sm text-slate-400">Загрузка запланированных диагностик...</p>
          ) : scheduledTasks.length === 0 ? (
            <p className="text-sm text-slate-400">Запланированные диагностики пока не добавлены.</p>
          ) : (
            <div className="space-y-3">
              {scheduledTasks.map((item) => {
                const statusLabel = item.last_task_status || (item.dispatched_at ? "dispatched" : "scheduled");
                return (
                  <article key={item.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div className="space-y-1 text-sm text-slate-300">
                        <p className="font-semibold text-slate-100">{formatScenarioLabel(item.task_type, item.payload)}</p>
                        <p>Запуск: {formatDate(item.run_at)}</p>
                        <p>Статус: <span className="font-mono">{statusLabel}</span>{item.last_task_severity ? ` / ${item.last_task_severity}` : ""}</p>
                        {item.last_task_summary ? <p className="text-xs text-slate-400">{item.last_task_summary}</p> : null}
                      </div>
                      <button type="button" onClick={() => void handleDeleteScheduled(item)} className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/20">Удалить</button>
                    </div>
                    <details className="mt-2 rounded-md border border-slate-800 bg-slate-950/40 p-2">
                      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">Payload</summary>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-slate-300">{JSON.stringify(item.payload, null, 2)}</pre>
                    </details>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
