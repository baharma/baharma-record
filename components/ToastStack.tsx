"use client";

import type { ToastItem, ToastKind } from "@/hooks/useToasts";

const KIND_STYLES: Record<ToastKind, string> = {
  error: "bg-red-600 text-white",
  success: "bg-green-600 text-white",
  info: "bg-zinc-800 text-white",
};

interface Props {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export function ToastStack({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === "error" ? "alert" : "status"}
          className={`flex items-start gap-3 rounded-lg px-4 py-3 text-sm shadow-lg ${KIND_STYLES[toast.kind]}`}
        >
          <p className="flex-1">{toast.message}</p>
          <button
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss"
            className="opacity-80 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
