"use client";

import type { RecordingEntry } from "@/lib/types";
import { RecordingCard } from "./RecordingCard";

interface Props {
  recordings: RecordingEntry[];
  loading: boolean;
  onSelect: (id: string) => void;
}

export function LibrarySection({ recordings, loading, onSelect }: Props) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Library{recordings.length > 0 && ` (${recordings.length})`}
      </h2>
      {loading ? (
        <p className="text-sm text-zinc-500">Loading recordings…</p>
      ) : recordings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-10 text-center dark:border-zinc-700">
          <p className="text-zinc-500">No recordings yet.</p>
          <p className="mt-1 text-sm text-zinc-400">
            Click &quot;+ Record New Source&quot; above to get started.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {recordings.map((recording) => (
            <RecordingCard
              key={recording.id}
              recording={recording}
              onSelect={() => onSelect(recording.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
