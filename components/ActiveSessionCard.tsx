"use client";

import { useCallback } from "react";
import { useRecordingSession } from "@/hooks/useRecordingSession";
import { formatDuration } from "@/lib/mediaFormat";
import { sourceTypeLabel, type PendingSession, type RecordingEntry } from "@/lib/types";

interface Props {
  session: PendingSession;
  onFinalized: (entry: RecordingEntry) => void;
  onRemove: (id: string) => void;
  onWarning: (message: string) => void;
}

export function ActiveSessionCard({ session, onFinalized, onRemove, onWarning }: Props) {
  const handleFinalized = useCallback(
    (entry: RecordingEntry) => {
      onFinalized(entry);
      onRemove(session.id);
    },
    [onFinalized, onRemove, session.id],
  );

  const { status, elapsedSeconds, transcriptSegments, interimText, stop } = useRecordingSession({
    sourceType: session.sourceType,
    label: session.label,
    stream: session.stream,
    enableTranscript: session.enableTranscript,
    recognitionLang: session.recognitionLang,
    secondaryStream: session.secondaryStream,
    extraCleanup: session.extraCleanup,
    onFinalized: handleFinalized,
    onWarning,
  });

  const latestTranscript = [transcriptSegments.at(-1)?.text, interimText]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="rounded-lg border border-red-200 bg-red-50/50 p-4 dark:border-red-900 dark:bg-red-950/20">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-600" />
            </span>
            <p className="truncate font-medium">{session.label}</p>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500">
            {sourceTypeLabel(session.sourceType)}
            {" · "}
            {session.enableTranscript ? "Live transcript" : "Audio only"}
          </p>
        </div>
        <p className="shrink-0 font-mono text-lg tabular-nums">{formatDuration(elapsedSeconds)}</p>
      </div>

      {session.enableTranscript && (
        <p className="mt-2 line-clamp-2 min-h-[2.5rem] text-sm text-zinc-600 dark:text-zinc-400">
          {latestTranscript || "Listening…"}
        </p>
      )}

      <button
        onClick={stop}
        disabled={status !== "recording"}
        className="mt-3 w-full rounded-md bg-red-600 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "recording" ? "Stop" : "Stopping…"}
      </button>
    </div>
  );
}
