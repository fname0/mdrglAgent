export type AgentStatus = "online" | "offline" | "unknown";
export type TaskType =
  | "agent_snapshot"
  | "tcp_connect_check"
  | "http_check"
  | "list_listening_ports"
  | "process_port_inventory"
  | "custom_scenario"
  | "service_status_check"
  | "process_presence_check"
  | "port_owner_check"
  | "process_resource_snapshot"
  | "docker_runtime_access_check"
  | "docker_container_status_check"
  | "docker_compose_stack_check"
  | "docker_port_mapping_check";

export interface Agent {
  id: string;
  hostname: string;
  os: string;
  ip: string;
  status: AgentStatus;
  last_seen: string;
  total_runs: number;
  average_execution_seconds: number | null;
  errors_today: number;
}

export interface AgentTask {
  id: string;
  task_type: string;
  status: string;
  created_at: string;
  completed_at: string;
  payload: unknown;
  result: unknown;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickValue(record: UnknownRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record && record[key] !== null && record[key] !== undefined) {
      return record[key];
    }
  }

  return undefined;
}

function toStringSafe(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return fallback;
}

function toTimestampString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    const asMillis = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(asMillis).toISOString();
  }

  return "";
}

function toNumberSafe(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function detectAgentStatus(record: UnknownRecord): AgentStatus {
  const boolValue = pickValue(record, ["online", "is_online", "alive", "connected"]);
  if (typeof boolValue === "boolean") {
    return boolValue ? "online" : "offline";
  }

  const rawStatus = toStringSafe(pickValue(record, ["status", "state"])).toLowerCase();

  if (
    rawStatus.includes("online") ||
    rawStatus.includes("up") ||
    rawStatus.includes("active") ||
    rawStatus.includes("connected")
  ) {
    return "online";
  }

  if (
    rawStatus.includes("offline") ||
    rawStatus.includes("down") ||
    rawStatus.includes("inactive") ||
    rawStatus.includes("disconnected")
  ) {
    return "offline";
  }

  return "unknown";
}

export function normalizeAgent(input: unknown, index: number): Agent {
  if (!isRecord(input)) {
    return {
      id: `agent-${index + 1}`,
      hostname: `agent-${index + 1}`,
      os: "unknown",
      ip: "-",
      status: "unknown",
      last_seen: "",
      total_runs: 0,
      average_execution_seconds: null,
      errors_today: 0,
    };
  }

  const id = toStringSafe(pickValue(input, ["id", "agent_id", "uuid"]), `agent-${index + 1}`);

  return {
    id,
    hostname: toStringSafe(pickValue(input, ["hostname", "host", "name"]), `agent-${id}`),
    os: toStringSafe(pickValue(input, ["os", "os_type", "platform", "system"]), "unknown"),
    ip: toStringSafe(
      pickValue(input, ["ip", "ip_address", "address", "public_ip", "private_ip"]),
      "-",
    ),
    status: detectAgentStatus(input),
    last_seen: toTimestampString(pickValue(input, ["last_seen", "lastSeen", "updated_at", "updatedAt"])),
    total_runs: Math.max(0, Math.trunc(toNumberSafe(pickValue(input, ["total_runs", "runs_total"]), 0))),
    average_execution_seconds: (() => {
      const raw = pickValue(input, ["average_execution_seconds", "avg_execution_seconds", "avg_duration_seconds"]);
      if (raw === null || raw === undefined) {
        return null;
      }

      const parsed = toNumberSafe(raw, Number.NaN);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    })(),
    errors_today: Math.max(0, Math.trunc(toNumberSafe(pickValue(input, ["errors_today", "daily_errors"]), 0))),
  };
}

function getCollection(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (isRecord(payload)) {
    for (const key of keys) {
      const value = payload[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }

  return [];
}

export function normalizeAgents(payload: unknown): Agent[] {
  return getCollection(payload, ["agents", "data", "items", "results"]).map((agent, index) =>
    normalizeAgent(agent, index),
  );
}

export function normalizeTask(input: unknown, index: number): AgentTask {
  if (!isRecord(input)) {
    return {
      id: `task-${index + 1}`,
      task_type: "unknown",
      status: "unknown",
      created_at: "",
      completed_at: "",
      payload: null,
      result: null,
    };
  }

  return {
    id: toStringSafe(pickValue(input, ["id", "task_id", "uuid"]), `task-${index + 1}`),
    task_type: toStringSafe(pickValue(input, ["task_type", "type", "name"]), "unknown"),
    status: toStringSafe(pickValue(input, ["status", "state"]), "unknown"),
    created_at: toTimestampString(pickValue(input, ["created_at", "createdAt", "date", "timestamp"])),
    completed_at: toTimestampString(pickValue(input, ["completed_at", "completedAt"])),
    payload: pickValue(input, ["payload", "params", "input", "request"]),
    result: pickValue(input, ["result", "output", "details", "data"]),
  };
}

export function normalizeTasks(payload: unknown): AgentTask[] {
  const tasks = getCollection(payload, ["tasks", "data", "items", "results"]).map((task, index) =>
    normalizeTask(task, index),
  );

  return tasks.sort((left, right) => {
    const leftDate = new Date(left.created_at).getTime();
    const rightDate = new Date(right.created_at).getTime();

    if (Number.isNaN(leftDate) || Number.isNaN(rightDate)) {
      return 0;
    }

    return rightDate - leftDate;
  });
}
