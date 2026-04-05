import axios from "axios";
import { TOKEN_STORAGE_KEY } from "@/lib/auth";
import { Agent, AgentTask, TaskType, normalizeAgents, normalizeTask, normalizeTasks } from "@/lib/types";

interface TcpConnectCheckPayload {
  host: string;
  port: number;
  timeout_seconds: number;
}

interface HttpCheckPayload {
  url: string;
  timeout_seconds: number;
  expected_statuses?: number[];
}

interface ServiceStatusCheckPayload {
  service_name: string;
  expected_state?: "running" | "stopped" | "paused";
  require_enabled?: boolean;
}

interface ProcessPresenceCheckPayload {
  process_name: string;
  cmdline_contains?: string;
  expected_min_count?: number;
  expected_max_count?: number;
}

interface PortOwnerCheckPayload {
  port: number;
  protocol?: "tcp" | "udp";
  expected_process_name?: string;
}

interface ProcessResourceSnapshotPayload {
  pid?: number;
  process_name?: string;
  cmdline_contains?: string;
  sample_seconds?: number;
  cpu_warn_percent?: number;
  rss_warn_mb?: number;
}

interface ProcessPortInventoryPayload {
  process_patterns: string[];
}

interface DockerRuntimeAccessCheckPayload {
  [key: string]: never;
}

interface DockerContainerStatusCheckPayload {
  container_name?: string;
  container_id?: string;
  expected_state?: "running" | "exited" | "paused" | "restarting" | "created" | "dead";
  require_healthy?: boolean;
}

interface DockerComposeStackCheckPayload {
  project_name: string;
  expected_services?: string[];
}

interface DockerPortMappingCheckPayload {
  container_name?: string;
  container_id?: string;
  host_port: number;
  expected_container_port?: number;
  protocol?: "tcp" | "udp";
}

interface CustomScenarioTaskPayload {
  scenario_id: string;
}

export type CustomScenarioShell = "bash" | "sh" | "powershell" | "cmd";

export interface CustomScenarioStep {
  shell: CustomScenarioShell;
  command: string;
}

export interface TelegramStatus {
  linked: boolean;
  bot_url: string;
  telegram_username: string | null;
  telegram_full_name: string | null;
  chat_id_masked: string | null;
  linked_at: string;
}

export interface TelegramRegistrationStart {
  linked: boolean;
  registration_url: string | null;
  expires_at: string;
}

export interface RemotePreviewStartPayload {
  fps?: number;
  max_width?: number;
  jpeg_quality?: number;
}

export interface RemotePreviewStatus {
  agent_id: string;
  active: boolean;
  fps: number;
  max_width: number;
  jpeg_quality: number;
  has_frame: boolean;
  last_frame_captured_at: string;
  last_frame_width: number | null;
  last_frame_height: number | null;
  last_error: string | null;
  updated_at: string;
}

export interface RemotePreviewFrame extends RemotePreviewStatus {
  image_base64: string | null;
}

export type RemotePreviewInputPayload =
  | {
      action: "mouse_move";
      x_ratio: number;
      y_ratio: number;
    }
  | {
      action: "mouse_click";
      x_ratio: number;
      y_ratio: number;
      button?: "left" | "right" | "middle";
    }
  | {
      action: "key_tap";
      key: string;
    }
  | {
      action: "text_input";
      text: string;
    };

export interface RemotePreviewInputResult {
  agent_id: string;
  accepted: boolean;
  detail: string;
}

export interface RoutineTaskRecord {
  id: string;
  agent_id: string;
  task_type: string;
  payload: unknown;
  interval_minutes: number;
  enabled: boolean;
  notify_on_warn: boolean;
  notify_on_crit: boolean;
  next_run_at: string;
  last_run_at: string;
  last_task_id: string;
  created_at: string;
  updated_at: string;
  last_task_status: string;
  last_task_severity: string;
  last_task_summary: string;
}

export interface ScheduledTaskRecord {
  id: string;
  agent_id: string;
  task_type: string;
  payload: unknown;
  run_at: string;
  dispatched_at: string;
  last_task_id: string;
  created_at: string;
  updated_at: string;
  last_task_status: string;
  last_task_severity: string;
  last_task_summary: string;
}

export interface CustomScenarioRecord {
  id: string;
  name: string;
  description: string | null;
  timeout_seconds: number;
  stop_on_error: boolean;
  is_active: boolean;
  linux_steps: CustomScenarioStep[];
  windows_steps: CustomScenarioStep[];
  created_at: string;
  updated_at: string;
}

export interface CreateCustomScenarioPayload {
  name: string;
  description?: string;
  timeout_seconds: number;
  stop_on_error: boolean;
  is_active: boolean;
  linux_steps: CustomScenarioStep[];
  windows_steps: CustomScenarioStep[];
}

export interface UpdateCustomScenarioPayload {
  name?: string;
  description?: string;
  timeout_seconds?: number;
  stop_on_error?: boolean;
  is_active?: boolean;
  linux_steps?: CustomScenarioStep[];
  windows_steps?: CustomScenarioStep[];
}

export type ScenarioGenerationStage = "insufficient_context" | "clarification" | "proposal";

export interface ScenarioGenerationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ScenarioGenerationStep {
  command: string;
  explanation: string;
}

export interface ScenarioGenerationRequest {
  name: string;
  description?: string;
  linux_shell_preference: "bash" | "sh";
  windows_shell_preference: "powershell" | "cmd";
  messages: ScenarioGenerationMessage[];
}

export interface ScenarioGenerationResponse {
  stage: ScenarioGenerationStage;
  assistant_message: string;
  understanding: string | null;
  questions: string[];
  linux_shell: "bash" | "sh" | null;
  windows_shell: "powershell" | "cmd" | null;
  linux_steps: ScenarioGenerationStep[];
  windows_steps: ScenarioGenerationStep[];
}

export type CreateTaskPayload =
  | {
      agent_id: string;
      task_type: "agent_snapshot";
      payload: Record<string, never>;
    }
  | {
      agent_id: string;
      task_type: "tcp_connect_check";
      payload: TcpConnectCheckPayload;
    }
  | {
      agent_id: string;
      task_type: "http_check";
      payload: HttpCheckPayload;
    }
  | {
      agent_id: string;
      task_type: "list_listening_ports";
      payload: Record<string, never>;
    }
  | {
      agent_id: string;
      task_type: "process_port_inventory";
      payload: ProcessPortInventoryPayload;
    }
  | {
      agent_id: string;
      task_type: "custom_scenario";
      payload: CustomScenarioTaskPayload;
    }
  | {
      agent_id: string;
      task_type: "service_status_check";
      payload: ServiceStatusCheckPayload;
    }
  | {
      agent_id: string;
      task_type: "process_presence_check";
      payload: ProcessPresenceCheckPayload;
    }
  | {
      agent_id: string;
      task_type: "port_owner_check";
      payload: PortOwnerCheckPayload;
    }
  | {
      agent_id: string;
      task_type: "process_resource_snapshot";
      payload: ProcessResourceSnapshotPayload;
    }
  | {
      agent_id: string;
      task_type: "docker_runtime_access_check";
      payload: DockerRuntimeAccessCheckPayload;
    }
  | {
      agent_id: string;
      task_type: "docker_container_status_check";
      payload: DockerContainerStatusCheckPayload;
    }
  | {
      agent_id: string;
      task_type: "docker_compose_stack_check";
      payload: DockerComposeStackCheckPayload;
    }
  | {
      agent_id: string;
      task_type: "docker_port_mapping_check";
      payload: DockerPortMappingCheckPayload;
    };

export interface CreateRoutineTaskPayload {
  agent_id: string;
  task_type: TaskType;
  payload: Record<string, unknown>;
  interval_minutes: number;
  notify_on_warn: boolean;
  notify_on_crit: boolean;
}

export interface CreateScheduledTaskPayload {
  agent_id: string;
  task_type: TaskType;
  payload: Record<string, unknown>;
  run_in_minutes: number;
}

export interface UpdateRoutineTaskPayload {
  enabled?: boolean;
  interval_minutes?: number;
  notify_on_warn?: boolean;
  notify_on_crit?: boolean;
}

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000",
  timeout: 15000,
});

const SCENARIO_GENERATION_TIMEOUT_MS = 120000;

api.interceptors.request.use((config) => {
  if (typeof window === "undefined") {
    return config;
  }

  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (token) {
    config.headers = config.headers ?? {};
    (config.headers as Record<string, string>).Authorization = `Bearer ${token}`;
  }

  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isAxiosError(error) && error.response?.status === 401 && typeof window !== "undefined") {
      localStorage.removeItem(TOKEN_STORAGE_KEY);

      if (window.location.pathname !== "/login") {
        const nextPath = `${window.location.pathname}${window.location.search}`;
        window.location.href = `/login?next=${encodeURIComponent(nextPath)}`;
      }
    }

    return Promise.reject(error);
  },
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStatus(error: unknown): number | undefined {
  if (axios.isAxiosError(error)) {
    return error.response?.status;
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

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return fallback;
}

function toBooleanSafe(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return fallback;
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

function extractToken(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const direct = [payload.access_token, payload.token, payload.jwt];

  for (const value of direct) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  const nested = isRecord(payload.data) ? payload.data : null;
  if (!nested) {
    return null;
  }

  const nestedValues = [nested.access_token, nested.token, nested.jwt];
  for (const value of nestedValues) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}

function normalizeTelegramStatus(payload: unknown): TelegramStatus {
  if (!isRecord(payload)) {
    return {
      linked: false,
      bot_url: "https://t.me/madrigalAgentsNotificationsBot",
      telegram_username: null,
      telegram_full_name: null,
      chat_id_masked: null,
      linked_at: "",
    };
  }

  return {
    linked: toBooleanSafe(payload.linked, false),
    bot_url: toStringSafe(payload.bot_url, "https://t.me/madrigalAgentsNotificationsBot"),
    telegram_username: toStringSafe(payload.telegram_username, "") || null,
    telegram_full_name: toStringSafe(payload.telegram_full_name, "") || null,
    chat_id_masked: toStringSafe(payload.chat_id_masked, "") || null,
    linked_at: toTimestampString(payload.linked_at),
  };
}

function normalizeTelegramRegistrationStart(payload: unknown): TelegramRegistrationStart {
  if (!isRecord(payload)) {
    return {
      linked: false,
      registration_url: null,
      expires_at: "",
    };
  }

  return {
    linked: toBooleanSafe(payload.linked, false),
    registration_url: toStringSafe(payload.registration_url, "") || null,
    expires_at: toTimestampString(payload.expires_at),
  };
}

function normalizeRemotePreviewStatus(payload: unknown): RemotePreviewStatus {
  if (!isRecord(payload)) {
    return {
      agent_id: "",
      active: false,
      fps: 2,
      max_width: 1280,
      jpeg_quality: 50,
      has_frame: false,
      last_frame_captured_at: "",
      last_frame_width: null,
      last_frame_height: null,
      last_error: null,
      updated_at: "",
    };
  }

  const widthRaw = toNumberSafe(payload.last_frame_width, Number.NaN);
  const heightRaw = toNumberSafe(payload.last_frame_height, Number.NaN);

  return {
    agent_id: toStringSafe(payload.agent_id),
    active: toBooleanSafe(payload.active, false),
    fps: Math.max(1, Math.trunc(toNumberSafe(payload.fps, 2))),
    max_width: Math.max(320, Math.trunc(toNumberSafe(payload.max_width, 1280))),
    jpeg_quality: Math.max(20, Math.trunc(toNumberSafe(payload.jpeg_quality, 50))),
    has_frame: toBooleanSafe(payload.has_frame, false),
    last_frame_captured_at: toTimestampString(payload.last_frame_captured_at),
    last_frame_width: Number.isFinite(widthRaw) ? Math.trunc(widthRaw) : null,
    last_frame_height: Number.isFinite(heightRaw) ? Math.trunc(heightRaw) : null,
    last_error: toStringSafe(payload.last_error, "") || null,
    updated_at: toTimestampString(payload.updated_at),
  };
}

function normalizeRemotePreviewFrame(payload: unknown): RemotePreviewFrame {
  const base = normalizeRemotePreviewStatus(payload);
  if (!isRecord(payload)) {
    return {
      ...base,
      image_base64: null,
    };
  }

  const imageRaw = toStringSafe(payload.image_base64, "");
  return {
    ...base,
    image_base64: imageRaw || null,
  };
}

function normalizeRemotePreviewInputResult(payload: unknown): RemotePreviewInputResult {
  if (!isRecord(payload)) {
    return {
      agent_id: "",
      accepted: false,
      detail: "invalid_response",
    };
  }

  return {
    agent_id: toStringSafe(payload.agent_id),
    accepted: toBooleanSafe(payload.accepted, false),
    detail: toStringSafe(payload.detail, ""),
  };
}

function normalizeRoutineTask(input: unknown): RoutineTaskRecord {
  if (!isRecord(input)) {
    return {
      id: "",
      agent_id: "",
      task_type: "unknown",
      payload: null,
      interval_minutes: 0,
      enabled: false,
      notify_on_warn: true,
      notify_on_crit: true,
      next_run_at: "",
      last_run_at: "",
      last_task_id: "",
      created_at: "",
      updated_at: "",
      last_task_status: "",
      last_task_severity: "",
      last_task_summary: "",
    };
  }

  return {
    id: toStringSafe(input.id),
    agent_id: toStringSafe(input.agent_id),
    task_type: toStringSafe(input.task_type, "unknown"),
    payload: input.payload ?? null,
    interval_minutes: Math.max(0, Math.trunc(toNumberSafe(input.interval_minutes, 0))),
    enabled: toBooleanSafe(input.enabled, false),
    notify_on_warn: toBooleanSafe(input.notify_on_warn, true),
    notify_on_crit: toBooleanSafe(input.notify_on_crit, true),
    next_run_at: toTimestampString(input.next_run_at),
    last_run_at: toTimestampString(input.last_run_at),
    last_task_id: toStringSafe(input.last_task_id),
    created_at: toTimestampString(input.created_at),
    updated_at: toTimestampString(input.updated_at),
    last_task_status: toStringSafe(input.last_task_status),
    last_task_severity: toStringSafe(input.last_task_severity),
    last_task_summary: toStringSafe(input.last_task_summary),
  };
}

function normalizeScheduledTask(input: unknown): ScheduledTaskRecord {
  if (!isRecord(input)) {
    return {
      id: "",
      agent_id: "",
      task_type: "unknown",
      payload: null,
      run_at: "",
      dispatched_at: "",
      last_task_id: "",
      created_at: "",
      updated_at: "",
      last_task_status: "",
      last_task_severity: "",
      last_task_summary: "",
    };
  }

  return {
    id: toStringSafe(input.id),
    agent_id: toStringSafe(input.agent_id),
    task_type: toStringSafe(input.task_type, "unknown"),
    payload: input.payload ?? null,
    run_at: toTimestampString(input.run_at),
    dispatched_at: toTimestampString(input.dispatched_at),
    last_task_id: toStringSafe(input.last_task_id),
    created_at: toTimestampString(input.created_at),
    updated_at: toTimestampString(input.updated_at),
    last_task_status: toStringSafe(input.last_task_status),
    last_task_severity: toStringSafe(input.last_task_severity),
    last_task_summary: toStringSafe(input.last_task_summary),
  };
}

function normalizeCustomScenarioStep(input: unknown): CustomScenarioStep | null {
  if (!isRecord(input)) {
    return null;
  }

  const shellRaw = toStringSafe(input.shell).toLowerCase();
  const command = toStringSafe(input.command).trim();
  if (!command) {
    return null;
  }

  if (shellRaw === "bash" || shellRaw === "sh" || shellRaw === "powershell" || shellRaw === "cmd") {
    return {
      shell: shellRaw,
      command,
    };
  }

  return null;
}

function normalizeCustomScenario(input: unknown): CustomScenarioRecord {
  if (!isRecord(input)) {
    return {
      id: "",
      name: "",
      description: null,
      timeout_seconds: 120,
      stop_on_error: true,
      is_active: true,
      linux_steps: [],
      windows_steps: [],
      created_at: "",
      updated_at: "",
    };
  }

  const linuxRaw = Array.isArray(input.linux_steps) ? input.linux_steps : [];
  const windowsRaw = Array.isArray(input.windows_steps) ? input.windows_steps : [];

  return {
    id: toStringSafe(input.id),
    name: toStringSafe(input.name),
    description: toStringSafe(input.description, "") || null,
    timeout_seconds: Math.max(1, Math.trunc(toNumberSafe(input.timeout_seconds, 120))),
    stop_on_error: toBooleanSafe(input.stop_on_error, true),
    is_active: toBooleanSafe(input.is_active, true),
    linux_steps: linuxRaw
      .map((item) => normalizeCustomScenarioStep(item))
      .filter((item): item is CustomScenarioStep => item !== null),
    windows_steps: windowsRaw
      .map((item) => normalizeCustomScenarioStep(item))
      .filter((item): item is CustomScenarioStep => item !== null),
    created_at: toTimestampString(input.created_at),
    updated_at: toTimestampString(input.updated_at),
  };
}

function normalizeScenarioGenerationStep(input: unknown): ScenarioGenerationStep | null {
  if (!isRecord(input)) {
    return null;
  }

  const command = toStringSafe(input.command).trim();
  const explanation = toStringSafe(input.explanation).trim();
  if (!command || !explanation) {
    return null;
  }

  return { command, explanation };
}

function normalizeScenarioGenerationResponse(input: unknown): ScenarioGenerationResponse {
  if (!isRecord(input)) {
    throw new Error("Некорректный ответ генератора сценария.");
  }

  const stage = toStringSafe(input.stage) as ScenarioGenerationStage;
  if (stage !== "insufficient_context" && stage !== "clarification" && stage !== "proposal") {
    throw new Error("Генератор сценария вернул неизвестный stage.");
  }

  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const rawLinuxSteps = Array.isArray(input.linux_steps) ? input.linux_steps : [];
  const rawWindowsSteps = Array.isArray(input.windows_steps) ? input.windows_steps : [];

  const linuxShellRaw = toStringSafe(input.linux_shell).toLowerCase();
  const windowsShellRaw = toStringSafe(input.windows_shell).toLowerCase();

  return {
    stage,
    assistant_message: toStringSafe(input.assistant_message),
    understanding: toStringSafe(input.understanding, "") || null,
    questions: rawQuestions
      .map((item) => toStringSafe(item).trim())
      .filter((item) => item.length > 0),
    linux_shell: linuxShellRaw === "bash" || linuxShellRaw === "sh" ? linuxShellRaw : null,
    windows_shell:
      windowsShellRaw === "powershell" || windowsShellRaw === "cmd" ? windowsShellRaw : null,
    linux_steps: rawLinuxSteps
      .map((item) => normalizeScenarioGenerationStep(item))
      .filter((item): item is ScenarioGenerationStep => item !== null),
    windows_steps: rawWindowsSteps
      .map((item) => normalizeScenarioGenerationStep(item))
      .filter((item): item is ScenarioGenerationStep => item !== null),
  };
}

function normalizeScenarioGenerationError(error: unknown): string {
  const message = getApiErrorMessage(error, "Не удалось сгенерировать шаги сценария.");
  const lower = message.toLowerCase();

  const modelBusy = [
    "rate limit",
    "overloaded",
    "busy",
    "temporarily unavailable",
    "upstream",
    "timeout",
    "gateway",
    "bad gateway",
    "service unavailable",
    "no endpoints found",
    "openrouter is unavailable",
  ].some((marker) => lower.includes(marker));

  if (modelBusy) {
    return "Нейросеть сейчас занята. Перезапустите генерацию через 10-20 секунд.";
  }

  if (lower.includes("openrouter_api_key")) {
    return "На backend не настроен ключ OPENROUTER_API_KEY.";
  }

  if (lower.includes("openrouter")) {
    return "Ошибка при обращении к нейросети. Повторите попытку через несколько секунд.";
  }

  return message;
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const responseData = error.response?.data;

    if (typeof responseData === "string" && responseData.trim().length > 0) {
      return responseData;
    }

    if (isRecord(responseData)) {
      if (typeof responseData.detail === "string" && responseData.detail.trim().length > 0) {
        return responseData.detail;
      }

      if (typeof responseData.message === "string" && responseData.message.trim().length > 0) {
        return responseData.message;
      }
    }

    if (error.message) {
      return error.message;
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

export async function authenticate(username: string, password: string): Promise<string> {
  const endpoint = process.env.NEXT_PUBLIC_LOGIN_ENDPOINT ?? "/api/auth/login";

  try {
    const response = await api.post(endpoint, { username, password });
    const token = extractToken(response.data);

    if (token) {
      return token;
    }

    throw new Error("Сервер не вернул JWT токен.");
  } catch (error) {
    const status = readStatus(error);

    if (status === 401 || status === 403) {
      throw new Error("Неверный логин или пароль.");
    }

    throw new Error(getApiErrorMessage(error, "Не удалось выполнить вход."));
  }
}

export async function fetchAgents(): Promise<Agent[]> {
  const response = await api.get("/api/agents");
  return normalizeAgents(response.data);
}

export async function createTask(payload: CreateTaskPayload): Promise<string | null> {
  const response = await api.post("/api/tasks", payload);

  if (isRecord(response.data) && typeof response.data.task_id === "string") {
    return response.data.task_id;
  }

  return null;
}

export async function fetchAgentTasks(agentId: string): Promise<AgentTask[]> {
  try {
    const response = await api.get(`/api/tasks/${agentId}`);
    return normalizeTasks(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось загрузить задачи агента."));
  }
}

export async function fetchTaskById(taskId: string): Promise<AgentTask> {
  try {
    const response = await api.get(`/api/task/${taskId}`);
    return normalizeTask(response.data, 0);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось загрузить задачу."));
  }
}

export async function fetchTelegramStatus(): Promise<TelegramStatus> {
  try {
    const response = await api.get("/api/telegram/status");
    return normalizeTelegramStatus(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось получить статус Telegram."));
  }
}

export async function startTelegramRegistration(): Promise<TelegramRegistrationStart> {
  try {
    const response = await api.post("/api/telegram/registration/start", {});
    return normalizeTelegramRegistrationStart(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось создать ссылку для Telegram регистрации."));
  }
}

export async function startRemotePreview(
  agentId: string,
  payload: RemotePreviewStartPayload = {},
): Promise<RemotePreviewStatus> {
  try {
    const response = await api.post(`/api/remote-preview/${agentId}/start`, payload);
    return normalizeRemotePreviewStatus(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось запустить remote preview."));
  }
}

export async function stopRemotePreview(agentId: string): Promise<RemotePreviewStatus> {
  try {
    const response = await api.post(`/api/remote-preview/${agentId}/stop`, {});
    return normalizeRemotePreviewStatus(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось остановить remote preview."));
  }
}

export async function fetchRemotePreviewStatus(agentId: string): Promise<RemotePreviewStatus> {
  try {
    const response = await api.get(`/api/remote-preview/${agentId}/status`);
    return normalizeRemotePreviewStatus(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось получить статус remote preview."));
  }
}

export async function fetchRemotePreviewFrame(agentId: string): Promise<RemotePreviewFrame> {
  try {
    const response = await api.get(`/api/remote-preview/${agentId}/frame`);
    return normalizeRemotePreviewFrame(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось получить кадр remote preview."));
  }
}

export async function sendRemotePreviewInput(
  agentId: string,
  payload: RemotePreviewInputPayload,
): Promise<RemotePreviewInputResult> {
  try {
    const response = await api.post(`/api/remote-preview/${agentId}/input`, payload);
    return normalizeRemotePreviewInputResult(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось отправить событие управления."));
  }
}

export async function fetchRoutineTasks(agentId: string): Promise<RoutineTaskRecord[]> {
  try {
    const response = await api.get(`/api/routines/${agentId}`);
    const items = Array.isArray(response.data) ? response.data : [];
    return items.map((item) => normalizeRoutineTask(item));
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось загрузить рутинные задачи."));
  }
}

export async function createRoutineTask(payload: CreateRoutineTaskPayload): Promise<RoutineTaskRecord> {
  try {
    const response = await api.post("/api/routines", payload);
    return normalizeRoutineTask(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось создать рутинную задачу."));
  }
}

export async function updateRoutineTask(routineId: string, payload: UpdateRoutineTaskPayload): Promise<RoutineTaskRecord> {
  try {
    const response = await api.patch(`/api/routines/${routineId}`, payload);
    return normalizeRoutineTask(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось обновить рутинную задачу."));
  }
}

export async function deleteRoutineTask(routineId: string): Promise<void> {
  try {
    await api.delete(`/api/routines/${routineId}`);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось удалить рутинную задачу."));
  }
}

export async function fetchScheduledTasks(agentId: string): Promise<ScheduledTaskRecord[]> {
  try {
    const response = await api.get(`/api/scheduled/${agentId}`);
    const items = Array.isArray(response.data) ? response.data : [];
    return items.map((item) => normalizeScheduledTask(item));
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось загрузить запланированные диагностики."));
  }
}

export async function createScheduledTask(payload: CreateScheduledTaskPayload): Promise<ScheduledTaskRecord> {
  try {
    const response = await api.post("/api/scheduled", payload);
    return normalizeScheduledTask(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось запланировать диагностику."));
  }
}

export async function deleteScheduledTask(scheduleId: string): Promise<void> {
  try {
    await api.delete(`/api/scheduled/${scheduleId}`);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось удалить запланированную диагностику."));
  }
}

export async function fetchCustomScenarios(): Promise<CustomScenarioRecord[]> {
  try {
    const response = await api.get("/api/custom-scenarios");
    const items = Array.isArray(response.data) ? response.data : [];
    return items
      .map((item) => normalizeCustomScenario(item))
      .sort((left, right) => {
        const leftTime = new Date(left.created_at).getTime();
        const rightTime = new Date(right.created_at).getTime();
        return rightTime - leftTime;
      });
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось загрузить кастомные сценарии."));
  }
}

export async function createCustomScenario(payload: CreateCustomScenarioPayload): Promise<CustomScenarioRecord> {
  try {
    const response = await api.post("/api/custom-scenarios", payload);
    return normalizeCustomScenario(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось создать кастомный сценарий."));
  }
}

export async function updateCustomScenario(
  scenarioId: string,
  payload: UpdateCustomScenarioPayload,
): Promise<CustomScenarioRecord> {
  try {
    const response = await api.patch(`/api/custom-scenarios/${scenarioId}`, payload);
    return normalizeCustomScenario(response.data);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось обновить кастомный сценарий."));
  }
}

export async function deleteCustomScenario(scenarioId: string): Promise<void> {
  try {
    await api.delete(`/api/custom-scenarios/${scenarioId}`);
  } catch (error) {
    throw new Error(getApiErrorMessage(error, "Не удалось удалить кастомный сценарий."));
  }
}

export async function generateScenarioSteps(
  payload: ScenarioGenerationRequest,
): Promise<ScenarioGenerationResponse> {
  try {
    const response = await api.post("/api/custom-scenarios/generate-steps", payload, {
      timeout: SCENARIO_GENERATION_TIMEOUT_MS,
    });
    return normalizeScenarioGenerationResponse(response.data);
  } catch (error) {
    throw new Error(normalizeScenarioGenerationError(error));
  }
}
