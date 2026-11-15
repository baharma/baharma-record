"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isLlmReady,
  readLlmConfig,
  speechLanguageName,
  updateRunningSummary,
  translateSegmentsResilient,
  type LlmConfig,
} from "@/lib/aiText";
import type { TranscriptSegment, TranscriptSummary, TranscriptTranslation } from "@/lib/types";

/** How often the scheduler looks for work. */
const SCHEDULER_TICK_MS = 2000;
/** After a failed request, wait this long before the next attempt. */
const ERROR_BACKOFF_MS = 10000;
/** Stop scheduling after this many consecutive failed requests (until retry()). */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Hard cap for finalize's whole catch-up, so it can never hang on a dead provider. */
const FINALIZE_TIMEOUT_MS = 30000;
/** A live translation request carries at most this many lines. */
const MAX_LINES_PER_REQUEST = 20;
/** The first summary waits for this many final lines to exist. */
const FIRST_SUMMARY_MIN_LINES = 3;
/** Later summary updates run at most this often (when there's anything new). */
const SUMMARY_MIN_INTERVAL_MS = 20000;

export type LiveAiBusy = "translate" | "summary" | null;

export interface LiveAiFinalResult {
  translation?: TranscriptTranslation;
  summary?: TranscriptSummary;
}

export interface LiveAiTextResult {
  /** Translated text per segment object — segments without an entry render a placeholder. */
  translations: Map<TranscriptSegment, string>;
  summary: string | null;
  /** Which kind of request is in flight, for the per-panel "working…" hint. */
  busy: LiveAiBusy;
  error: string | null;
  /** True after MAX_CONSECUTIVE_FAILURES in a row; scheduling stopped until retry(). */
  paused: boolean;
  retry: () => void;
  /**
   * Called once at finalize (after Stop): catches up on translation and one
   * last summary update, bounded by FINALIZE_TIMEOUT_MS, and returns what is
   * safe to attach to the saved entry — the translation only when it covers
   * every final segment, the running summary whenever one exists.
   */
  finalize: (finalSegments: TranscriptSegment[]) => Promise<LiveAiFinalResult>;
}

/**
 * Live translation + running summary for an active recording session, driven
 * by the session's *final* transcript lines (interim text isn't sent — it
 * changes every word).
 *
 * Bookkeeping is per segment OBJECT identity, not per index:
 * useRecordingSession creates each segment object once and only re-sorts the
 * array afterwards, and on-device tab transcription stamps a line with the
 * time its audio was captured — seconds in the past — so a tab line can be
 * inserted before mic lines that were already processed. An index-based
 * "translated prefix" would therefor pair translations with the wrong lines;
 * a Map keyed on the object can't. The refs are the source of truth and are
 * mutated only inside async request code; each mutation publishes a snapshot
 * to React state for rendering.
 *
 * One scheduler (single interval, one in-flight request slot) decides what to
 * run next: a due summary update takes priority, otherwise the oldest
 * untranslated lines go out. Failures back off 10 s and stop the scheduler
 * entirely after 3 consecutive failures — a down provider must not turn into
 * a request every tick for a whole hour-long recording — until the user
 * retries. Every request captures the generation before its first await and
 * discards its result when the target language changed mid-request, which is
 * what clears both artifacts for a clean restart.
 */
// Never mutated — the published snapshot a language switch ignores.
const EMPTY_TRANSLATIONS = new Map<TranscriptSegment, string>();

export function useLiveAiText(
  segments: TranscriptSegment[],
  enabled: boolean,
  language: string,
): LiveAiTextResult {
  // Source of truth (mutated only inside async request code, never during
  // render). Keyed by segment OBJECT identity — see the hook doc comment.
  const translationsRef = useRef(new Map<TranscriptSegment, string>());
  const summarizedRef = useRef(new Set<TranscriptSegment>());
  const summaryRef = useRef<string | null>(null);

  // Published snapshot for rendering, tagged with the generation it came
  // from: a language switch bumps the generation and the render below simply
  // ignores snapshots from older ones — the visual reset needs no state
  // write of its own.
  const [snapshot, setSnapshot] = useState<{
    generation: number;
    translations: Map<TranscriptSegment, string>;
    summary: string | null;
  }>({ generation: 0, translations: EMPTY_TRANSLATIONS, summary: null });
  const [busy, setBusy] = useState<LiveAiBusy>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  // Mutable mirrors for the interval callbacks and finalize — synced in an
  // effect (refs are off-limits during render) so the scheduler always reads
  // the latest props without re-creating the interval.
  const segmentsRef = useRef(segments);
  const enabledRef = useRef(enabled);
  const languageRef = useRef(language);
  useEffect(() => {
    segmentsRef.current = segments;
    enabledRef.current = enabled;
    languageRef.current = language;
  });

  const inFlightRef = useRef<Promise<void> | null>(null);
  const generationRef = useRef(0);
  const consecutiveFailuresRef = useRef(0);
  const pausedRef = useRef(false);
  const backoffUntilRef = useRef(0);
  const lastSummaryAtRef = useRef(0);

  const publish = useCallback(() => {
    setSnapshot({
      generation: generationRef.current,
      translations: new Map(translationsRef.current),
      summary: summaryRef.current,
    });
  }, []);

  // Switching the target language mid-recording restarts both artifacts from
  // scratch — a translation that changes language halfway is worse than a
  // short re-translate delay, and the summary must be in one language. The
  // generation bump makes every in-flight request discard its old-language
  // result instead of appending it to the freshly cleared maps.
  const [languageGeneration, setLanguageGeneration] = useState({ language, generation: 0 });
  if (language !== languageGeneration.language) {
    setLanguageGeneration({
      language,
      generation: languageGeneration.generation + 1,
    });
  }
  useEffect(() => {
    generationRef.current = languageGeneration.generation;
    translationsRef.current = new Map();
    summarizedRef.current = new Set();
    summaryRef.current = null;
    consecutiveFailuresRef.current = 0;
    pausedRef.current = false;
    backoffUntilRef.current = 0;
    lastSummaryAtRef.current = 0;
  }, [languageGeneration]);

  // A snapshot from an older generation is ignored in render — that's the
  // language-switch reset, with no extra state to clear.
  const currentSnapshot =
    snapshot.generation === languageGeneration.generation
      ? snapshot
      : { generation: languageGeneration.generation, translations: EMPTY_TRANSLATIONS, summary: null };

  useEffect(() => {
    if (!enabled) return;

    function fail(message: string) {
      consecutiveFailuresRef.current += 1;
      backoffUntilRef.current = Date.now() + ERROR_BACKOFF_MS;
      setError(message);
      if (consecutiveFailuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
        pausedRef.current = true;
        setPaused(true);
      }
    }

    function runTranslate(config: LlmConfig, batch: TranscriptSegment[]) {
      const generation = generationRef.current;
      setBusy("translate");
      let promise: Promise<void> | null = null;
      promise = (async () => {
        try {
          const texts = await translateSegmentsResilient(
            config,
            batch,
            speechLanguageName(languageRef.current),
          );
          if (generationRef.current !== generation) return;
          batch.forEach((segment, i) => translationsRef.current.set(segment, texts[i]));
          consecutiveFailuresRef.current = 0;
          setError(null);
          publish();
        } catch (error) {
          if (generationRef.current !== generation) return;
          fail(error instanceof Error ? error.message : "Translation failed.");
        } finally {
          if (generationRef.current === generation) setBusy(null);
          if (inFlightRef.current === promise) inFlightRef.current = null;
        }
      })();
      inFlightRef.current = promise;
    }

    function runSummary(config: LlmConfig, fresh: TranscriptSegment[]) {
      const generation = generationRef.current;
      const previous = summaryRef.current;
      setBusy("summary");
      let promise: Promise<void> | null = null;
      promise = (async () => {
        try {
          // Feed the original lines (not the translations) — the summary's
          // target language is requested explicitly either way, and the
          // original is what exists even before a translation lands.
          const text = fresh.map((segment) => segment.text).join("\n");
          const updated = await updateRunningSummary(
            config,
            previous,
            text,
            speechLanguageName(languageRef.current),
          );
          if (generationRef.current !== generation) return;
          // Only the lines actually sent are marked — lines that arrived
          // while the request was in flight stay pending for the next update
          // instead of being silently dropped from the summary.
          fresh.forEach((segment) => summarizedRef.current.add(segment));
          summaryRef.current = updated;
          lastSummaryAtRef.current = Date.now();
          consecutiveFailuresRef.current = 0;
          setError(null);
          publish();
        } catch (error) {
          if (generationRef.current !== generation) return;
          fail(error instanceof Error ? error.message : "Summarization failed.");
        } finally {
          if (generationRef.current === generation) setBusy(null);
          if (inFlightRef.current === promise) inFlightRef.current = null;
        }
      })();
      inFlightRef.current = promise;
    }

    function tick() {
      if (inFlightRef.current || pausedRef.current) return;
      if (Date.now() < backoffUntilRef.current) return;
      const config = readLlmConfig();
      if (!isLlmReady(config)) return;
      const currentSegments = segmentsRef.current;
      const pendingSummary = currentSegments.filter(
        (segment) => !summarizedRef.current.has(segment),
      );
      const summaryDue =
        pendingSummary.length > 0 &&
        (summaryRef.current === null
          ? currentSegments.length >= FIRST_SUMMARY_MIN_LINES
          : Date.now() - lastSummaryAtRef.current >= SUMMARY_MIN_INTERVAL_MS);
      if (summaryDue) {
        runSummary(config, pendingSummary);
        return;
      }
      const pendingTranslation = currentSegments.filter(
        (segment) => !translationsRef.current.has(segment),
      );
      if (pendingTranslation.length > 0) {
        runTranslate(config, pendingTranslation.slice(0, MAX_LINES_PER_REQUEST));
      }
    }

    const timer = setInterval(tick, SCHEDULER_TICK_MS);
    return () => clearInterval(timer);
  }, [enabled, languageGeneration.generation, publish]);

  const retry = useCallback(() => {
    pausedRef.current = false;
    consecutiveFailuresRef.current = 0;
    backoffUntilRef.current = 0;
    setPaused(false);
    setError(null);
  }, []);

  // Stable identity (everything it reads is a ref or a module function), and
  // it never touches React state: it runs after the card has been unmounted,
  // patching the already-saved recording in the background.
  const finalize = useCallback(
    async (finalSegments: TranscriptSegment[]): Promise<LiveAiFinalResult> => {
      const result: LiveAiFinalResult = {};

      // 1. Let the in-flight request settle — it publishes into the same
      //    refs, so waiting here avoids sending a duplicate request for the
      //    same lines.
      if (inFlightRef.current) {
        try {
          await inFlightRef.current;
        } catch {
          // Its own error handling already ran.
        }
      }

      // 2. Catch up on whatever the ticks didn't get to (the tail since the
      //    last tick, or everything if the provider was down): batches of 20
      //    sequential translation requests, then one final summary update.
      //    The whole step is bounded — on timeout or error, continue with
      //    whatever is complete; the recording is already saved either way.
      const generation = generationRef.current;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FINALIZE_TIMEOUT_MS);
      let stale = false;
      try {
        if (enabledRef.current) {
          const config = readLlmConfig();
          if (isLlmReady(config)) {
            const languageName = speechLanguageName(languageRef.current);
            const pending = finalSegments.filter((s) => !translationsRef.current.has(s));
            for (let i = 0; i < pending.length; i += MAX_LINES_PER_REQUEST) {
              const batch = pending.slice(i, i + MAX_LINES_PER_REQUEST);
              try {
                const texts = await translateSegmentsResilient(
                  config,
                  batch,
                  languageName,
                  controller.signal,
                );
                if (generationRef.current !== generation) {
                  stale = true;
                  break;
                }
                batch.forEach((segment, j) => translationsRef.current.set(segment, texts[j]));
              } catch {
                // Keep what's complete so far.
              }
            }
            if (!stale) {
              const pendingSummary = finalSegments.filter(
                (s) => !summarizedRef.current.has(s),
              );
              if (pendingSummary.length > 0) {
                try {
                  const text = pendingSummary.map((s) => s.text).join("\n");
                  const updated = await updateRunningSummary(
                    config,
                    summaryRef.current,
                    text,
                    languageName,
                  );
                  if (generationRef.current === generation) {
                    pendingSummary.forEach((s) => summarizedRef.current.add(s));
                    summaryRef.current = updated;
                  }
                } catch {
                  // Keep the previous summary, if any.
                }
              }
            }
          }
        }
      } finally {
        clearTimeout(timeout);
      }

      // 3. Only a translation covering EVERY final line is attached —
      //    partial coverage would silently mix languages in the saved
      //    entry's translated view. Segments copy the originals' time and
      //    source so seek and the MIC/TAB badges keep working.
      if (finalSegments.length > 0 && finalSegments.every((s) => translationsRef.current.has(s))) {
        result.translation = {
          language: languageRef.current,
          segments: finalSegments.map((s) => ({
            time: s.time,
            text: translationsRef.current.get(s)!,
            source: s.source,
          })),
          createdAt: Date.now(),
        };
      }
      if (summaryRef.current) {
        result.summary = {
          language: languageRef.current,
          text: summaryRef.current,
          createdAt: Date.now(),
        };
      }
      return result;
    },
    [],
  );

  return {
    translations: currentSnapshot.translations,
    summary: currentSnapshot.summary,
    busy,
    error,
    paused,
    retry,
    finalize,
  };
}
