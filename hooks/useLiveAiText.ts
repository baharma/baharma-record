"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isLlmReady,
  onLlmUsage,
  readLlmConfig,
  speechLanguageName,
  updateRunningSummary,
  translateSegmentsResilient,
  type LlmConfig,
} from "@/lib/aiText";
import type { TranscriptSegment, TranscriptSummary, TranscriptTranslation } from "@/lib/types";

/** Translation lane: up to this many requests in flight at once. */
const TRANSLATE_CONCURRENCY = 2;
/** Wait this long after the oldest waiting line before a batch goes out... */
const TRANSLATE_COLLECT_MS = 4000;
/** ...or send at once when this many lines are already waiting. */
const TRANSLATE_FLUSH_LINES = 8;
/** Hard cap on lines per translation request. */
const TRANSLATE_MAX_BATCH_LINES = 12;
/** Per-request timeout, scaled with the batch: base + per-line, capped. */
const TRANSLATE_TIMEOUT_BASE_MS = 15000;
const TRANSLATE_TIMEOUT_PER_LINE_MS = 2000;
const TRANSLATE_TIMEOUT_MAX_MS = 60000;
/** Earlier lines sent as read-only context (never translated, never replied). */
const TRANSLATE_CONTEXT_LINES = 3;
/** Summary requests rewrite the whole running text; they get more time. */
const SUMMARY_TIMEOUT_MS = 45000;
/**
 * Interval that releases a collected batch when no new line arrives, resumes
 * a lane whose backoff expired, and fires the summary's due check.
 */
const SAFETY_TICK_MS = 1000;
/** After a failed request, wait this long before that lane's next attempt. */
const ERROR_BACKOFF_MS = 10000;
/** Stop scheduling a lane after this many consecutive failed requests (until retry()). */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Hard cap for finalize's whole catch-up, so it can never hang on a dead provider. */
const FINALIZE_TIMEOUT_MS = 30000;
/** The first summary waits for this many final lines to exist. */
const FIRST_SUMMARY_MIN_LINES = 3;
/** Later summary updates run at most this often... */
const SUMMARY_MIN_INTERVAL_MS = 60000;
/** ...and only when at least this many unsummarized lines exist. */
const SUMMARY_MIN_NEW_LINES = 5;

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

/** Running cost totals for the card's sub-line, accumulated per session. */
export interface LiveAiUsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export interface LiveAiTextResult {
  /** Translated text per segment object — segments without an entry render a placeholder. */
  translations: Map<TranscriptSegment, string>;
  summary: string | null;
  /** At least one translation request is in flight (panel "working…" hint). */
  translating: boolean;
  summarizing: boolean;
  /** Running request/token totals from every chat request the app makes. */
  usage: LiveAiUsageTotals;
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
  // Kept for the whole session (not reset on a language switch) so the cost
  // shown is the session's true total.
  const [usage, setUsage] = useState<LiveAiUsageTotals>({
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
  });
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
  // and the lane's own failure state. firstSeen backs the collect window
  // (how long the oldest waiting line has waited); batchLimit is the
  // adaptive batch size — halved after a timeout, doubled back after success.
  const translatingRef = useRef(new Set<TranscriptSegment>());
  const translateInFlightRef = useRef(new Set<Promise<void>>());
  const translateControllersRef = useRef(new Set<AbortController>());
  const translateLaneRef = useRef(freshLane());
  const firstSeenRef = useRef(new Map<TranscriptSegment, number>());
  const batchLimitRef = useRef(TRANSLATE_MAX_BATCH_LINES);
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
    firstSeenRef.current.clear();
    batchLimitRef.current = TRANSLATE_MAX_BATCH_LINES;
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
      // The timeout scales with the batch: a 12-line request legitimately
      // takes longer than a 4-line one, and a fixed timeout used to abort
      // exactly the batches that needed the most time.
      const timeoutMs = Math.min(
        TRANSLATE_TIMEOUT_MAX_MS,
        TRANSLATE_TIMEOUT_BASE_MS + batch.length * TRANSLATE_TIMEOUT_PER_LINE_MS,
      );
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
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
          // Success lets the batch size grow back toward the cap.
          batchLimitRef.current = Math.min(
            TRANSLATE_MAX_BATCH_LINES,
            batchLimitRef.current * 2,
          );
          setTranslationError(null);
          publish();
        } catch (error) {
          if (generationRef.current !== generation) return;
          // A timeout means the batch was too big for the model's speed —
          // halve it so the retry (which would otherwise resend the same
          // oversized, already-billed batch) has a chance to fit.
          if (timedOut) {
            batchLimitRef.current = Math.max(1, Math.floor(batchLimitRef.current / 2));
          }
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
    // Collect-then-send: a batch goes out when enough lines are waiting, or
    // when the oldest waiting line has been waiting for the collect window —
    // whichever comes first. Fewer, larger requests instead of one per line,
    // because every request pays the same fixed prompt/billing overhead.
    while (translateInFlightRef.current.size < TRANSLATE_CONCURRENCY) {
      const waiting = segmentsRef.current.filter(
        (segment) =>
          !translationsRef.current.has(segment) && !translatingRef.current.has(segment),
      );
      if (waiting.length === 0) break;
      const oldestFirstSeen = firstSeenRef.current.get(waiting[0]) ?? Date.now();
      const collectElapsed = Date.now() - oldestFirstSeen >= TRANSLATE_COLLECT_MS;
      if (waiting.length < TRANSLATE_FLUSH_LINES && !collectElapsed) break;
      // Oldest first (array order), capped by the adaptive batch limit; a
      // segment is marked translating BEFORE the request starts so it can
      // never be in two requests at once.
      const batch = waiting.slice(0, Math.min(batchLimitRef.current, waiting.length));
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
    // After the first summary exists, an update is due only when enough new
    // material exists AND the interval has passed — each update rewrites the
    // whole summary, so running it on every trickle is pure cost.
    const summaryDue =
      pendingSummary.length > 0 &&
      (summaryRef.current === null
        ? currentSegments.length >= FIRST_SUMMARY_MIN_LINES
        : pendingSummary.length >= SUMMARY_MIN_NEW_LINES &&
          Date.now() - lastSummaryAtRef.current >= SUMMARY_MIN_INTERVAL_MS);
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

  // Event-driven triggers: a new final line records when it first appeared
  // (for the collect window) and pumps both lanes right away. The timeout
  // defers the call out of the effect body — the linter (rightly) forbids
  // synchronous state updates from effects, and the pumps set their working
  // flags when they start a request.
  useEffect(() => {
    const now = Date.now();
    for (const segment of segments) {
      if (!firstSeenRef.current.has(segment)) {
        firstSeenRef.current.set(segment, now);
      }
    }
    const timer = setTimeout(() => {
      pumpTranslation();
      pumpSummary();
    }, 0);
    return () => clearTimeout(timer);
  }, [segments, pumpTranslation, pumpSummary]);

  // Safety net: with the collect window, this tick is what releases a batch
  // when no new line arrives; it also resumes a lane whose backoff expired
  // and fires the summary's due check.
  useEffect(() => {
    const timer = setInterval(() => {
      pumpTranslation();
      pumpSummary();
    }, SAFETY_TICK_MS);
    return () => clearInterval(timer);
  }, [pumpTranslation, pumpSummary]);

  // Cost tracking: the listener is app-wide, so with two sessions recording
  // at once each card shows the combined total of every chat request the app
  // makes (detail-view Translate/Summarize included). Acceptable for a cost
  // indicator; totals are kept for the whole session.
  useEffect(() => {
    return onLlmUsage((u) => {
      setUsage((prev) => ({
        requests: prev.requests + 1,
        promptTokens: prev.promptTokens + u.promptTokens,
        completionTokens: prev.completionTokens + u.completionTokens,
        reasoningTokens: prev.reasoningTokens + u.reasoningTokens,
      }));
    });
  }, []);

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
              for (let i = 0; i < pending.length; i += TRANSLATE_MAX_BATCH_LINES) {
                const batch = pending.slice(i, i + TRANSLATE_MAX_BATCH_LINES);
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
    usage,
    translationError,
    translationPaused,
    summaryError,
    summaryPaused,
    retry,
    finalize,
  };
}
