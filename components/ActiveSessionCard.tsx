"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRecordingSession } from "@/hooks/useRecordingSession";
import { formatDuration } from "@/lib/mediaFormat";
import { sourceTypeLabel, type PendingSession, type RecordingEntry } from "@/lib/types";
import { TranscriptSourceBadge } from "./TranscriptSourceBadge";

interface Props {
  session: PendingSession;
  onFinalized: (entry: RecordingEntry) => void;
  onRemove: (id: string) => void;
  onWarning: (message: string) => void;
}

/** How close to the bottom (px) still counts as "following the live feed". */
const STICK_TO_BOTTOM_THRESHOLD = 24;

export function ActiveSessionCard({ session, onFinalized, onRemove, onWarning }: Props) {
  const handleFinalized = useCallback(
    (entry: RecordingEntry) => {
      onFinalized(entry);
      onRemove(session.id);
    },
    [onFinalized, onRemove, session.id],
  );

  const { status, elapsedSeconds, transcriptSegments, interimText, tabInterimText, stop } =
    useRecordingSession({
      sourceType: session.sourceType,
      label: session.label,
      stream: session.stream,
      enableTranscript: session.enableTranscript,
      recognitionLang: session.recognitionLang,
      secondaryStream: session.secondaryStream,
      liveCloudTab: session.liveCloudTab,
      extraCleanup: session.extraCleanup,
      onFinalized: handleFinalized,
      onWarning,
    });

  const hasVideo = session.stream.getVideoTracks().length > 0;
  const isMixed = session.sourceType === "mixed";
  const interimLine = [interimText, tabInterimText].filter(Boolean).join(" ");

  // Auto-scrolls to the newest line as it arrives, but only while the user
  // is already at (or near) the bottom — so scrolling up to re-read earlier
  // parts of the conversation during a live call isn't yanked back down by
  // the next word that comes in.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD;
  }

  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [transcriptSegments, interimLine]);

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
            {hasVideo ? " · Video" : ""}
            {" · "}
            {session.enableTranscript ? "Live transcript" : "Audio only"}
          </p>
        </div>
        <p className="shrink-0 font-mono text-lg tabular-nums">{formatDuration(elapsedSeconds)}</p>
      </div>

      {session.enableTranscript && (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="mt-2 max-h-64 min-h-[2.5rem] space-y-1 overflow-y-auto rounded-md border border-red-100 bg-white/60 p-2 text-sm dark:border-red-900/40 dark:bg-black/10"
        >
          {transcriptSegments.length === 0 && !interimLine ? (
            <p className="text-zinc-500">Listening…</p>
          ) : (
            <>
              {transcriptSegments.map((segment, i) => (
                <p key={i} className="text-zinc-700 dark:text-zinc-300">
                  <span className="mr-2 font-mono text-xs text-zinc-400">
                    {formatDuration(segment.time)}
                  </span>
                  {isMixed && <TranscriptSourceBadge source={segment.source} />}
                  {segment.text}
                </p>
              ))}
              {interimLine && <p className="italic text-zinc-400">{interimLine}</p>}
            </>
          )}
        </div>
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
