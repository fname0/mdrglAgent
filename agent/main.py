import asyncio
import ctypes
import ctypes.wintypes as wintypes
import json
import ipaddress
import platform
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from time import perf_counter
from typing import Any

import psutil
import requests
import websockets
from websockets.exceptions import ConnectionClosed

import base64
import io

try:
    from mss import mss as mss_factory
except Exception:
    mss_factory = None

try:
    from PIL import Image
except Exception:
    Image = None

try:
    import pyautogui
except Exception:
    pyautogui = None


CONFIG_PATH = Path("config.json")
REGISTER_URL = "http://localhost:8000/api/agents/register"
WS_URL_TEMPLATE = "ws://localhost:8000/ws/agent/{agent_id}"
RECONNECT_DELAY_SECONDS = 5
HEARTBEAT_INTERVAL_SECONDS = 10
DEFAULT_PROCESS_PATTERNS = ["node", "postgres", "docker", "nginx", "python", "redis", "java"]
DEFAULT_CUSTOM_SCENARIO_TIMEOUT_SECONDS = 120
MAX_CUSTOM_SCENARIO_OUTPUT_CHARS = 8000
DEFAULT_REMOTE_PREVIEW_FPS = 2
DEFAULT_REMOTE_PREVIEW_MAX_WIDTH = 1280
DEFAULT_REMOTE_PREVIEW_JPEG_QUALITY = 50
REMOTE_PREVIEW_IDLE_SLEEP_SECONDS = 0.2


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_config() -> dict[str, Any] | None:
    if not CONFIG_PATH.exists():
        return None

    try:
        with CONFIG_PATH.open("r", encoding="utf-8") as file_obj:
            return json.load(file_obj)
    except (json.JSONDecodeError, OSError):
        return None


def save_config(config: dict[str, Any]) -> None:
    with CONFIG_PATH.open("w", encoding="utf-8") as file_obj:
        json.dump(config, file_obj, ensure_ascii=False, indent=2)


def get_local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def register_agent() -> str:
    payload = {
        "hostname": socket.gethostname(),
        "os": platform.platform(),
        "ip_address": get_local_ip(),
    }
    response = requests.post(REGISTER_URL, json=payload, timeout=10)
    if response.status_code == 422:
        raise ValueError(f"Registration payload rejected (422): {response.text}")
    response.raise_for_status()

    data = response.json()
    agent_id = data.get("agent_id")
    if not agent_id:
        raise ValueError("Registration response does not contain agent_id")

    return str(agent_id)


async def get_or_create_agent_id() -> str:
    config = load_config()
    if config and config.get("agent_id"):
        return str(config["agent_id"])

    agent_id = await asyncio.to_thread(register_agent)
    save_config({"agent_id": agent_id})
    return agent_id


def run_command(command: list[str], timeout_seconds: int = 5) -> str:
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_seconds,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""

    return (completed.stdout or "").strip()


def parse_linux_default_gateway() -> str | None:
    output = run_command(["ip", "route"])
    for line in output.splitlines():
        line = line.strip()
        if not line.startswith("default"):
            continue

        parts = line.split()
        if "via" in parts:
            idx = parts.index("via")
            if idx + 1 < len(parts):
                return parts[idx + 1]

    return None


def parse_windows_default_gateway() -> str | None:
    command = [
        "powershell",
        "-NoProfile",
        "-Command",
        "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | "
        "Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1 -ExpandProperty NextHop)",
    ]

    output = run_command(command)
    if output:
        return output.splitlines()[0].strip()
    return None


def get_default_gateway() -> str | None:
    system_name = platform.system().lower()

    try:
        if system_name == "windows":
            return parse_windows_default_gateway()
        return parse_linux_default_gateway()
    except Exception:
        return None


def get_dns_servers() -> list[str]:
    system_name = platform.system().lower()

    if system_name == "windows":
        command = [
            "powershell",
            "-NoProfile",
            "-Command",
            "(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | "
            "Select-Object -ExpandProperty ServerAddresses) -join ','",
        ]
        output = run_command(command)
        if not output:
            return []

        return [item.strip() for item in output.split(",") if item.strip()]

    resolv_path = Path("/etc/resolv.conf")
    if not resolv_path.exists():
        return []

    servers: list[str] = []
    try:
        for line in resolv_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if not line.startswith("nameserver"):
                continue

            parts = line.split()
            if len(parts) >= 2:
                servers.append(parts[1])
    except OSError:
        return []

    return servers


def collect_interfaces() -> tuple[list[dict[str, Any]], list[str]]:
    stats_by_name = psutil.net_if_stats()
    interfaces: list[dict[str, Any]] = []
    ip_addresses: list[str] = []

    for name, addresses in psutil.net_if_addrs().items():
        iface: dict[str, Any] = {
            "name": name,
            "is_up": bool(stats_by_name.get(name).isup) if stats_by_name.get(name) else False,
            "ipv4": [],
            "ipv6": [],
            "mac_addresses": [],
        }

        for addr in addresses:
            if addr.family == socket.AF_INET:
                iface["ipv4"].append(addr.address)
                ip_addresses.append(addr.address)
                continue

            if addr.family == socket.AF_INET6:
                ip_v6 = addr.address.split("%", 1)[0]
                iface["ipv6"].append(ip_v6)
                ip_addresses.append(ip_v6)
                continue

            if getattr(psutil, "AF_LINK", object()) == addr.family:
                iface["mac_addresses"].append(addr.address)
                continue

            if platform.system().lower() == "windows" and addr.family == -1:
                iface["mac_addresses"].append(addr.address)

        interfaces.append(iface)

    deduped_ips = list(dict.fromkeys(ip_addresses))
    return interfaces, deduped_ips


def to_iso_from_epoch(epoch: float | int | None) -> str | None:
    if epoch is None:
        return None

    try:
        return datetime.fromtimestamp(float(epoch), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        return None


def parse_key_value_output(output: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for line in output.splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        parsed[key.strip()] = value.strip()
    return parsed


def to_int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def to_float_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def to_trimmed_string_or_none(value: Any) -> str | None:
    if not isinstance(value, str):
        return None

    trimmed = value.strip()
    return trimmed if trimmed else None


def normalize_cmdline(raw_cmdline: Any) -> str:
    if isinstance(raw_cmdline, list):
        return " ".join(str(part) for part in raw_cmdline if str(part).strip()).strip()

    if isinstance(raw_cmdline, str):
        return raw_cmdline.strip()

    return ""


def read_process_identity(pid: int | None) -> dict[str, Any]:
    if pid is None:
        return {
            "pid": None,
            "process_name": None,
            "exe": None,
            "cmdline": None,
            "username": None,
            "create_time": None,
        }

    try:
        process = psutil.Process(pid)
        return {
            "pid": pid,
            "process_name": process.name(),
            "exe": process.exe() if hasattr(process, "exe") else None,
            "cmdline": normalize_cmdline(process.cmdline()),
            "username": process.username(),
            "create_time": to_iso_from_epoch(process.create_time()),
        }
    except (psutil.Error, OSError):
        return {
            "pid": pid,
            "process_name": None,
            "exe": None,
            "cmdline": None,
            "username": None,
            "create_time": None,
        }


def collect_matching_processes(
    process_name: str,
    cmdline_contains: str | None,
    max_items: int = 30,
) -> tuple[int, list[dict[str, Any]]]:
    process_name_filter = process_name.strip().lower()
    cmdline_filter = (cmdline_contains or "").strip().lower()

    total = 0
    items: list[dict[str, Any]] = []

    for process in psutil.process_iter(["pid", "name", "exe", "cmdline", "username", "create_time"]):
        info = process.info
        name = str(info.get("name") or "")
        cmdline = normalize_cmdline(info.get("cmdline"))

        if process_name_filter and process_name_filter not in name.lower():
            continue

        if cmdline_filter and cmdline_filter not in cmdline.lower():
            continue

        total += 1

        if len(items) < max_items:
            items.append(
                {
                    "pid": info.get("pid"),
                    "name": name or None,
                    "exe": info.get("exe") or None,
                    "cmdline": cmdline or None,
                    "username": info.get("username") or None,
                    "create_time": to_iso_from_epoch(info.get("create_time")),
                }
            )

    return total, items


def map_service_state(raw_state: str) -> str:
    normalized = raw_state.strip().lower()
    if normalized in {"active", "running"}:
        return "running"
    if normalized in {"inactive", "stopped", "deactivating", "dead"}:
        return "stopped"
    if normalized == "paused":
        return "paused"
    if normalized == "failed":
        return "failed"
    return normalized or "unknown"


def read_linux_service_status(service_name: str) -> dict[str, Any]:
    output = run_command(
        [
            "systemctl",
            "show",
            service_name,
            "--no-page",
            "--property",
            "Id,LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStartTimestamp,FragmentPath,User",
        ],
        timeout_seconds=8,
    )

    if not output:
        return {
            "exists": False,
            "state": "unknown",
            "substate": "unknown",
            "enabled": None,
            "pid": None,
            "start_mode": None,
            "account": None,
            "binary_path": None,
            "last_state_change_at": None,
            "raw": {},
            "error": "systemctl output is empty",
        }

    parsed = parse_key_value_output(output)
    load_state = parsed.get("LoadState", "unknown").strip().lower()
    active_state = parsed.get("ActiveState", "unknown").strip().lower()
    sub_state = parsed.get("SubState", "unknown").strip().lower()
    unit_file_state = parsed.get("UnitFileState", "").strip().lower()
    main_pid = to_int_or_none(parsed.get("MainPID"))

    return {
        "exists": load_state != "not-found",
        "state": map_service_state(active_state),
        "substate": sub_state or "unknown",
        "enabled": unit_file_state in {"enabled", "enabled-runtime", "static"} if unit_file_state else None,
        "pid": main_pid if main_pid and main_pid > 0 else None,
        "start_mode": unit_file_state or None,
        "account": parsed.get("User") or None,
        "binary_path": parsed.get("FragmentPath") or None,
        "last_state_change_at": parsed.get("ExecMainStartTimestamp") or None,
        "raw": parsed,
        "error": None,
    }


def read_windows_service_status(service_name: str) -> dict[str, Any]:
    escaped_service_name = service_name.replace("'", "''")
    resolve_script = (
        "$n='"
        + escaped_service_name
        + "'; "
        "$svc = Get-Service -Name $n -ErrorAction SilentlyContinue | Select-Object -First 1; "
        "if ($null -eq $svc) { "
        "$svc = Get-Service -ErrorAction SilentlyContinue | "
        "Where-Object { $_.DisplayName -eq $n -or $_.Name -eq $n } | Select-Object -First 1 "
        "}; "
        "if ($null -eq $svc) { '' } else { "
        "[pscustomobject]@{Name=$svc.Name;DisplayName=$svc.DisplayName;Status=[string]$svc.Status} | "
        "ConvertTo-Json -Compress "
        "}"
    )

    resolved_output = run_command(["powershell", "-NoProfile", "-Command", resolve_script], timeout_seconds=8)
    if not resolved_output:
        return {
            "exists": False,
            "state": "unknown",
            "substate": "unknown",
            "enabled": None,
            "pid": None,
            "start_mode": None,
            "account": None,
            "binary_path": None,
            "last_state_change_at": None,
            "raw": {},
            "error": None,
        }

    try:
        resolved = json.loads(resolved_output)
    except json.JSONDecodeError:
        return {
            "exists": False,
            "state": "unknown",
            "substate": "unknown",
            "enabled": None,
            "pid": None,
            "start_mode": None,
            "account": None,
            "binary_path": None,
            "last_state_change_at": None,
            "raw": {},
            "error": "Failed to decode Get-Service output",
        }

    resolved_name = str(resolved.get("Name") or "").strip()
    if not resolved_name:
        return {
            "exists": False,
            "state": "unknown",
            "substate": "unknown",
            "enabled": None,
            "pid": None,
            "start_mode": None,
            "account": None,
            "binary_path": None,
            "last_state_change_at": None,
            "raw": {"resolved": resolved},
            "error": "Service name could not be resolved",
        }

    queryex_output = run_command(["sc.exe", "queryex", resolved_name], timeout_seconds=8)
    qc_output = run_command(["sc.exe", "qc", resolved_name], timeout_seconds=8)

    raw_state: str | None = None
    pid: int | None = None

    for line in queryex_output.splitlines():
        normalized = line.strip()
        if "STATE" in normalized and ":" in normalized:
            state_part = normalized.split(":", 1)[1].strip()
            state_match = re.search(r"\b([A-Z_]+)\b$", state_part)
            raw_state = state_match.group(1) if state_match else state_part
            continue

        if normalized.startswith("PID") and ":" in normalized:
            pid = to_int_or_none(normalized.split(":", 1)[1].strip())

    start_mode_raw: str | None = None
    account: str | None = None
    binary_path: str | None = None

    for line in qc_output.splitlines():
        normalized = line.strip()
        if normalized.startswith("START_TYPE") and ":" in normalized:
            part = normalized.split(":", 1)[1].strip()
            match = re.search(r"\b([A-Z_]+)\b$", part)
            start_mode_raw = match.group(1) if match else part
            continue

        if normalized.startswith("SERVICE_START_NAME") and ":" in normalized:
            account = normalized.split(":", 1)[1].strip() or None
            continue

        if normalized.startswith("BINARY_PATH_NAME") and ":" in normalized:
            binary_path = normalized.split(":", 1)[1].strip() or None

    start_mode_map = {
        "AUTO_START": "auto",
        "BOOT_START": "auto",
        "SYSTEM_START": "auto",
        "DEMAND_START": "manual",
        "DISABLED": "disabled",
    }
    start_mode = start_mode_map.get((start_mode_raw or "").upper(), (start_mode_raw or "").lower() or None)

    state_from_service = str(resolved.get("Status") or "").strip()
    state_value = map_service_state(raw_state or state_from_service)

    return {
        "exists": True,
        "state": state_value,
        "substate": (raw_state or state_from_service or "unknown").lower(),
        "enabled": start_mode != "disabled" if start_mode else None,
        "pid": pid if pid and pid > 0 else None,
        "start_mode": start_mode,
        "account": account,
        "binary_path": binary_path,
        "last_state_change_at": None,
        "raw": {
            "resolved": resolved,
            "queryex": queryex_output,
            "qc": qc_output,
        },
        "error": None,
    }


def run_command_capture(command: list[str], timeout_seconds: int = 8) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "stdout": (exc.stdout or "").strip() if isinstance(exc.stdout, str) else "",
            "stderr": (exc.stderr or "").strip() if isinstance(exc.stderr, str) else "",
            "returncode": None,
            "error": "timeout",
        }
    except OSError as exc:
        return {
            "ok": False,
            "stdout": "",
            "stderr": "",
            "returncode": None,
            "error": str(exc),
        }

    return {
        "ok": completed.returncode == 0,
        "stdout": (completed.stdout or "").strip(),
        "stderr": (completed.stderr or "").strip(),
        "returncode": completed.returncode,
        "error": None,
    }


def parse_json_object(output: str) -> dict[str, Any] | None:
    if not output.strip():
        return None

    try:
        parsed = json.loads(output)
    except json.JSONDecodeError:
        return None

    return parsed if isinstance(parsed, dict) else None


def parse_json_items(output: str) -> list[dict[str, Any]]:
    stripped = output.strip()
    if not stripped:
        return []

    items: list[dict[str, Any]] = []

    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, dict):
        return [parsed]

    if isinstance(parsed, list):
        for item in parsed:
            if isinstance(item, dict):
                items.append(item)
        return items

    for line in stripped.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed_line = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed_line, dict):
            items.append(parsed_line)

    return items


def normalize_container_name(raw_name: Any) -> str | None:
    if not isinstance(raw_name, str):
        return None
    trimmed = raw_name.strip().lstrip("/")
    return trimmed or None


def resolve_container_target(payload: dict[str, Any]) -> tuple[str | None, str | None, str | None]:
    container_name = to_trimmed_string_or_none(payload.get("container_name"))
    container_id = to_trimmed_string_or_none(payload.get("container_id"))
    target = container_id or container_name
    return container_name, container_id, target


def inspect_docker_container(target: str) -> tuple[dict[str, Any] | None, str | None]:
    inspect_result = run_command_capture(["docker", "inspect", target, "--format", "{{json .}}"], timeout_seconds=10)
    if not inspect_result["ok"]:
        error_text = inspect_result["stderr"] or inspect_result["error"] or "docker inspect failed"
        return None, str(error_text)

    inspected = parse_json_object(str(inspect_result["stdout"]))
    if inspected is None:
        return None, "Failed to decode docker inspect output"

    return inspected, None


def parse_compose_service_from_labels(labels_value: Any) -> str | None:
    if not isinstance(labels_value, str):
        return None

    match = re.search(r"(?:^|,)com\\.docker\\.compose\\.service=([^,]+)", labels_value)
    if not match:
        return None

    service = match.group(1).strip()
    return service or None


def build_result(
    scenario: str,
    severity: str,
    summary: str,
    facts: dict[str, Any],
    details: dict[str, Any],
    started_at: str,
    finished_at: str,
) -> dict[str, Any]:
    return {
        "scenario": scenario,
        "severity": severity,
        "summary": summary,
        "facts": facts,
        "details": details,
        "started_at": started_at,
        "finished_at": finished_at,
    }


def run_agent_snapshot(_: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    hostname = socket.gethostname()
    os_name = platform.system()
    os_version = f"{platform.release()} ({platform.version()})"

    interfaces, ip_addresses = collect_interfaces()
    default_gateway = get_default_gateway()
    dns_servers = get_dns_servers()

    facts = {
        "hostname": hostname,
        "os_name": os_name,
        "os_version": os_version,
        "ip_addresses": ip_addresses,
        "network_interfaces": interfaces,
        "default_gateway": default_gateway,
        "dns_servers": dns_servers,
        "last_seen_at": utc_now_iso(),
    }

    primary_ip = ip_addresses[0] if ip_addresses else "n/a"
    summary = f"Node online, interfaces={len(interfaces)}, primary_ip={primary_ip}"

    return build_result(
        scenario="agent_snapshot",
        severity="ok",
        summary=summary,
        facts=facts,
        details={"interface_count": len(interfaces)},
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def classify_connect_error(error: Exception) -> str:
    if isinstance(error, socket.timeout):
        return "timeout"

    if isinstance(error, socket.gaierror):
        return "name_resolution_failed"

    if isinstance(error, OSError):
        errno_value = error.errno
        if errno_value in {110, 10060}:
            return "timeout"
        if errno_value in {111, 61, 10061}:
            return "connection_refused"
        if errno_value in {101, 10051}:
            return "network_unreachable"
        if errno_value in {113, 10065}:
            return "host_unreachable"
        if errno_value in {13, 10013}:
            return "access_denied"

    return "connection_failed"


def run_tcp_connect_check(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    host = str(payload.get("host", "")).strip()
    if not host:
        raise ValueError("payload.host is required")

    try:
        port = int(payload.get("port"))
    except (TypeError, ValueError):
        raise ValueError("payload.port must be an integer") from None

    if port < 1 or port > 65535:
        raise ValueError("payload.port must be in range 1..65535")

    try:
        timeout_seconds = int(payload.get("timeout_seconds", 3))
    except (TypeError, ValueError):
        raise ValueError("payload.timeout_seconds must be an integer") from None

    if timeout_seconds < 1 or timeout_seconds > 30:
        raise ValueError("payload.timeout_seconds must be in range 1..30")

    try:
        addr_infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        summary = f"TCP connect failed: {host}:{port} name resolution failed"
        return build_result(
            scenario="tcp_connect_check",
            severity="crit",
            summary=summary,
            facts={
                "target_host": host,
                "target_port": port,
                "resolved_ip": None,
                "connect_success": False,
                "failure_reason": classify_connect_error(exc),
            },
            details={"error": str(exc)},
            started_at=started_at,
            finished_at=utc_now_iso(),
        )

    resolved_ip = None
    last_error: Exception | None = None

    for family, sock_type, proto, _canonname, sockaddr in addr_infos:
        resolved_ip = sockaddr[0]
        connect_started = perf_counter()
        try:
            with socket.socket(family, sock_type, proto) as sock:
                sock.settimeout(timeout_seconds)
                sock.connect(sockaddr)

            latency_ms = int((perf_counter() - connect_started) * 1000)
            summary = f"TCP connect ok: {host}:{port}"
            return build_result(
                scenario="tcp_connect_check",
                severity="ok",
                summary=summary,
                facts={
                    "target_host": host,
                    "target_port": port,
                    "resolved_ip": resolved_ip,
                    "connect_success": True,
                    "latency_ms": latency_ms,
                },
                details={"timeout_seconds": timeout_seconds},
                started_at=started_at,
                finished_at=utc_now_iso(),
            )
        except Exception as exc:  # pragma: no cover - network specific branches
            last_error = exc

    failure_reason = classify_connect_error(last_error) if last_error else "connection_failed"
    summary = f"TCP connect failed: {host}:{port} ({failure_reason})"

    return build_result(
        scenario="tcp_connect_check",
        severity="crit",
        summary=summary,
        facts={
            "target_host": host,
            "target_port": port,
            "resolved_ip": resolved_ip,
            "connect_success": False,
            "failure_reason": failure_reason,
        },
        details={"timeout_seconds": timeout_seconds, "error": str(last_error) if last_error else None},
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def classify_http_exception(error: Exception) -> str:
    if isinstance(error, requests.exceptions.Timeout):
        return "timeout"
    if isinstance(error, requests.exceptions.SSLError):
        return "tls_error"
    if isinstance(error, requests.exceptions.InvalidURL):
        return "invalid_url"
    if isinstance(error, requests.exceptions.ConnectionError):
        message = str(error).lower()
        if "name or service not known" in message or "nodename nor servname provided" in message:
            return "dns_error"
        if "getaddrinfo failed" in message:
            return "dns_error"
        return "connection_error"

    return "http_check_failed"


def run_http_check(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    url = str(payload.get("url", "")).strip()
    if not url:
        raise ValueError("payload.url is required")

    try:
        timeout_seconds = int(payload.get("timeout_seconds", 5))
    except (TypeError, ValueError):
        raise ValueError("payload.timeout_seconds must be an integer") from None

    if timeout_seconds < 1 or timeout_seconds > 30:
        raise ValueError("payload.timeout_seconds must be in range 1..30")

    expected_statuses_raw = payload.get("expected_statuses")
    expected_statuses: list[int] | None = None
    if expected_statuses_raw is not None:
        if not isinstance(expected_statuses_raw, list):
            raise ValueError("payload.expected_statuses must be an array of integers")

        expected_statuses = []
        for value in expected_statuses_raw:
            try:
                code = int(value)
            except (TypeError, ValueError):
                raise ValueError("payload.expected_statuses must contain only integers") from None

            if code < 100 or code > 599:
                raise ValueError("payload.expected_statuses values must be in range 100..599")
            expected_statuses.append(code)

    request_started = perf_counter()

    try:
        response = requests.get(url, timeout=timeout_seconds, allow_redirects=True)
    except Exception as exc:  # pragma: no cover - network specific branches
        failure_reason = classify_http_exception(exc)
        summary = f"HTTP check failed: {url} ({failure_reason})"
        return build_result(
            scenario="http_check",
            severity="crit",
            summary=summary,
            facts={
                "url": url,
                "http_status": None,
                "response_time_ms": int((perf_counter() - request_started) * 1000),
                "final_url": None,
                "failure_reason": failure_reason,
            },
            details={"error": str(exc)},
            started_at=started_at,
            finished_at=utc_now_iso(),
        )

    response_time_ms = int((perf_counter() - request_started) * 1000)
    severity = "ok"

    if expected_statuses and response.status_code not in expected_statuses:
        severity = "warn"
    elif response.status_code >= 400:
        severity = "warn"

    summary = f"HTTP {response.status_code}: {url}"

    return build_result(
        scenario="http_check",
        severity=severity,
        summary=summary,
        facts={
            "url": url,
            "http_status": response.status_code,
            "response_time_ms": response_time_ms,
            "final_url": response.url,
            "redirect_count": len(response.history),
        },
        details={
            "expected_statuses": expected_statuses,
            "timeout_seconds": timeout_seconds,
        },
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def get_process_name(pid: int | None) -> str | None:
    if pid is None:
        return None

    try:
        return psutil.Process(pid).name()
    except (psutil.Error, OSError):
        return None


def is_listening_inet_socket(conn: Any) -> bool:
    is_tcp = conn.type == socket.SOCK_STREAM
    is_udp = conn.type == socket.SOCK_DGRAM

    if is_tcp:
        return conn.status == psutil.CONN_LISTEN

    return is_udp


def extract_local_address(conn: Any) -> tuple[str, int] | None:
    if not conn.laddr:
        return None

    if hasattr(conn.laddr, "ip") and hasattr(conn.laddr, "port"):
        address = str(conn.laddr.ip)
        port = conn.laddr.port
    elif isinstance(conn.laddr, tuple) and len(conn.laddr) >= 2:
        address = str(conn.laddr[0])
        port = conn.laddr[1]
    else:
        return None

    parsed_port = to_int_or_none(port)
    if parsed_port is None:
        return None

    return address, parsed_port


def normalize_process_patterns(raw_patterns: Any) -> list[str]:
    if raw_patterns is None:
        return DEFAULT_PROCESS_PATTERNS.copy()

    if not isinstance(raw_patterns, list):
        raise ValueError("payload.process_patterns must be an array of strings")

    normalized: list[str] = []
    seen: set[str] = set()
    for item in raw_patterns:
        if not isinstance(item, str):
            continue

        trimmed = item.strip().lower()
        if not trimmed:
            continue

        if trimmed not in seen:
            seen.add(trimmed)
            normalized.append(trimmed)

    if not normalized:
        raise ValueError("payload.process_patterns must contain at least one non-empty string")

    return normalized


def is_loopback_bind_address(address: str) -> bool:
    normalized = address.strip().split("%", 1)[0]
    if not normalized:
        return False

    try:
        parsed = ipaddress.ip_address(normalized)
        return bool(parsed.is_loopback)
    except ValueError:
        lowered = normalized.lower()
        return lowered == "localhost"


def run_list_listening_ports(_: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    ports: list[dict[str, Any]] = []

    try:
        connections = psutil.net_connections(kind="inet")
    except (psutil.Error, OSError) as exc:
        summary = "Failed to collect listening ports"
        return build_result(
            scenario="list_listening_ports",
            severity="crit",
            summary=summary,
            facts={"ports": []},
            details={"error": str(exc)},
            started_at=started_at,
            finished_at=utc_now_iso(),
        )

    for conn in connections:
        if not conn.laddr:
            continue

        is_tcp = conn.type == socket.SOCK_STREAM
        is_udp = conn.type == socket.SOCK_DGRAM

        include_tcp = is_tcp and conn.status == psutil.CONN_LISTEN
        include_udp = is_udp

        if not (include_tcp or include_udp):
            continue

        address = conn.laddr.ip if hasattr(conn.laddr, "ip") else conn.laddr[0]
        port = conn.laddr.port if hasattr(conn.laddr, "port") else conn.laddr[1]

        ports.append(
            {
                "protocol": "tcp" if is_tcp else "udp",
                "address": address,
                "port": port,
                "pid": conn.pid,
                "process_name": get_process_name(conn.pid),
            }
        )

    ports.sort(key=lambda item: (item["protocol"], item["address"], item["port"]))

    severity = "ok" if ports else "warn"
    summary = f"Listening ports found: {len(ports)}"

    return build_result(
        scenario="list_listening_ports",
        severity=severity,
        summary=summary,
        facts={"ports": ports},
        details={"total": len(ports)},
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def run_process_port_inventory(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()
    process_patterns = normalize_process_patterns(payload.get("process_patterns"))

    try:
        connections = psutil.net_connections(kind="inet")
    except (psutil.Error, OSError) as exc:
        return build_result(
            scenario="process_port_inventory",
            severity="crit",
            summary="Failed to collect listening sockets",
            facts={
                "process_patterns": process_patterns,
                "items": [],
                "total": 0,
                "network_exposed_count": 0,
                "local_only_count": 0,
                "unique_process_count": 0,
            },
            details={"error": str(exc)},
            started_at=started_at,
            finished_at=utc_now_iso(),
        )

    process_name_cache: dict[int, str | None] = {}
    items: list[dict[str, Any]] = []
    listening_scanned = 0

    for conn in connections:
        if not is_listening_inet_socket(conn):
            continue

        endpoint = extract_local_address(conn)
        if endpoint is None:
            continue

        address, port = endpoint
        listening_scanned += 1

        pid = conn.pid
        process_name: str | None
        if isinstance(pid, int):
            if pid not in process_name_cache:
                process_name_cache[pid] = get_process_name(pid)
            process_name = process_name_cache[pid]
        else:
            process_name = None

        if process_name is None:
            continue

        lowered_name = process_name.lower()
        matched_patterns = [pattern for pattern in process_patterns if pattern in lowered_name]
        if not matched_patterns:
            continue

        protocol = "tcp" if conn.type == socket.SOCK_STREAM else "udp"
        network_exposed = not is_loopback_bind_address(address)

        items.append(
            {
                "process_name": process_name,
                "pid": pid,
                "protocol": protocol,
                "address": address,
                "port": port,
                "network_exposed": network_exposed,
                "matched_patterns": matched_patterns,
            }
        )

    items.sort(
        key=lambda item: (
            0 if item["network_exposed"] else 1,
            str(item["process_name"] or "").lower(),
            int(item["pid"] or 0),
            str(item["protocol"]),
            str(item["address"]),
            int(item["port"]),
        )
    )

    network_exposed_count = sum(1 for item in items if item["network_exposed"])
    local_only_count = len(items) - network_exposed_count
    unique_process_count = len({(item["pid"], item["process_name"]) for item in items})

    severity = "ok" if items else "warn"
    if items:
        summary = (
            f"Matched sockets: {len(items)} "
            f"(network exposed: {network_exposed_count}, local only: {local_only_count})"
        )
    else:
        summary = "No listening sockets matched requested process patterns"

    return build_result(
        scenario="process_port_inventory",
        severity=severity,
        summary=summary,
        facts={
            "process_patterns": process_patterns,
            "items": items,
            "total": len(items),
            "network_exposed_count": network_exposed_count,
            "local_only_count": local_only_count,
            "unique_process_count": unique_process_count,
        },
        details={
            "listening_sockets_scanned": listening_scanned,
            "match_mode": "process_name contains pattern (case-insensitive)",
        },
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def run_docker_runtime_access_check(_: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    version_result = run_command_capture(["docker", "version", "--format", "{{json .}}"], timeout_seconds=8)
    info_result = run_command_capture(["docker", "info", "--format", "{{json .}}"], timeout_seconds=8)

    docker_cli_available = version_result["returncode"] is not None
    version_data = parse_json_object(str(version_result["stdout"])) if version_result["ok"] else None
    info_data = parse_json_object(str(info_result["stdout"])) if info_result["ok"] else None
    daemon_reachable = info_data is not None

    server_version: str | None = None
    if info_data is not None:
        server_version = to_trimmed_string_or_none(info_data.get("ServerVersion"))
    if server_version is None and isinstance(version_data, dict):
        server_block = version_data.get("Server")
        if isinstance(server_block, dict):
            server_version = to_trimmed_string_or_none(server_block.get("Version"))

    engine_os = None
    container_count = None
    if info_data is not None:
        engine_os = to_trimmed_string_or_none(info_data.get("OSType")) or to_trimmed_string_or_none(
            info_data.get("OperatingSystem")
        )
        container_count = to_int_or_none(info_data.get("Containers"))

    severity = "ok"
    summary = "Docker runtime is available"

    if not docker_cli_available:
        severity = "crit"
        summary = "Docker CLI is not available"
    elif not daemon_reachable:
        severity = "crit"
        summary = "Docker daemon is not reachable"

    return build_result(
        scenario="docker_runtime_access_check",
        severity=severity,
        summary=summary,
        facts={
            "docker_cli_available": docker_cli_available,
            "daemon_reachable": daemon_reachable,
            "server_version": server_version,
            "engine_os": engine_os,
            "container_count": container_count,
        },
        details={
            "version_stderr": version_result["stderr"] or None,
            "version_error": version_result["error"],
            "info_stderr": info_result["stderr"] or None,
            "info_error": info_result["error"],
        },
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def run_docker_container_status_check(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    container_name, container_id, target = resolve_container_target(payload)
    if target is None:
        raise ValueError("Either payload.container_name or payload.container_id is required")

    expected_state = to_trimmed_string_or_none(payload.get("expected_state"))
    allowed_states = {"running", "exited", "paused", "restarting", "created", "dead"}
    if expected_state is not None:
        expected_state = expected_state.lower()
        if expected_state not in allowed_states:
            raise ValueError(
                "payload.expected_state must be one of: running, exited, paused, restarting, created, dead"
            )

    require_healthy_raw = payload.get("require_healthy")
    if require_healthy_raw is None:
        require_healthy = None
    elif isinstance(require_healthy_raw, bool):
        require_healthy = require_healthy_raw
    else:
        raise ValueError("payload.require_healthy must be boolean")

    inspected, inspect_error = inspect_docker_container(target)
    if inspected is None:
        return build_result(
            scenario="docker_container_status_check",
            severity="crit",
            summary=f"Container {target} not found",
            facts={
                "container_id": container_id,
                "container_name": container_name,
                "exists": False,
                "state": "unknown",
                "health_status": None,
                "restart_count": None,
                "image": None,
                "created_at": None,
                "started_at": None,
            },
            details={
                "expected_state": expected_state,
                "require_healthy": require_healthy,
                "error": inspect_error,
            },
            started_at=started_at,
            finished_at=utc_now_iso(),
        )

    state_block = inspected.get("State") if isinstance(inspected.get("State"), dict) else {}
    config_block = inspected.get("Config") if isinstance(inspected.get("Config"), dict) else {}
    health_block = state_block.get("Health") if isinstance(state_block.get("Health"), dict) else {}

    resolved_name = normalize_container_name(inspected.get("Name")) or container_name
    resolved_id = to_trimmed_string_or_none(inspected.get("Id")) or container_id
    state = to_trimmed_string_or_none(state_block.get("Status")) or "unknown"
    state = state.lower()
    health_status = to_trimmed_string_or_none(health_block.get("Status"))
    if health_status is not None:
        health_status = health_status.lower()
    restart_count = to_int_or_none(state_block.get("RestartCount"))
    image = to_trimmed_string_or_none(config_block.get("Image"))
    created_at = to_trimmed_string_or_none(inspected.get("Created"))
    container_started_at = to_trimmed_string_or_none(state_block.get("StartedAt"))

    severity = "ok"
    summary = f"Container {resolved_name or target} is {state}"
    if health_status:
        summary += f" ({health_status})"

    if state == "dead":
        severity = "crit"
        summary = f"Container {resolved_name or target} is dead"
    elif state in {"exited", "restarting"}:
        severity = "warn"

    if expected_state and state != expected_state and severity != "crit":
        severity = "warn"
        summary = f"Container {resolved_name or target} is {state}, expected {expected_state}"
        if health_status:
            summary += f" ({health_status})"

    if require_healthy and health_status != "healthy" and severity != "crit":
        severity = "warn"
        summary = f"Container {resolved_name or target} health requirement is not met"
        if health_status:
            summary += f" ({health_status})"

    return build_result(
        scenario="docker_container_status_check",
        severity=severity,
        summary=summary,
        facts={
            "container_id": resolved_id[:12] if resolved_id else None,
            "container_name": resolved_name,
            "exists": True,
            "state": state,
            "health_status": health_status,
            "restart_count": restart_count,
            "image": image,
            "created_at": created_at,
            "started_at": container_started_at,
        },
        details={
            "expected_state": expected_state,
            "require_healthy": require_healthy,
            "inspect_error": inspect_error,
        },
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def run_docker_compose_stack_check(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    project_name = str(payload.get("project_name", "")).strip()
    if not project_name:
        raise ValueError("payload.project_name is required")

    expected_services_raw = payload.get("expected_services")
    expected_services: list[str] = []
    if expected_services_raw is not None:
        if not isinstance(expected_services_raw, list):
            raise ValueError("payload.expected_services must be an array of strings")
        for value in expected_services_raw:
            normalized = to_trimmed_string_or_none(value)
            if normalized is not None:
                expected_services.append(normalized)

    compose_result = run_command_capture(
        ["docker", "compose", "-p", project_name, "ps", "--format", "json"],
        timeout_seconds=10,
    )

    services: list[dict[str, Any]] = []
    source = "docker_compose_ps"
    compose_error = compose_result["stderr"] or compose_result["error"]
    fallback_error: str | None = None

    for item in parse_json_items(str(compose_result["stdout"])):
        service_name = to_trimmed_string_or_none(item.get("Service")) or to_trimmed_string_or_none(item.get("service"))
        container_name = normalize_container_name(item.get("Name")) or to_trimmed_string_or_none(item.get("Name"))
        state = (to_trimmed_string_or_none(item.get("State")) or "unknown").lower()
        health_status = to_trimmed_string_or_none(item.get("Health"))
        if health_status is not None:
            health_status = health_status.lower()

        services.append(
            {
                "service": service_name,
                "container_name": container_name,
                "state": state,
                "health_status": health_status,
            }
        )

    if not services:
        source = "docker_ps_label"
        fallback_result = run_command_capture(
            [
                "docker",
                "ps",
                "-a",
                "--filter",
                f"label=com.docker.compose.project={project_name}",
                "--format",
                "{{json .}}",
            ],
            timeout_seconds=10,
        )
        fallback_error = fallback_result["stderr"] or fallback_result["error"]

        for item in parse_json_items(str(fallback_result["stdout"])):
            status_text = to_trimmed_string_or_none(item.get("Status")) or "unknown"
            status_lower = status_text.lower()

            if status_lower.startswith("up"):
                state = "running"
            elif "exited" in status_lower:
                state = "exited"
            elif "restarting" in status_lower:
                state = "restarting"
            elif "paused" in status_lower:
                state = "paused"
            else:
                state = "unknown"

            health_status = None
            if "(healthy)" in status_lower:
                health_status = "healthy"
            elif "(unhealthy)" in status_lower:
                health_status = "unhealthy"

            services.append(
                {
                    "service": parse_compose_service_from_labels(item.get("Labels")),
                    "container_name": normalize_container_name(item.get("Names")),
                    "state": state,
                    "health_status": health_status,
                }
            )

    running_count = sum(1 for item in services if item.get("state") == "running")
    unhealthy_count = sum(1 for item in services if item.get("health_status") == "unhealthy")
    not_running_count = sum(1 for item in services if item.get("state") != "running")
    total_count = len(services)

    observed_services = {
        str(item["service"]).strip()
        for item in services
        if isinstance(item.get("service"), str) and str(item["service"]).strip()
    }
    missing_services = [item for item in expected_services if item not in observed_services]

    if total_count == 0:
        severity = "crit"
        summary = f"Compose project {project_name} not found"
    elif missing_services or unhealthy_count > 0 or not_running_count > 0:
        severity = "warn"
        summary = f"Compose project {project_name} has {running_count}/{total_count} services running"
    else:
        severity = "ok"
        summary = f"Compose project {project_name} is healthy ({running_count}/{total_count} running)"

    return build_result(
        scenario="docker_compose_stack_check",
        severity=severity,
        summary=summary,
        facts={
            "project_name": project_name,
            "service_count": total_count,
            "running_count": running_count,
            "unhealthy_count": unhealthy_count,
            "services": services,
        },
        details={
            "expected_services": expected_services,
            "missing_services": missing_services,
            "source": source,
            "compose_error": compose_error,
            "fallback_error": fallback_error,
        },
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def run_docker_port_mapping_check(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    container_name, container_id, target = resolve_container_target(payload)
    if target is None:
        raise ValueError("Either payload.container_name or payload.container_id is required")

    host_port = to_int_or_none(payload.get("host_port"))
    if host_port is None or host_port < 1 or host_port > 65535:
        raise ValueError("payload.host_port must be an integer in range 1..65535")

    protocol = str(payload.get("protocol", "tcp")).strip().lower()
    if protocol not in {"tcp", "udp"}:
        raise ValueError("payload.protocol must be tcp or udp")

    expected_container_port = to_int_or_none(payload.get("expected_container_port"))
    if expected_container_port is not None and (expected_container_port < 1 or expected_container_port > 65535):
        raise ValueError("payload.expected_container_port must be an integer in range 1..65535")

    inspected, inspect_error = inspect_docker_container(target)
    if inspected is None:
        return build_result(
            scenario="docker_port_mapping_check",
            severity="crit",
            summary=f"Container {target} not found",
            facts={
                "container_name": container_name,
                "container_id": container_id,
                "host_port": host_port,
                "protocol": protocol,
                "published": False,
                "container_port": None,
                "host_ip": None,
                "mappings": [],
            },
            details={
                "expected_container_port": expected_container_port,
                "error": inspect_error,
            },
            started_at=started_at,
            finished_at=utc_now_iso(),
        )

    ports_block = (
        inspected.get("NetworkSettings", {}).get("Ports")
        if isinstance(inspected.get("NetworkSettings"), dict)
        else {}
    )
    if not isinstance(ports_block, dict):
        ports_block = {}

    mappings: list[dict[str, Any]] = []

    for port_key, bindings in ports_block.items():
        if not isinstance(port_key, str) or "/" not in port_key:
            continue

        container_port_raw, mapping_protocol = port_key.split("/", 1)
        mapping_protocol = mapping_protocol.strip().lower()
        container_port_value = to_int_or_none(container_port_raw)

        if mapping_protocol != protocol or container_port_value is None:
            continue

        if not isinstance(bindings, list):
            continue

        for binding in bindings:
            if not isinstance(binding, dict):
                continue

            mapped_host_port = to_int_or_none(binding.get("HostPort"))
            if mapped_host_port is None:
                continue

            mappings.append(
                {
                    "container_port": container_port_value,
                    "host_port": mapped_host_port,
                    "host_ip": to_trimmed_string_or_none(binding.get("HostIp")),
                    "protocol": mapping_protocol,
                }
            )

    matched_mapping = next((item for item in mappings if item["host_port"] == host_port), None)

    resolved_name = normalize_container_name(inspected.get("Name")) or container_name
    resolved_id = to_trimmed_string_or_none(inspected.get("Id")) or container_id

    if matched_mapping is None:
        return build_result(
            scenario="docker_port_mapping_check",
            severity="crit",
            summary=f"Container {resolved_name or target} does not publish {host_port}/{protocol}",
            facts={
                "container_name": resolved_name,
                "container_id": resolved_id[:12] if resolved_id else None,
                "host_port": host_port,
                "protocol": protocol,
                "published": False,
                "container_port": None,
                "host_ip": None,
                "mappings": mappings,
            },
            details={
                "expected_container_port": expected_container_port,
                "inspect_error": inspect_error,
            },
            started_at=started_at,
            finished_at=utc_now_iso(),
        )

    severity = "ok"
    summary = (
        f"Container {resolved_name or target} publishes "
        f"{host_port}/{protocol} -> {matched_mapping['container_port']}/{protocol}"
    )

    if (
        expected_container_port is not None
        and matched_mapping["container_port"] is not None
        and matched_mapping["container_port"] != expected_container_port
    ):
        severity = "warn"
        summary = (
            f"Container {resolved_name or target} publishes {host_port}/{protocol} -> "
            f"{matched_mapping['container_port']}/{protocol}, expected {expected_container_port}/{protocol}"
        )

    return build_result(
        scenario="docker_port_mapping_check",
        severity=severity,
        summary=summary,
        facts={
            "container_name": resolved_name,
            "container_id": resolved_id[:12] if resolved_id else None,
            "host_port": host_port,
            "protocol": protocol,
            "published": True,
            "container_port": matched_mapping["container_port"],
            "host_ip": matched_mapping["host_ip"],
            "mappings": mappings,
        },
        details={
            "expected_container_port": expected_container_port,
            "inspect_error": inspect_error,
        },
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def run_service_status_check(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    service_name = str(payload.get("service_name", "")).strip()
    if not service_name:
        raise ValueError("payload.service_name is required")

    expected_state = to_trimmed_string_or_none(payload.get("expected_state"))
    if expected_state is not None and expected_state not in {"running", "stopped", "paused"}:
        raise ValueError("payload.expected_state must be one of: running, stopped, paused")

    require_enabled_raw = payload.get("require_enabled")
    if require_enabled_raw is None:
        require_enabled = None
    elif isinstance(require_enabled_raw, bool):
        require_enabled = require_enabled_raw
    else:
        raise ValueError("payload.require_enabled must be boolean")

    if platform.system().lower() == "windows":
        service_data = read_windows_service_status(service_name)
    else:
        service_data = read_linux_service_status(service_name)

    exists = bool(service_data.get("exists"))
    observed_state = str(service_data.get("state") or "unknown")
    enabled = service_data.get("enabled")

    severity = "ok"
    summary = f"Service {service_name} is {observed_state}"

    if not exists:
        severity = "crit"
        summary = f"Service {service_name} not found"
    elif observed_state == "failed":
        severity = "crit"
        summary = f"Service {service_name} is in failed state"
    elif expected_state and observed_state != expected_state:
        severity = "warn"
        summary = f"Service {service_name} state is {observed_state}, expected {expected_state}"

    if severity != "crit" and require_enabled is True and enabled is False:
        severity = "warn"
        summary = f"Service {service_name} is not enabled"

    if service_data.get("error") and severity != "crit":
        severity = "warn"

    return build_result(
        scenario="service_status_check",
        severity=severity,
        summary=summary,
        facts={
            "service_name": service_name,
            "exists": exists,
            "state": observed_state,
            "substate": service_data.get("substate"),
            "enabled": enabled,
            "pid": service_data.get("pid"),
            "start_mode": service_data.get("start_mode"),
            "account": service_data.get("account"),
            "binary_path": service_data.get("binary_path"),
            "last_state_change_at": service_data.get("last_state_change_at"),
        },
        details={
            "expected_state": expected_state,
            "require_enabled": require_enabled,
            "platform": platform.system().lower(),
            "error": service_data.get("error"),
        },
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def run_process_presence_check(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    process_name = str(payload.get("process_name", "")).strip()
    if not process_name:
        raise ValueError("payload.process_name is required")

    cmdline_contains = to_trimmed_string_or_none(payload.get("cmdline_contains"))

    expected_min_count = to_int_or_none(payload.get("expected_min_count", 1))
    if expected_min_count is None or expected_min_count < 0 or expected_min_count > 200:
        raise ValueError("payload.expected_min_count must be an integer in range 0..200")

    expected_max_raw = payload.get("expected_max_count")
    expected_max_count: int | None = None
    if expected_max_raw is not None:
        expected_max_count = to_int_or_none(expected_max_raw)
        if expected_max_count is None or expected_max_count < 0 or expected_max_count > 200:
            raise ValueError("payload.expected_max_count must be an integer in range 0..200")
        if expected_max_count < expected_min_count:
            raise ValueError("payload.expected_max_count must be greater than or equal to expected_min_count")

    total, processes = collect_matching_processes(process_name, cmdline_contains, max_items=30)

    severity = "ok"
    if total == 0:
        severity = "crit"
    elif total < expected_min_count:
        severity = "warn"
    elif expected_max_count is not None and total > expected_max_count:
        severity = "warn"

    if severity == "ok":
        summary = f"Found {total} matching process(es)"
    elif severity == "warn":
        if expected_max_count is not None:
            summary = f"Found {total} matching process(es), expected {expected_min_count}..{expected_max_count}"
        else:
            summary = f"Found {total} matching process(es), expected at least {expected_min_count}"
    else:
        summary = f"No matching process found for {process_name}"

    return build_result(
        scenario="process_presence_check",
        severity=severity,
        summary=summary,
        facts={
            "process_name": process_name,
            "cmdline_contains": cmdline_contains,
            "running_count": total,
            "expected_min_count": expected_min_count,
            "expected_max_count": expected_max_count,
            "match_mode": "name+cmdline" if cmdline_contains else "name",
            "processes": processes,
        },
        details={},
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def run_port_owner_check(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    port = to_int_or_none(payload.get("port"))
    if port is None or port < 1 or port > 65535:
        raise ValueError("payload.port must be an integer in range 1..65535")

    protocol = str(payload.get("protocol", "tcp")).strip().lower()
    if protocol not in {"tcp", "udp"}:
        raise ValueError("payload.protocol must be tcp or udp")

    expected_process_name = to_trimmed_string_or_none(payload.get("expected_process_name"))
    expected_process_name_lower = expected_process_name.lower() if expected_process_name else None

    owners: list[dict[str, Any]] = []

    try:
        connections = psutil.net_connections(kind="inet")
    except (psutil.Error, OSError) as exc:
        return build_result(
            scenario="port_owner_check",
            severity="crit",
            summary=f"Failed to inspect port owners for {port}/{protocol}",
            facts={
                "port": port,
                "protocol": protocol,
                "listening": False,
                "owners": [],
            },
            details={"error": str(exc)},
            started_at=started_at,
            finished_at=utc_now_iso(),
        )

    for conn in connections:
        if not conn.laddr:
            continue

        is_tcp = conn.type == socket.SOCK_STREAM
        is_udp = conn.type == socket.SOCK_DGRAM

        if protocol == "tcp" and not is_tcp:
            continue
        if protocol == "udp" and not is_udp:
            continue
        if protocol == "tcp" and conn.status != psutil.CONN_LISTEN:
            continue

        local_port = conn.laddr.port if hasattr(conn.laddr, "port") else conn.laddr[1]
        if local_port != port:
            continue

        local_address = conn.laddr.ip if hasattr(conn.laddr, "ip") else conn.laddr[0]
        owners.append(
            {
                "address": local_address,
                "pid": conn.pid,
                "process_name": get_process_name(conn.pid),
            }
        )

    if not owners:
        return build_result(
            scenario="port_owner_check",
            severity="crit",
            summary=f"Port {port}/{protocol} is not listening",
            facts={
                "port": port,
                "protocol": protocol,
                "listening": False,
                "pid": None,
                "process_name": None,
                "exe": None,
                "cmdline": None,
                "address": None,
                "owners": [],
            },
            details={"expected_process_name": expected_process_name},
            started_at=started_at,
            finished_at=utc_now_iso(),
        )

    owners.sort(key=lambda item: (str(item.get("address") or ""), int(item.get("pid") or -1)))

    selected_owner = next((item for item in owners if item.get("pid") is not None), owners[0])
    selected_pid = to_int_or_none(selected_owner.get("pid"))
    identity = read_process_identity(selected_pid)
    actual_name = str(identity.get("process_name") or selected_owner.get("process_name") or "").strip()

    severity = "ok"
    if expected_process_name_lower and expected_process_name_lower not in actual_name.lower():
        severity = "warn"

    if expected_process_name and severity == "warn":
        summary = (
            f"Port {port}/{protocol} is owned by {actual_name or 'unknown'} "
            f"(expected {expected_process_name})"
        )
    else:
        summary = f"Port {port}/{protocol} is owned by {actual_name or 'unknown'}"
        if selected_pid:
            summary += f" (pid {selected_pid})"

    return build_result(
        scenario="port_owner_check",
        severity=severity,
        summary=summary,
        facts={
            "port": port,
            "protocol": protocol,
            "listening": True,
            "pid": selected_pid,
            "process_name": actual_name or None,
            "exe": identity.get("exe"),
            "cmdline": identity.get("cmdline"),
            "address": selected_owner.get("address"),
            "owners": owners,
        },
        details={"expected_process_name": expected_process_name},
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def run_process_resource_snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    pid = to_int_or_none(payload.get("pid"))
    process_name = to_trimmed_string_or_none(payload.get("process_name"))
    cmdline_contains = to_trimmed_string_or_none(payload.get("cmdline_contains"))

    if pid is None and not process_name:
        raise ValueError("Either payload.pid or payload.process_name is required")

    sample_seconds = to_int_or_none(payload.get("sample_seconds", 2))
    if sample_seconds is None or sample_seconds < 1 or sample_seconds > 10:
        raise ValueError("payload.sample_seconds must be an integer in range 1..10")

    cpu_warn_percent = to_float_or_none(payload.get("cpu_warn_percent"))
    if cpu_warn_percent is not None and (cpu_warn_percent <= 0 or cpu_warn_percent > 100):
        raise ValueError("payload.cpu_warn_percent must be in range (0, 100]")

    rss_warn_mb = to_int_or_none(payload.get("rss_warn_mb"))
    if rss_warn_mb is not None and rss_warn_mb <= 0:
        raise ValueError("payload.rss_warn_mb must be greater than 0")

    matched_count = 0
    selected_pid: int | None = pid

    if selected_pid is None:
        assert process_name is not None
        matched_count, matches = collect_matching_processes(process_name, cmdline_contains, max_items=10)
        if matched_count == 0 or not matches:
            return build_result(
                scenario="process_resource_snapshot",
                severity="crit",
                summary=f"No matching process found for {process_name}",
                facts={
                    "pid": None,
                    "process_name": process_name,
                    "cpu_percent": None,
                    "rss_mb": None,
                    "vms_mb": None,
                    "thread_count": None,
                    "open_file_count": None,
                    "connection_count": None,
                    "uptime_seconds": None,
                    "matched_count": 0,
                },
                details={
                    "sample_seconds": sample_seconds,
                    "cpu_warn_percent": cpu_warn_percent,
                    "rss_warn_mb": rss_warn_mb,
                    "cmdline_contains": cmdline_contains,
                },
                started_at=started_at,
                finished_at=utc_now_iso(),
            )

        selected_pid = to_int_or_none(matches[0].get("pid"))

    if selected_pid is None:
        return build_result(
            scenario="process_resource_snapshot",
            severity="crit",
            summary="Unable to resolve process pid",
            facts={
                "pid": None,
                "process_name": process_name,
                "cpu_percent": None,
                "rss_mb": None,
                "vms_mb": None,
                "thread_count": None,
                "open_file_count": None,
                "connection_count": None,
                "uptime_seconds": None,
                "matched_count": matched_count,
            },
            details={
                "sample_seconds": sample_seconds,
                "cpu_warn_percent": cpu_warn_percent,
                "rss_warn_mb": rss_warn_mb,
                "cmdline_contains": cmdline_contains,
            },
            started_at=started_at,
            finished_at=utc_now_iso(),
        )

    try:
        process = psutil.Process(selected_pid)
        process.cpu_percent(interval=None)
        time.sleep(sample_seconds)
        cpu_percent = round(float(process.cpu_percent(interval=None)), 1)

        memory_info = process.memory_info()
        rss_mb = round(memory_info.rss / (1024 * 1024), 1)
        vms_mb = round(memory_info.vms / (1024 * 1024), 1)

        try:
            open_file_count = len(process.open_files())
        except (psutil.Error, OSError):
            open_file_count = None

        try:
            connection_count = len(process.connections(kind="inet"))
        except (psutil.Error, OSError):
            connection_count = None

        create_time_epoch = process.create_time()
        now_epoch = datetime.now(timezone.utc).timestamp()

        facts = {
            "pid": selected_pid,
            "process_name": process.name(),
            "exe": process.exe() if hasattr(process, "exe") else None,
            "cmdline": normalize_cmdline(process.cmdline()),
            "username": process.username(),
            "create_time": to_iso_from_epoch(create_time_epoch),
            "cpu_percent": cpu_percent,
            "rss_mb": rss_mb,
            "vms_mb": vms_mb,
            "thread_count": process.num_threads(),
            "open_file_count": open_file_count,
            "connection_count": connection_count,
            "uptime_seconds": int(max(0, now_epoch - create_time_epoch)),
            "matched_count": matched_count if pid is None else 1,
        }
    except (psutil.Error, OSError) as exc:
        return build_result(
            scenario="process_resource_snapshot",
            severity="crit",
            summary=f"Failed to collect metrics for pid {selected_pid}",
            facts={
                "pid": selected_pid,
                "process_name": process_name,
                "cpu_percent": None,
                "rss_mb": None,
                "vms_mb": None,
                "thread_count": None,
                "open_file_count": None,
                "connection_count": None,
                "uptime_seconds": None,
                "matched_count": matched_count,
            },
            details={
                "sample_seconds": sample_seconds,
                "cpu_warn_percent": cpu_warn_percent,
                "rss_warn_mb": rss_warn_mb,
                "cmdline_contains": cmdline_contains,
                "error": str(exc),
            },
            started_at=started_at,
            finished_at=utc_now_iso(),
        )

    severity = "ok"
    warning_reasons: list[str] = []

    if cpu_warn_percent is not None and facts["cpu_percent"] is not None and facts["cpu_percent"] > cpu_warn_percent:
        warning_reasons.append(f"CPU {facts['cpu_percent']}% > {cpu_warn_percent}%")

    if rss_warn_mb is not None and facts["rss_mb"] is not None and facts["rss_mb"] > rss_warn_mb:
        warning_reasons.append(f"RSS {facts['rss_mb']} MB > {rss_warn_mb} MB")

    if pid is None and facts["matched_count"] > 1:
        warning_reasons.append(f"selected pid {selected_pid} from {facts['matched_count']} matches")

    if warning_reasons:
        severity = "warn"

    summary = (
        f"Process {facts['process_name'] or 'unknown'} (pid {selected_pid}) "
        f"CPU {facts['cpu_percent']}%, RSS {facts['rss_mb']} MB"
    )
    if warning_reasons:
        summary = f"{summary}; {'; '.join(warning_reasons)}"

    return build_result(
        scenario="process_resource_snapshot",
        severity=severity,
        summary=summary,
        facts=facts,
        details={
            "sample_seconds": sample_seconds,
            "cpu_warn_percent": cpu_warn_percent,
            "rss_warn_mb": rss_warn_mb,
            "process_name_filter": process_name,
            "cmdline_contains": cmdline_contains,
        },
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def to_bool_or_default(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value

    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False

    return default


def trim_command_output(value: Any) -> str:
    if not isinstance(value, str):
        return ""

    text = value.strip()
    if len(text) <= MAX_CUSTOM_SCENARIO_OUTPUT_CHARS:
        return text

    return f"{text[:MAX_CUSTOM_SCENARIO_OUTPUT_CHARS]} ...[truncated]"


def build_shell_command(shell_name: str, command: str) -> list[str]:
    shell = shell_name.strip().lower()

    if shell == "bash":
        return ["bash", "-lc", command]
    if shell == "sh":
        return ["sh", "-lc", command]
    if shell == "powershell":
        return ["powershell", "-NoProfile", "-Command", command]
    if shell == "cmd":
        return ["cmd", "/c", command]

    raise ValueError(f"Unsupported shell: {shell_name}")


def parse_custom_scenario_steps(raw_steps: Any) -> list[dict[str, str]]:
    if not isinstance(raw_steps, list):
        return []

    steps: list[dict[str, str]] = []
    for item in raw_steps:
        if not isinstance(item, dict):
            continue

        shell_raw = item.get("shell")
        command_raw = item.get("command")
        if not isinstance(shell_raw, str) or not isinstance(command_raw, str):
            continue

        shell = shell_raw.strip().lower()
        command = command_raw.strip()
        if not shell or not command:
            continue

        steps.append({"shell": shell, "command": command})

    return steps


def run_custom_scenario(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = utc_now_iso()

    scenario_name = to_trimmed_string_or_none(payload.get("scenario_name")) or "custom_scenario"
    scenario_id = to_trimmed_string_or_none(payload.get("scenario_id"))

    timeout_seconds = to_int_or_none(payload.get("timeout_seconds", DEFAULT_CUSTOM_SCENARIO_TIMEOUT_SECONDS))
    if timeout_seconds is None or timeout_seconds < 1 or timeout_seconds > 3600:
        raise ValueError("payload.timeout_seconds must be an integer in range 1..3600")

    stop_on_error = to_bool_or_default(payload.get("stop_on_error"), True)
    system_name = platform.system().lower()

    target_step_key = "windows_steps" if system_name == "windows" else "linux_steps"
    fallback_step_key = "linux_steps" if target_step_key == "windows_steps" else "windows_steps"

    steps = parse_custom_scenario_steps(payload.get(target_step_key))
    fallback_steps = parse_custom_scenario_steps(payload.get(fallback_step_key))

    if not steps:
        fallback_hint = "yes" if fallback_steps else "no"
        return build_result(
            scenario="custom_scenario",
            severity="crit",
            summary=f"No steps configured for current platform ({system_name})",
            facts={
                "scenario_id": scenario_id,
                "scenario_name": scenario_name,
                "platform": system_name,
                "configured_steps": 0,
                "executed_steps": 0,
                "successful_steps": 0,
                "failed_steps": 0,
                "stop_on_error": stop_on_error,
                "steps": [],
            },
            details={
                "target_step_key": target_step_key,
                "fallback_steps_available": fallback_hint,
            },
            started_at=started_at,
            finished_at=utc_now_iso(),
        )

    step_logs: list[dict[str, Any]] = []
    executed_steps = 0
    failed_steps = 0

    for index, step in enumerate(steps, start=1):
        command = step["command"]
        shell = step["shell"]
        executed_steps += 1

        step_started = perf_counter()
        ok = False
        returncode: int | None = None
        stdout = ""
        stderr = ""
        error_text: str | None = None

        try:
            command_args = build_shell_command(shell, command)
            completed = subprocess.run(
                command_args,
                capture_output=True,
                text=True,
                check=False,
                timeout=timeout_seconds,
            )
            returncode = completed.returncode
            stdout = trim_command_output(completed.stdout)
            stderr = trim_command_output(completed.stderr)
            ok = returncode == 0
        except subprocess.TimeoutExpired as exc:
            stdout = trim_command_output(exc.stdout)
            stderr = trim_command_output(exc.stderr)
            error_text = f"timeout after {timeout_seconds}s"
        except OSError as exc:
            error_text = str(exc)
        except ValueError as exc:
            error_text = str(exc)

        if not ok:
            failed_steps += 1

        duration_ms = round((perf_counter() - step_started) * 1000, 1)
        step_logs.append(
            {
                "index": index,
                "shell": shell,
                "command": command,
                "ok": ok,
                "returncode": returncode,
                "duration_ms": duration_ms,
                "stdout": stdout,
                "stderr": stderr,
                "error": error_text,
            }
        )

        if not ok and stop_on_error:
            break

    successful_steps = executed_steps - failed_steps
    severity = "ok" if failed_steps == 0 else "crit"

    if failed_steps == 0:
        summary = f"Scenario '{scenario_name}' completed successfully ({executed_steps}/{len(steps)} step(s))"
    elif stop_on_error:
        summary = f"Scenario '{scenario_name}' failed at step {executed_steps}"
    else:
        summary = (
            f"Scenario '{scenario_name}' completed with errors: "
            f"{failed_steps} of {executed_steps} executed step(s) failed"
        )

    return build_result(
        scenario="custom_scenario",
        severity=severity,
        summary=summary,
        facts={
            "scenario_id": scenario_id,
            "scenario_name": scenario_name,
            "platform": system_name,
            "configured_steps": len(steps),
            "executed_steps": executed_steps,
            "successful_steps": successful_steps,
            "failed_steps": failed_steps,
            "stop_on_error": stop_on_error,
            "steps": step_logs,
        },
        details={
            "target_step_key": target_step_key,
            "timeout_seconds": timeout_seconds,
        },
        started_at=started_at,
        finished_at=utc_now_iso(),
    )


def build_failed_result(task_type: str, error_message: str) -> dict[str, Any]:
    timestamp = utc_now_iso()
    return {
        "scenario": task_type,
        "severity": "crit",
        "summary": f"Scenario execution failed: {error_message}",
        "facts": {},
        "details": {"error": error_message},
        "started_at": timestamp,
        "finished_at": timestamp,
    }


def normalize_remote_preview_config(raw_config: Any) -> dict[str, int]:
    config = raw_config if isinstance(raw_config, dict) else {}

    fps = to_int_or_none(config.get("fps"))
    max_width = to_int_or_none(config.get("max_width"))
    jpeg_quality = to_int_or_none(config.get("jpeg_quality"))

    normalized_fps = fps if fps is not None else DEFAULT_REMOTE_PREVIEW_FPS
    normalized_max_width = max_width if max_width is not None else DEFAULT_REMOTE_PREVIEW_MAX_WIDTH
    normalized_jpeg_quality = jpeg_quality if jpeg_quality is not None else DEFAULT_REMOTE_PREVIEW_JPEG_QUALITY

    return {
        "fps": max(1, min(normalized_fps, 10)),
        "max_width": max(320, min(normalized_max_width, 2560)),
        "jpeg_quality": max(20, min(normalized_jpeg_quality, 90)),
    }


class RemotePreviewController:
    def __init__(self) -> None:
        self.enabled = False
        self.fps = DEFAULT_REMOTE_PREVIEW_FPS
        self.max_width = DEFAULT_REMOTE_PREVIEW_MAX_WIDTH
        self.jpeg_quality = DEFAULT_REMOTE_PREVIEW_JPEG_QUALITY
        self.last_error: str | None = None
        self.monitor_left: int | None = None
        self.monitor_top: int | None = None
        self.monitor_width: int | None = None
        self.monitor_height: int | None = None

    def start(self, config: dict[str, int]) -> None:
        self.enabled = True
        self.fps = config["fps"]
        self.max_width = config["max_width"]
        self.jpeg_quality = config["jpeg_quality"]
        self.last_error = None

    def stop(self) -> None:
        self.enabled = False

    def snapshot(self) -> dict[str, int]:
        return {
            "fps": self.fps,
            "max_width": self.max_width,
            "jpeg_quality": self.jpeg_quality,
        }

    def update_monitor_geometry(self, left: int, top: int, width: int, height: int) -> None:
        self.monitor_left = left
        self.monitor_top = top
        self.monitor_width = width
        self.monitor_height = height


def capture_remote_preview_frame(max_width: int, jpeg_quality: int) -> dict[str, Any]:
    if mss_factory is None or Image is None:
        raise RuntimeError("screen capture dependencies are not installed (mss, Pillow)")

    with mss_factory() as capture:
        monitor = capture.monitors[1] if len(capture.monitors) > 1 else capture.monitors[0]
        raw_shot = capture.grab(monitor)

    image = Image.frombytes("RGB", raw_shot.size, raw_shot.rgb)
    if image.width > max_width:
        resized_height = int((image.height / image.width) * max_width)
        image = image.resize((max_width, max(1, resized_height)))

    with io.BytesIO() as output_buffer:
        image.save(output_buffer, format="JPEG", quality=jpeg_quality)
        encoded_image = base64.b64encode(output_buffer.getvalue()).decode("ascii")

    return {
        "captured_at": utc_now_iso(),
        "width": image.width,
        "height": image.height,
        "image_base64": encoded_image,
        "monitor_left": int(monitor.get("left", 0)),
        "monitor_top": int(monitor.get("top", 0)),
        "monitor_width": int(monitor.get("width", image.width)),
        "monitor_height": int(monitor.get("height", image.height)),
    }


def normalize_remote_preview_key(raw_key: Any) -> list[str]:
    if not isinstance(raw_key, str):
        raise ValueError("key must be a string")

    stripped = raw_key.strip()
    if not stripped:
        raise ValueError("key must not be empty")

    key_aliases = {
        "enter": "enter",
        "return": "enter",
        "escape": "esc",
        "esc": "esc",
        "tab": "tab",
        "backspace": "backspace",
        "delete": "delete",
        "del": "delete",
        "insert": "insert",
        "home": "home",
        "end": "end",
        "pageup": "pageup",
        "pagedown": "pagedown",
        "arrowup": "up",
        "arrowdown": "down",
        "arrowleft": "left",
        "arrowright": "right",
        "up": "up",
        "down": "down",
        "left": "left",
        "right": "right",
        "space": "space",
        "capslock": "capslock",
        "numlock": "numlock",
        "scrolllock": "scrolllock",
        "pause": "pause",
        "printscreen": "printscreen",
        "control": "ctrl",
        "ctrl": "ctrl",
        "alt": "alt",
        "shift": "shift",
        "meta": "win",
        "cmd": "win",
        "windows": "win",
        "win": "win",
    }

    normalized_tokens: list[str] = []
    for token in [part.strip() for part in stripped.split("+")]:
        if not token:
            continue

        lowered = token.lower()
        mapped = key_aliases.get(lowered)
        if mapped:
            normalized_tokens.append(mapped)
            continue

        if re.fullmatch(r"f([1-9]|1[0-9]|2[0-4])", lowered):
            normalized_tokens.append(lowered)
            continue

        if len(token) == 1:
            normalized_tokens.append("space" if token == " " else token.lower())
            continue

        raise ValueError(f"Unsupported key token: {token}")

    if not normalized_tokens:
        raise ValueError("key must contain at least one key token")

    return normalized_tokens


if ctypes.sizeof(ctypes.c_void_p) == 8:
    _ULONG_PTR = ctypes.c_ulonglong
else:
    _ULONG_PTR = ctypes.c_ulong


class _WINDOWS_MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", _ULONG_PTR),
    ]


class _WINDOWS_KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", ctypes.c_ushort),
        ("wScan", ctypes.c_ushort),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", _ULONG_PTR),
    ]


class _WINDOWS_HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", ctypes.c_ulong),
        ("wParamL", ctypes.c_ushort),
        ("wParamH", ctypes.c_ushort),
    ]


class _WINDOWS_INPUT_UNION(ctypes.Union):
    _fields_ = [
        ("mi", _WINDOWS_MOUSEINPUT),
        ("ki", _WINDOWS_KEYBDINPUT),
        ("hi", _WINDOWS_HARDWAREINPUT),
    ]


class _WINDOWS_INPUT(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_ulong),
        ("union", _WINDOWS_INPUT_UNION),
    ]


def _windows_send_keyboard_inputs(items: list[_WINDOWS_KEYBDINPUT]) -> int:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.SendInput.argtypes = [wintypes.UINT, wintypes.LPVOID, ctypes.c_int]
    user32.SendInput.restype = wintypes.UINT

    payload = (_WINDOWS_INPUT * len(items))()
    for index, keyboard_item in enumerate(items):
        payload[index].type = 1  # INPUT_KEYBOARD
        payload[index].union.ki = keyboard_item

    return int(user32.SendInput(len(payload), ctypes.byref(payload), ctypes.sizeof(_WINDOWS_INPUT)))


def send_unicode_text_windows(text: str) -> None:
    if not text:
        return

    if platform.system().lower() != "windows":
        if pyautogui is None:
            raise RuntimeError("pyautogui is not installed")
        pyautogui.write(text)
        return

    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_UNICODE = 0x0004

    utf16_payload = text.encode("utf-16-le")
    for offset in range(0, len(utf16_payload), 2):
        scan_code = int.from_bytes(utf16_payload[offset : offset + 2], byteorder="little", signed=False)
        key_down = _WINDOWS_KEYBDINPUT(0, scan_code, KEYEVENTF_UNICODE, 0, 0)
        key_up = _WINDOWS_KEYBDINPUT(0, scan_code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0)
        sent = _windows_send_keyboard_inputs([key_down, key_up])
        if sent != 2:
            raise RuntimeError("failed to send unicode text input")


def _windows_open_clipboard_with_retry(attempts: int = 8, delay_seconds: float = 0.04) -> bool:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.OpenClipboard.argtypes = [wintypes.HWND]
    user32.OpenClipboard.restype = wintypes.BOOL

    for _ in range(max(1, attempts)):
        if user32.OpenClipboard(None):
            return True
        time.sleep(delay_seconds)
    return False


def _windows_get_clipboard_text() -> str | None:
    CF_UNICODETEXT = 13
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.GetClipboardData.argtypes = [wintypes.UINT]
    user32.GetClipboardData.restype = wintypes.HANDLE

    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL

    if not _windows_open_clipboard_with_retry():
        return None

    text_value = ""
    try:
        clipboard_handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not clipboard_handle:
            return text_value

        raw_pointer = kernel32.GlobalLock(clipboard_handle)
        if not raw_pointer:
            return text_value

        try:
            text_value = ctypes.wstring_at(raw_pointer)
        finally:
            kernel32.GlobalUnlock(clipboard_handle)
    finally:
        user32.CloseClipboard()

    return text_value


def _windows_set_clipboard_text(text: str) -> None:
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    user32.CloseClipboard.argtypes = []
    user32.CloseClipboard.restype = wintypes.BOOL
    user32.EmptyClipboard.argtypes = []
    user32.EmptyClipboard.restype = wintypes.BOOL
    user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    user32.SetClipboardData.restype = wintypes.HANDLE

    kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
    kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalLock.restype = wintypes.LPVOID
    kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalUnlock.restype = wintypes.BOOL
    kernel32.GlobalFree.argtypes = [wintypes.HGLOBAL]
    kernel32.GlobalFree.restype = wintypes.HGLOBAL
    kernel32.GetLastError.argtypes = []
    kernel32.GetLastError.restype = wintypes.DWORD

    payload = f"{text}\x00"
    payload_size = len(payload) * ctypes.sizeof(ctypes.c_wchar)

    memory_handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, payload_size)
    if not memory_handle:
        raise RuntimeError(f"GlobalAlloc failed (winerr={kernel32.GetLastError()})")

    raw_pointer = kernel32.GlobalLock(memory_handle)
    if not raw_pointer:
        kernel32.GlobalFree(memory_handle)
        raise RuntimeError(f"GlobalLock failed (winerr={kernel32.GetLastError()})")

    try:
        source_buffer = ctypes.create_unicode_buffer(payload)
        ctypes.memmove(raw_pointer, ctypes.addressof(source_buffer), payload_size)
    finally:
        kernel32.GlobalUnlock(memory_handle)

    if not _windows_open_clipboard_with_retry():
        kernel32.GlobalFree(memory_handle)
        raise RuntimeError("OpenClipboard failed")

    memory_owned_by_clipboard = False
    try:
        if not user32.EmptyClipboard():
            raise RuntimeError("EmptyClipboard failed")

        if not user32.SetClipboardData(CF_UNICODETEXT, memory_handle):
            raise RuntimeError(f"SetClipboardData failed (winerr={kernel32.GetLastError()})")

        memory_owned_by_clipboard = True
    finally:
        user32.CloseClipboard()
        if not memory_owned_by_clipboard:
            kernel32.GlobalFree(memory_handle)


def send_text_via_clipboard_windows(text: str) -> None:
    if platform.system().lower() != "windows":
        if pyautogui is None:
            raise RuntimeError("pyautogui is not installed")
        pyautogui.write(text)
        return

    _windows_set_clipboard_text(text)

    KEYEVENTF_KEYUP = 0x0002
    VK_CONTROL = 0x11
    VK_V = 0x56

    combo = [
        _WINDOWS_KEYBDINPUT(VK_CONTROL, 0, 0, 0, 0),
        _WINDOWS_KEYBDINPUT(VK_V, 0, 0, 0, 0),
        _WINDOWS_KEYBDINPUT(VK_V, 0, KEYEVENTF_KEYUP, 0, 0),
        _WINDOWS_KEYBDINPUT(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0, 0),
    ]
    sent = _windows_send_keyboard_inputs(combo)
    if sent != 4:
        raise RuntimeError("failed to send ctrl+v paste sequence")


def perform_remote_preview_input(preview_controller: RemotePreviewController, raw_input: Any) -> None:
    if not preview_controller.enabled:
        raise RuntimeError("remote preview is not active")

    if not isinstance(raw_input, dict):
        raise ValueError("input payload must be an object")

    action = str(raw_input.get("action", "mouse_click")).strip().lower()
    if action == "key_tap":
        if pyautogui is None:
            raise RuntimeError("pyautogui is not installed")

        pyautogui.FAILSAFE = False
        key_tokens = normalize_remote_preview_key(raw_input.get("key"))
        if len(key_tokens) == 1:
            pyautogui.press(key_tokens[0])
        else:
            pyautogui.hotkey(*key_tokens)
        return

    if action == "text_input":
        raw_text = raw_input.get("text")
        if not isinstance(raw_text, str) or len(raw_text) == 0:
            raise ValueError("text is required for text_input action")

        if platform.system().lower() == "windows":
            try:
                send_unicode_text_windows(raw_text)
            except Exception:
                send_text_via_clipboard_windows(raw_text)
        else:
            send_unicode_text_windows(raw_text)
        return

    if pyautogui is None:
        raise RuntimeError("pyautogui is not installed")

    pyautogui.FAILSAFE = False

    monitor_left = preview_controller.monitor_left
    monitor_top = preview_controller.monitor_top
    monitor_width = preview_controller.monitor_width
    monitor_height = preview_controller.monitor_height

    if (
        monitor_left is None
        or monitor_top is None
        or monitor_width is None
        or monitor_height is None
        or monitor_width <= 0
        or monitor_height <= 0
    ):
        raise RuntimeError("monitor geometry is not available yet")

    x_ratio_raw = to_float_or_none(raw_input.get("x_ratio"))
    y_ratio_raw = to_float_or_none(raw_input.get("y_ratio"))
    button_raw = str(raw_input.get("button", "left")).strip().lower()

    if x_ratio_raw is None or y_ratio_raw is None:
        raise ValueError("x_ratio and y_ratio are required")

    x_ratio = min(1.0, max(0.0, float(x_ratio_raw)))
    y_ratio = min(1.0, max(0.0, float(y_ratio_raw)))

    target_x = int(monitor_left + x_ratio * max(1, monitor_width - 1))
    target_y = int(monitor_top + y_ratio * max(1, monitor_height - 1))

    if button_raw not in {"left", "right", "middle"}:
        button_raw = "left"

    if action == "mouse_move":
        pyautogui.moveTo(target_x, target_y)
        return

    if action == "mouse_click":
        pyautogui.click(target_x, target_y, button=button_raw)
        return

    raise ValueError(f"Unsupported input action: {action}")


async def execute_task(task: dict[str, Any]) -> dict[str, Any]:
    task_type = str(task.get("task_type", ""))
    payload = task.get("payload", {}) or {}

    if not isinstance(payload, dict):
        raise ValueError("Task payload must be a JSON object")

    match task_type:
        case "agent_snapshot":
            return await asyncio.to_thread(run_agent_snapshot, payload)
        case "tcp_connect_check":
            return await asyncio.to_thread(run_tcp_connect_check, payload)
        case "http_check":
            return await asyncio.to_thread(run_http_check, payload)
        case "list_listening_ports":
            return await asyncio.to_thread(run_list_listening_ports, payload)
        case "process_port_inventory":
            return await asyncio.to_thread(run_process_port_inventory, payload)
        case "custom_scenario":
            return await asyncio.to_thread(run_custom_scenario, payload)
        case "service_status_check":
            return await asyncio.to_thread(run_service_status_check, payload)
        case "process_presence_check":
            return await asyncio.to_thread(run_process_presence_check, payload)
        case "port_owner_check":
            return await asyncio.to_thread(run_port_owner_check, payload)
        case "process_resource_snapshot":
            return await asyncio.to_thread(run_process_resource_snapshot, payload)
        case "docker_runtime_access_check":
            return await asyncio.to_thread(run_docker_runtime_access_check, payload)
        case "docker_container_status_check":
            return await asyncio.to_thread(run_docker_container_status_check, payload)
        case "docker_compose_stack_check":
            return await asyncio.to_thread(run_docker_compose_stack_check, payload)
        case "docker_port_mapping_check":
            return await asyncio.to_thread(run_docker_port_mapping_check, payload)
        case _:
            raise ValueError(f"Unsupported task_type: {task_type}")


async def send_heartbeat(websocket: Any) -> None:
    while True:
        await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
        await websocket.send(json.dumps({"type": "heartbeat"}))


async def stream_remote_preview(websocket: Any, preview_controller: RemotePreviewController) -> None:
    while True:
        if not preview_controller.enabled:
            await asyncio.sleep(REMOTE_PREVIEW_IDLE_SLEEP_SECONDS)
            continue

        started_at = perf_counter()
        config_snapshot = preview_controller.snapshot()

        try:
            frame_payload = await asyncio.to_thread(
                capture_remote_preview_frame,
                config_snapshot["max_width"],
                config_snapshot["jpeg_quality"],
            )
            preview_controller.update_monitor_geometry(
                int(frame_payload.get("monitor_left", 0)),
                int(frame_payload.get("monitor_top", 0)),
                int(frame_payload.get("monitor_width", 0)),
                int(frame_payload.get("monitor_height", 0)),
            )
            await websocket.send(
                json.dumps(
                    {
                        "type": "remote_preview_frame",
                        **frame_payload,
                    }
                )
            )
            preview_controller.last_error = None
        except Exception as exc:
            error_text = f"{type(exc).__name__}: {exc}"
            if preview_controller.last_error != error_text:
                preview_controller.last_error = error_text
                await websocket.send(json.dumps({"type": "remote_preview_error", "error": error_text}))

            preview_controller.stop()
            await websocket.send(
                json.dumps(
                    {
                        "type": "remote_preview_status",
                        "active": False,
                        "config": config_snapshot,
                    }
                )
            )
            await asyncio.sleep(1)
            continue

        elapsed = perf_counter() - started_at
        sleep_delay = max(0.0, (1.0 / max(1, config_snapshot["fps"])) - elapsed)
        if sleep_delay > 0:
            await asyncio.sleep(sleep_delay)


async def handle_messages(websocket: Any, preview_controller: RemotePreviewController) -> None:
    async for raw_message in websocket:
        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError:
            continue

        message_type = message.get("type")

        if message_type == "remote_preview_start":
            config = normalize_remote_preview_config(message.get("config"))
            preview_controller.start(config)
            await websocket.send(
                json.dumps(
                    {
                        "type": "remote_preview_status",
                        "active": True,
                        "config": preview_controller.snapshot(),
                    }
                )
            )
            continue

        if message_type == "remote_preview_stop":
            preview_controller.stop()
            await websocket.send(
                json.dumps(
                    {
                        "type": "remote_preview_status",
                        "active": False,
                        "config": preview_controller.snapshot(),
                    }
                )
            )
            continue

        if message_type == "remote_preview_input":
            try:
                await asyncio.to_thread(perform_remote_preview_input, preview_controller, message.get("input"))
                await websocket.send(json.dumps({"type": "remote_preview_input_ack", "accepted": True}))
            except Exception as exc:
                await websocket.send(
                    json.dumps(
                        {
                            "type": "remote_preview_error",
                            "error": f"input failed: {type(exc).__name__}: {exc}",
                        }
                    )
                )
            continue

        if message_type != "new_task":
            continue

        task = message.get("task", {}) or {}
        task_id = task.get("task_id") or task.get("id") or message.get("task_id")
        task_type = str(task.get("task_type", "unknown"))

        try:
            result = await execute_task(task)
            response = {
                "type": "task_result",
                "task_id": task_id,
                "status": "success",
                "result": result,
            }
        except Exception as exc:
            response = {
                "type": "task_result",
                "task_id": task_id,
                "status": "failed",
                "result": build_failed_result(task_type, str(exc)),
            }

        await websocket.send(json.dumps(response))


async def run_agent(agent_id: str) -> None:
    ws_url = WS_URL_TEMPLATE.format(agent_id=agent_id)

    while True:
        try:
            async with websockets.connect(ws_url, ping_interval=None) as websocket:
                preview_controller = RemotePreviewController()
                heartbeat_task = asyncio.create_task(send_heartbeat(websocket))
                preview_task = asyncio.create_task(stream_remote_preview(websocket, preview_controller))
                try:
                    await handle_messages(websocket, preview_controller)
                finally:
                    preview_controller.stop()
                    heartbeat_task.cancel()
                    preview_task.cancel()
                    await asyncio.gather(heartbeat_task, preview_task, return_exceptions=True)
        except (OSError, ConnectionClosed, websockets.WebSocketException):
            await asyncio.sleep(RECONNECT_DELAY_SECONDS)


async def main() -> None:
    agent_id = await get_or_create_agent_id()
    await run_agent(agent_id)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        print(f"Fatal error: {exc}", file=sys.stderr)
        raise

