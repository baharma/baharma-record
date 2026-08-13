"use client";

import { useStorageEstimate } from "@/hooks/useStorageEstimate";
import { formatBytes } from "@/lib/mediaFormat";

export function StorageEstimateBar({ refreshKey }: { refreshKey: number }) {
  const { usage, quota, supported } = useStorageEstimate(refreshKey);

  if (!supported || quota === 0) return null;

  const percent = Math.min(100, (usage / quota) * 100);
  const nearLimit = percent >= 80;

  return (
    <div className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-zinc-600 dark:text-zinc-400">Browser storage used</span>
        <span
          className={
            nearLimit
              ? "font-medium text-amber-600 dark:text-amber-400"
              : "text-zinc-600 dark:text-zinc-400"
          }
        >
          {formatBytes(usage)} / {formatBytes(quota)}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
        <div
          className={`h-full rounded-full ${nearLimit ? "bg-amber-500" : "bg-zinc-500"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {nearLimit && (
        <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
          You&apos;re approaching this browser&apos;s storage limit. Consider exporting and
          removing old recordings.
        </p>
      )}
    </div>
  );
}
