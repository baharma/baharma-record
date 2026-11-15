"use client";

import { memo } from "react";
import { formatDuration } from "@/lib/mediaFormat";
import type { TranscriptSegment } from "@/lib/types";
import { TranscriptSourceBadge } from "./TranscriptSourceBadge";

/**
 * The live card's three lists as memoized components. The card re-renders
 * several times per second on interim transcript updates, and the on-device
 * transcription path taps audio on the main thread (ScriptProcessorNode), so
 * every unnecessary list re-render competes directly with capture. Each
 * component re-renders only when its own data changes: interim updates re-
 * render the card but skip these lists, translation/summary updates skip the
 * transcript list, and so on. The italic interim line is deliberately NOT
 * part of LiveTranscriptLines — it changes on every speech event and would
 * defeat the memoization; the card renders it as a sibling.
 */

export const LiveTranscriptLines = memo(function LiveTranscriptLines({
  segments,
  isMixed,
}: {
  segments: TranscriptSegment[];
  isMixed: boolean;
}) {
  return (
    <>
      {segments.map((segment, i) => (
        <p key={i} className="text-zinc-700 dark:text-zinc-300">
          <span className="mr-2 font-mono text-xs text-zinc-400">
            {formatDuration(segment.time)}
          </span>
          {isMixed && <TranscriptSourceBadge source={segment.source} />}
          {segment.text}
        </p>
      ))}
    </>
  );
});

export const LiveTranslationLines = memo(function LiveTranslationLines({
  segments,
  translations,
  isMixed,
}: {
  segments: TranscriptSegment[];
  translations: Map<TranscriptSegment, string>;
  isMixed: boolean;
}) {
  return (
    <>
      {segments.map((segment, i) => (
        <p key={i} className="text-zinc-700 dark:text-zinc-300">
          <span className="mr-2 font-mono text-xs text-zinc-400">
            {formatDuration(segment.time)}
          </span>
          {isMixed && <TranscriptSourceBadge source={segment.source} />}
          {translations.get(segment) ?? <span className="text-zinc-400">…</span>}
        </p>
      ))}
    </>
  );
});

export const LiveSummaryText = memo(function LiveSummaryText({ summary }: { summary: string }) {
  return (
    <p className="whitespace-pre-wrap leading-relaxed text-zinc-700 dark:text-zinc-300">
      {summary}
    </p>
  );
});
