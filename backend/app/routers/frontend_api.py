import uuid
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db_session
from app.dependencies import get_current_user
from app.models import Agent, CustomScenario, RoutineTask, ScheduledTask, Task, TaskStatus, TaskType, User, utcnow
from app.remote_preview_service import normalize_preview_config, remote_preview_service
from app.routine_service import routine_service
from app.scenario_generator_service import scenario_generator_service
from app.task_dispatcher import MAX_PENDING_TASKS_PER_AGENT, count_pending_tasks, dispatch_next_pending_task
from app.schemas import (
    AgentResponse,
    CustomScenarioCreateRequest,
    ScenarioGenerationRequest,
    ScenarioGenerationResponse,
    CustomScenarioResponse,
    CustomScenarioUpdateRequest,
    CreateTaskRequest,
    CreateTaskResponse,
    RemotePreviewFrameResponse,
    RemotePreviewInputRequest,
    RemotePreviewInputResponse,
    RemotePreviewStartRequest,
    RemotePreviewStatusResponse,
    RoutineTaskCreateRequest,
    RoutineTaskResponse,
    RoutineTaskUpdateRequest,
    ScheduledTaskCreateRequest,
    ScheduledTaskResponse,
    TaskResponse,
    TelegramRegistrationStartResponse,
    TelegramStatusResponse,
)
from app.ws_manager import manager

router = APIRouter(tags=["frontend"])


def _serialize_steps(steps: list[Any]) -> list[dict[str, str]]:
    serialized: list[dict[str, str]] = []
    for item in steps:
        if hasattr(item, "model_dump"):
            dumped = item.model_dump(mode="json")
            if isinstance(dumped, dict):
                shell = dumped.get("shell")
                command = dumped.get("command")
                if isinstance(shell, str) and isinstance(command, str):
                    serialized.append({"shell": shell, "command": command})
        elif isinstance(item, dict):
            shell = item.get("shell")
            command = item.get("command")
            if isinstance(shell, str) and isinstance(command, str):
                serialized.append({"shell": shell, "command": command})
    return serialized


async def _custom_scenario_name_exists(
    *,
    session: AsyncSession,
    user_id: int,
    scenario_name: str,
    exclude_id: uuid.UUID | None = None,
) -> bool:
    normalized_name = scenario_name.strip().lower()
    if not normalized_name:
        return False

    query = select(CustomScenario.id).where(
        CustomScenario.user_id == user_id,
        func.lower(CustomScenario.name) == normalized_name,
    )
    if exclude_id is not None:
        query = query.where(CustomScenario.id != exclude_id)

    result = await session.execute(query.limit(1))
    return result.scalar_one_or_none() is not None


async def _expand_custom_scenario_payload(
    *,
    session: AsyncSession,
    user_id: int,
    payload: dict[str, Any],
) -> dict[str, Any]:
    scenario_id_raw = payload.get("scenario_id")
    try:
        scenario_id = uuid.UUID(str(scenario_id_raw))
    except (TypeError, ValueError):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid scenario_id") from None

    scenario = await session.get(CustomScenario, scenario_id)
    if scenario is None or scenario.user_id != user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Custom scenario not found")

    if not scenario.is_active:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Custom scenario is disabled")

    return {
        "scenario_id": str(scenario.id),
        "scenario_name": scenario.name,
        "timeout_seconds": scenario.timeout_seconds,
        "stop_on_error": scenario.stop_on_error,
        "linux_steps": scenario.linux_steps,
        "windows_steps": scenario.windows_steps,
    }


def _read_task_severity(task: Task | None) -> tuple[str | None, str | None]:
    if task is None or not isinstance(task.result, dict):
        return (None, None)

    raw_severity = task.result.get("severity")
    severity = raw_severity.strip().lower() if isinstance(raw_severity, str) and raw_severity.strip() else None

    raw_summary = task.result.get("summary")
    summary = raw_summary.strip() if isinstance(raw_summary, str) and raw_summary.strip() else None

    return (severity, summary)


@router.get("/api/agents", response_model=list[AgentResponse])
async def list_agents(
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> list[AgentResponse]:
    day_start = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)

    metrics_subquery = (
        select(
            Task.agent_id.label("agent_id"),
            func.count(Task.id).label("total_runs"),
            func.avg(
                func.extract("epoch", Task.completed_at - Task.created_at),
            ).label("average_execution_seconds"),
            func.count(Task.id)
            .filter(
                and_(
                    Task.status == TaskStatus.failed,
                    Task.created_at >= day_start,
                )
            )
            .label("errors_today"),
        )
        .group_by(Task.agent_id)
        .subquery()
    )

    result = await session.execute(
        select(
            Agent,
            metrics_subquery.c.total_runs,
            metrics_subquery.c.average_execution_seconds,
            metrics_subquery.c.errors_today,
        )
        .outerjoin(metrics_subquery, metrics_subquery.c.agent_id == Agent.id)
        .order_by(Agent.hostname.asc())
    )

    response_payload: list[AgentResponse] = []
    for agent, total_runs, average_execution_seconds, errors_today in result.all():
        response_payload.append(
            AgentResponse(
                id=agent.id,
                hostname=agent.hostname,
                os=agent.os,
                ip_address=agent.ip_address,
                status=agent.status,
                last_seen=agent.last_seen,
                total_runs=int(total_runs or 0),
                average_execution_seconds=float(average_execution_seconds)
                if average_execution_seconds is not None
                else None,
                errors_today=int(errors_today or 0),
            )
        )

    return response_payload


@router.get("/api/tasks/{agent_id}", response_model=list[TaskResponse])
async def list_agent_tasks(
    agent_id: uuid.UUID,
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> list[TaskResponse]:
    result = await session.execute(
        select(Task)
        .where(Task.agent_id == agent_id)
        .order_by(Task.created_at.desc())
    )
    return list(result.scalars().all())


@router.get("/api/task/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: uuid.UUID,
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> TaskResponse:
    task = await session.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    return task


@router.post("/api/tasks", response_model=CreateTaskResponse, status_code=status.HTTP_201_CREATED)
async def create_task(
    payload: CreateTaskRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CreateTaskResponse:
    agent = await session.get(Agent, payload.agent_id)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    task_payload = payload.payload
    if payload.task_type == TaskType.custom_scenario:
        task_payload = await _expand_custom_scenario_payload(
            session=session,
            user_id=current_user.id,
            payload=payload.payload,
        )

    pending_count = await count_pending_tasks(session, payload.agent_id)
    if pending_count >= MAX_PENDING_TASKS_PER_AGENT:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Очередь агента заполнена (максимум {MAX_PENDING_TASKS_PER_AGENT} ожидающих команд).",
        )

    task = Task(
        agent_id=payload.agent_id,
        task_type=payload.task_type.value,
        payload=task_payload,
        status=TaskStatus.pending,
    )
    session.add(task)
    await session.commit()
    await session.refresh(task)

    await dispatch_next_pending_task(session, payload.agent_id)

    return CreateTaskResponse(task_id=task.id)


@router.get("/api/telegram/status", response_model=TelegramStatusResponse)
async def get_telegram_status(
    current_user: User = Depends(get_current_user),
) -> TelegramStatusResponse:
    status_payload = await routine_service.get_telegram_status(current_user.id)
    return TelegramStatusResponse.model_validate(status_payload)


@router.post("/api/telegram/registration/start", response_model=TelegramRegistrationStartResponse)
async def start_telegram_registration(
    current_user: User = Depends(get_current_user),
) -> TelegramRegistrationStartResponse:
    status_payload = await routine_service.get_telegram_status(current_user.id)
    if status_payload.get("linked"):
        return TelegramRegistrationStartResponse(
            linked=True,
            registration_url=None,
            expires_at=None,
        )

    registration_url, expires_at = await routine_service.create_registration_link(current_user.id)
    return TelegramRegistrationStartResponse(
        linked=False,
        registration_url=registration_url,
        expires_at=expires_at,
    )


@router.post("/api/custom-scenarios/generate-steps", response_model=ScenarioGenerationResponse)
async def generate_custom_scenario_steps(
    payload: ScenarioGenerationRequest,
    _: User = Depends(get_current_user),
) -> ScenarioGenerationResponse:
    return await scenario_generator_service.generate(payload)


@router.post("/api/remote-preview/{agent_id}/start", response_model=RemotePreviewStatusResponse)
async def start_remote_preview(
    agent_id: uuid.UUID,
    payload: RemotePreviewStartRequest,
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> RemotePreviewStatusResponse:
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    config = normalize_preview_config(payload.model_dump(mode="json"))
    started_payload = await remote_preview_service.start(agent_id, config)
    sent = await manager.send_message(
        agent_id,
        {
            "type": "remote_preview_start",
            "config": config,
            "sent_at": utcnow().isoformat(),
        },
    )
    if not sent:
        await remote_preview_service.set_error(agent_id, "Agent is offline")
        await remote_preview_service.stop(agent_id)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Агент офлайн: не удалось запустить remote preview.",
        )

    return RemotePreviewStatusResponse.model_validate(started_payload)


@router.post("/api/remote-preview/{agent_id}/stop", response_model=RemotePreviewStatusResponse)
async def stop_remote_preview(
    agent_id: uuid.UUID,
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> RemotePreviewStatusResponse:
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    status_payload = await remote_preview_service.stop(agent_id)
    await manager.send_message(
        agent_id,
        {
            "type": "remote_preview_stop",
            "sent_at": utcnow().isoformat(),
        },
    )
    return RemotePreviewStatusResponse.model_validate(status_payload)


@router.get("/api/remote-preview/{agent_id}/status", response_model=RemotePreviewStatusResponse)
async def get_remote_preview_status(
    agent_id: uuid.UUID,
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> RemotePreviewStatusResponse:
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    payload = await remote_preview_service.get_status(agent_id)
    return RemotePreviewStatusResponse.model_validate(payload)


@router.get("/api/remote-preview/{agent_id}/frame", response_model=RemotePreviewFrameResponse)
async def get_remote_preview_frame(
    agent_id: uuid.UUID,
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> RemotePreviewFrameResponse:
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    payload = await remote_preview_service.get_frame(agent_id)
    return RemotePreviewFrameResponse.model_validate(payload)


@router.post("/api/remote-preview/{agent_id}/input", response_model=RemotePreviewInputResponse)
async def send_remote_preview_input(
    agent_id: uuid.UUID,
    payload: RemotePreviewInputRequest,
    _: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> RemotePreviewInputResponse:
    agent = await session.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    preview_status = await remote_preview_service.get_status(agent_id)
    if not bool(preview_status.get("active")):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Remote preview не активен. Сначала запустите трансляцию.",
        )

    sent = await manager.send_message(
        agent_id,
        {
            "type": "remote_preview_input",
            "input": payload.model_dump(mode="json"),
            "sent_at": utcnow().isoformat(),
        },
    )
    if not sent:
        await remote_preview_service.set_error(agent_id, "Agent is offline")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Агент офлайн: не удалось отправить событие управления.",
        )

    return RemotePreviewInputResponse(
        agent_id=agent_id,
        accepted=True,
        detail="input_sent",
    )


@router.get("/api/routines/{agent_id}", response_model=list[RoutineTaskResponse])
async def list_routines(
    agent_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> list[RoutineTaskResponse]:
    routine_result = await session.execute(
        select(RoutineTask)
        .where(
            RoutineTask.user_id == current_user.id,
            RoutineTask.agent_id == agent_id,
        )
        .order_by(RoutineTask.created_at.desc())
    )
    routines = list(routine_result.scalars().all())

    task_ids = [routine.last_task_id for routine in routines if routine.last_task_id is not None]
    task_map: dict[uuid.UUID, Task] = {}

    if task_ids:
        tasks_result = await session.execute(select(Task).where(Task.id.in_(task_ids)))
        for task in tasks_result.scalars().all():
            task_map[task.id] = task

    response_payload: list[RoutineTaskResponse] = []
    for routine in routines:
        last_task = task_map.get(routine.last_task_id) if routine.last_task_id else None
        severity, summary = _read_task_severity(last_task)

        response_payload.append(
            RoutineTaskResponse(
                id=routine.id,
                agent_id=routine.agent_id,
                task_type=routine.task_type,
                payload=routine.payload,
                interval_minutes=routine.interval_minutes,
                enabled=routine.enabled,
                notify_on_warn=routine.notify_on_warn,
                notify_on_crit=routine.notify_on_crit,
                next_run_at=routine.next_run_at,
                last_run_at=routine.last_run_at,
                last_task_id=routine.last_task_id,
                created_at=routine.created_at,
                updated_at=routine.updated_at,
                last_task_status=last_task.status.value if last_task else None,
                last_task_severity=severity,
                last_task_summary=summary,
            )
        )

    return response_payload


@router.post("/api/routines", response_model=RoutineTaskResponse, status_code=status.HTTP_201_CREATED)
async def create_routine(
    payload: RoutineTaskCreateRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> RoutineTaskResponse:
    agent = await session.get(Agent, payload.agent_id)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    routine_payload = payload.payload
    if payload.task_type == TaskType.custom_scenario:
        routine_payload = await _expand_custom_scenario_payload(
            session=session,
            user_id=current_user.id,
            payload=payload.payload,
        )

    now = utcnow()
    routine = RoutineTask(
        user_id=current_user.id,
        agent_id=payload.agent_id,
        task_type=payload.task_type.value,
        payload=routine_payload,
        interval_minutes=payload.interval_minutes,
        enabled=True,
        notify_on_warn=payload.notify_on_warn,
        notify_on_crit=payload.notify_on_crit,
        next_run_at=now + timedelta(minutes=payload.interval_minutes),
        created_at=now,
        updated_at=now,
    )

    session.add(routine)
    await session.commit()
    await session.refresh(routine)

    return RoutineTaskResponse(
        id=routine.id,
        agent_id=routine.agent_id,
        task_type=routine.task_type,
        payload=routine.payload,
        interval_minutes=routine.interval_minutes,
        enabled=routine.enabled,
        notify_on_warn=routine.notify_on_warn,
        notify_on_crit=routine.notify_on_crit,
        next_run_at=routine.next_run_at,
        last_run_at=routine.last_run_at,
        last_task_id=routine.last_task_id,
        created_at=routine.created_at,
        updated_at=routine.updated_at,
    )


@router.patch("/api/routines/{routine_id}", response_model=RoutineTaskResponse)
async def update_routine(
    routine_id: uuid.UUID,
    payload: RoutineTaskUpdateRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> RoutineTaskResponse:
    result = await session.execute(
        select(RoutineTask).where(
            RoutineTask.id == routine_id,
            RoutineTask.user_id == current_user.id,
        )
    )
    routine = result.scalar_one_or_none()
    if routine is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Routine task not found")

    now = utcnow()

    if payload.interval_minutes is not None:
        routine.interval_minutes = payload.interval_minutes
        if routine.enabled:
            routine.next_run_at = now + timedelta(minutes=payload.interval_minutes)

    if payload.enabled is not None:
        routine.enabled = payload.enabled
        if payload.enabled:
            routine.next_run_at = now + timedelta(minutes=routine.interval_minutes)

    if payload.notify_on_warn is not None:
        routine.notify_on_warn = payload.notify_on_warn

    if payload.notify_on_crit is not None:
        routine.notify_on_crit = payload.notify_on_crit

    routine.updated_at = now

    await session.commit()
    await session.refresh(routine)

    return RoutineTaskResponse(
        id=routine.id,
        agent_id=routine.agent_id,
        task_type=routine.task_type,
        payload=routine.payload,
        interval_minutes=routine.interval_minutes,
        enabled=routine.enabled,
        notify_on_warn=routine.notify_on_warn,
        notify_on_crit=routine.notify_on_crit,
        next_run_at=routine.next_run_at,
        last_run_at=routine.last_run_at,
        last_task_id=routine.last_task_id,
        created_at=routine.created_at,
        updated_at=routine.updated_at,
    )


@router.delete("/api/routines/{routine_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_routine(
    routine_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    result = await session.execute(
        select(RoutineTask).where(
            RoutineTask.id == routine_id,
            RoutineTask.user_id == current_user.id,
        )
    )
    routine = result.scalar_one_or_none()
    if routine is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Routine task not found")

    await session.delete(routine)
    await session.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/api/scheduled/{agent_id}", response_model=list[ScheduledTaskResponse])
async def list_scheduled_tasks(
    agent_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> list[ScheduledTaskResponse]:
    scheduled_result = await session.execute(
        select(ScheduledTask)
        .where(
            ScheduledTask.user_id == current_user.id,
            ScheduledTask.agent_id == agent_id,
        )
        .order_by(ScheduledTask.created_at.desc())
    )
    scheduled_items = list(scheduled_result.scalars().all())

    task_ids = [item.last_task_id for item in scheduled_items if item.last_task_id is not None]
    task_map: dict[uuid.UUID, Task] = {}

    if task_ids:
        tasks_result = await session.execute(select(Task).where(Task.id.in_(task_ids)))
        for task in tasks_result.scalars().all():
            task_map[task.id] = task

    response_payload: list[ScheduledTaskResponse] = []
    for item in scheduled_items:
        last_task = task_map.get(item.last_task_id) if item.last_task_id else None
        severity, summary = _read_task_severity(last_task)

        response_payload.append(
            ScheduledTaskResponse(
                id=item.id,
                agent_id=item.agent_id,
                task_type=item.task_type,
                payload=item.payload,
                run_at=item.run_at,
                dispatched_at=item.dispatched_at,
                last_task_id=item.last_task_id,
                created_at=item.created_at,
                updated_at=item.updated_at,
                last_task_status=last_task.status.value if last_task else None,
                last_task_severity=severity,
                last_task_summary=summary,
            )
        )

    return response_payload


@router.post("/api/scheduled", response_model=ScheduledTaskResponse, status_code=status.HTTP_201_CREATED)
async def create_scheduled_task(
    payload: ScheduledTaskCreateRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> ScheduledTaskResponse:
    agent = await session.get(Agent, payload.agent_id)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")

    scheduled_payload = payload.payload
    if payload.task_type == TaskType.custom_scenario:
        scheduled_payload = await _expand_custom_scenario_payload(
            session=session,
            user_id=current_user.id,
            payload=payload.payload,
        )

    now = utcnow()
    scheduled = ScheduledTask(
        user_id=current_user.id,
        agent_id=payload.agent_id,
        task_type=payload.task_type.value,
        payload=scheduled_payload,
        run_at=now + timedelta(minutes=payload.run_in_minutes),
        created_at=now,
        updated_at=now,
    )

    session.add(scheduled)
    await session.commit()
    await session.refresh(scheduled)

    return ScheduledTaskResponse(
        id=scheduled.id,
        agent_id=scheduled.agent_id,
        task_type=scheduled.task_type,
        payload=scheduled.payload,
        run_at=scheduled.run_at,
        dispatched_at=scheduled.dispatched_at,
        last_task_id=scheduled.last_task_id,
        created_at=scheduled.created_at,
        updated_at=scheduled.updated_at,
    )


@router.delete("/api/scheduled/{scheduled_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_scheduled_task(
    scheduled_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    result = await session.execute(
        select(ScheduledTask).where(
            ScheduledTask.id == scheduled_id,
            ScheduledTask.user_id == current_user.id,
        )
    )
    scheduled = result.scalar_one_or_none()
    if scheduled is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Scheduled task not found")

    await session.delete(scheduled)
    await session.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/api/custom-scenarios", response_model=list[CustomScenarioResponse])
async def list_custom_scenarios(
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> list[CustomScenarioResponse]:
    result = await session.execute(
        select(CustomScenario)
        .where(CustomScenario.user_id == current_user.id)
        .order_by(CustomScenario.created_at.desc())
    )
    items = list(result.scalars().all())

    return [
        CustomScenarioResponse(
            id=item.id,
            name=item.name,
            description=item.description,
            timeout_seconds=item.timeout_seconds,
            stop_on_error=item.stop_on_error,
            is_active=item.is_active,
            linux_steps=item.linux_steps,
            windows_steps=item.windows_steps,
            created_at=item.created_at,
            updated_at=item.updated_at,
        )
        for item in items
    ]


@router.post("/api/custom-scenarios", response_model=CustomScenarioResponse, status_code=status.HTTP_201_CREATED)
async def create_custom_scenario(
    payload: CustomScenarioCreateRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CustomScenarioResponse:
    if await _custom_scenario_name_exists(
        session=session,
        user_id=current_user.id,
        scenario_name=payload.name,
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Custom scenario with this name already exists",
        )

    now = utcnow()
    scenario = CustomScenario(
        user_id=current_user.id,
        name=payload.name,
        description=payload.description,
        timeout_seconds=payload.timeout_seconds,
        stop_on_error=payload.stop_on_error,
        is_active=payload.is_active,
        linux_steps=_serialize_steps(payload.linux_steps),
        windows_steps=_serialize_steps(payload.windows_steps),
        created_at=now,
        updated_at=now,
    )
    session.add(scenario)
    await session.commit()
    await session.refresh(scenario)

    return CustomScenarioResponse(
        id=scenario.id,
        name=scenario.name,
        description=scenario.description,
        timeout_seconds=scenario.timeout_seconds,
        stop_on_error=scenario.stop_on_error,
        is_active=scenario.is_active,
        linux_steps=scenario.linux_steps,
        windows_steps=scenario.windows_steps,
        created_at=scenario.created_at,
        updated_at=scenario.updated_at,
    )


@router.patch("/api/custom-scenarios/{scenario_id}", response_model=CustomScenarioResponse)
async def update_custom_scenario(
    scenario_id: uuid.UUID,
    payload: CustomScenarioUpdateRequest,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> CustomScenarioResponse:
    result = await session.execute(
        select(CustomScenario).where(
            CustomScenario.id == scenario_id,
            CustomScenario.user_id == current_user.id,
        )
    )
    scenario = result.scalar_one_or_none()
    if scenario is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Custom scenario not found")

    if payload.name is not None:
        if await _custom_scenario_name_exists(
            session=session,
            user_id=current_user.id,
            scenario_name=payload.name,
            exclude_id=scenario.id,
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Custom scenario with this name already exists",
            )
        scenario.name = payload.name
    if payload.description is not None:
        scenario.description = payload.description
    if payload.timeout_seconds is not None:
        scenario.timeout_seconds = payload.timeout_seconds
    if payload.stop_on_error is not None:
        scenario.stop_on_error = payload.stop_on_error
    if payload.is_active is not None:
        scenario.is_active = payload.is_active

    next_linux_steps = scenario.linux_steps
    if payload.linux_steps is not None:
        next_linux_steps = _serialize_steps(payload.linux_steps)

    next_windows_steps = scenario.windows_steps
    if payload.windows_steps is not None:
        next_windows_steps = _serialize_steps(payload.windows_steps)

    if not next_linux_steps and not next_windows_steps:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one step must remain for linux_steps or windows_steps",
        )

    scenario.linux_steps = next_linux_steps
    scenario.windows_steps = next_windows_steps
    scenario.updated_at = utcnow()

    await session.commit()
    await session.refresh(scenario)

    return CustomScenarioResponse(
        id=scenario.id,
        name=scenario.name,
        description=scenario.description,
        timeout_seconds=scenario.timeout_seconds,
        stop_on_error=scenario.stop_on_error,
        is_active=scenario.is_active,
        linux_steps=scenario.linux_steps,
        windows_steps=scenario.windows_steps,
        created_at=scenario.created_at,
        updated_at=scenario.updated_at,
    )


@router.delete("/api/custom-scenarios/{scenario_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_custom_scenario(
    scenario_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> Response:
    result = await session.execute(
        select(CustomScenario).where(
            CustomScenario.id == scenario_id,
            CustomScenario.user_id == current_user.id,
        )
    )
    scenario = result.scalar_one_or_none()
    if scenario is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Custom scenario not found")

    await session.delete(scenario)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
