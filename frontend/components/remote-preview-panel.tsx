"use client";

import { KeyboardEvent as ReactKeyboardEvent, MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  RemotePreviewFrame,
  RemotePreviewInputPayload,
  RemotePreviewInputResult,
  RemotePreviewStatus,
  fetchRemotePreviewFrame,
  fetchRemotePreviewStatus,
  getApiErrorMessage,
  sendRemotePreviewInput,
  startRemotePreview,
  stopRemotePreview,
} from "@/lib/api";

interface RemotePreviewPanelProps {
  agentId: string;
}

interface InputPoint {
  xRatio: number;
  yRatio: number;
}

function formatTimestamp(value: string): string {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(parsed);
}

function frameResolution(frame: RemotePreviewFrame | null): string {
  if (!frame) {
    return "-";
  }
  if (frame.last_frame_width && frame.last_frame_height) {
    return `${frame.last_frame_width} x ${frame.last_frame_height}`;
  }
  return "-";
}

function mapPointerToImage(clientX: number, clientY: number, imageElement: HTMLImageElement): InputPoint | null {
  const bounds = imageElement.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) {
    return null;
  }

  const naturalWidth = imageElement.naturalWidth;
  const naturalHeight = imageElement.naturalHeight;
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return null;
  }

  const boxWidth = bounds.width;
  const boxHeight = bounds.height;
  const imageAspect = naturalWidth / naturalHeight;
  const boxAspect = boxWidth / boxHeight;

  let renderedWidth = boxWidth;
  let renderedHeight = boxHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (imageAspect > boxAspect) {
    renderedHeight = boxWidth / imageAspect;
    offsetY = (boxHeight - renderedHeight) / 2;
  } else {
    renderedWidth = boxHeight * imageAspect;
    offsetX = (boxWidth - renderedWidth) / 2;
  }

  const localX = clientX - bounds.left - offsetX;
  const localY = clientY - bounds.top - offsetY;

  if (localX < 0 || localY < 0 || localX > renderedWidth || localY > renderedHeight) {
    return null;
  }

  return {
    xRatio: Math.min(1, Math.max(0, localX / renderedWidth)),
    yRatio: Math.min(1, Math.max(0, localY / renderedHeight)),
  };
}

function mapKeyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3).toLowerCase();
  }

  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }

  if (/^Numpad[0-9]$/.test(code)) {
    return code.slice(6);
  }

  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return code.toLowerCase();
  }

  const codeMap: Record<string, string> = {
    Space: "space",
    Enter: "enter",
    Tab: "tab",
    Backspace: "backspace",
    Escape: "esc",
    Delete: "delete",
    Insert: "insert",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backquote: "`",
  };

  return codeMap[code] ?? null;
}

function mapKeyFromValue(key: string): string | null {
  const normalized = key.toLowerCase();

  const keyMap: Record<string, string> = {
    enter: "enter",
    return: "enter",
    escape: "esc",
    esc: "esc",
    tab: "tab",
    backspace: "backspace",
    delete: "delete",
    del: "delete",
    insert: "insert",
    home: "home",
    end: "end",
    pageup: "pageup",
    pagedown: "pagedown",
    arrowup: "up",
    arrowdown: "down",
    arrowleft: "left",
    arrowright: "right",
    space: "space",
  };

  if (Object.prototype.hasOwnProperty.call(keyMap, normalized)) {
    return keyMap[normalized];
  }

  if (key.length === 1 && /[\x20-\x7E]/.test(key)) {
    return key === " " ? "space" : key.toLowerCase();
  }

  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) {
    return key.toLowerCase();
  }

  return null;
}

function buildKeyboardPayload(
  event: ReactKeyboardEvent<HTMLDivElement>,
): Extract<RemotePreviewInputPayload, { action: "key_tap" | "text_input" }> | null {
  const modifierCodes = new Set([
    "ShiftLeft",
    "ShiftRight",
    "ControlLeft",
    "ControlRight",
    "AltLeft",
    "AltRight",
    "MetaLeft",
    "MetaRight",
  ]);
  if (modifierCodes.has(event.code)) {
    return null;
  }

  const isPlainTextKey = !event.ctrlKey && !event.altKey && !event.metaKey && event.key.length === 1;
  if (isPlainTextKey && event.key !== "\u0000") {
    return {
      action: "text_input",
      text: event.key,
    };
  }

  const keyFromCode = mapKeyFromCode(event.code);
  const keyToken = keyFromCode ?? mapKeyFromValue(event.key);
  if (!keyToken) {
    return null;
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) {
    modifiers.push("ctrl");
  }
  if (event.altKey) {
    modifiers.push("alt");
  }
  if (event.shiftKey) {
    modifiers.push("shift");
  }
  if (event.metaKey) {
    modifiers.push("win");
  }

  if (!modifiers.includes(keyToken)) {
    modifiers.push(keyToken);
  }

  return {
    action: "key_tap",
    key: modifiers.join("+"),
  };
}

export function RemotePreviewPanel({ agentId }: RemotePreviewPanelProps) {
  const [status, setStatus] = useState<RemotePreviewStatus | null>(null);
  const [frame, setFrame] = useState<RemotePreviewFrame | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sendingInput, setSendingInput] = useState(false);
  const [controlEnabled, setControlEnabled] = useState(false);
  const [pointerEnabled, setPointerEnabled] = useState(true);
  const [keyboardEnabled, setKeyboardEnabled] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [inputInfo, setInputInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const previewRef = useRef<HTMLDivElement | null>(null);

  const isActive = Boolean(status?.active);
  const imageSrc = useMemo(() => {
    if (!frame?.image_base64) {
      return null;
    }
    return `data:image/jpeg;base64,${frame.image_base64}`;
  }, [frame]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  async function loadStatus() {
    try {
      const payload = await fetchRemotePreviewStatus(agentId);
      setStatus(payload);
      setError(null);
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, "Не удалось загрузить статус remote preview."));
    }
  }

  async function loadFrame() {
    try {
      const payload = await fetchRemotePreviewFrame(agentId);
      setFrame(payload);
      setStatus((prev) => (prev ? { ...prev, ...payload } : payload));
      setError(null);
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, "Не удалось получить кадр remote preview."));
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setLoading(true);
      try {
        const payload = await fetchRemotePreviewStatus(agentId);
        if (cancelled) {
          return;
        }
        setStatus(payload);
        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setError(getApiErrorMessage(loadError, "Не удалось загрузить статус remote preview."));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    let cancelled = false;

    const pullFrame = async () => {
      if (cancelled) {
        return;
      }
      await loadFrame();
    };

    void pullFrame();
    const timerId = window.setInterval(() => {
      void pullFrame();
    }, 700);

    return () => {
      cancelled = true;
      window.clearInterval(timerId);
    };
  }, [agentId, isActive]);

  async function sendInput(
    payload: RemotePreviewInputPayload,
    options?: { successMessage?: string },
  ): Promise<RemotePreviewInputResult | null> {
    setSendingInput(true);

    try {
      const result = await sendRemotePreviewInput(agentId, payload);
      setInputInfo(result.accepted ? options?.successMessage ?? "Событие отправлено на агент." : "Событие отклонено агентом.");
      setError(null);
      return result;
    } catch (inputError) {
      setError(getApiErrorMessage(inputError, "Не удалось отправить событие управления на агент."));
      return null;
    } finally {
      setSendingInput(false);
    }
  }

  async function handleStart() {
    setBusy(true);
    try {
      const payload = await startRemotePreview(agentId, {
        fps: 3,
        max_width: 1280,
        jpeg_quality: 50,
      });
      setStatus(payload);
      await loadFrame();
      setError(null);
      setInputInfo(null);
    } catch (startError) {
      setError(getApiErrorMessage(startError, "Не удалось запустить remote preview."));
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    setBusy(true);
    try {
      const payload = await stopRemotePreview(agentId);
      setStatus(payload);
      setControlEnabled(false);
      setError(null);
      setInputInfo(null);
    } catch (stopError) {
      setError(getApiErrorMessage(stopError, "Не удалось остановить remote preview."));
    } finally {
      setBusy(false);
    }
  }

  async function toggleFullscreen() {
    const element = previewRef.current;
    if (!element) {
      return;
    }

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await element.requestFullscreen();
        element.focus();
      }
      setError(null);
    } catch (fullscreenError) {
      setError(getApiErrorMessage(fullscreenError, "Не удалось переключить полноэкранный режим."));
    }
  }

  function handleFrameClick(event: MouseEvent<HTMLImageElement>) {
    if (!controlEnabled || !pointerEnabled || !isActive || !imageSrc) {
      return;
    }

    const point = mapPointerToImage(event.clientX, event.clientY, event.currentTarget);
    if (!point) {
      return;
    }

    previewRef.current?.focus();
    void sendInput(
      {
        action: "mouse_click",
        x_ratio: point.xRatio,
        y_ratio: point.yRatio,
        button: "left",
      },
      {
        successMessage: "Левый клик отправлен на агент.",
      },
    );
  }

  function handleFrameContextMenu(event: MouseEvent<HTMLImageElement>) {
    if (!controlEnabled || !pointerEnabled || !isActive || !imageSrc) {
      return;
    }

    event.preventDefault();
    const point = mapPointerToImage(event.clientX, event.clientY, event.currentTarget);
    if (!point) {
      return;
    }

    previewRef.current?.focus();
    void sendInput(
      {
        action: "mouse_click",
        x_ratio: point.xRatio,
        y_ratio: point.yRatio,
        button: "right",
      },
      {
        successMessage: "Правый клик отправлен на агент.",
      },
    );
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!controlEnabled || !keyboardEnabled || !isActive) {
      return;
    }

    if (event.repeat) {
      return;
    }

    const payload = buildKeyboardPayload(event);
    if (!payload) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const keyLabel = payload.action === "text_input" ? payload.text : payload.key.toUpperCase();
    void sendInput(payload, {
      successMessage: `Клавиша отправлена: ${keyLabel}`,
    });
  }

  return (
    <section className="rounded-xl border border-slate-700/70 bg-panel/85 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Удалённый доступ (Этап 3)</h2>
          <p className="text-xs text-slate-400">Live-просмотр экрана, клики мышью и передача клавиш.</p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadStatus()}
            disabled={loading || busy}
            className="rounded-lg border border-slate-600 bg-slate-900/70 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Обновить
          </button>

          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            disabled={!imageSrc}
            className="rounded-lg border border-slate-600 bg-slate-900/70 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-slate-500 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isFullscreen ? "Свернуть" : "На весь экран"}
          </button>

          {isActive ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              disabled={loading || busy}
              className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Остановить
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={loading || busy}
              className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Запустить
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-200">
          <input
            type="checkbox"
            checked={controlEnabled}
            onChange={(event) => setControlEnabled(event.target.checked)}
            disabled={!isActive || loading || busy}
            className="h-3.5 w-3.5"
          />
          Управление
        </label>

        <label className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-200">
          <input
            type="checkbox"
            checked={pointerEnabled}
            onChange={(event) => setPointerEnabled(event.target.checked)}
            disabled={!controlEnabled || !isActive || loading || busy}
            className="h-3.5 w-3.5"
          />
          Мышь (клики)
        </label>

        <label className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-200">
          <input
            type="checkbox"
            checked={keyboardEnabled}
            onChange={(event) => setKeyboardEnabled(event.target.checked)}
            disabled={!controlEnabled || !isActive || loading || busy}
            className="h-3.5 w-3.5"
          />
          Клавиатура
        </label>
      </div>

      {inputInfo ? (
        <div className="mt-3 rounded-lg border border-sky-500/50 bg-sky-500/10 px-3 py-2 text-sm text-sky-200">
          {inputInfo}
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      {status?.last_error ? (
        <div className="mt-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          Ошибка агента: {status.last_error}
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Статус</p>
          <p className={`mt-1 text-sm font-semibold ${isActive ? "text-emerald-300" : "text-slate-300"}`}>
            {isActive ? "active" : "inactive"}
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">FPS / Quality</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">
            {status ? `${status.fps} / ${status.jpeg_quality}` : "-"}
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Resolution</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">{frameResolution(frame)}</p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Captured At</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">
            {formatTimestamp(frame?.last_frame_captured_at || "")}
          </p>
        </div>
      </div>

      <div
        ref={previewRef}
        tabIndex={controlEnabled && keyboardEnabled && isActive ? 0 : -1}
        onKeyDown={handleKeyDown}
        className={`${isFullscreen ? "h-screen w-screen rounded-none border-none bg-black" : "mt-4 rounded-xl border bg-slate-950/70"} overflow-hidden outline-none transition ${
          controlEnabled && keyboardEnabled && isActive
            ? "border-sky-500/40 focus-visible:ring-2 focus-visible:ring-sky-500/40"
            : "border-slate-700"
        }`}
      >
        {imageSrc ? (
          <img
            src={imageSrc}
            alt="Remote preview frame"
            onClick={handleFrameClick}
            onContextMenu={handleFrameContextMenu}
            className={`mx-auto block h-auto w-auto max-w-full ${isFullscreen ? "max-h-screen" : "max-h-[70vh]"} ${
              controlEnabled && pointerEnabled ? "cursor-crosshair" : ""
            }`}
          />
        ) : (
          <div className="flex min-h-[280px] items-center justify-center px-4 py-8 text-sm text-slate-400">
            {isActive ? "Ожидаем первый кадр от агента..." : "Превью не запущено."}
          </div>
        )}
      </div>

      {controlEnabled ? (
        <p className="mt-2 text-xs text-slate-500">
          {pointerEnabled ? "ЛКМ/ПКМ по кадру передают клики. " : ""}
          {keyboardEnabled ? "Кликните в область превью и нажимайте клавиши для передачи на агент. " : ""}
          {sendingInput ? "Отправка..." : ""}
        </p>
      ) : null}
    </section>
  );
}
