import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[uuid.UUID, WebSocket] = {}
        self._lock = asyncio.Lock()

    async def connect(self, agent_id: uuid.UUID, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections[agent_id] = websocket

    async def disconnect(self, agent_id: uuid.UUID) -> None:
        async with self._lock:
            self._connections.pop(agent_id, None)

    async def dispatch_task(self, agent_id: uuid.UUID, task_data: dict[str, Any]) -> bool:
        payload = dict(task_data)
        if "id" in payload and "task_id" not in payload:
            payload["task_id"] = payload["id"]

        message = {
            "type": "new_task",
            "task": payload,
            "sent_at": utcnow().isoformat(),
        }

        return await self.send_message(agent_id, message)

    async def send_message(self, agent_id: uuid.UUID, message: dict[str, Any]) -> bool:
        async with self._lock:
            websocket = self._connections.get(agent_id)

        if websocket is None:
            return False

        try:
            await websocket.send_json(message)
        except Exception:
            await self.disconnect(agent_id)
            return False

        return True


manager = ConnectionManager()
