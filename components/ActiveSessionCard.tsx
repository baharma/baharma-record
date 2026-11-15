"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveAiText, type LiveAiFinalResult, type LiveAiTextResult } from "@/hooks/useLiveAiText";
import { useRecordingSession } from "@/hooks/useRecordingSession";
import {
  AI_TARGET_LANGUAGE_STORAGE_KEY,
  LIVE_AI_ENABLED_STORAGE_KEY,
  llmNotReadyReason,
  readLlmConfig,
  speechLanguageName,
} from "@/lib/aiText";
import { formatDuration } from "@/lib/mediaFormat";
import { readLocalStorage, writeLocalStorage } from "@/lib/localStorage";
import { defaultSpeechLanguageCode, SPEECH_LANGUAGES } from "@/lib/speechLanguage";
import { cloudProvider } from "@/lib/transcription/cloudProviders";
import {
  sourceTypeLabel,
  type PendingSession,
  type RecordingEntry,
  type TranscriptSegment,
} from "@/lib/types";
import {
  LiveSummaryText,
  LiveTranscriptLines,
  LiveTranslationLines,
} from "./LiveSessionPanels";

interface Props {
  session: PendingSession;
  onFinalized: (entry: RecordingEntry) => void | Promise<void>;
  onSnapshot: (entry: RecordingEntry) => void;
  onRemove: (id: string) => void;
  onWarning: (message: string) => void;
  onAiResult: (
    id: string,
    segmentsAtStop: TranscriptSegment[],
    ai: LiveAiFinalResult,
  ) => Promise<void> | void;
  onOpenSettings: () => void;
}

/** How close to the bottom (px) still counts as "following the live feed". */
const STICK_TO_BOTTOM_THRESHOLD = 24;

export function ActiveSessionCard({
  session,
  onFinalized,
  onSnapshot,
  onRemove,
  onWarning,
  onAiResult,
  onOpenSettings,
}: Props) {
  const llmConfig = readLlmConfig();
  const notReadyReason = llmNotReadyReason(llmConfig);
  const [liveAiEnabled, setLiveAiEnabled] = useState(
    () => readLocalStorage(LIVE_AI_ENABLED_STORAGE_KEY) !== "off",
  );
  const [aiLanguage, setAiLanguage] = useState(
    () => readLocalStorage(AI_TARGET_LANGUAGE_STORAGE_KEY) ?? defaultSpeechLanguageCode(),
  );
  const liveAiActive =
    Boolean(session.enableTranscript) && liveAiEnabled && notReadyReason === null;

  // `finalize` comes from useLiveAiText BELOW, which needs the transcript
  // state that useRecordingSession (fed by handleFinalized) produces — a
  // circular order resolved with a ref, updated in an effect (the sanctioned
  // place): finalize only ever fires on a user Stop, long after the latest
  // effect ran, so the trampoline always calls the current one.
  const finalizeRef = useRef<LiveAiTextResult["finalize"]>(async () => ({}));

  const handleFinalized = useCallback(
    (entry: RecordingEntry) => {
      // Save FIRST, never awaited in front of onFinalized: the pagehide
      // snapshot in useRecordingSession is disabled once finalize has fired,
      // so any await here opens a window where closing the tab loses the
      // recording. The AI catch-up runs in the background and patches the
      // already-saved entry via onAiResult instead.
      const saved = Promise.resolve(onFinalized(entry));
      onRemove(session.id);
      const segments = entry.transcriptSegments ?? [];
      void (async () => {
        try {
          const ai = await finalizeRef.current(segments);
          await saved;
          if (ai.translation || ai.summary) {
            await onAiResult(entry.id, segments, ai);
          }
        } catch {
          // The recording is already saved; the AI text is best-effort.
        }
      })();
    },
    [onFinalized, onRemove, onAiResult, session.id],
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

  const {
    translations,
    summary,
    translating,
    summarizing,
    translationError,
    translationPaused,
    summaryError,
    summaryPaused,
    retry,
    finalize,
  } = useLiveAiText(transcriptSegments, liveAiActive, aiLanguage);

  useEffect(() => {
    finalizeRef.current = finalize;
  });

  const hasVideo = session.stream.getVideoTracks().length > 0;
  const isMixed = session.sourceType === "mixed";
  const interimLine = [interimText, tabInterimText].filter(Boolean).join(" ");

  // Auto-scrolls to the newest line as it arrives, but only while the user
  // is already at (or near) the bottom — so scrolling up to re-read earlier
  // parts of the conversation during a live call isn't yanked back down by
  // the next word that comes in. Each panel keeps its own stick-to-bottom
  // state.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const translationScrollRef = useRef<HTMLDivElement | null>(null);
  const translationStickRef = useRef(true);
  const summaryScrollRef = useRef<HTMLDivElement | null>(null);
  const summaryStickRef = useRef(true);

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD;
  }

  function handleTranslationScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    translationStickRef.current = distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD;
  }

  function handleSummaryScroll(event: React.UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    summaryStickRef.current = distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD;
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
  }, [translations]);

  useEffect(() => {
    if (summaryStickRef.current) {
      summaryScrollRef.current?.scrollTo({ top: summaryScrollRef.current.scrollHeight });
    }
  }, [summary]);

  const scrollBoxClass =
    "h-72 min-h-[2.5rem] space-y-1 overflow-y-auto rounded-md border border-red-100 bg-white/60 p-2 text-sm dark:border-red-900/40 dark:bg-black/10";
  const panelLabelClass =
    "mb-1 px-0.5 text-xs font-semibold uppercase tracking-wide text-zinc-500";

  return (
    <div
      className={`rounded-lg border border-red-200 bg-red-50/50 p-4 dark:border-red-900 dark:bg-red-950/20 ${
        session.enableTranscript ? "col-span-full" : ""
      }`}
    >
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
            {session.enableTranscript && notReadyReason === null && (
              <>
                {" · "}
                {cloudProvider(llmConfig.provider).label} · {llmConfig.model}
              </>
            )}
          </p>
        </div>
        <p className="shrink-0 font-mono text-lg tabular-nums">{formatDuration(elapsedSeconds)}</p>
      </div>

      {session.enableTranscript && (
        <>
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

          {liveAiActive ? (
            <>
              <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-3">
                <div>
                  <p className={panelLabelClass}>Transcript</p>
                  <div
                    ref={scrollRef}
                    onScroll={handleScroll}
                    className={scrollBoxClass}
                  >
                    {transcriptSegments.length === 0 && !interimLine ? (
                      <p className="text-zinc-500">Listening…</p>
                    ) : (
                      <>
                        <LiveTranscriptLines segments={transcriptSegments} isMixed={isMixed} />
                        {interimLine && <p className="italic text-zinc-400">{interimLine}</p>}
                      </>
                    )}
                  </div>
                </div>

                <div>
                  <p className={panelLabelClass}>
                    Translation ({speechLanguageName(aiLanguage)})
                    {translating && (
                      <span className="ml-1 font-normal normal-case">· working…</span>
                    )}
                  </p>
                  <div
                    ref={translationScrollRef}
                    onScroll={handleTranslationScroll}
                    className={scrollBoxClass}
                  >
                    {transcriptSegments.length === 0 ? (
                      <p className="text-zinc-500">Waiting for the first lines…</p>
                    ) : (
                      <LiveTranslationLines
                        segments={transcriptSegments}
                        translations={translations}
                        isMixed={isMixed}
                      />
                    )}
                  </div>
                </div>

                <div>
                  <p className={panelLabelClass}>
                    Summary ({speechLanguageName(aiLanguage)})
                    {summarizing && (
                      <span className="ml-1 font-normal normal-case">· working…</span>
                    )}
                  </p>
                  <div
                    ref={summaryScrollRef}
                    onScroll={handleSummaryScroll}
                    className={scrollBoxClass}
                  >
                    {summary ? (
                      <LiveSummaryText summary={summary} />
                    ) : (
                      <p className="text-zinc-500">
                        The summary appears after the first few lines.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              {(translationError || summaryError) && (
                <div className="mt-1.5 space-y-1 text-xs" role="status">
                  {translationError && (
                    <div className="flex flex-wrap items-center gap-2 text-red-600 dark:text-red-400">
                      <span>
                        Translation: {translationError}
                        {!translationPaused && " — retrying…"}
                      </span>
                      {translationPaused && (
                        <>
                          <button
                            onClick={retry}
                            className="rounded-md border border-red-300 px-2 py-0.5 font-medium hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/40"
                          >
                            Retry
                          </button>
                          <button
                            onClick={onOpenSettings}
                            className="rounded-md border border-red-300 px-2 py-0.5 font-medium hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/40"
                          >
                            Open Settings
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {summaryError && (
                    <div className="flex flex-wrap items-center gap-2 text-red-600 dark:text-red-400">
                      <span>
                        Summary: {summaryError}
                        {!summaryPaused && " — retrying…"}
                      </span>
                      {summaryPaused && (
                        <>
                          <button
                            onClick={retry}
                            className="rounded-md border border-red-300 px-2 py-0.5 font-medium hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/40"
                          >
                            Retry
                          </button>
                          <button
                            onClick={onOpenSettings}
                            className="rounded-md border border-red-300 px-2 py-0.5 font-medium hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/40"
                          >
                            Open Settings
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="mt-2 max-h-64 min-h-[2.5rem] space-y-1 overflow-y-auto rounded-md border border-red-100 bg-white/60 p-2 text-sm dark:border-red-900/40 dark:bg-black/10"
              >
                {transcriptSegments.length === 0 && !interimLine ? (
                  <p className="text-zinc-500">Listening…</p>
                ) : (
                  <>
                    <LiveTranscriptLines segments={transcriptSegments} isMixed={isMixed} />
                    {interimLine && <p className="italic text-zinc-400">{interimLine}</p>}
                  </>
                )}
              </div>
              {liveAiEnabled && notReadyReason && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span>{notReadyReason}</span>
                  <button
                    onClick={onOpenSettings}
                    className="rounded-md border border-zinc-300 px-2 py-0.5 font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    Open Settings
                  </button>
                </div>
              )}
            </>
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
