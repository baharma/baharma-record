"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDuration } from "@/lib/mediaFormat";
import type { TranscriptSegment } from "@/lib/types";
import { TranscriptSourceBadge } from "./TranscriptSourceBadge";

interface Props {
  segments: TranscriptSegment[] | null;
  freeform: boolean;
  showSource: boolean;
  currentTime: number;
  onSeek: (time: number) => void;
  onExit: () => void;
}

/**
 * Compact transcript shown beside the video while the player wrapper is
 * fullscreen. Native <video> fullscreen hides everything but the video, so the
 * modal fullscreens a wrapper instead and renders this next to it.
 */
export function FullscreenTranscript({
  segments,
  freeform,
  showSource,
  currentTime,
  onSeek,
  onExit,
}: Props) {
  const [query, setQuery] = useState("");
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const q = query.trim().toLowerCase();

  const activeIndex = useMemo(() => {
    if (freeform || !segments) return -1;
    let idx = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].time <= currentTime) idx = i;
      else break;
    }
    return idx;
  }, [segments, currentTime, freeform]);

  useEffect(() => {
    if (!q) activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIndex, q]);

  const visible = (segments ?? [])
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => !q || segment.text.toLowerCase().includes(q));

  return (
    <aside className="flex h-full w-96 max-w-[40vw] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950 text-zinc-100">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 p-3">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search transcript…"
          aria-label="Search transcript"
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-transparent px-2 py-1.5 text-sm"
        />
        <button
          onClick={onExit}
          className="shrink-0 rounded-md border border-zinc-700 px-2 py-1.5 text-sm hover:bg-zinc-800"
        >
          Exit
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {!segments || segments.length === 0 ? (
          <p className="p-2 text-sm italic text-zinc-500">No transcript text yet.</p>
        ) : freeform ? (
          <p className="whitespace-pre-wrap p-2 text-sm leading-relaxed">{segments[0].text}</p>
        ) : visible.length === 0 ? (
          <p className="p-2 text-sm italic text-zinc-500">No matches.</p>
        ) : (
          visible.map(({ segment, index }) => (
            <button
              key={index}
              ref={index === activeIndex ? activeRef : undefined}
              onClick={() => onSeek(segment.time)}
              className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                index === activeIndex ? "bg-amber-900/40" : "hover:bg-zinc-800"
              }`}
            >
              <span className="mr-2 font-mono text-xs text-zinc-500">
                {formatDuration(segment.time)}
              </span>
              {showSource && <TranscriptSourceBadge source={segment.source} />}
              {segment.text}
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
