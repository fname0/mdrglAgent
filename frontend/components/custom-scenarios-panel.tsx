"use client";

import { useEffect, useState } from "react";
import {
  CreateCustomScenarioPayload,
  CustomScenarioRecord,
  CustomScenarioShell,
  ScenarioGenerationMessage,
  ScenarioGenerationResponse,
  createCustomScenario,
  deleteCustomScenario,
  fetchCustomScenarios,
  generateScenarioSteps,
  getApiErrorMessage,
  updateCustomScenario,
} from "@/lib/api";
import { ScenarioGeneratorModal } from "@/components/scenario-generator-modal";

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70";

const TEXTAREA_CLASS =
  "w-full min-h-28 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70";

function formatDate(value: string): string {
  if (!value) {
    return "-";
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

function shellLabel(shell: CustomScenarioShell): string {
  if (shell === "powershell") {
    return "PowerShell";
  }
  if (shell === "cmd") {
    return "CMD";
  }
  if (shell === "bash") {
    return "Bash";
  }
  return "sh";
}

function parseCommands(text: string, shell: CustomScenarioShell): Array<{ shell: CustomScenarioShell; command: string }> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((command) => ({ shell, command }));
}

function notifyCustomScenariosChanged() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent("custom-scenarios:changed"));
}

function formatGeneratorMessage(response: ScenarioGenerationResponse): string {
  const parts = [response.assistant_message.trim()];

  if (response.understanding) {
    parts.push(`Понимание: ${response.understanding}`);
  }

  if (response.questions.length > 0) {
    parts.push(`Вопросы:\n${response.questions.map((question, index) => `${index + 1}. ${question}`).join("\n")}`);
  }

  return parts.filter(Boolean).join("\n\n");
}

function stepsToTextarea(steps: ScenarioGenerationResponse["linux_steps"]): string {
  return steps.map((step) => step.command).join("\n");
}

export function CustomScenariosPanel() {
  const [items, setItems] = useState<CustomScenarioRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("120");
  const [stopOnError, setStopOnError] = useState(true);
  const [isActive, setIsActive] = useState(true);
  const [linuxShell, setLinuxShell] = useState<CustomScenarioShell>("bash");
  const [windowsShell, setWindowsShell] = useState<CustomScenarioShell>("powershell");
  const [linuxCommands, setLinuxCommands] = useState("");
  const [windowsCommands, setWindowsCommands] = useState("");

  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [generatorLoading, setGeneratorLoading] = useState(false);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  const [generatorReply, setGeneratorReply] = useState("");
  const [generatorMessages, setGeneratorMessages] = useState<ScenarioGenerationMessage[]>([]);
  const [generatorResponse, setGeneratorResponse] = useState<ScenarioGenerationResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const payload = await fetchCustomScenarios();
        if (!cancelled) {
          setItems(payload);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(getApiErrorMessage(loadError, "Не удалось загрузить кастомные сценарии."));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshScenarios() {
    setLoading(true);
    try {
      const payload = await fetchCustomScenarios();
      setItems(payload);
      setError(null);
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, "Не удалось загрузить кастомные сценарии."));
    } finally {
      setLoading(false);
    }
  }

  function resetGeneratorState() {
    setGeneratorOpen(false);
    setGeneratorLoading(false);
    setGeneratorError(null);
    setGeneratorReply("");
    setGeneratorMessages([]);
    setGeneratorResponse(null);
  }

  async function handleCreateScenario() {
    setError(null);
    setActionMessage(null);

    const normalizedName = name.trim();
    const duplicateExists = items.some((item) => item.name.trim().toLowerCase() === normalizedName.toLowerCase());
    if (!normalizedName) {
      setError("Название сценария обязательно.");
      return;
    }

    if (duplicateExists) {
      setError("Сценарий с таким названием уже существует.");
      return;
    }

    const parsedTimeout = Number(timeoutSeconds.trim());
    if (!Number.isInteger(parsedTimeout) || parsedTimeout < 1 || parsedTimeout > 3600) {
      setError("timeout_seconds должен быть целым числом в диапазоне 1..3600.");
      return;
    }

    const linuxSteps = parseCommands(linuxCommands, linuxShell);
    const windowsSteps = parseCommands(windowsCommands, windowsShell);
    if (linuxSteps.length === 0 && windowsSteps.length === 0) {
      setError("Добавьте хотя бы одну команду для Linux или Windows.");
      return;
    }

    const payload: CreateCustomScenarioPayload = {
      name: normalizedName,
      description: description.trim() || undefined,
      timeout_seconds: parsedTimeout,
      stop_on_error: stopOnError,
      is_active: isActive,
      linux_steps: linuxSteps,
      windows_steps: windowsSteps,
    };

    setSubmitting(true);
    try {
      await createCustomScenario(payload);
      setActionMessage("Кастомный сценарий создан.");
      setName("");
      setDescription("");
      setLinuxCommands("");
      setWindowsCommands("");
      await refreshScenarios();
      notifyCustomScenariosChanged();
    } catch (createError) {
      setError(getApiErrorMessage(createError, "Не удалось создать кастомный сценарий."));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleActive(item: CustomScenarioRecord) {
    setError(null);
    setActionMessage(null);
    try {
      await updateCustomScenario(item.id, { is_active: !item.is_active });
      setActionMessage(item.is_active ? "Сценарий отключён." : "Сценарий включён.");
      await refreshScenarios();
      notifyCustomScenariosChanged();
    } catch (updateError) {
      setError(getApiErrorMessage(updateError, "Не удалось изменить состояние сценария."));
    }
  }

  async function handleDelete(item: CustomScenarioRecord) {
    setError(null);
    setActionMessage(null);
    if (!window.confirm(`Удалить сценарий "${item.name}"?`)) {
      return;
    }

    try {
      await deleteCustomScenario(item.id);
      setActionMessage("Сценарий удалён.");
      await refreshScenarios();
      notifyCustomScenariosChanged();
    } catch (deleteError) {
      setError(getApiErrorMessage(deleteError, "Не удалось удалить сценарий."));
    }
  }

  async function requestScenarioGeneration(messages: ScenarioGenerationMessage[]) {
    return generateScenarioSteps({
      name: name.trim(),
      description: description.trim() || undefined,
      linux_shell_preference: linuxShell === "sh" ? "sh" : "bash",
      windows_shell_preference: windowsShell === "cmd" ? "cmd" : "powershell",
      messages,
    });
  }

  async function handleGenerateSteps() {
    setError(null);
    setActionMessage(null);
    setGeneratorError(null);

    const normalizedName = name.trim();
    if (!normalizedName) {
      setError("Сначала укажите название сценария.");
      return;
    }

    setGeneratorLoading(true);
    try {
      const response = await requestScenarioGeneration([]);
      if (response.stage === "insufficient_context") {
        setError(response.assistant_message || "Опишите сценарий понятнее.");
        return;
      }

      const assistantMessage = formatGeneratorMessage(response);
      setGeneratorMessages([{ role: "assistant", content: assistantMessage }]);
      setGeneratorResponse(response);
      setGeneratorReply("");
      setGeneratorOpen(true);
    } catch (generationError) {
      setError(getApiErrorMessage(generationError, "Не удалось сгенерировать шаги сценария."));
    } finally {
      setGeneratorLoading(false);
    }
  }

  async function handleSubmitGeneratorReply() {
    const normalizedReply = generatorReply.trim();
    if (!normalizedReply) {
      setGeneratorError("Введите ответ для генератора.");
      return;
    }

    const nextMessages: ScenarioGenerationMessage[] = [...generatorMessages, { role: "user", content: normalizedReply }];
    setGeneratorLoading(true);
    setGeneratorError(null);

    try {
      const response = await requestScenarioGeneration(nextMessages);
      if (response.stage === "insufficient_context") {
        setGeneratorOpen(false);
        setError(response.assistant_message || "Опишите сценарий понятнее.");
        resetGeneratorState();
        return;
      }

      const assistantMessage = formatGeneratorMessage(response);
      setGeneratorMessages([...nextMessages, { role: "assistant", content: assistantMessage }]);
      setGeneratorResponse(response);
      setGeneratorReply("");
    } catch (generationError) {
      setGeneratorError(getApiErrorMessage(generationError, "Не удалось продолжить генерацию."));
    } finally {
      setGeneratorLoading(false);
    }
  }

  function handleApplyGeneratedSteps() {
    if (!generatorResponse || generatorResponse.stage !== "proposal") {
      return;
    }

    setLinuxCommands(stepsToTextarea(generatorResponse.linux_steps));
    setWindowsCommands(stepsToTextarea(generatorResponse.windows_steps));

    if (generatorResponse.linux_shell) {
      setLinuxShell(generatorResponse.linux_shell);
    }
    if (generatorResponse.windows_shell) {
      setWindowsShell(generatorResponse.windows_shell);
    }

    setActionMessage("Сгенерированные шаги применены к форме сценария.");
    resetGeneratorState();
  }

  return (
    <>
      <details className="rounded-xl border border-slate-700/70 bg-panel/85">
        <summary className="cursor-pointer p-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Кастомные сценарии</h2>
            <p className="text-sm text-slate-400">
              Создайте команду или цепочку команд и используйте её как обычный сценарий диагностики.
            </p>
          </div>
        </summary>

        <div className="space-y-4 px-5 pb-5">
          {error ? (
            <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>
          ) : null}

          {actionMessage ? (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
              {actionMessage}
            </div>
          ) : null}

          <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-4">
            <p className="text-sm font-semibold text-slate-200">Новый сценарий</p>

            <div className="mt-3 space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Название</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={submitting || generatorLoading}
                    placeholder="Например: Проверка nginx и health endpoint"
                    className={INPUT_CLASS}
                  />
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">timeout_seconds</span>
                  <input
                    value={timeoutSeconds}
                    onChange={(event) => setTimeoutSeconds(event.target.value)}
                    disabled={submitting || generatorLoading}
                    placeholder="120"
                    className={INPUT_CLASS}
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Описание</span>
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  disabled={submitting || generatorLoading}
                  placeholder="Опишите, что именно должен проверить или выполнить сценарий"
                  className={INPUT_CLASS}
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Linux шаги</p>
                    <select
                      value={linuxShell}
                      onChange={(event) => setLinuxShell(event.target.value as CustomScenarioShell)}
                      disabled={submitting || generatorLoading}
                      className="rounded-md border border-slate-700 bg-slate-900/90 px-2 py-1.5 text-xs text-slate-200"
                    >
                      <option value="bash">bash</option>
                      <option value="sh">sh</option>
                      <option value="powershell">powershell</option>
                      <option value="cmd">cmd</option>
                    </select>
                  </div>
                  <textarea
                    value={linuxCommands}
                    onChange={(event) => setLinuxCommands(event.target.value)}
                    disabled={submitting || generatorLoading}
                    placeholder={"Одна команда на строку\nsystemctl status nginx\ncurl -I http://127.0.0.1:8080/health"}
                    className={TEXTAREA_CLASS}
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Windows шаги</p>
                    <select
                      value={windowsShell}
                      onChange={(event) => setWindowsShell(event.target.value as CustomScenarioShell)}
                      disabled={submitting || generatorLoading}
                      className="rounded-md border border-slate-700 bg-slate-900/90 px-2 py-1.5 text-xs text-slate-200"
                    >
                      <option value="powershell">powershell</option>
                      <option value="cmd">cmd</option>
                      <option value="bash">bash</option>
                      <option value="sh">sh</option>
                    </select>
                  </div>
                  <textarea
                    value={windowsCommands}
                    onChange={(event) => setWindowsCommands(event.target.value)}
                    disabled={submitting || generatorLoading}
                    placeholder={"Одна команда на строку\nGet-Service -Name Spooler\nTest-NetConnection -ComputerName 127.0.0.1 -Port 3389"}
                    className={TEXTAREA_CLASS}
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-4">
                <label className="inline-flex items-center gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={stopOnError}
                    onChange={(event) => setStopOnError(event.target.checked)}
                    disabled={submitting || generatorLoading}
                    className="h-4 w-4"
                  />
                  Остановить при ошибке шага
                </label>

                <label className="inline-flex items-center gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(event) => setIsActive(event.target.checked)}
                    disabled={submitting || generatorLoading}
                    className="h-4 w-4"
                  />
                  Активен
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleGenerateSteps()}
                  disabled={submitting || generatorLoading}
                  className="rounded-lg border border-amber-400/40 bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-200 transition hover:border-amber-300 hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {generatorLoading ? "Генерируем..." : "Сгенерировать шаги"}
                </button>

                <button
                  type="button"
                  onClick={() => void handleCreateScenario()}
                  disabled={submitting || generatorLoading}
                  className="rounded-lg border border-sky-400/40 bg-sky-500/20 px-4 py-2 text-sm font-semibold text-sky-200 transition hover:border-sky-300 hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? "Создаём..." : "Добавить кастомный сценарий"}
                </button>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-slate-700 bg-slate-950/40 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-200">Сохранённые сценарии</p>
              <button
                type="button"
                onClick={() => void refreshScenarios()}
                className="rounded-md border border-slate-600 bg-slate-900/70 px-2.5 py-1 text-xs font-semibold text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
              >
                Обновить
              </button>
            </div>

            {loading ? (
              <p className="text-sm text-slate-400">Загрузка сценариев...</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-slate-400">Кастомные сценарии пока не добавлены.</p>
            ) : (
              <div className="space-y-3">
                {items.map((item) => (
                  <article key={item.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div className="space-y-1 text-sm text-slate-300">
                        <p className="font-semibold text-slate-100">{item.name}</p>
                        {item.description ? <p className="text-slate-400">{item.description}</p> : null}
                        <p>
                          Статус:{" "}
                          <span className={item.is_active ? "text-emerald-300" : "text-slate-400"}>
                            {item.is_active ? "активен" : "отключён"}
                          </span>
                        </p>
                        <p>Linux шагов: {item.linux_steps.length}, Windows шагов: {item.windows_steps.length}</p>
                        <p>timeout: {item.timeout_seconds}s, stop_on_error: {item.stop_on_error ? "true" : "false"}</p>
                        <p className="text-xs text-slate-500">Обновлён: {formatDate(item.updated_at)}</p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleToggleActive(item)}
                          className="rounded-md border border-slate-600 bg-slate-900/70 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
                        >
                          {item.is_active ? "Отключить" : "Включить"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(item)}
                          className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/20"
                        >
                          Удалить
                        </button>
                      </div>
                    </div>

                    <details className="mt-3 rounded-md border border-slate-800 bg-slate-950/40 p-2">
                      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Шаги сценария
                      </summary>

                      <div className="mt-2 space-y-3 text-xs text-slate-300">
                        <div>
                          <p className="mb-1 font-semibold text-slate-400">Linux</p>
                          {item.linux_steps.length === 0 ? (
                            <p className="text-slate-500">Не задано</p>
                          ) : (
                            <ul className="space-y-1">
                              {item.linux_steps.map((step, index) => (
                                <li key={`${item.id}:linux:${index}`} className="font-mono">
                                  [{shellLabel(step.shell)}] {step.command}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>

                        <div>
                          <p className="mb-1 font-semibold text-slate-400">Windows</p>
                          {item.windows_steps.length === 0 ? (
                            <p className="text-slate-500">Не задано</p>
                          ) : (
                            <ul className="space-y-1">
                              {item.windows_steps.map((step, index) => (
                                <li key={`${item.id}:windows:${index}`} className="font-mono">
                                  [{shellLabel(step.shell)}] {step.command}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </details>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </details>

      <ScenarioGeneratorModal
        open={generatorOpen}
        loading={generatorLoading}
        error={generatorError}
        messages={generatorMessages}
        response={generatorResponse}
        reply={generatorReply}
        onReplyChange={setGeneratorReply}
        onSubmitReply={() => void handleSubmitGeneratorReply()}
        onApply={handleApplyGeneratedSteps}
        onClose={resetGeneratorState}
      />
    </>
  );
}
