"use client";

import { useMemo } from "react";
import { Agent } from "@/lib/types";

interface TopologyRelationsCardProps {
  agents: Agent[];
}

interface PositionedAgent {
  agent: Agent;
  x: number;
  y: number;
}

const VIEWBOX_WIDTH = 760;
const VIEWBOX_HEIGHT = 420;
const CENTER_X = VIEWBOX_WIDTH / 2;
const CENTER_Y = VIEWBOX_HEIGHT / 2;
const SERVER_LINK_OFFSET = 30;
const AGENT_LINK_OFFSET = 24;

function truncateHostname(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 18) {
    return trimmed;
  }
  return `${trimmed.slice(0, 15)}...`;
}

function projectFromPoint(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  offset: number,
): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const distance = Math.hypot(dx, dy) || 1;
  const k = offset / distance;
  return {
    x: x1 + dx * k,
    y: y1 + dy * k,
  };
}

export function TopologyRelationsCard({ agents }: TopologyRelationsCardProps) {
  const positionedAgents = useMemo<PositionedAgent[]>(() => {
    if (agents.length === 0) {
      return [];
    }

    const radius = Math.min(170, 115 + Math.max(0, agents.length - 6) * 8);
    const angleStep = (Math.PI * 2) / agents.length;

    return agents.map((agent, index) => {
      const angle = -Math.PI / 2 + index * angleStep;
      return {
        agent,
        x: CENTER_X + Math.cos(angle) * radius,
        y: CENTER_Y + Math.sin(angle) * radius,
      };
    });
  }, [agents]);

  return (
    <section className="rounded-xl border border-slate-700/70 bg-panel/85 p-4">
      <h2 className="mb-3 text-lg font-semibold text-slate-100">Топология связей</h2>

      <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40 p-1.5">
        <svg viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`} className="h-[300px] w-full min-w-[560px]">
          {positionedAgents.map(({ agent, x, y }) => {
            const isOnline = agent.status === "online";
            const linkClassName = isOnline ? "topology-link-online" : "topology-link-offline";

            const start = projectFromPoint(CENTER_X, CENTER_Y, x, y, SERVER_LINK_OFFSET);
            const end = projectFromPoint(x, y, CENTER_X, CENTER_Y, AGENT_LINK_OFFSET);

            return (
              <line
                key={`link:${agent.id}`}
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                className={linkClassName}
                strokeWidth={2.8}
                strokeLinecap="round"
              />
            );
          })}

          <g transform={`translate(${CENTER_X} ${CENTER_Y})`}>
            <rect x={-26} y={-34} width={52} height={68} rx={8} fill="#0b1f36" stroke="#38bdf8" strokeWidth={2.2} />
            <line x1={-17} y1={-10} x2={17} y2={-10} stroke="#7dd3fc" strokeWidth={1.4} />
            <line x1={-17} y1={10} x2={17} y2={10} stroke="#7dd3fc" strokeWidth={1.4} />
            <circle cx={14} cy={-18} r={2.1} fill="#22d3ee" />
            <circle cx={14} cy={2} r={2.1} fill="#22d3ee" />
            <circle cx={14} cy={22} r={2.1} fill="#22d3ee" />
          </g>

          {positionedAgents.map(({ agent, x, y }) => {
            const isOnline = agent.status === "online";
            const label = truncateHostname(agent.hostname);

            return (
              <g key={agent.id}>
                <rect
                  x={x - 24}
                  y={y - 18}
                  width={48}
                  height={32}
                  rx={5}
                  fill={isOnline ? "#0a2218" : "#341818"}
                  stroke={isOnline ? "#4ade80" : "#f87171"}
                  strokeWidth={2}
                />
                <rect x={x - 21} y={y - 15} width={42} height={20} rx={3} fill="#0b1220" stroke="#334155" strokeWidth={1.2} />
                <line x1={x - 10} y1={y + 14} x2={x + 10} y2={y + 14} stroke="#94a3b8" strokeWidth={1.4} strokeLinecap="round" />
                <rect x={x - 13} y={y + 14} width={26} height={3.5} rx={2} fill="#64748b" />
                <title>{label}</title>
              </g>
            );
          })}

          {positionedAgents.length === 0 ? (
            <text x={CENTER_X} y={CENTER_Y + 94} textAnchor="middle" className="fill-slate-500 text-sm">
              Нет подключенных агентов
            </text>
          ) : null}
        </svg>
      </div>
    </section>
  );
}
