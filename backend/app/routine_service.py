import asyncio
import json
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

from sqlalchemy import select

from app.database import async_session_maker
from app.models import Agent, RoutineTask, ScheduledTask, Task, TaskStatus, TelegramBinding, TelegramRegistrationToken
from app.task_dispatcher import dispatch_next_pending_task


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def normalize_severity(value: Any) -> str:
    if not isinstance(value, str):
        return "unknown"

    normalized = value.strip().lower()
    if normalized in {"ok", "warn", "crit"}:
        return normalized

    if "warn" in normalized:
        return "warn"

    if "crit" in normalized or "error" in normalized or "fail" in normalized:
        return "crit"

    if "ok" in normalized or "success" in normalized:
        return "ok"

    return "unknown"


class RoutineService:
    def __init__(self) -> None:
        self._scheduler_task: asyncio.Task[None] | None = None
        self._telegram_task: asyncio.Task[None] | None = None
        self._running = False

        env_file_values = self._read_env_file_values(Path(__file__).with_name(".env"))

        self._bot_token = os.getenv(
            "TELEGRAM_BOT_TOKEN",
            env_file_values.get("TELEGRAM_BOT_TOKEN", ""),
        ).strip()
        self._bot_link = os.getenv(
            "TELEGRAM_BOT_LINK",
            env_file_values.get("TELEGRAM_BOT_LINK", "https://t.me/madrigalAgentsNotificationsBot"),
        ).strip()
        self._scheduler_interval_seconds = max(
            2,
            self._read_int_setting(
                "ROUTINE_SCHEDULER_INTERVAL_SECONDS",
                env_file_values,
                default=5,
            ),
        )
        self._telegram_poll_timeout_seconds = max(
            10,
            self._read_int_setting(
                "TELEGRAM_POLL_TIMEOUT_SECONDS",
                env_file_values,
                default=35,
            ),
        )

    @staticmethod
    def _read_env_file_values(path: Path) -> dict[str, str]:
        if not path.exists():
            return {}

        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return {}

        parsed: dict[str, str] = {}
        for raw_line in lines:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                parsed[key] = value

        return parsed

    @staticmethod
    def _read_int_setting(name: str, env_file_values: dict[str, str], default: int) -> int:
        raw = os.getenv(name, env_file_values.get(name, str(default))).strip()
        try:
            return int(raw)
        except ValueError:
            return default

    async def start(self) -> None:
        if self._running:
            return

        self._running = True
        self._scheduler_task = asyncio.create_task(self._scheduler_loop(), name="routine-scheduler")

        if self._bot_token:
            self._telegram_task = asyncio.create_task(self._telegram_poll_loop(), name="telegram-poller")

    async def stop(self) -> None:
        self._running = False

        tasks = [task for task in [self._scheduler_task, self._telegram_task] if task is not None]
        for task in tasks:
            task.cancel()

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        self._scheduler_task = None
        self._telegram_task = None

    async def get_telegram_status(self, user_id: int) -> dict[str, Any]:
        async with async_session_maker() as session:
            binding = await session.get(TelegramBinding, user_id)

        if binding is None:
            return {
                "linked": False,
                "bot_url": self._bot_link,
            }

        return {
            "linked": True,
            "bot_url": self._bot_link,
            "telegram_username": binding.telegram_username,
            "telegram_full_name": binding.telegram_full_name,
            "chat_id_masked": self._mask_chat_id(binding.chat_id),
            "linked_at": binding.linked_at,
        }

    async def create_registration_link(self, user_id: int) -> tuple[str, datetime]:
        token = secrets.token_urlsafe(24)
        expires_at = utcnow() + timedelta(minutes=15)

        async with async_session_maker() as session:
            active_tokens = await session.execute(
                select(TelegramRegistrationToken).where(
                    TelegramRegistrationToken.user_id == user_id,
                    TelegramRegistrationToken.consumed_at.is_(None),
                )
            )

            now = utcnow()
            for item in active_tokens.scalars().all():
                item.consumed_at = now

            session.add(
                TelegramRegistrationToken(
                    user_id=user_id,
                    token=token,
                    expires_at=expires_at,
                )
            )
            await session.commit()

        return (f"{self._bot_link}?start={token}", expires_at)

    async def on_task_result(self, task_id: uuid.UUID) -> None:
        async with async_session_maker() as session:
            task = await session.get(Task, task_id)
            if task is None or not isinstance(task.payload, dict):
                return

            scheduled_id_raw = task.payload.get("_scheduled_task_id")
            if isinstance(scheduled_id_raw, str):
                try:
                    scheduled_id = uuid.UUID(scheduled_id_raw)
                except ValueError:
                    scheduled_id = None

                if scheduled_id is not None:
                    scheduled = await session.get(ScheduledTask, scheduled_id)
                    if scheduled is None:
                        return

                    if scheduled.notified_at is not None:
                        return

                    binding = await session.get(TelegramBinding, scheduled.user_id)
                    if binding is None:
                        return

                    result_payload = task.result if isinstance(task.result, dict) else {}
                    severity = normalize_severity(result_payload.get("severity"))
                    if severity == "unknown":
                        if task.status == TaskStatus.success:
                            severity = "ok"
                        elif task.status == TaskStatus.failed:
                            severity = "crit"

                    summary = result_payload.get("summary")
                    if not isinstance(summary, str) or not summary.strip():
                        summary = f"Scenario {task.task_type} finished with {severity}"

                    agent = await session.get(Agent, task.agent_id)
                    facts = result_payload.get("facts") if isinstance(result_payload.get("facts"), dict) else {}
                    text = self._build_notification_text(
                        agent_name=agent.hostname if agent else str(task.agent_id),
                        task_type=task.task_type,
                        severity=severity,
                        summary=summary,
                        facts=facts,
                        task_id=task.id,
                    )

                    sent = await self._send_telegram_message(binding.chat_id, text)
                    if not sent:
                        return

                    now = utcnow()
                    scheduled.notified_at = now
                    scheduled.updated_at = now
                    await session.commit()
                    return

            routine_id_raw = task.payload.get("_routine_task_id")
            if not isinstance(routine_id_raw, str):
                return

            try:
                routine_id = uuid.UUID(routine_id_raw)
            except ValueError:
                return

            routine = await session.get(RoutineTask, routine_id)
            if routine is None:
                return

            result_payload = task.result if isinstance(task.result, dict) else {}
            severity = normalize_severity(result_payload.get("severity"))
            if severity not in {"warn", "crit"}:
                return

            if severity == "warn" and not routine.notify_on_warn:
                return

            if severity == "crit" and not routine.notify_on_crit:
                return

            binding = await session.get(TelegramBinding, routine.user_id)
            if binding is None:
                return

            summary = result_payload.get("summary")
            if not isinstance(summary, str) or not summary.strip():
                summary = f"Scenario {task.task_type} finished with {severity}"

            signature = f"{task.task_type}|{severity}|{summary.strip()}"
            now = utcnow()
            cooldown = timedelta(minutes=max(1, min(60, routine.interval_minutes)))
            if (
                routine.last_notified_signature == signature
                and routine.last_notified_at is not None
                and (now - routine.last_notified_at) < cooldown
            ):
                return

            agent = await session.get(Agent, task.agent_id)
            facts = result_payload.get("facts") if isinstance(result_payload.get("facts"), dict) else {}
            text = self._build_notification_text(
                agent_name=agent.hostname if agent else str(task.agent_id),
                task_type=task.task_type,
                severity=severity,
                summary=summary,
                facts=facts,
                task_id=task.id,
            )

            sent = await self._send_telegram_message(binding.chat_id, text)
            if not sent:
                return

            routine.last_notified_at = now
            routine.last_notified_signature = signature
            routine.updated_at = now
            await session.commit()

    async def _scheduler_loop(self) -> None:
        while self._running:
            try:
                await self._run_due_routines_once()
                await self._run_due_scheduled_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(1)

            await asyncio.sleep(self._scheduler_interval_seconds)

    async def _run_due_routines_once(self) -> None:
        now = utcnow()
        agent_ids_to_dispatch: set[uuid.UUID] = set()

        async with async_session_maker() as session:
            due_result = await session.execute(
                select(RoutineTask)
                .where(
                    RoutineTask.enabled.is_(True),
                    RoutineTask.next_run_at <= now,
                )
                .order_by(RoutineTask.next_run_at.asc())
                .limit(50)
            )
            due_routines = list(due_result.scalars().all())

            if not due_routines:
                return

            for routine in due_routines:
                payload = dict(routine.payload)
                payload["_routine_task_id"] = str(routine.id)

                task = Task(
                    agent_id=routine.agent_id,
                    task_type=routine.task_type,
                    payload=payload,
                    status=TaskStatus.pending,
                )
                session.add(task)
                await session.flush()

                routine.last_run_at = now
                routine.last_task_id = task.id
                routine.next_run_at = now + timedelta(minutes=routine.interval_minutes)
                routine.updated_at = now
                agent_ids_to_dispatch.add(routine.agent_id)

            await session.commit()

        for agent_id in agent_ids_to_dispatch:
            async with async_session_maker() as session:
                await dispatch_next_pending_task(session, agent_id)

    async def _run_due_scheduled_once(self) -> None:
        now = utcnow()
        agent_ids_to_dispatch: set[uuid.UUID] = set()

        async with async_session_maker() as session:
            due_result = await session.execute(
                select(ScheduledTask)
                .where(
                    ScheduledTask.dispatched_at.is_(None),
                    ScheduledTask.run_at <= now,
                )
                .order_by(ScheduledTask.run_at.asc())
                .limit(50)
            )
            due_items = list(due_result.scalars().all())

            if not due_items:
                return

            for scheduled in due_items:
                payload = dict(scheduled.payload)
                payload["_scheduled_task_id"] = str(scheduled.id)

                task = Task(
                    agent_id=scheduled.agent_id,
                    task_type=scheduled.task_type,
                    payload=payload,
                    status=TaskStatus.pending,
                )
                session.add(task)
                await session.flush()

                scheduled.dispatched_at = now
                scheduled.last_task_id = task.id
                scheduled.updated_at = now
                agent_ids_to_dispatch.add(scheduled.agent_id)

            await session.commit()

        for agent_id in agent_ids_to_dispatch:
            async with async_session_maker() as session:
                await dispatch_next_pending_task(session, agent_id)

    async def _telegram_poll_loop(self) -> None:
        offset: int | None = None

        while self._running and self._bot_token:
            try:
                payload: dict[str, Any] = {
                    "timeout": self._telegram_poll_timeout_seconds,
                    "allowed_updates": ["message"],
                }
                if offset is not None:
                    payload["offset"] = offset

                response = await asyncio.to_thread(
                    self._telegram_api_request,
                    "getUpdates",
                    payload,
                    self._telegram_poll_timeout_seconds + 10,
                )

                if not isinstance(response, dict) or not response.get("ok"):
                    await asyncio.sleep(2)
                    continue

                updates = response.get("result")
                if not isinstance(updates, list):
                    continue

                for update in updates:
                    if not isinstance(update, dict):
                        continue

                    update_id = update.get("update_id")
                    if isinstance(update_id, int):
                        offset = update_id + 1

                    await self._handle_telegram_update(update)
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(2)

    async def _handle_telegram_update(self, update: dict[str, Any]) -> None:
        message = update.get("message")
        if not isinstance(message, dict):
            return

        text = message.get("text")
        if not isinstance(text, str):
            return

        token = self._extract_start_token(text)
        if token is None:
            return

        chat = message.get("chat")
        from_user = message.get("from")
        if not isinstance(chat, dict):
            return

        chat_id_raw = chat.get("id")
        if chat_id_raw is None:
            return

        chat_id = str(chat_id_raw)

        telegram_username: str | None = None
        telegram_full_name: str | None = None

        if isinstance(from_user, dict):
            if isinstance(from_user.get("username"), str):
                telegram_username = from_user["username"]

            first_name = from_user.get("first_name")
            last_name = from_user.get("last_name")
            parts = []
            if isinstance(first_name, str) and first_name.strip():
                parts.append(first_name.strip())
            if isinstance(last_name, str) and last_name.strip():
                parts.append(last_name.strip())
            if parts:
                telegram_full_name = " ".join(parts)

        linked = await self._bind_telegram_chat(
            token=token,
            chat_id=chat_id,
            telegram_username=telegram_username,
            telegram_full_name=telegram_full_name,
        )

        if linked:
            await self._send_telegram_message(
                chat_id,
                "Madrigal: Telegram notifications are enabled for your account.",
            )
        else:
            await self._send_telegram_message(
                chat_id,
                "Madrigal: registration token is invalid or expired. Please generate a new link in the web panel.",
            )

    async def _bind_telegram_chat(
        self,
        token: str,
        chat_id: str,
        telegram_username: str | None,
        telegram_full_name: str | None,
    ) -> bool:
        now = utcnow()

        async with async_session_maker() as session:
            token_result = await session.execute(
                select(TelegramRegistrationToken).where(TelegramRegistrationToken.token == token)
            )
            token_row = token_result.scalar_one_or_none()

            if token_row is None or token_row.consumed_at is not None or token_row.expires_at <= now:
                return False

            existing_binding = await session.get(TelegramBinding, token_row.user_id)
            if existing_binding is None:
                session.add(
                    TelegramBinding(
                        user_id=token_row.user_id,
                        chat_id=chat_id,
                        telegram_username=telegram_username,
                        telegram_full_name=telegram_full_name,
                        linked_at=now,
                        updated_at=now,
                    )
                )
            else:
                existing_binding.chat_id = chat_id
                existing_binding.telegram_username = telegram_username
                existing_binding.telegram_full_name = telegram_full_name
                existing_binding.updated_at = now

            token_row.consumed_at = now
            await session.commit()

        return True

    async def _send_telegram_message(self, chat_id: str, text: str) -> bool:
        if not self._bot_token:
            return False

        response = await asyncio.to_thread(
            self._telegram_api_request,
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": text,
                "disable_web_page_preview": True,
            },
            20,
        )
        return isinstance(response, dict) and bool(response.get("ok"))

    def _telegram_api_request(self, method: str, payload: dict[str, Any], timeout_seconds: int) -> dict[str, Any] | None:
        if not self._bot_token:
            return None

        url = f"https://api.telegram.org/bot{self._bot_token}/{method}"
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
        }

        request_obj = urllib_request.Request(url=url, data=body, headers=headers, method="POST")

        try:
            with urllib_request.urlopen(request_obj, timeout=timeout_seconds) as response:  # nosec B310
                response_body = response.read().decode("utf-8")
                data = json.loads(response_body)
                if isinstance(data, dict):
                    return data
                return None
        except (urllib_error.URLError, TimeoutError, json.JSONDecodeError):
            return None

    @staticmethod
    def _extract_start_token(text: str) -> str | None:
        value = text.strip()
        if not value.startswith("/start"):
            return None

        parts = value.split(maxsplit=1)
        if len(parts) < 2:
            return None

        token = parts[1].strip()
        return token or None

    @staticmethod
    def _mask_chat_id(chat_id: str) -> str:
        if len(chat_id) <= 5:
            return "***"
        return f"{chat_id[:2]}***{chat_id[-2:]}"

    @staticmethod
    def _build_notification_text(
        agent_name: str,
        task_type: str,
        severity: str,
        summary: str,
        facts: dict[str, Any],
        task_id: uuid.UUID,
    ) -> str:
        lines = [
            "Madrigal alert",
            f"Agent: {agent_name}",
            f"Scenario: {task_type}",
            f"Severity: {severity}",
            f"Summary: {summary}",
            f"Task ID: {task_id}",
        ]

        if facts:
            key_facts = []
            for key in ["service_name", "container_name", "state", "health_status", "host", "port", "url"]:
                if key in facts:
                    key_facts.append(f"{key}={facts[key]}")
            if key_facts:
                lines.append(f"Facts: {', '.join(key_facts[:4])}")

        return "\n".join(lines)


routine_service = RoutineService()


