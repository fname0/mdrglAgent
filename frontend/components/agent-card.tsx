"use client";

import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Clock3, Cpu, Network, PlayCircle } from "lucide-react";
import { Agent } from "@/lib/types";
import { AgentStatusPill } from "@/components/status-pill";

interface AgentCardProps {
  agent: Agent;
}

function formatDate(value: string): string {
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

function formatAvgExecutionSeconds(value: number | null): string {
  if (value === null || Number.isNaN(value) || !Number.isFinite(value)) {
    return "-";
  }

  if (value < 1) {
    return `${Math.round(value * 1000)} ms`;
  }

  return `${value.toFixed(1)} c`;
}

export function AgentCard({ agent }: AgentCardProps) {
  return (
    <Link
      href={`/agent/${agent.id}`}
      className="block rounded-xl outline-none ring-offset-0 transition focus-visible:ring-2 focus-visible:ring-sky-300/60"
      aria-label={`Открыть страницу агента ${agent.hostname}`}
    >
      <article className="group rounded-xl border border-slate-700/70 bg-panel/80 p-4 shadow-[0_12px_30px_-16px_rgba(17,139,224,0.35)] backdrop-blur transition hover:border-accent/50 hover:bg-panel-2/95">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-100">{agent.hostname}</h3>
            <p className="mt-1 text-xs uppercase tracking-[0.2em] text-slate-400">ID агента: {agent.id}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[11px] font-semibold text-sky-200">
                <PlayCircle className="h-3.5 w-3.5" />
                Запуски: {agent.total_runs}
              </span>
              <span className="inline-flex items-center gap-1 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-2 py-1 text-[11px] font-semibold text-indigo-200">
                <Clock3 className="h-3.5 w-3.5" />
                Ср. время: {formatAvgExecutionSeconds(agent.average_execution_seconds)}
              </span>
              <span className="inline-flex items-center gap-1 rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] font-semibold text-rose-200">
                <AlertTriangle className="h-3.5 w-3.5" />
                Ошибок за день: {agent.errors_today}
              </span>
            </div>
          </div>
          <AgentStatusPill status={agent.status} />
        </header>

        <div className="space-y-2.5 text-sm text-slate-200">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-sky-300" />
            <span className="text-slate-400">ОС:</span>
            <span className="font-medium">{agent.os}</span>
          </div>
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-cyan-300" />
            <span className="text-slate-400">IP:</span>
            <span className="font-mono text-sm">{agent.ip}</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock3 className="h-4 w-4 text-violet-300" />
            <span className="text-slate-400">Последний контакт:</span>
            <span>{formatDate(agent.last_seen)}</span>
          </div>
        </div>

        <div className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-sky-200/90 transition group-hover:text-sky-100">
          <span>Открыть агента</span>
          <ArrowUpRight className="h-4 w-4" />
        </div>
      </article>
    </Link>
  );
}
