"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveAiText, type LiveAiTextResult } from "@/hooks/useLiveAiText";
import { useRecordingSession } from "@/hooks/useRecordingSession";
import {
  AI_TARGET_LANGUAGE_STORAGE_KEY,
  LIVE_AI_ENABLED_STORAGE_KEY,
  isLlmReady,
  readLlmConfig,
  speechLanguageName,
} from "@/lib/aiText";
import { formatDuration } from "@/lib/mediaFormat";
import { readLocalStorage, writeLocalStorage } from "@/lib/localStorage";
import { defaultSpeechLanguageCode, SPEECH_LANGUAGES } from "@/lib/speechLanguage";
import { sourceTypeLabel, type PendingSession, type RecordingEntry } from "@/lib/types";
import { TranscriptSourceBadge } from "./TranscriptSourceBadge";

interface Props {
  session: PendingSession;
  onFinalized: (entry: RecordingEntry) => void;
  onSnapshot: (entry: RecordingEntry) => void;
  onRemove: (id: string) => void;
  onWarning: (message: string) => void;
}

/** How close to the bottom (px) still counts as "following the live feed". */
const STICK_TO_BOTTOM_THRESHOLD = 24;

export function ActiveSessionCard({ session, onFinalized, onSnapshot, onRemove, onWarning }: Props) {
  const llmReady = isLlmReady(readLlmConfig());
  const [liveAiEnabled, setLiveAiEnabled] = useState(
    () => readLocalStorage(LIVE_AI_ENABLED_STORAGE_KEY) !== "off",
  );
  const [aiLanguage, setAiLanguage] = useState(
    () => readLocalStorage(AI_TARGET_LANGUAGE_STORAGE_KEY) ?? defaultSpeechLanguageCode(),
  );
  const liveAiActive = Boolean(session.enableTranscript) && llmReady && liveAiEnabled;

  // `flush` comes from useLiveAiText BELOW, which needs the transcript state
  // that useRecordingSession (fed by handleFinalized) produces — a circular
  // order resolved with a ref, updated in an effect (the sanctioned place):
  // finalize only ever fires on a user Stop, long after the latest effect
  // ran, so the trampoline below always calls the current flush.
  const flushRef = useRef<LiveAiTextResult["flush"]>(async () => ({}));

  const handleFinalized = useCallback(
    async (entry: RecordingEntry) => {
      // Attach the live translation/running summary to the saved entry
      // before it lands in the library (flush is timeout-bounded and
      // failure-safe inside the hook — the recording is never lost to AI).
      let patched = entry;
      try {
        const ai = await flushRef.current(entry.transcriptSegments ?? []);
        if (ai.translation || ai.summary) {
          patched = { ...entry, ...ai };
        }
      } catch {
        // Ignore — save the recording without the AI artifacts.
      }
      onFinalized(patched);
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
      localLiveTab: session.localLiveTab,
      extraCleanup: session.extraCleanup,
      onFinalized: handleFinalized,
      onSnapshot,
      onWarning,
    });

  const { state: aiState, flush } = useLiveAiText(transcriptSegments, liveAiActive, aiLanguage);

  useEffect(() => {
    flushRef.current = flush;
  });

  const hasVideo = session.stream.getVideoTracks().length > 0;
  const isMixed = session.sourceType === "mixed";
  const interimLine = [interimText, tabInterimText].filter(Boolean).join(" ");

  // Auto-scrolls to the newest line as it arrives, but only while the user
  // is already at (or near) the bottom — so scrolling up to re-read earlier
  // parts of the conversation during a live call isn't yanked back down by
  // the next word that comes in. The original and translation columns each
  // get their own stick-to-bottom state.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const translationScrollRef = useRef<HTMLDivElement | null>(null);
  const translationStickRef = useRef(true);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD;
  }

  function handleTranslationScroll() {
    const el = translationScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    translationStickRef.current = distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD;
  }

  useEffect(() => {
    if (stickToBottomRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [transcriptSegments, interimLine]);

  useEffect(() => {
    if (translationStickRef.current) {
      translationScrollRef.current?.scrollTo({ top: translationScrollRef.current.scrollHeight });
    }
  }, [aiState.translatedSegments]);

  const showAiColumns = liveAiActive && (aiState.translatedCount > 0 || aiState.summary !== null);
  const untranslatedCount = transcriptSegments.length - aiState.translatedCount;

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
        <>
          {llmReady && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={liveAiEnabled}
                  onChange={(event) => {
                    setLiveAiEnabled(event.target.checked);
                    writeLocalStorage(
                      LIVE_AI_ENABLED_STORAGE_KEY,
                      event.target.checked ? "on" : "off",
                    );
                  }}
                  className="accent-red-600"
                />
                Live translate &amp; summarize
              </label>
              {liveAiEnabled && (
                <select
                  value={aiLanguage}
                  onChange={(event) => {
                    setAiLanguage(event.target.value);
                    writeLocalStorage(AI_TARGET_LANGUAGE_STORAGE_KEY, event.target.value);
                  }}
                  className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
                  title="Language the live translation and running summary are produced in"
                >
                  {SPEECH_LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div className={showAiColumns ? "mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2" : ""}>
            <div>
              {showAiColumns && (
                <p className="mb-1 px-0.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Transcript
                </p>
              )}
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="max-h-64 min-h-[2.5rem] space-y-1 overflow-y-auto rounded-md border border-red-100 bg-white/60 p-2 text-sm dark:border-red-900/40 dark:bg-black/10"
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
            </div>

            {showAiColumns && (
              <div>
                <p className="mb-1 px-0.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  Translation ({speechLanguageName(aiLanguage)})
                  {aiState.busy && <span className="ml-1 font-normal normal-case">· working…</span>}
                </p>
                <div
                  ref={translationScrollRef}
                  onScroll={handleTranslationScroll}
                  className="max-h-64 min-h-[2.5rem] space-y-1 overflow-y-auto rounded-md border border-red-100 bg-white/60 p-2 text-sm dark:border-red-900/40 dark:bg-black/10"
                >
                  {aiState.translatedSegments.length === 0 ? (
                    <p className="text-zinc-500">Waiting for the first lines…</p>
                  ) : (
                    aiState.translatedSegments.map((segment, i) => (
                      <p key={i} className="text-zinc-700 dark:text-zinc-300">
                        <span className="mr-2 font-mono text-xs text-zinc-400">
                          {formatDuration(segment.time)}
                        </span>
                        {isMixed && <TranscriptSourceBadge source={segment.source} />}
                        {segment.text}
                      </p>
                    ))
                  )}
                  {untranslatedCount > 0 && !aiState.busy && (
                    <p className="italic text-zinc-400">
                      {untranslatedCount} new line{untranslatedCount === 1 ? "" : "s"} coming up…
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {showAiColumns && aiState.summary && (
            <div className="mt-2 rounded-md border border-red-100 bg-white/60 p-2 dark:border-red-900/40 dark:bg-black/10">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Summary ({speechLanguageName(aiLanguage)})
                {aiState.busy && <span className="ml-1 font-normal normal-case">· updating…</span>}
              </p>
              <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
                {aiState.summary}
              </p>
            </div>
          )}
          {aiState.error && (
            <p className="mt-1.5 text-xs text-red-600 dark:text-red-400" role="status">
              {aiState.error} — will retry automatically.
            </p>
          )}
        </>
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
