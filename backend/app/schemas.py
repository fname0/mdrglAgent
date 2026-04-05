import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, field_validator, model_validator

from app.models import AgentStatus, TaskStatus, TaskType


ROUTINE_SUPPORTED_TASK_TYPES: set[TaskType] = {
    TaskType.tcp_connect_check,
    TaskType.http_check,
    TaskType.service_status_check,
    TaskType.process_presence_check,
    TaskType.port_owner_check,
    TaskType.process_resource_snapshot,
    TaskType.docker_container_status_check,
    TaskType.docker_compose_stack_check,
    TaskType.docker_port_mapping_check,
}

SCHEDULED_SUPPORTED_TASK_TYPES: set[TaskType] = set(ROUTINE_SUPPORTED_TASK_TYPES)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1, max_length=128)


class LoginResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"


class AgentRegisterRequest(BaseModel):
    hostname: str = Field(min_length=1, max_length=255)
    os: str = Field(min_length=1, max_length=128)
    ip_address: str = Field(min_length=1, max_length=64)

    model_config = ConfigDict(extra="forbid")


class AgentRegisterResponse(BaseModel):
    agent_id: uuid.UUID


class AgentResponse(BaseModel):
    id: uuid.UUID
    hostname: str
    os: str
    ip_address: str
    status: AgentStatus
    last_seen: datetime | None
    total_runs: int = 0
    average_execution_seconds: float | None = None
    errors_today: int = 0

    model_config = ConfigDict(from_attributes=True)


class AgentSnapshotPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TcpConnectCheckPayload(BaseModel):
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(ge=1, le=65535)
    timeout_seconds: int = Field(default=3, ge=1, le=30)

    model_config = ConfigDict(extra="forbid")


class HttpCheckPayload(BaseModel):
    url: AnyHttpUrl
    timeout_seconds: int = Field(default=5, ge=1, le=30)
    expected_statuses: list[int] | None = Field(default=None, min_length=1, max_length=20)

    model_config = ConfigDict(extra="forbid")

    @field_validator("expected_statuses")
    @classmethod
    def validate_expected_statuses(cls, statuses: list[int] | None) -> list[int] | None:
        if statuses is None:
            return None

        if any(code < 100 or code > 599 for code in statuses):
            raise ValueError("Every expected status code must be in range 100..599")

        return statuses


class ListListeningPortsPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProcessPortInventoryPayload(BaseModel):
    process_patterns: list[str] = Field(
        default_factory=lambda: ["node", "postgres", "docker", "nginx", "python", "redis", "java"],
        min_length=1,
        max_length=100,
    )

    model_config = ConfigDict(extra="forbid")

    @field_validator("process_patterns")
    @classmethod
    def validate_process_patterns(cls, patterns: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()

        for raw_pattern in patterns:
            if not isinstance(raw_pattern, str):
                continue

            trimmed = raw_pattern.strip().lower()
            if not trimmed:
                continue

            if trimmed not in seen:
                seen.add(trimmed)
                normalized.append(trimmed)

        if not normalized:
            raise ValueError("process_patterns must contain at least one non-empty pattern")

        return normalized


class CustomScenarioTaskPayload(BaseModel):
    scenario_id: uuid.UUID

    model_config = ConfigDict(extra="forbid")


class ServiceStatusCheckPayload(BaseModel):
    service_name: str = Field(min_length=1, max_length=255)
    expected_state: Literal["running", "stopped", "paused"] | None = None
    require_enabled: bool | None = None

    model_config = ConfigDict(extra="forbid")


class ProcessPresenceCheckPayload(BaseModel):
    process_name: str = Field(min_length=1, max_length=255)
    cmdline_contains: str | None = Field(default=None, min_length=1, max_length=1024)
    expected_min_count: int = Field(default=1, ge=0, le=200)
    expected_max_count: int | None = Field(default=None, ge=0, le=200)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_count_bounds(self) -> "ProcessPresenceCheckPayload":
        if self.expected_max_count is not None and self.expected_max_count < self.expected_min_count:
            raise ValueError("expected_max_count must be greater than or equal to expected_min_count")

        return self


class PortOwnerCheckPayload(BaseModel):
    port: int = Field(ge=1, le=65535)
    protocol: Literal["tcp", "udp"] = "tcp"
    expected_process_name: str | None = Field(default=None, min_length=1, max_length=255)

    model_config = ConfigDict(extra="forbid")


class ProcessResourceSnapshotPayload(BaseModel):
    pid: int | None = Field(default=None, ge=1)
    process_name: str | None = Field(default=None, min_length=1, max_length=255)
    cmdline_contains: str | None = Field(default=None, min_length=1, max_length=1024)
    sample_seconds: int = Field(default=2, ge=1, le=10)
    cpu_warn_percent: float | None = Field(default=None, gt=0, le=100)
    rss_warn_mb: int | None = Field(default=None, ge=1, le=1_048_576)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_selector(self) -> "ProcessResourceSnapshotPayload":
        if self.pid is None and self.process_name is None:
            raise ValueError("Either pid or process_name must be provided")

        return self


class DockerRuntimeAccessCheckPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DockerContainerStatusCheckPayload(BaseModel):
    container_name: str | None = Field(default=None, min_length=1, max_length=255)
    container_id: str | None = Field(default=None, min_length=1, max_length=128)
    expected_state: Literal["running", "exited", "paused", "restarting", "created", "dead"] | None = None
    require_healthy: bool | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_selector(self) -> "DockerContainerStatusCheckPayload":
        if self.container_name is None and self.container_id is None:
            raise ValueError("Either container_name or container_id must be provided")

        return self


class DockerComposeStackCheckPayload(BaseModel):
    project_name: str = Field(min_length=1, max_length=255)
    expected_services: list[str] | None = Field(default=None, min_length=1, max_length=100)

    model_config = ConfigDict(extra="forbid")

    @field_validator("expected_services")
    @classmethod
    def validate_expected_services(cls, services: list[str] | None) -> list[str] | None:
        if services is None:
            return None

        normalized = [item.strip() for item in services if isinstance(item, str) and item.strip()]
        if not normalized:
            raise ValueError("expected_services must contain at least one non-empty service name")

        return normalized


class DockerPortMappingCheckPayload(BaseModel):
    container_name: str | None = Field(default=None, min_length=1, max_length=255)
    container_id: str | None = Field(default=None, min_length=1, max_length=128)
    host_port: int = Field(ge=1, le=65535)
    expected_container_port: int | None = Field(default=None, ge=1, le=65535)
    protocol: Literal["tcp", "udp"] = "tcp"

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_selector(self) -> "DockerPortMappingCheckPayload":
        if self.container_name is None and self.container_id is None:
            raise ValueError("Either container_name or container_id must be provided")

        return self


PAYLOAD_MODELS = {
    TaskType.agent_snapshot: AgentSnapshotPayload,
    TaskType.tcp_connect_check: TcpConnectCheckPayload,
    TaskType.http_check: HttpCheckPayload,
    TaskType.list_listening_ports: ListListeningPortsPayload,
    TaskType.process_port_inventory: ProcessPortInventoryPayload,
    TaskType.custom_scenario: CustomScenarioTaskPayload,
    TaskType.service_status_check: ServiceStatusCheckPayload,
    TaskType.process_presence_check: ProcessPresenceCheckPayload,
    TaskType.port_owner_check: PortOwnerCheckPayload,
    TaskType.process_resource_snapshot: ProcessResourceSnapshotPayload,
    TaskType.docker_runtime_access_check: DockerRuntimeAccessCheckPayload,
    TaskType.docker_container_status_check: DockerContainerStatusCheckPayload,
    TaskType.docker_compose_stack_check: DockerComposeStackCheckPayload,
    TaskType.docker_port_mapping_check: DockerPortMappingCheckPayload,
}


class CreateTaskRequest(BaseModel):
    agent_id: uuid.UUID
    task_type: TaskType
    payload: dict[str, Any]

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_payload_template(self) -> "CreateTaskRequest":
        payload_model = PAYLOAD_MODELS[self.task_type]
        validated_payload = payload_model.model_validate(self.payload)
        self.payload = validated_payload.model_dump(mode="json")
        return self


class CreateTaskResponse(BaseModel):
    task_id: uuid.UUID


class TaskResponse(BaseModel):
    id: uuid.UUID
    agent_id: uuid.UUID
    task_type: str
    payload: dict[str, Any]
    status: TaskStatus
    result: dict[str, Any] | None
    created_at: datetime
    completed_at: datetime | None

    model_config = ConfigDict(from_attributes=True)


class TelegramStatusResponse(BaseModel):
    linked: bool
    bot_url: str
    telegram_username: str | None = None
    telegram_full_name: str | None = None
    chat_id_masked: str | None = None
    linked_at: datetime | None = None


class TelegramRegistrationStartResponse(BaseModel):
    linked: bool
    registration_url: str | None = None
    expires_at: datetime | None = None


class RemotePreviewStartRequest(BaseModel):
    fps: int = Field(default=2, ge=1, le=10)
    max_width: int = Field(default=1280, ge=320, le=2560)
    jpeg_quality: int = Field(default=50, ge=20, le=90)

    model_config = ConfigDict(extra="forbid")


class RemotePreviewStatusResponse(BaseModel):
    agent_id: uuid.UUID
    active: bool
    fps: int
    max_width: int
    jpeg_quality: int
    has_frame: bool
    last_frame_captured_at: datetime | None = None
    last_frame_width: int | None = None
    last_frame_height: int | None = None
    last_error: str | None = None
    updated_at: datetime | None = None


class RemotePreviewFrameResponse(RemotePreviewStatusResponse):
    image_base64: str | None = None


class RemotePreviewInputRequest(BaseModel):
    action: Literal["mouse_move", "mouse_click", "key_tap", "text_input"] = "mouse_click"
    x_ratio: float | None = Field(default=None, ge=0.0, le=1.0)
    y_ratio: float | None = Field(default=None, ge=0.0, le=1.0)
    button: Literal["left", "right", "middle"] = "left"
    key: str | None = Field(default=None, min_length=1, max_length=128)
    text: str | None = Field(default=None, max_length=1000)

    model_config = ConfigDict(extra="forbid")

    @field_validator("key")
    @classmethod
    def normalize_key(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("key must not be empty")
        return normalized

    @model_validator(mode="after")
    def validate_action_payload(self) -> "RemotePreviewInputRequest":
        if self.action in {"mouse_move", "mouse_click"}:
            if self.x_ratio is None or self.y_ratio is None:
                raise ValueError("x_ratio and y_ratio are required for mouse actions")
            return self

        if self.action == "key_tap":
            if self.key is None:
                raise ValueError("key is required for key_tap action")
            return self

        if self.action == "text_input":
            if self.text is None or len(self.text) == 0:
                raise ValueError("text is required for text_input action")
            return self

        return self


class RemotePreviewInputResponse(BaseModel):
    agent_id: uuid.UUID
    accepted: bool
    detail: str


class RoutineTaskCreateRequest(BaseModel):
    agent_id: uuid.UUID
    task_type: TaskType
    payload: dict[str, Any]
    interval_minutes: int = Field(default=15, ge=1, le=1440)
    notify_on_warn: bool = True
    notify_on_crit: bool = True

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_payload_template(self) -> "RoutineTaskCreateRequest":
        if self.task_type not in ROUTINE_SUPPORTED_TASK_TYPES:
            allowed = ", ".join(sorted(item.value for item in ROUTINE_SUPPORTED_TASK_TYPES))
            raise ValueError(f"Unsupported task_type for routine task. Allowed: {allowed}")

        payload_model = PAYLOAD_MODELS[self.task_type]
        validated_payload = payload_model.model_validate(self.payload)
        self.payload = validated_payload.model_dump(mode="json")
        return self


class RoutineTaskUpdateRequest(BaseModel):
    enabled: bool | None = None
    interval_minutes: int | None = Field(default=None, ge=1, le=1440)
    notify_on_warn: bool | None = None
    notify_on_crit: bool | None = None

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_any_field(self) -> "RoutineTaskUpdateRequest":
        if (
            self.enabled is None
            and self.interval_minutes is None
            and self.notify_on_warn is None
            and self.notify_on_crit is None
        ):
            raise ValueError("At least one field must be provided")

        return self


class RoutineTaskResponse(BaseModel):
    id: uuid.UUID
    agent_id: uuid.UUID
    task_type: str
    payload: dict[str, Any]
    interval_minutes: int
    enabled: bool
    notify_on_warn: bool
    notify_on_crit: bool
    next_run_at: datetime
    last_run_at: datetime | None
    last_task_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    last_task_status: str | None = None
    last_task_severity: str | None = None
    last_task_summary: str | None = None


class ScheduledTaskCreateRequest(BaseModel):
    agent_id: uuid.UUID
    task_type: TaskType
    payload: dict[str, Any]
    run_in_minutes: int = Field(default=5, ge=1, le=1440)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def validate_payload_template(self) -> "ScheduledTaskCreateRequest":
        if self.task_type not in SCHEDULED_SUPPORTED_TASK_TYPES:
            allowed = ", ".join(sorted(item.value for item in SCHEDULED_SUPPORTED_TASK_TYPES))
            raise ValueError(f"Unsupported task_type for scheduled task. Allowed: {allowed}")

        payload_model = PAYLOAD_MODELS[self.task_type]
        validated_payload = payload_model.model_validate(self.payload)
        self.payload = validated_payload.model_dump(mode="json")
        return self


class ScheduledTaskResponse(BaseModel):
    id: uuid.UUID
    agent_id: uuid.UUID
    task_type: str
    payload: dict[str, Any]
    run_at: datetime
    dispatched_at: datetime | None
    last_task_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    last_task_status: str | None = None
    last_task_severity: str | None = None
    last_task_summary: str | None = None


class CustomScenarioStep(BaseModel):
    shell: Literal["bash", "sh", "powershell", "cmd"]
    command: str = Field(min_length=1, max_length=4000)

    model_config = ConfigDict(extra="forbid")

    @field_validator("command")
    @classmethod
    def normalize_command(cls, command: str) -> str:
        normalized = command.strip()
        if not normalized:
            raise ValueError("command must not be empty")
        return normalized


class CustomScenarioCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=1024)
    timeout_seconds: int = Field(default=120, ge=1, le=3600)
    stop_on_error: bool = True
    is_active: bool = True
    linux_steps: list[CustomScenarioStep] = Field(default_factory=list, max_length=100)
    windows_steps: list[CustomScenarioStep] = Field(default_factory=list, max_length=100)

    model_config = ConfigDict(extra="forbid")

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("name must not be empty")
        return normalized

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @model_validator(mode="after")
    def validate_steps(self) -> "CustomScenarioCreateRequest":
        if not self.linux_steps and not self.windows_steps:
            raise ValueError("At least one step must be provided for linux_steps or windows_steps")
        return self


class CustomScenarioUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=1024)
    timeout_seconds: int | None = Field(default=None, ge=1, le=3600)
    stop_on_error: bool | None = None
    is_active: bool | None = None
    linux_steps: list[CustomScenarioStep] | None = Field(default=None, max_length=100)
    windows_steps: list[CustomScenarioStep] | None = Field(default=None, max_length=100)

    model_config = ConfigDict(extra="forbid")

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("name must not be empty")
        return normalized

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @model_validator(mode="after")
    def validate_any_field(self) -> "CustomScenarioUpdateRequest":
        if (
            self.name is None
            and self.description is None
            and self.timeout_seconds is None
            and self.stop_on_error is None
            and self.is_active is None
            and self.linux_steps is None
            and self.windows_steps is None
        ):
            raise ValueError("At least one field must be provided")
        return self


class CustomScenarioResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    timeout_seconds: int
    stop_on_error: bool
    is_active: bool
    linux_steps: list[CustomScenarioStep]
    windows_steps: list[CustomScenarioStep]
    created_at: datetime
    updated_at: datetime


class ScenarioGenerationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)

    model_config = ConfigDict(extra="forbid")

    @field_validator("content")
    @classmethod
    def normalize_content(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("content must not be empty")
        return normalized


class ScenarioGenerationStep(BaseModel):
    command: str = Field(min_length=1, max_length=4000)
    explanation: str = Field(min_length=1, max_length=2000)

    model_config = ConfigDict(extra="forbid")

    @field_validator("command", "explanation")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("text value must not be empty")
        return normalized


class ScenarioGenerationRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: str | None = Field(default=None, max_length=1024)
    linux_shell_preference: Literal["bash", "sh"] = "bash"
    windows_shell_preference: Literal["powershell", "cmd"] = "powershell"
    messages: list[ScenarioGenerationMessage] = Field(default_factory=list, max_length=20)

    model_config = ConfigDict(extra="forbid")

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("name must not be empty")
        return normalized

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None


class ScenarioGenerationResponse(BaseModel):
    stage: Literal["insufficient_context", "clarification", "proposal"]
    assistant_message: str = Field(min_length=1, max_length=8000)
    understanding: str | None = Field(default=None, max_length=4000)
    questions: list[str] = Field(default_factory=list, max_length=5)
    linux_shell: Literal["bash", "sh"] | None = None
    windows_shell: Literal["powershell", "cmd"] | None = None
    linux_steps: list[ScenarioGenerationStep] = Field(default_factory=list, max_length=50)
    windows_steps: list[ScenarioGenerationStep] = Field(default_factory=list, max_length=50)

    model_config = ConfigDict(extra="forbid")

    @field_validator("assistant_message")
    @classmethod
    def normalize_assistant_message(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("assistant_message must not be empty")
        return normalized

    @field_validator("understanding")
    @classmethod
    def normalize_understanding(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("questions")
    @classmethod
    def normalize_questions(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value if isinstance(item, str) and item.strip()]
        return normalized[:5]


class HeartbeatMessage(BaseModel):
    type: Literal["heartbeat"]


class TaskResultMessage(BaseModel):
    type: Literal["task_result"]
    task_id: uuid.UUID
    status: Literal["success", "failed"]
    result: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")
