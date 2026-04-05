import { AgentStatus } from "@/lib/types";

function classNames(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const AGENT_STYLES: Record<AgentStatus, string> = {
  online: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300",
  offline: "border-rose-400/30 bg-rose-500/10 text-rose-300",
  unknown: "border-slate-400/30 bg-slate-500/10 text-slate-300",
};

const AGENT_LABELS: Record<AgentStatus, string> = {
  online: "онлайн",
  offline: "офлайн",
  unknown: "неизвестно",
};

const TASK_STYLES: Record<string, string> = {
  pending: "border-amber-400/30 bg-amber-500/10 text-amber-300",
  running: "border-sky-400/30 bg-sky-500/10 text-sky-300",
  success: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300",
  failed: "border-rose-400/30 bg-rose-500/10 text-rose-300",
  unknown: "border-slate-400/30 bg-slate-500/10 text-slate-300",
};

const TASK_LABELS: Record<string, string> = {
  pending: "ожидание",
  running: "выполняется",
  success: "успешно",
  failed: "ошибка",
  unknown: "неизвестно",
};

function normalizeTaskStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized in TASK_STYLES) {
    return normalized;
  }

  if (normalized.includes("running")) {
    return "running";
  }

  if (normalized.includes("progress") || normalized.includes("pending") || normalized.includes("queued")) {
    return "pending";
  }

  if (normalized.includes("success") || normalized.includes("done") || normalized.includes("completed")) {
    return "success";
  }

  if (normalized.includes("fail") || normalized.includes("error") || normalized.includes("cancel")) {
    return "failed";
  }

  return "unknown";
}

export function AgentStatusPill({ status }: { status: AgentStatus }) {
  return (
    <span
      className={classNames(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold uppercase tracking-wider",
        AGENT_STYLES[status],
      )}
    >
      <span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />
      {AGENT_LABELS[status]}
    </span>
  );
}

export function TaskStatusBadge({ status }: { status: string }) {
  const normalized = normalizeTaskStatus(status);

  return (
    <span
      className={classNames(
        "inline-flex items-center rounded-md border px-2 py-1 text-xs font-semibold uppercase tracking-wide",
        TASK_STYLES[normalized],
      )}
    >
      {TASK_LABELS[normalized]}
    </span>
  );
}