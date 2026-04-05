"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, LogOut } from "lucide-react";
import { RemotePreviewPanel } from "@/components/remote-preview-panel";
import { fetchAgents } from "@/lib/api";
import { clearToken } from "@/lib/auth";
import { Agent } from "@/lib/types";
import { useAuthGuard } from "@/lib/use-auth-guard";

export default function RemoteAccessPage() {
  const params = useParams<{ id: string }>();
  const rawId = params?.id;
  const agentId = Array.isArray(rawId) ? rawId[0] : rawId;
  const router = useRouter();
  const isAuthorized = useAuthGuard();

  const [agent, setAgent] = useState<Agent | null>(null);

  const loadAgent = useCallback(async () => {
    if (!agentId) {
      return;
    }
    try {
      const agents = await fetchAgents();
      const matched = agents.find((item) => item.id === agentId) ?? null;
      setAgent(matched);
    } catch {
      setAgent(null);
    }
  }, [agentId]);

  useEffect(() => {
    if (!isAuthorized || !agentId) {
      return;
    }
    void loadAgent();
  }, [agentId, isAuthorized, loadAgent]);

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

  if (!agentId) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-rose-300">Некорректный ID агента.</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-4 py-6 md:px-6 md:py-8">
      <div className="mx-auto w-full max-w-7xl space-y-6">
        <header className="rounded-2xl border border-slate-700/70 bg-panel/85 p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <Link
                href={`/agent/${agentId}`}
                className="mb-3 inline-flex items-center gap-2 text-sm text-slate-300 transition hover:text-sky-200"
              >
                <ArrowLeft className="h-4 w-4" />
                Назад к агенту
              </Link>
              <h1 className="text-2xl font-semibold text-slate-100">Удалённый доступ</h1>
              <p className="mt-2 text-sm text-slate-400">Агент: {agent?.hostname ?? agentId}</p>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm font-semibold text-rose-200 transition hover:bg-rose-500/20"
            >
              <LogOut className="h-4 w-4" />
              Выйти
            </button>
          </div>
        </header>

        <RemotePreviewPanel agentId={agentId} />
      </div>
    </main>
  );
}

