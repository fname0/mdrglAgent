"use client";

import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, FileText } from "lucide-react";
import { AgentTask } from "@/lib/types";
import { TaskStatusBadge } from "@/components/status-pill";
import { JsonViewer } from "@/components/json-viewer";

interface TaskHistoryTableProps {
  tasks: AgentTask[];
  loading: boolean;
  error: string | null;
  agentId?: string;
  agentHostname?: string;
}

type Severity = "ok" | "warn" | "crit" | "unknown";

function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value || "-";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatTaskType(taskType: string): string {
  if (taskType === "agent_snapshot") {
    return "Паспорт узла";
  }

  if (taskType === "tcp_connect_check") {
    return "Проверка TCP";
  }

  if (taskType === "http_check") {
    return "Проверка HTTP";
  }

  if (taskType === "list_listening_ports") {
    return "Listening порты";
  }

  if (taskType === "process_port_inventory") {
    return "Инвентарь сетевых процессов";
  }

  if (taskType === "custom_scenario") {
    return "Кастомный сценарий";
  }

  if (taskType === "service_status_check") {
    return "Статус сервиса";
  }

  if (taskType === "process_presence_check") {
    return "Наличие процесса";
  }

  if (taskType === "port_owner_check") {
    return "Владелец порта";
  }

  if (taskType === "process_resource_snapshot") {
    return "Ресурсы процесса";
  }

  if (taskType === "docker_runtime_access_check") {
    return "Docker runtime";
  }

  if (taskType === "docker_container_status_check") {
    return "Docker контейнер";
  }

  if (taskType === "docker_compose_stack_check") {
    return "Docker compose stack";
  }

  if (taskType === "docker_port_mapping_check") {
    return "Docker port mapping";
  }

  if (taskType === "sys_info") {
    return "sys_info (legacy)";
  }

  if (taskType === "ping") {
    return "ping (legacy)";
  }

  if (taskType === "port_scan") {
    return "port_scan (legacy)";
  }

  return taskType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function getDiagnostic(task: AgentTask): { severity: Severity; summary: string } {
  if (!isRecord(task.result)) {
    return { severity: "unknown", summary: "-" };
  }

  const severity = normalizeSeverity(task.result.severity);
  const summaryRaw = task.result.summary;
  const summary = typeof summaryRaw === "string" && summaryRaw.trim().length > 0 ? summaryRaw : "-";

  return { severity, summary };
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

interface ExportTaskResult {
  task_id: string;
  task_type: string;
  status: string;
  created_at: string;
  completed_at: string;
  payload: unknown;
  result: unknown;
}

function toExportPayload(task: AgentTask): ExportTaskResult {
  return {
    task_id: task.id,
    task_type: task.task_type,
    status: task.status,
    created_at: task.created_at,
    completed_at: task.completed_at,
    payload: task.payload,
    result: task.result,
  };
}

function formatFileTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

function triggerDownload(content: string, mimeType: string, filename: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function TaskHistoryTable({ tasks, loading, error, agentId, agentHostname }: TaskHistoryTableProps) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((left, right) => {
      const leftTime = new Date(left.created_at).getTime();
      const rightTime = new Date(right.created_at).getTime();

      if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
        return 0;
      }

      return rightTime - leftTime;
    });
  }, [tasks]);

  function exportTaskAsJson(task: AgentTask) {
    setExportError(null);

    const now = new Date();
    const safeAgentPart = sanitizeFilePart(agentHostname || agentId || "agent");
    const safeTaskPart = sanitizeFilePart(task.id);
    const filename = `result-${safeAgentPart}-${safeTaskPart}-${formatFileTimestamp(now)}.json`;
    const payload = {
      exported_at: now.toISOString(),
      agent_id: agentId ?? null,
      agent_hostname: agentHostname ?? null,
      task: toExportPayload(task),
    };

    triggerDownload(JSON.stringify(payload, null, 2), "application/json;charset=utf-8", filename);
  }

  async function exportTaskAsPdf(task: AgentTask) {
    setExportError(null);

    try {
      const { jsPDF } = await import("jspdf");

      const now = new Date();
      const payload = {
        exported_at: now.toISOString(),
        agent_id: agentId ?? null,
        agent_hostname: agentHostname ?? null,
        task: toExportPayload(task),
      };
      const prettyJson = JSON.stringify(payload, null, 2);
      const safeAgentPart = sanitizeFilePart(agentHostname || agentId || "agent");
      const safeTaskPart = sanitizeFilePart(task.id);
      const filename = `result-${safeAgentPart}-${safeTaskPart}-${formatFileTimestamp(now)}.pdf`;

      const documentPdf = new jsPDF({
        orientation: "portrait",
        unit: "pt",
        format: "a4",
      });

      const pageWidth = documentPdf.internal.pageSize.getWidth();
      const pageHeight = documentPdf.internal.pageSize.getHeight();
      const margin = 36;
      const contentWidth = pageWidth - margin * 2;
      const lineHeight = 12;
      let cursorY = margin;

      documentPdf.setFont("courier", "normal");
      documentPdf.setFontSize(9);
      const lines = documentPdf.splitTextToSize(prettyJson, contentWidth) as string[];

      for (const line of lines) {
        if (cursorY > pageHeight - margin) {
          documentPdf.addPage();
          cursorY = margin;
          documentPdf.setFont("courier", "normal");
          documentPdf.setFontSize(9);
        }
        documentPdf.text(line, margin, cursorY);
        cursorY += lineHeight;
      }

      documentPdf.save(filename);
    } catch {
      setExportError("Не удалось сформировать PDF. Используйте JSON экспорт.");
    }
  }

  return (
    <section className="rounded-xl border border-slate-700/70 bg-panel/85 p-4">
      <h2 className="mb-4 text-lg font-semibold text-slate-100">История задач</h2>

      {loading && <p className="text-sm text-slate-400">Загрузка истории задач...</p>}

      {error && (
        <div className="mb-3 rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </div>
      )}

      {exportError && (
        <div className="mb-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          {exportError}
        </div>
      )}

      {!loading && sortedTasks.length === 0 && !error && (
        <p className="text-sm text-slate-400">Для этого агента пока нет задач.</p>
      )}

      {sortedTasks.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="min-w-full divide-y divide-slate-800 text-left text-sm">
            <thead className="bg-slate-900/70 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">Тип</th>
                <th className="px-4 py-3">Статус</th>
                <th className="px-4 py-3">Диагностика</th>
                <th className="px-4 py-3">Дата</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-950/50">
              {sortedTasks.map((task) => {
                const isExpanded = expandedTaskId === task.id;
                const diagnostic = getDiagnostic(task);

                return (
                  <Fragment key={task.id}>
                    <tr
                      className="cursor-pointer transition hover:bg-slate-900/70"
                      onClick={() => setExpandedTaskId(isExpanded ? null : task.id)}
                    >
                      <td className="px-4 py-3">
                        <div className="inline-flex items-center gap-2 font-medium text-slate-100">
                          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          {formatTaskType(task.task_type)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <TaskStatusBadge status={task.status} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex rounded-md border px-2 py-1 text-xs font-semibold uppercase tracking-wide ${severityStyles(
                              diagnostic.severity,
                            )}`}
                          >
                            {severityLabel(diagnostic.severity)}
                          </span>
                          <span className="text-slate-200">{diagnostic.summary}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">{formatDate(task.created_at)}</td>
                    </tr>

                    {isExpanded && (
                      <tr className="bg-slate-950/80">
                        <td className="space-y-3 px-4 pb-4 pt-2" colSpan={4}>
                          <div>
                            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Payload</p>
                            <JsonViewer value={task.payload} />
                          </div>

                          <div>
                            <div className="mb-1 flex flex-wrap items-center gap-2">
                              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Result</p>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => exportTaskAsJson(task)}
                                  className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-900/70 px-2 py-1 text-[11px] font-semibold text-slate-200 transition hover:border-slate-400 hover:bg-slate-800"
                                >
                                  <Download className="h-3.5 w-3.5" />
                                  JSON
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void exportTaskAsPdf(task)}
                                  className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-900/70 px-2 py-1 text-[11px] font-semibold text-slate-200 transition hover:border-slate-400 hover:bg-slate-800"
                                >
                                  <FileText className="h-3.5 w-3.5" />
                                  PDF
                                </button>
                              </div>
                            </div>
                            <JsonViewer value={task.result} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
