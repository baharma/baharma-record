"use client";

import { formatDateTime, formatDuration } from "@/lib/mediaFormat";
import { sourceTypeLabel, type RecordingEntry } from "@/lib/types";

interface Props {
  recording: RecordingEntry;
  onSelect: () => void;
}

export function RecordingCard({ recording, onSelect }: Props) {
  const hasTranscript = Boolean(
    recording.transcriptSegments && recording.transcriptSegments.length > 0,
  );
  const hasVideo = Boolean(recording.hasVideo);

  return (
    <button
      onClick={onSelect}
      className="rounded-lg border border-zinc-200 p-4 text-left transition-colors hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
    >
      <p className="truncate font-medium">{recording.label}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{formatDateTime(recording.createdAt)}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-800">
          {sourceTypeLabel(recording.sourceType)}
        </span>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono dark:bg-zinc-800">
          {formatDuration(recording.durationSeconds)}
        </span>
        {hasVideo && (
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-800 dark:bg-blue-950 dark:text-blue-400">
            Video
          </span>
        )}
        {hasTranscript ? (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-green-800 dark:bg-green-950 dark:text-green-400">
            Has transcript
          </span>
        ) : (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            Audio only
          </span>
        )}
      </div>
    </button>
  );
}
