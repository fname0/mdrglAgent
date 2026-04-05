import json
import os
from pathlib import Path
from typing import Any
from urllib import error as urllib_error
from urllib import request as urllib_request

from fastapi import HTTPException, status

from app.schemas import ScenarioGenerationRequest, ScenarioGenerationResponse

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_OPENROUTER_MODEL = "qwen/qwen3.6-plus:free"
DEFAULT_OPENROUTER_TIMEOUT_SECONDS = 90


class ScenarioGeneratorService:
    def __init__(self) -> None:
        self._env_file_values = self._read_env_file_values(Path(__file__).with_name(".env"))

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
            normalized_key = key.strip()
            normalized_value = value.strip().strip('"').strip("'")
            if normalized_key:
                parsed[normalized_key] = normalized_value

        return parsed

    def _read_setting(self, name: str, default: str = "") -> str:
        return os.getenv(name, self._env_file_values.get(name, default)).strip()

    @staticmethod
    def _build_model_candidates(model: str) -> list[str]:
        candidates: list[str] = []

        def append(value: str) -> None:
            normalized = value.strip()
            if normalized and normalized not in candidates:
                candidates.append(normalized)

        append(model)
        if ":" not in model:
            append(f"{model}:free")

        if model == "qwen/qwen3.6-plus":
            append("qwen/qwen3.6-plus:free")

        return candidates or [DEFAULT_OPENROUTER_MODEL]

    @staticmethod
    def _read_timeout_seconds(raw_value: str) -> int:
        if not raw_value:
            return DEFAULT_OPENROUTER_TIMEOUT_SECONDS
        try:
            parsed = int(raw_value)
        except ValueError:
            return DEFAULT_OPENROUTER_TIMEOUT_SECONDS
        return max(15, min(parsed, 300))

    def _build_system_prompt(self, payload: ScenarioGenerationRequest) -> str:
        description = payload.description or "не указано"
        return (
            "Ты инженерный ассистент по инфраструктурной диагностике и помогаешь составлять безопасные сценарии команд.\n\n"
            "Входные данные сценария:\n"
            f"- Название: {payload.name}\n"
            f"- Описание: {description}\n"
            f"- Предпочтительная Linux-оболочка: {payload.linux_shell_preference}\n"
            f"- Предпочтительная Windows-оболочка: {payload.windows_shell_preference}\n\n"
            "Правила:\n"
            "1. Верни только один JSON-объект. Без markdown, без code fence, без лишнего текста.\n"
            "2. Выбери ровно один этап: insufficient_context, clarification или proposal.\n"
            "3. insufficient_context используй только если даже примерно нельзя понять задачу.\n"
            "4. clarification используй, если общий смысл понятен, но нужны уточнения.\n"
            "5. proposal используй, когда можешь выдать практические команды.\n"
            "6. Предпочитай безопасные read-only диагностики. Не предлагай разрушительные или необратимые команды.\n"
            "7. Команды должны быть реалистичными и подходящими под платформу.\n"
            "8. Для proposal дай краткое понятное объяснение каждой команды.\n"
            "9. Соблюдай указанные shell preferences, если нет явной причины иначе.\n"
            "10. Все user-facing тексты в JSON должны быть на русском языке: assistant_message, understanding, questions, explanation.\n\n"
            "JSON-схема:\n"
            "{"
            '"stage":"insufficient_context|clarification|proposal",'
            '"assistant_message":"string",'
            '"understanding":"string|null",'
            '"questions":["string"],'
            '"linux_shell":"bash|sh|null",'
            '"windows_shell":"powershell|cmd|null",'
            '"linux_steps":[{"command":"string","explanation":"string"}],'
            '"windows_steps":[{"command":"string","explanation":"string"}]'
            "}\n"
        )

    @staticmethod
    def _extract_content(response_payload: dict[str, Any]) -> str:
        choices = response_payload.get("choices")
        if not isinstance(choices, list) or not choices:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Ответ модели не содержит choices.")

        first_choice = choices[0]
        if not isinstance(first_choice, dict):
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Некорректная структура choices в ответе модели.")

        message = first_choice.get("message")
        if not isinstance(message, dict):
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Некорректная структура message в ответе модели.")

        content = message.get("content")
        if isinstance(content, str):
            return content.strip()

        if isinstance(content, list):
            text_parts: list[str] = []
            for item in content:
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "text" and isinstance(item.get("text"), str):
                    text_parts.append(item["text"])
            if text_parts:
                return "\n".join(part.strip() for part in text_parts if part.strip())

        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Модель вернула пустой content.")

    @staticmethod
    def _extract_json_text(raw_text: str) -> str:
        stripped = raw_text.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            return stripped

        start = stripped.find("{")
        end = stripped.rfind("}")
        if start != -1 and end != -1 and end > start:
            return stripped[start : end + 1]

        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Модель вернула невалидный JSON.")

    async def generate(self, payload: ScenarioGenerationRequest) -> ScenarioGenerationResponse:
        api_key = self._read_setting("OPENROUTER_API_KEY")
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="На backend не настроен OPENROUTER_API_KEY.",
            )

        model = self._read_setting("OPENROUTER_MODEL", DEFAULT_OPENROUTER_MODEL)
        timeout_seconds = self._read_timeout_seconds(self._read_setting("OPENROUTER_TIMEOUT_SECONDS"))

        request_messages: list[dict[str, str]] = [
            {"role": "system", "content": self._build_system_prompt(payload)},
            {
                "role": "user",
                "content": (
                    "Проанализируй сценарий и продолжи диалог по правилам. "
                    "Если это первый запрос, определи: insufficient_context, clarification или proposal."
                ),
            },
        ]
        request_messages.extend(message.model_dump(mode="json") for message in payload.messages)

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "Madrigal Scenario Generator",
        }

        raw_body = ""
        last_http_error: HTTPException | None = None
        candidates = self._build_model_candidates(model)

        for candidate in candidates:
            body = {
                "model": candidate,
                "messages": request_messages,
                "temperature": 0.2,
                "max_tokens": 1600,
                "response_format": {"type": "json_object"},
            }
            request_obj = urllib_request.Request(
                url=OPENROUTER_URL,
                data=json.dumps(body).encode("utf-8"),
                headers=headers,
                method="POST",
            )

            try:
                with urllib_request.urlopen(request_obj, timeout=timeout_seconds) as response:  # nosec B310
                    raw_body = response.read().decode("utf-8")
                last_http_error = None
                break
            except urllib_error.HTTPError as exc:
                error_body = exc.read().decode("utf-8", errors="ignore")
                try:
                    parsed_error = json.loads(error_body)
                except json.JSONDecodeError:
                    parsed_error = None

                detail = "Ошибка запроса к OpenRouter."
                if isinstance(parsed_error, dict):
                    error_data = parsed_error.get("error")
                    if isinstance(error_data, dict) and isinstance(error_data.get("message"), str):
                        detail = error_data["message"].strip() or detail
                    elif isinstance(parsed_error.get("message"), str):
                        detail = parsed_error["message"].strip() or detail

                if "No endpoints found" in detail and candidate != candidates[-1]:
                    continue

                lower_detail = detail.lower()
                is_provider_busy = any(
                    marker in lower_detail
                    for marker in (
                        "rate limit",
                        "overloaded",
                        "busy",
                        "temporarily unavailable",
                        "upstream",
                        "timeout",
                        "capacity",
                    )
                )
                if is_provider_busy:
                    detail = "Нейросеть сейчас занята. Перезапустите генерацию через 10-20 секунд."

                last_http_error = HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"{detail} (model: {candidate})",
                )
                break
            except urllib_error.URLError as exc:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=(
                        "OpenRouter недоступен или не успел ответить. "
                        f"Проверьте интернет и OPENROUTER_TIMEOUT_SECONDS (сейчас {timeout_seconds}s)."
                    ),
                ) from exc

        if last_http_error is not None:
            raise last_http_error

        if not raw_body:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="OpenRouter вернул пустой ответ.",
            )

        try:
            parsed_response = json.loads(raw_body)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Некорректный ответ от OpenRouter.") from exc

        assistant_content = self._extract_content(parsed_response)
        json_text = self._extract_json_text(assistant_content)

        try:
            structured_payload = json.loads(json_text)
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Модель вернула повреждённый JSON.") from exc

        try:
            normalized = ScenarioGenerationResponse.model_validate(structured_payload)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Модель вернула неожиданный формат ответа.",
            ) from exc

        if normalized.stage == "proposal" and not normalized.linux_steps and not normalized.windows_steps:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Модель вернула proposal без шагов.",
            )

        if normalized.stage == "proposal":
            if normalized.linux_shell is None:
                normalized.linux_shell = payload.linux_shell_preference
            if normalized.windows_shell is None:
                normalized.windows_shell = payload.windows_shell_preference

        return normalized


scenario_generator_service = ScenarioGeneratorService()
