"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TranscriberStatus } from "@/hooks/useTranscriber";
import { formatDuration } from "@/lib/mediaFormat";
import { defaultSpeechLanguageCode, SPEECH_LANGUAGES } from "@/lib/speechLanguage";
import type { ModelFileProgress } from "@/lib/transcription/types";
import type { RecordingEntry, TranscriptSegment } from "@/lib/types";

interface Props {
  recording: RecordingEntry;
  currentTime: number;
  onSeek: (time: number) => void;
  onSaveTranscript: (segments: TranscriptSegment[]) => Promise<void> | void;
  onAutoTranscribe: (language: string) => void;
  isTranscribing: boolean;
  transcriberBusyElsewhere: boolean;
  transcriberStatus: TranscriberStatus;
  transcriberProgress: ModelFileProgress | null;
  hasPreviousTranscript: boolean;
  onUndoTranscript: () => void;
}

function progressLabel(status: TranscriberStatus, progress: ModelFileProgress | null): string {
  if (status === "decoding") return "Preparing audio…";
  if (status === "loading-model") {
    if (progress?.file && typeof progress.loaded === "number" && typeof progress.total === "number" && progress.total > 0) {
      const percent = Math.round((progress.loaded / progress.total) * 100);
      return `Downloading speech-to-text model… ${progress.file} (${percent}%)`;
    }
    return "Downloading speech-to-text model… (first use only, then cached for offline use)";
  }
  if (status === "transcribing") return "Transcribing audio…";
  return "Working…";
}

function transcriptToPlainText(recording: RecordingEntry): string {
  const segments = recording.transcriptSegments;
  if (!segments || segments.length === 0) return "";
  if (recording.transcriptEditedManually) return segments[0].text;
  return segments.map((segment) => segment.text).join(" ");
}

function sourceBadge(source: TranscriptSegment["source"]) {
  if (!source) return null;
  const isMic = source === "mic";
  return (
    <span
      className={`mr-2 rounded px-1 py-0.5 text-[10px] font-semibold ${
        isMic
          ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
          : "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-400"
      }`}
    >
      {isMic ? "MIC" : "TAB"}
    </span>
  );
}

export function TranscriptPanel({
  recording,
  currentTime,
  onSeek,
  onSaveTranscript,
  onAutoTranscribe,
  isTranscribing,
  transcriberBusyElsewhere,
  transcriberStatus,
  transcriberProgress,
  hasPreviousTranscript,
  onUndoTranscript,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [language, setLanguage] = useState(() => defaultSpeechLanguageCode());
  const [copied, setCopied] = useState(false);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const segments = recording.transcriptSegments;
  const hasSegments = Boolean(segments && segments.length > 0);
  const isFreeform = recording.transcriptEditedManually;
  const isMixed = recording.sourceType === "mixed";

  // "mixed" recordings get the mic side automatically (live transcript);
  // the tab side needs an explicit Whisper pass over the isolated audio
  // recorded alongside it. That audio is kept around (not discarded after
  // first use) so this can be re-run any time, e.g. with a different
  // language — each run replaces only the tab-sourced segments.
  const tabAlreadyCovered = isFreeform || Boolean(segments?.some((s) => s.source === "tab"));
  const canTranscribeTab = isMixed && Boolean(recording.secondaryAudioBlob);
  const showTranscribeControls = isMixed ? canTranscribeTab : true;
  const transcribeButtonLabel = isTranscribing
    ? "Transcribing…"
    : isMixed
      ? tabAlreadyCovered
        ? "Re-transcribe Tab Audio"
        : "Transcribe Tab Audio"
      : hasSegments
        ? "Re-transcribe Audio"
        : "Transcribe Audio";

  const activeIndex = useMemo(() => {
    if (isFreeform || !segments || segments.length === 0) return -1;
    let idx = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].time <= currentTime) idx = i;
      else break;
    }
    return idx;
  }, [segments, currentTime, isFreeform]);

  useEffect(() => {
    if (activeIndex >= 0) {
      activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeIndex]);

  function startEditing() {
    if (segments && segments.length > 0) {
      setDraft(isFreeform ? segments[0].text : segments.map((s) => s.text).join("\n"));
    } else {
      setDraft("");
    }
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    try {
      const text = draft.trim();
      await onSaveTranscript(text.length > 0 ? [{ time: 0, text }] : []);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function copyTranscript() {
    const text = transcriptToPlainText(recording);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied/unavailable — fail silently, no
      // destructive fallback needed since the button is purely additive.
    }
  }

  if (editing) {
    return (
      <div className="flex h-full flex-col">
        <textarea
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type or paste the transcript here…"
          className="w-full flex-1 resize-none rounded-md border border-zinc-300 bg-transparent p-3 text-sm dark:border-zinc-700"
        />
        <div className="mt-3 flex gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {saving ? "Saving…" : "Save Transcript"}
          </button>
          <button
            onClick={() => setEditing(false)}
            disabled={saving}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {!hasSegments && (
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          {recording.sourceType === "tab" ? (
            <p>
              Tab/window recordings don&apos;t get a live transcript while recording — the
              browser&apos;s speech recognition can only listen to the microphone, not shared tab
              audio. Use &quot;Transcribe Audio&quot; below to generate one automatically from the
              recording (runs entirely in your browser), or add one manually.
            </p>
          ) : isMixed ? (
            <p>
              No mic speech was detected and the tab audio hasn&apos;t been transcribed yet. Use
              &quot;Transcribe Tab Audio&quot; below to generate a transcript from the tab side, or
              add one manually.
            </p>
          ) : (
            <p>
              No transcript was captured for this recording. Use &quot;Transcribe Audio&quot;
              below to generate one automatically, or add one manually.
            </p>
          )}
        </div>
      )}
      {isMixed && canTranscribeTab && (
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          {tabAlreadyCovered
            ? "Not happy with the tab transcript? Pick a different language and click “Re-transcribe Tab Audio” to try again."
            : "The mic side is transcribed below. Use “Transcribe Tab Audio” to also transcribe what was happening in the tab, merged into the same transcript."}
        </div>
      )}
      {hasSegments && !isMixed && (
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          Wrong result? Pick a different language and click &quot;Re-transcribe Audio&quot;, or
          use &quot;Undo&quot; below to go back to what was there before.
        </div>
      )}

      {isTranscribing && (
        <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
          {progressLabel(transcriberStatus, transcriberProgress)}
        </div>
      )}

      <div className="flex-1 overflow-y-auto pr-1">
        {!hasSegments ? (
          <p className="text-sm italic text-zinc-400">No transcript text yet.</p>
        ) : isFreeform ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{segments![0].text}</p>
        ) : (
          <div className="space-y-1">
            {segments!.map((segment, i) => (
              <button
                key={i}
                ref={i === activeIndex ? activeRef : undefined}
                onClick={() => onSeek(segment.time)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  i === activeIndex
                    ? "bg-amber-100 dark:bg-amber-900/40"
                    : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
              >
                <span className="mr-2 font-mono text-xs text-zinc-400">
                  {formatDuration(segment.time)}
                </span>
                {isMixed && sourceBadge(segment.source)}
                {segment.text}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {showTranscribeControls && (
          <>
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              disabled={isTranscribing || transcriberBusyElsewhere}
              className="rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
              title="Language spoken in this recording"
            >
              {SPEECH_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </select>
            <button
              onClick={() => onAutoTranscribe(language)}
              disabled={isTranscribing || transcriberBusyElsewhere}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              title={
                transcriberBusyElsewhere
                  ? "Another recording is currently being transcribed"
                  : undefined
              }
            >
              {transcribeButtonLabel}
            </button>
          </>
        )}
        {hasPreviousTranscript && (
          <button
            onClick={onUndoTranscript}
            disabled={isTranscribing}
            className="rounded-md border border-amber-300 px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/30"
            title="Revert to the transcript that was there before your last change"
          >
            Undo
          </button>
        )}
        {hasSegments && (
          <button
            onClick={copyTranscript}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {copied ? "Copied!" : "Copy Transcript"}
          </button>
        )}
        <button
          onClick={startEditing}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {hasSegments ? "Edit Transcript" : "Add Transcript Manually"}
        </button>
      </div>
    </div>
  );
}
