import asyncio
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Task, TaskStatus
from app.ws_manager import manager

MAX_PENDING_TASKS_PER_AGENT = 3

_agent_dispatch_locks: dict[uuid.UUID, asyncio.Lock] = {}
_locks_guard = asyncio.Lock()


async def _get_agent_dispatch_lock(agent_id: uuid.UUID) -> asyncio.Lock:
    async with _locks_guard:
        lock = _agent_dispatch_locks.get(agent_id)
        if lock is None:
            lock = asyncio.Lock()
            _agent_dispatch_locks[agent_id] = lock
        return lock


async def count_pending_tasks(session: AsyncSession, agent_id: uuid.UUID) -> int:
    result = await session.execute(
        select(func.count(Task.id)).where(
            Task.agent_id == agent_id,
            Task.status == TaskStatus.pending,
        )
    )
    value = result.scalar_one_or_none()
    return int(value or 0)


async def dispatch_next_pending_task(session: AsyncSession, agent_id: uuid.UUID) -> bool:
    lock = await _get_agent_dispatch_lock(agent_id)

    async with lock:
        running_result = await session.execute(
            select(Task.id)
            .where(
                Task.agent_id == agent_id,
                Task.status == TaskStatus.running,
            )
            .limit(1)
        )
        if running_result.scalar_one_or_none() is not None:
            return False

        pending_result = await session.execute(
            select(Task)
            .where(
                Task.agent_id == agent_id,
                Task.status == TaskStatus.pending,
            )
            .order_by(Task.created_at.asc())
            .limit(1)
        )
        pending_task = pending_result.scalar_one_or_none()
        if pending_task is None:
            return False

        dispatched = await manager.dispatch_task(
            agent_id,
            {
                "id": str(pending_task.id),
                "task_type": pending_task.task_type,
                "payload": pending_task.payload,
                "created_at": pending_task.created_at.isoformat(),
            },
        )
        if not dispatched:
            return False

        pending_task.status = TaskStatus.running
        await session.commit()
        return True
