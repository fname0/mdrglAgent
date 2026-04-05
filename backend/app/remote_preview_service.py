import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any

DEFAULT_PREVIEW_FPS = 2
DEFAULT_PREVIEW_MAX_WIDTH = 1280
DEFAULT_PREVIEW_JPEG_QUALITY = 50

MIN_PREVIEW_FPS = 1
MAX_PREVIEW_FPS = 10

MIN_PREVIEW_MAX_WIDTH = 320
MAX_PREVIEW_MAX_WIDTH = 2560

MIN_PREVIEW_JPEG_QUALITY = 20
MAX_PREVIEW_JPEG_QUALITY = 90

MAX_FRAME_BASE64_CHARS = 4_000_000


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed


def normalize_preview_config(raw: dict[str, Any] | None) -> dict[str, int]:
    payload = raw or {}

    fps = _to_int(payload.get("fps"), DEFAULT_PREVIEW_FPS)
    max_width = _to_int(payload.get("max_width"), DEFAULT_PREVIEW_MAX_WIDTH)
    jpeg_quality = _to_int(payload.get("jpeg_quality"), DEFAULT_PREVIEW_JPEG_QUALITY)

    return {
        "fps": max(MIN_PREVIEW_FPS, min(fps, MAX_PREVIEW_FPS)),
        "max_width": max(MIN_PREVIEW_MAX_WIDTH, min(max_width, MAX_PREVIEW_MAX_WIDTH)),
        "jpeg_quality": max(MIN_PREVIEW_JPEG_QUALITY, min(jpeg_quality, MAX_PREVIEW_JPEG_QUALITY)),
    }


class RemotePreviewService:
    def __init__(self) -> None:
        self._states: dict[uuid.UUID, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    def _get_or_create_state(self, agent_id: uuid.UUID) -> dict[str, Any]:
        state = self._states.get(agent_id)
        if state is not None:
            return state

        state = {
            "active": False,
            "fps": DEFAULT_PREVIEW_FPS,
            "max_width": DEFAULT_PREVIEW_MAX_WIDTH,
            "jpeg_quality": DEFAULT_PREVIEW_JPEG_QUALITY,
            "last_error": None,
            "last_frame_base64": None,
            "last_frame_captured_at": None,
            "last_frame_width": None,
            "last_frame_height": None,
            "updated_at": utc_now_iso(),
        }
        self._states[agent_id] = state
        return state

    @staticmethod
    def _status_payload(agent_id: uuid.UUID, state: dict[str, Any]) -> dict[str, Any]:
        return {
            "agent_id": agent_id,
            "active": bool(state.get("active")),
            "fps": int(state.get("fps") or DEFAULT_PREVIEW_FPS),
            "max_width": int(state.get("max_width") or DEFAULT_PREVIEW_MAX_WIDTH),
            "jpeg_quality": int(state.get("jpeg_quality") or DEFAULT_PREVIEW_JPEG_QUALITY),
            "has_frame": bool(state.get("last_frame_base64")),
            "last_frame_captured_at": state.get("last_frame_captured_at"),
            "last_frame_width": state.get("last_frame_width"),
            "last_frame_height": state.get("last_frame_height"),
            "last_error": state.get("last_error"),
            "updated_at": state.get("updated_at"),
        }

    async def start(self, agent_id: uuid.UUID, config: dict[str, int]) -> dict[str, Any]:
        async with self._lock:
            state = self._get_or_create_state(agent_id)
            state["active"] = True
            state["fps"] = config["fps"]
            state["max_width"] = config["max_width"]
            state["jpeg_quality"] = config["jpeg_quality"]
            state["last_error"] = None
            state["updated_at"] = utc_now_iso()
            return self._status_payload(agent_id, state)

    async def stop(self, agent_id: uuid.UUID) -> dict[str, Any]:
        async with self._lock:
            state = self._get_or_create_state(agent_id)
            state["active"] = False
            state["updated_at"] = utc_now_iso()
            return self._status_payload(agent_id, state)

    async def set_error(self, agent_id: uuid.UUID, error_text: str) -> None:
        async with self._lock:
            state = self._get_or_create_state(agent_id)
            state["last_error"] = error_text.strip() or "unknown_error"
            state["updated_at"] = utc_now_iso()

    async def update_frame(
        self,
        agent_id: uuid.UUID,
        *,
        image_base64: str,
        width: int | None,
        height: int | None,
        captured_at: str | None,
    ) -> None:
        normalized_image = image_base64.strip()
        if not normalized_image:
            return

        async with self._lock:
            state = self._get_or_create_state(agent_id)

            if len(normalized_image) > MAX_FRAME_BASE64_CHARS:
                state["last_error"] = "Frame is too large"
                state["updated_at"] = utc_now_iso()
                return

            state["active"] = True
            state["last_frame_base64"] = normalized_image
            state["last_frame_width"] = width
            state["last_frame_height"] = height
            state["last_frame_captured_at"] = captured_at or utc_now_iso()
            state["last_error"] = None
            state["updated_at"] = utc_now_iso()

    async def get_status(self, agent_id: uuid.UUID) -> dict[str, Any]:
        async with self._lock:
            state = self._get_or_create_state(agent_id)
            return self._status_payload(agent_id, state)

    async def get_frame(self, agent_id: uuid.UUID) -> dict[str, Any]:
        async with self._lock:
            state = self._get_or_create_state(agent_id)
            payload = self._status_payload(agent_id, state)
            payload["image_base64"] = state.get("last_frame_base64")
            return payload

    async def on_agent_disconnected(self, agent_id: uuid.UUID) -> None:
        async with self._lock:
            state = self._states.get(agent_id)
            if state is None:
                return
            state["active"] = False
            state["last_error"] = "Agent disconnected"
            state["updated_at"] = utc_now_iso()


remote_preview_service = RemotePreviewService()
