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

/** Translation lane: up to this many requests in flight at once. */
const TRANSLATE_CONCURRENCY = 3;
/** Normal batch size — small, for low latency. */
const TRANSLATE_BATCH_LINES = 4;
/** More pending lines than this means a backlog: switch to big batches. */
const TRANSLATE_CATCHUP_THRESHOLD = 12;
/** Backlog batch size. */
const TRANSLATE_CATCHUP_BATCH_LINES = 20;
/** Earlier lines sent as read-only context (never translated, never replied). */
const TRANSLATE_CONTEXT_LINES = 3;
/** Per-request timeout — a hung gateway must not freeze the lane forever. */
const TRANSLATE_TIMEOUT_MS = 20000;
/** Summary requests rewrite the whole running text; they get more time. */
const SUMMARY_TIMEOUT_MS = 45000;
/** Interval that only resumes work after a backoff and fires the summary's due check. */
const SAFETY_TICK_MS = 2000;
/** After a failed request, wait this long before that lane's next attempt. */
const ERROR_BACKOFF_MS = 10000;
/** Stop scheduling a lane after this many consecutive failed requests (until retry()). */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Hard cap for finalize's whole catch-up, so it can never hang on a dead provider. */
const FINALIZE_TIMEOUT_MS = 30000;
/** The first summary waits for this many final lines to exist. */
const FIRST_SUMMARY_MIN_LINES = 3;
/** Later summary updates run at most this often (when there's anything new). */
const SUMMARY_MIN_INTERVAL_MS = 20000;

export interface LiveAiFinalResult {
  translation?: TranscriptTranslation;
  summary?: TranscriptSummary;
}

/** Per-lane failure bookkeeping — one lane's failures never stop the other. */
interface LaneState {
  failures: number;
  backoffUntil: number;
  paused: boolean;
}

function freshLane(): LaneState {
  return { failures: 0, backoffUntil: 0, paused: false };
}

// Never mutated — the published snapshot a language switch ignores.
const EMPTY_TRANSLATIONS = new Map<TranscriptSegment, string>();

export interface LiveAiTextResult {
  /** Translated text per segment object — segments without an entry render a placeholder. */
  translations: Map<TranscriptSegment, string>;
  summary: string | null;
  /** At least one translation request is in flight (panel "working…" hint). */
  translating: boolean;
  summarizing: boolean;
  translationError: string | null;
  translationPaused: boolean;
  summaryError: string | null;
  summaryPaused: boolean;
  /** Un-pauses both lanes and pumps them immediately. */
  retry: () => void;
  /**
   * Called once at finalize (after Stop): waits for the in-flight requests,
   * then catches up on translation and one last summary update concurrently,
   * bounded by FINALIZE_TIMEOUT_MS, and returns what is safe to attach to
   * the saved entry — the translation only when it covers every final
   * segment, the running summary whenever one exists.
   */
  finalize: (finalSegments: TranscriptSegment[]) => Promise<LiveAiFinalResult>;
}

/**
 * Live translation + running summary for an active recording session, as
 * two INDEPENDENT asynchronous lanes driven by the session's *final*
 * transcript lines (interim text isn't sent — it changes every word):
 *
 * - The transcript lane never depends on either — useRecordingSession never
 *   awaits or calls any AI code, so capture runs at its own pace whether the
 *   provider is fast, slow, failing, or hanging.
 * - The translation lane is event-driven: a new final line pumps the lane
 *   immediately, so a line is translated as soon as a slot is free instead
 *   of waiting for a poll plus someone else's request. Up to 3 requests run
 *   concurrently over different segments; results may arrive out of order
 *   because they are stored by segment identity.
 * - The summary lane updates on its own schedule and never looks at the
 *   translation lane.
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
 * Every request carries its own AbortController timeout — a request that
 * never answers used to freeze both panels for the rest of the recording.
 * Failures back off per lane and pause that lane after 3 consecutive
 * failures (the card offers Retry). Every request also captures the
 * generation before its first await and discards its result when the target
 * language changed mid-request, which is what clears both panels for a
 * clean restart (the switch also aborts the running requests).
 */
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
  const [translating, setTranslating] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translationPaused, setTranslationPaused] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryPaused, setSummaryPaused] = useState(false);

  // Mutable mirrors for the pumps and finalize — synced in an effect (refs
  // are off-limits during render) so they always read the latest props.
  const segmentsRef = useRef(segments);
  const enabledRef = useRef(enabled);
  const languageRef = useRef(language);
  useEffect(() => {
    segmentsRef.current = segments;
    enabledRef.current = enabled;
    languageRef.current = language;
  });

  // Translation lane: segments inside a request right now, the running
  // requests, their abort controllers (so a language switch can abort them),
  // and the lane's own failure state.
  const translatingRef = useRef(new Set<TranscriptSegment>());
  const translateInFlightRef = useRef(new Set<Promise<void>>());
  const translateControllersRef = useRef(new Set<AbortController>());
  const translateLaneRef = useRef(freshLane());
  // Summary lane: one request at a time, its own failure state.
  const summaryInFlightRef = useRef<Promise<void> | null>(null);
  const summaryControllerRef = useRef<AbortController | null>(null);
  const summaryLaneRef = useRef(freshLane());
  const lastSummaryAtRef = useRef(0);
  const generationRef = useRef(0);

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
  // result (and its failure) instead of touching the freshly cleared maps.
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
    translateLaneRef.current = freshLane();
    summaryLaneRef.current = freshLane();
    // Abort everything still running for the old language; their finally
    // blocks clean up the in-flight sets and the working flags, and their
    // results are discarded by the generation check above.
    for (const controller of translateControllersRef.current) controller.abort();
    translateControllersRef.current.clear();
    translatingRef.current.clear();
    summaryControllerRef.current?.abort();
    summaryControllerRef.current = null;
    summaryInFlightRef.current = null;
  }, [languageGeneration]);

  // A snapshot from an older generation is ignored in render — that's the
  // language-switch reset, with no extra state to clear.
  const currentSnapshot =
    snapshot.generation === languageGeneration.generation
      ? snapshot
      : {
          generation: languageGeneration.generation,
          translations: EMPTY_TRANSLATIONS,
          summary: null,
        };

  const failLane = useCallback((lane: "translate" | "summary", message: string) => {
    const laneState = lane === "translate" ? translateLaneRef.current : summaryLaneRef.current;
    laneState.failures += 1;
    laneState.backoffUntil = Date.now() + ERROR_BACKOFF_MS;
    if (laneState.failures >= MAX_CONSECUTIVE_FAILURES) {
      laneState.paused = true;
    }
    if (lane === "translate") {
      setTranslationError(message);
      setTranslationPaused(laneState.paused);
    } else {
      setSummaryError(message);
      setSummaryPaused(laneState.paused);
    }
  }, []);

  // Ref indirection for the one circular link: a finished translation request
  // re-pumps the lane (so the next pending lines go out without waiting for
  // a tick), while the pump itself starts requests. Synced in an effect.
  const pumpTranslationRef = useRef<() => void>(() => {});

  const startTranslate = useCallback(
    (config: LlmConfig, batch: TranscriptSegment[]) => {
      const generation = generationRef.current;
      const controller = new AbortController();
      translateControllersRef.current.add(controller);
      const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
      setTranslating(true);
      // Context: the lines directly before the batch in the current array —
      // fragments translate poorly in isolation. Context only; the reply
      // contract stays one string per batch line.
      const all = segmentsRef.current;
      const batchStart = all.indexOf(batch[0]);
      const context =
        batchStart > 0
          ? all
              .slice(Math.max(0, batchStart - TRANSLATE_CONTEXT_LINES), batchStart)
              .map((segment) => segment.text)
          : undefined;
      let promise: Promise<void> | null = null;
      promise = (async () => {
        try {
          const texts = await translateSegmentsResilient(
            config,
            batch,
            speechLanguageName(languageRef.current),
            controller.signal,
            context,
          );
          if (generationRef.current !== generation) return;
          batch.forEach((segment, i) => translationsRef.current.set(segment, texts[i]));
          translateLaneRef.current.failures = 0;
          setTranslationError(null);
          publish();
        } catch (error) {
          if (generationRef.current !== generation) return;
          failLane("translate", error instanceof Error ? error.message : "Translation failed.");
        } finally {
          clearTimeout(timer);
          translateControllersRef.current.delete(controller);
          batch.forEach((segment) => translatingRef.current.delete(segment));
          if (promise) translateInFlightRef.current.delete(promise);
          setTranslating(translateInFlightRef.current.size > 0);
          pumpTranslationRef.current();
        }
      })();
      translateInFlightRef.current.add(promise);
    },
    [publish, failLane],
  );

  const pumpTranslation = useCallback(() => {
    const lane = translateLaneRef.current;
    if (lane.paused || Date.now() < lane.backoffUntil) return;
    if (!enabledRef.current) return;
    const config = readLlmConfig();
    if (!isLlmReady(config)) return;
    while (translateInFlightRef.current.size < TRANSLATE_CONCURRENCY) {
      const pending = segmentsRef.current.filter(
        (segment) =>
          !translationsRef.current.has(segment) && !translatingRef.current.has(segment),
      );
      if (pending.length === 0) break;
      const size =
        pending.length > TRANSLATE_CATCHUP_THRESHOLD
          ? TRANSLATE_CATCHUP_BATCH_LINES
          : TRANSLATE_BATCH_LINES;
      // Oldest first (array order); a segment is marked translating BEFORE
      // the request starts so it can never be in two requests at once.
      const batch = pending.slice(0, size);
      batch.forEach((segment) => translatingRef.current.add(segment));
      startTranslate(config, batch);
    }
  }, [startTranslate]);

  useEffect(() => {
    pumpTranslationRef.current = pumpTranslation;
  });

  const pumpSummary = useCallback(() => {
    const lane = summaryLaneRef.current;
    if (lane.paused || Date.now() < lane.backoffUntil) return;
    if (!enabledRef.current) return;
    if (summaryInFlightRef.current) return;
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
    if (!summaryDue) return;

    const generation = generationRef.current;
    const previous = summaryRef.current;
    const controller = new AbortController();
    summaryControllerRef.current = controller;
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
    setSummarizing(true);
    let promise: Promise<void> | null = null;
    promise = (async () => {
      try {
        // Feed the original lines (not the translations) — the summary's
        // target language is requested explicitly either way, and the
        // original is what exists even before a translation lands.
        const text = pendingSummary.map((segment) => segment.text).join("\n");
        const updated = await updateRunningSummary(
          config,
          previous,
          text,
          speechLanguageName(languageRef.current),
          controller.signal,
        );
        if (generationRef.current !== generation) return;
        // Only the lines actually sent are marked — lines that arrived while
        // the request was in flight stay pending for the next update instead
        // of being silently dropped from the summary.
        pendingSummary.forEach((segment) => summarizedRef.current.add(segment));
        summaryRef.current = updated;
        lastSummaryAtRef.current = Date.now();
        summaryLaneRef.current.failures = 0;
        setSummaryError(null);
        publish();
      } catch (error) {
        if (generationRef.current !== generation) return;
        failLane("summary", error instanceof Error ? error.message : "Summarization failed.");
      } finally {
        clearTimeout(timer);
        summaryControllerRef.current = null;
        summaryInFlightRef.current = null;
        setSummarizing(false);
      }
    })();
    summaryInFlightRef.current = promise;
  }, [publish, failLane]);

  // Event-driven triggers: a new final line pumps both lanes right away (a
  // line is translated as soon as a slot is free, not on the next poll).
  // The timeout defers the call out of the effect body — the linter (rightly)
  // forbids synchronous state updates from effects, and the pumps set their
  // working flags when they start a request.
  useEffect(() => {
    const timer = setTimeout(() => {
      pumpTranslation();
      pumpSummary();
    }, 0);
    return () => clearTimeout(timer);
  }, [segments, pumpTranslation, pumpSummary]);

  // Safety net only: resumes a lane whose backoff expired and fires the
  // summary's due check even when no new line arrives.
  useEffect(() => {
    const timer = setInterval(() => {
      pumpTranslation();
      pumpSummary();
    }, SAFETY_TICK_MS);
    return () => clearInterval(timer);
  }, [pumpTranslation, pumpSummary]);

  const retry = useCallback(() => {
    translateLaneRef.current = freshLane();
    summaryLaneRef.current = freshLane();
    setTranslationPaused(false);
    setSummaryPaused(false);
    setTranslationError(null);
    setSummaryError(null);
    pumpTranslation();
    pumpSummary();
  }, [pumpTranslation, pumpSummary]);

  // Stable identity (everything it reads is a ref or a module function), and
  // it never touches React state: it runs after the card has been unmounted,
  // patching the already-saved recording in the background.
  const finalize = useCallback(
    async (finalSegments: TranscriptSegment[]): Promise<LiveAiFinalResult> => {
      const result: LiveAiFinalResult = {};

      // 1. Let whatever is in flight in either lane settle — it publishes
      //    into the same refs, so waiting here avoids duplicate requests for
      //    the same lines.
      const inFlight = [...translateInFlightRef.current];
      if (summaryInFlightRef.current) inFlight.push(summaryInFlightRef.current);
      await Promise.allSettled(inFlight);

      // 2. Catch up on whatever the lanes didn't finish, with the two tasks
      //    running CONCURRENTLY under one shared timeout — a slow summary no
      //    longer delays the translation catch-up. Task-internal requests
      //    stay sequential (batches of 20; one summary update).
      const generation = generationRef.current;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FINALIZE_TIMEOUT_MS);
      try {
        if (enabledRef.current) {
          const config = readLlmConfig();
          if (isLlmReady(config)) {
            const languageName = speechLanguageName(languageRef.current);
            const translateTask = (async () => {
              const pending = finalSegments.filter((s) => !translationsRef.current.has(s));
              for (let i = 0; i < pending.length; i += TRANSLATE_CATCHUP_BATCH_LINES) {
                const batch = pending.slice(i, i + TRANSLATE_CATCHUP_BATCH_LINES);
                try {
                  const texts = await translateSegmentsResilient(
                    config,
                    batch,
                    languageName,
                    controller.signal,
                  );
                  if (generationRef.current !== generation) return;
                  batch.forEach((segment, j) => translationsRef.current.set(segment, texts[j]));
                } catch {
                  // Keep what's complete so far.
                }
              }
            })();
            const summaryTask = (async () => {
              const pendingSummary = finalSegments.filter(
                (s) => !summarizedRef.current.has(s),
              );
              if (pendingSummary.length === 0) return;
              try {
                const text = pendingSummary.map((s) => s.text).join("\n");
                const updated = await updateRunningSummary(
                  config,
                  summaryRef.current,
                  text,
                  languageName,
                  controller.signal,
                );
                if (generationRef.current !== generation) return;
                pendingSummary.forEach((s) => summarizedRef.current.add(s));
                summaryRef.current = updated;
              } catch {
                // Keep the previous summary, if any.
              }
            })();
            await Promise.allSettled([translateTask, summaryTask]);
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
    translating,
    summarizing,
    translationError,
    translationPaused,
    summaryError,
    summaryPaused,
    retry,
    finalize,
  };
}
