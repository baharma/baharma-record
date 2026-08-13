"use client";

import { useCallback, useState } from "react";
import { generateId } from "@/lib/id";

export type ToastKind = "error" | "success" | "info";

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
}

const AUTO_DISMISS_MS: Record<ToastKind, number> = {
  error: 8000,
  success: 4000,
  info: 5000,
};

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = generateId();
      setToasts((prev) => [...prev, { id, kind, message }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS[kind]);
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}
