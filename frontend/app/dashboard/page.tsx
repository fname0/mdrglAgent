"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { AgentCard } from "@/components/agent-card";
import { TopologyRelationsCard } from "@/components/topology-relations-card";
import { fetchAgents, getApiErrorMessage } from "@/lib/api";
import { clearToken } from "@/lib/auth";
import { Agent } from "@/lib/types";
import { useAuthGuard } from "@/lib/use-auth-guard";

type AgentSortMode = "speed" | "stability" | "hostname";

export default function DashboardPage() {
  const router = useRouter();
  const isAuthorized = useAuthGuard();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<AgentSortMode>("hostname");

  const loadAgents = useCallback(async (silent: boolean) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const payload = await fetchAgents();
      setAgents(payload);
      setError(null);
    } catch (loadError) {
      setError(getApiErrorMessage(loadError, "Не удалось загрузить агентов."));
    } finally {
      if (silent) {
        setRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!isAuthorized) {
      return;
    }

    void loadAgents(false);

    const timerId = window.setInterval(() => {
      void loadAgents(true);
    }, 5000);

    return () => window.clearInterval(timerId);
  }, [isAuthorized, loadAgents]);

  const onlineCount = useMemo(() => agents.filter((agent) => agent.status === "online").length, [agents]);
  const offlineCount = useMemo(() => agents.filter((agent) => agent.status === "offline").length, [agents]);
  const sortedAgents = useMemo(() => {
    const collator = new Intl.Collator("ru", { sensitivity: "base" });
    const sorted = [...agents];

    sorted.sort((left, right) => {
      if (sortMode === "hostname") {
        return collator.compare(left.hostname, right.hostname);
      }

      if (sortMode === "speed") {
        const leftSpeed = left.average_execution_seconds;
        const rightSpeed = right.average_execution_seconds;

        if (leftSpeed === null && rightSpeed === null) {
          return collator.compare(left.hostname, right.hostname);
        }

        if (leftSpeed === null) {
          return 1;
        }

        if (rightSpeed === null) {
          return -1;
        }

        if (leftSpeed !== rightSpeed) {
          return leftSpeed - rightSpeed;
        }

        return collator.compare(left.hostname, right.hostname);
      }

      if (left.errors_today !== right.errors_today) {
        return left.errors_today - right.errors_today;
      }

      const leftSpeed = left.average_execution_seconds ?? Number.POSITIVE_INFINITY;
      const rightSpeed = right.average_execution_seconds ?? Number.POSITIVE_INFINITY;
      if (leftSpeed !== rightSpeed) {
        return leftSpeed - rightSpeed;
      }

      return collator.compare(left.hostname, right.hostname);
    });

    return sorted;
  }, [agents, sortMode]);

  function handleLogout() {
    clearToken();
    router.replace("/login");
  }

  if (!isAuthorized) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-slate-400">Проверка сессии...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-4 py-6 md:px-6 md:py-8">
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <header className="rounded-2xl border border-slate-700/70 bg-panel/85 p-5 backdrop-blur">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-slate-100 md:text-3xl">Панель мониторинга агентов</h1>
              <p className="mt-1 text-sm text-slate-400">Откройте карточку агента, чтобы запускать сценарии и смотреть историю диагностики.</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void loadAgents(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-900/60 px-3 py-2 text-sm text-slate-200 transition hover:border-slate-400 hover:bg-slate-800"
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
                Обновить
              </button>

              <button
                type="button"
                onClick={handleLogout}
                className="inline-flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/20"
              >
                <LogOut className="h-4 w-4" />
                Выйти
              </button>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
              <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-emerald-300">
                <Wifi className="h-3.5 w-3.5" />
                Онлайн
              </div>
              <p className="mt-2 text-2xl font-semibold text-emerald-100">{onlineCount}</p>
            </div>

            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3">
              <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-rose-300">
                <WifiOff className="h-3.5 w-3.5" />
                Офлайн
              </div>
              <p className="mt-2 text-2xl font-semibold text-rose-100">{offlineCount}</p>
            </div>

            <div className="rounded-xl border border-slate-600/70 bg-slate-900/50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Всего агентов</p>
              <p className="mt-2 text-2xl font-semibold text-slate-100">{agents.length}</p>
            </div>
          </div>
        </header>

        {error && (
          <div className="rounded-lg border border-rose-500/50 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        {loading && agents.length === 0 ? (
          <div className="rounded-xl border border-slate-700 bg-panel/70 p-5 text-sm text-slate-400">Загрузка агентов...</div>
        ) : null}

        {!loading && agents.length === 0 ? (
          <div className="rounded-xl border border-slate-700 bg-panel/70 p-5 text-sm text-slate-400">
            Агенты не найдены. Проверьте подключение к API.
          </div>
        ) : null}

        <TopologyRelationsCard agents={sortedAgents} />

        {sortedAgents.length > 0 && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-100">Сетка агентов</h2>
              <label className="inline-flex items-center gap-2 text-sm text-slate-300">
                <span className="text-slate-400">Сортировка:</span>
                <select
                  value={sortMode}
                  onChange={(event) => setSortMode(event.target.value as AgentSortMode)}
                  className="rounded-md border border-slate-600 bg-slate-900/80 px-2.5 py-1.5 text-sm text-slate-100 outline-none transition focus:border-sky-400"
                >
                  <option value="speed">По скорости</option>
                  <option value="stability">По стабильности</option>
                  <option value="hostname">По хостнейму</option>
                </select>
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {sortedAgents.map((agent) => (
                <AgentCard key={agent.id} agent={agent} />
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
