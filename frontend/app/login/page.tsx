"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Lock, ShieldCheck, User } from "lucide-react";
import { authenticate } from "@/lib/api";
import { getToken, setToken } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (getToken()) {
      router.replace("/dashboard");
    }
  }, [router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!username.trim() || !password.trim()) {
      setError("Заполните username и password.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const token = await authenticate(username.trim(), password);
      setToken(token);

      const nextPath =
        typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("next") : null;
      const redirectPath = nextPath && nextPath.startsWith("/") ? nextPath : "/dashboard";
      router.replace(redirectPath);
    } catch (authError) {
      const message = authError instanceof Error ? authError.message : "Ошибка входа.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <section className="w-full max-w-md rounded-2xl border border-slate-700/70 bg-panel/90 p-6 shadow-[0_35px_60px_-20px_rgba(9,29,63,0.75)] backdrop-blur">
        <div className="mb-6">
          <div className="mb-3 inline-flex rounded-lg border border-sky-400/40 bg-sky-500/15 p-2 text-sky-200">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <h1 className="text-2xl font-semibold text-slate-100">Мадригал</h1>
          <p className="mt-1 text-sm text-slate-400">Панель мониторинга и управления агентами</p>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Логин</span>
            <div className="relative">
              <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/90 py-2.5 pl-10 pr-3 text-sm text-slate-100 outline-none transition focus:border-accent"
                placeholder="admin"
                autoComplete="username"
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Пароль</span>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/90 py-2.5 pl-10 pr-3 text-sm text-slate-100 outline-none transition focus:border-accent"
                placeholder="********"
                autoComplete="current-password"
              />
            </div>
          </label>

          {error && (
            <div className="inline-flex w-full items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
              <AlertTriangle className="h-4 w-4" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-lg border border-sky-400/40 bg-sky-500/20 px-4 py-2.5 text-sm font-semibold text-sky-100 transition hover:border-sky-300 hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-65"
          >
            {isSubmitting ? "Выполняется вход..." : "Войти"}
          </button>
        </form>
      </section>
    </main>
  );
}