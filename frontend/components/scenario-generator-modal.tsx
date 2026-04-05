"use client";

import { FormEvent } from "react";
import { Loader2, WandSparkles, X } from "lucide-react";
import {
  ScenarioGenerationMessage,
  ScenarioGenerationResponse,
  ScenarioGenerationStep,
} from "@/lib/api";

interface ScenarioGeneratorModalProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  messages: ScenarioGenerationMessage[];
  response: ScenarioGenerationResponse | null;
  reply: string;
  onReplyChange: (value: string) => void;
  onSubmitReply: () => void;
  onApply: () => void;
  onClose: () => void;
}

const INPUT_CLASS =
  "w-full min-h-28 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-accent disabled:cursor-not-allowed disabled:opacity-70";

function StageBadge({ stage }: { stage: ScenarioGenerationResponse["stage"] }) {
  if (stage === "proposal") {
    return (
      <span className="inline-flex rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-200">
        Готово
      </span>
    );
  }

  return (
    <span className="inline-flex rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-sky-200">
      Уточнение
    </span>
  );
}

function StepsPreview({
  title,
  shell,
  steps,
}: {
  title: string;
  shell: string | null;
  steps: ScenarioGenerationStep[];
}) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-100">{title}</p>
        <span className="text-xs uppercase tracking-wide text-slate-500">{shell ?? "не задан"}</span>
      </div>

      {steps.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">Шаги не сгенерированы.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {steps.map((step, index) => (
            <div key={`${title}:${index}:${step.command}`} className="rounded-md border border-slate-800 bg-slate-950/60 p-3">
              <p className="font-mono text-xs text-sky-200">{step.command}</p>
              <p className="mt-2 text-sm text-slate-300">{step.explanation}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function ScenarioGeneratorModal({
  open,
  loading,
  error,
  messages,
  response,
  reply,
  onReplyChange,
  onSubmitReply,
  onApply,
  onClose,
}: ScenarioGeneratorModalProps) {
  if (!open) {
    return null;
  }

  const isProposal = response?.stage === "proposal";
  const canApply = Boolean(response && (response.linux_steps.length > 0 || response.windows_steps.length > 0));

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loading) {
      onSubmitReply();
    }
  }

  return (
    <div className="fixed inset-0 z-[120] h-dvh w-screen overflow-y-auto bg-slate-950/80 backdrop-blur-sm">
      <div className="min-h-dvh px-3 py-4 sm:px-6 sm:py-8">
        <div className="mx-auto w-full max-w-4xl rounded-2xl border border-slate-700 bg-panel shadow-2xl">
          <div className="flex max-h-[90dvh] flex-col">
            <div className="flex items-start justify-between gap-4 border-b border-slate-800 px-5 py-4 sm:px-6 sm:py-5">
              <div>
                <div className="inline-flex items-center gap-2 text-sm font-semibold text-sky-200">
                  <WandSparkles className="h-4 w-4" />
                  Генерация шагов
                </div>
                <p className="mt-2 text-sm text-slate-400">
                  Нейросеть уточнит смысл сценария и соберет команды для Linux и Windows.
                </p>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-slate-700 p-2 text-slate-300 transition hover:border-slate-500 hover:text-white"
                aria-label="Закрыть"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 pb-5 pt-4 sm:px-6 sm:pb-6">
              {response ? (
                <div className="mt-1 flex items-center gap-2">
                  <StageBadge stage={response.stage} />
                  {response.understanding ? <p className="text-sm text-slate-300">{response.understanding}</p> : null}
                </div>
              ) : null}

              {error ? (
                <div className="mt-4 rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                  {error}
                </div>
              ) : null}

              <div className="mt-4 max-h-[34dvh] space-y-3 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                {messages.map((message, index) => (
                  <div
                    key={`${message.role}:${index}:${message.content.slice(0, 30)}`}
                    className={`max-w-[88%] rounded-xl px-4 py-3 text-sm ${
                      message.role === "assistant"
                        ? "border border-slate-700 bg-slate-900/90 text-slate-200"
                        : "ml-auto border border-sky-500/30 bg-sky-500/10 text-sky-100"
                    }`}
                  >
                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      {message.role === "assistant" ? "Ассистент" : "Вы"}
                    </p>
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  </div>
                ))}

                {messages.length === 0 ? <p className="text-sm text-slate-500">История пока пуста.</p> : null}
              </div>

              {isProposal && response ? (
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <StepsPreview title="Linux шаги" shell={response.linux_shell} steps={response.linux_steps} />
                  <StepsPreview title="Windows шаги" shell={response.windows_shell} steps={response.windows_steps} />
                </div>
              ) : null}

              {!isProposal ? (
                <form className="mt-4 space-y-3" onSubmit={handleSubmit}>
                  {response?.questions && response.questions.length > 0 ? (
                    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Вопросы</p>
                      <ul className="mt-2 space-y-1 text-sm text-slate-300">
                        {response.questions.map((question, index) => (
                          <li key={`${index}:${question}`}>{question}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <label className="block">
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Ваш ответ
                    </span>
                    <textarea
                      value={reply}
                      onChange={(event) => onReplyChange(event.target.value)}
                      disabled={loading}
                      placeholder="Ответьте на вопросы или уточните, что именно должен делать сценарий"
                      className={INPUT_CLASS}
                    />
                  </label>

                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      className="rounded-lg border border-slate-700 bg-slate-900/70 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
                    >
                      Отмена
                    </button>
                    <button
                      type="submit"
                      disabled={loading}
                      className="inline-flex items-center gap-2 rounded-lg border border-sky-400/40 bg-sky-500/20 px-4 py-2.5 text-sm font-semibold text-sky-200 transition hover:border-sky-300 hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      {loading ? "Генерация..." : "Отправить"}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-lg border border-slate-700 bg-slate-900/70 px-4 py-2.5 text-sm font-semibold text-slate-200 transition hover:border-slate-500 hover:bg-slate-800"
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    onClick={onApply}
                    disabled={!canApply}
                    className="rounded-lg border border-emerald-400/40 bg-emerald-500/20 px-4 py-2.5 text-sm font-semibold text-emerald-200 transition hover:border-emerald-300 hover:bg-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Применить
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
