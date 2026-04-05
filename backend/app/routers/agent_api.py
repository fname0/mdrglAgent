import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session_maker
from app.models import Agent, AgentStatus, Task, TaskStatus
from app.remote_preview_service import normalize_preview_config, remote_preview_service
from app.routine_service import routine_service
from app.task_dispatcher import dispatch_next_pending_task
from app.schemas import (
    AgentRegisterRequest,
    AgentRegisterResponse,
    HeartbeatMessage,
    TaskResultMessage,
)
from app.ws_manager import manager

router = APIRouter(tags=["agent"])


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def get_agent(session: AsyncSession, agent_id: uuid.UUID) -> Agent | None:
    return await session.get(Agent, agent_id)


async def _fail_running_tasks(
    session: AsyncSession,
    agent_id: uuid.UUID,
    summary: str,
) -> list[uuid.UUID]:
    now = utcnow()
    running_tasks_result = await session.execute(
        select(Task).where(
            Task.agent_id == agent_id,
            Task.status == TaskStatus.running,
        )
    )
    running_tasks = list(running_tasks_result.scalars().all())

    task_ids: list[uuid.UUID] = []
    for task in running_tasks:
        task.status = TaskStatus.failed
        task.completed_at = now
        task.result = {
            "scenario": "agent_disconnect",
            "severity": "crit",
            "summary": summary,
            "facts": {
                "agent_id": str(agent_id),
            },
        }
        task_ids.append(task.id)

    return task_ids


async def set_agent_online(agent_id: uuid.UUID) -> None:
    async with async_session_maker() as session:
        agent = await get_agent(session, agent_id)
        if agent is None:
            return
        agent.status = AgentStatus.online
        agent.last_seen = utcnow()
        await session.commit()


async def set_agent_offline(agent_id: uuid.UUID) -> None:
    task_ids_needing_notifications: list[uuid.UUID] = []
    async with async_session_maker() as session:
        agent = await get_agent(session, agent_id)
        if agent is None:
            return

        agent.status = AgentStatus.offline
        task_ids_needing_notifications = await _fail_running_tasks(
            session,
            agent_id,
            "Agent disconnected before task completion",
        )

        await session.commit()

    for task_id in task_ids_needing_notifications:
        await routine_service.on_task_result(task_id)
    await remote_preview_service.on_agent_disconnected(agent_id)


async def handle_heartbeat(agent_id: uuid.UUID) -> None:
    async with async_session_maker() as session:
        agent = await get_agent(session, agent_id)
        if agent is None:
            return
        agent.last_seen = utcnow()
        agent.status = AgentStatus.online
        await session.commit()


async def handle_task_result(
    agent_id: uuid.UUID,
    task_id: uuid.UUID,
    status_value: str,
    result_payload: dict,
) -> None:
    async with async_session_maker() as session:
        task = await session.get(Task, task_id)
        if task is None or task.agent_id != agent_id:
            return

        task.status = TaskStatus(status_value)
        task.result = result_payload
        task.completed_at = utcnow()

        agent = await get_agent(session, agent_id)
        if agent:
            agent.last_seen = utcnow()
            agent.status = AgentStatus.online

        await session.commit()
        await dispatch_next_pending_task(session, agent_id)

    await routine_service.on_task_result(task_id)


@router.post("/api/agents/register", response_model=AgentRegisterResponse, status_code=status.HTTP_201_CREATED)
async def register_agent(payload: AgentRegisterRequest) -> AgentRegisterResponse:
    async with async_session_maker() as session:
        agent = Agent(
            hostname=payload.hostname,
            os=payload.os,
            ip_address=payload.ip_address,
            status=AgentStatus.offline,
            last_seen=None,
        )
        session.add(agent)
        await session.commit()
        await session.refresh(agent)
    return AgentRegisterResponse(agent_id=agent.id)


@router.websocket("/ws/agent/{agent_id}")
async def agent_ws(websocket: WebSocket, agent_id: uuid.UUID) -> None:
    async with async_session_maker() as session:
        agent = await get_agent(session, agent_id)
        if agent is None:
            await websocket.close(code=1008, reason="agent_not_registered")
            return

    await manager.connect(agent_id, websocket)
    await set_agent_online(agent_id)

    async with async_session_maker() as session:
        interrupted_task_ids = await _fail_running_tasks(
            session,
            agent_id,
            "Task interrupted by reconnect before completion",
        )
        if interrupted_task_ids:
            await session.commit()

        await dispatch_next_pending_task(session, agent_id)

    for task_id in interrupted_task_ids:
        await routine_service.on_task_result(task_id)

    try:
        while True:
            message = await websocket.receive_json()
            if not isinstance(message, dict):
                await websocket.send_json({"type": "error", "message": "Message must be JSON object"})
                continue

            try:
                message_type = message.get("type")

                if message_type == "heartbeat":
                    HeartbeatMessage.model_validate(message)
                    await handle_heartbeat(agent_id)
                    await websocket.send_json({"type": "heartbeat_ack"})
                    continue

                if message_type == "task_result":
                    task_result = TaskResultMessage.model_validate(message)
                    await handle_task_result(
                        agent_id=agent_id,
                        task_id=task_result.task_id,
                        status_value=task_result.status,
                        result_payload=task_result.result,
                    )
                    await websocket.send_json(
                        {
                            "type": "task_result_ack",
                            "task_id": str(task_result.task_id),
                        }
                    )
                    continue

                if message_type == "remote_preview_frame":
                    image_base64_raw = message.get("image_base64")
                    if isinstance(image_base64_raw, str) and image_base64_raw.strip():
                        width_raw = message.get("width")
                        height_raw = message.get("height")

                        width = int(width_raw) if isinstance(width_raw, int) else None
                        height = int(height_raw) if isinstance(height_raw, int) else None

                        captured_at_raw = message.get("captured_at")
                        captured_at = captured_at_raw if isinstance(captured_at_raw, str) else None

                        await remote_preview_service.update_frame(
                            agent_id=agent_id,
                            image_base64=image_base64_raw,
                            width=width,
                            height=height,
                            captured_at=captured_at,
                        )
                    continue

                if message_type == "remote_preview_error":
                    error_raw = message.get("error")
                    if isinstance(error_raw, str):
                        await remote_preview_service.set_error(agent_id, error_raw)
                    continue

                if message_type == "remote_preview_status":
                    active_raw = message.get("active")
                    active = bool(active_raw) if isinstance(active_raw, bool) else False
                    if active:
                        config_raw = message.get("config")
                        normalized = normalize_preview_config(config_raw if isinstance(config_raw, dict) else None)
                        await remote_preview_service.start(agent_id, normalized)
                    else:
                        await remote_preview_service.stop(agent_id)
                    continue

                if message_type == "remote_preview_input_ack":
                    continue

                await websocket.send_json({"type": "error", "message": "Unsupported message type"})
            except ValidationError as exc:
                await websocket.send_json(
                    {
                        "type": "error",
                        "message": "Validation error",
                        "details": exc.errors(),
                    }
                )
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(agent_id)
        await set_agent_offline(agent_id)
