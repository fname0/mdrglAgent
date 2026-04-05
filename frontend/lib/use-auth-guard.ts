"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getToken } from "@/lib/auth";

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  window.addEventListener("storage", onStoreChange);
  return () => window.removeEventListener("storage", onStoreChange);
}

function getSnapshot(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return getToken();
}

export function useAuthGuard(): boolean {
  const pathname = usePathname();
  const router = useRouter();
  const token = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const isAuthorized = Boolean(token);

  useEffect(() => {
    if (isAuthorized) {
      return;
    }

    const safePath = pathname && pathname !== "/login" ? pathname : "/dashboard";
    router.replace(`/login?next=${encodeURIComponent(safePath)}`);
  }, [isAuthorized, pathname, router]);

  return isAuthorized;
}