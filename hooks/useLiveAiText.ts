"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isLlmReady,
  readLlmConfig,
  speechLanguageName,
  updateRunningSummary,
  translateTranscriptSegments,
} from "@/lib/aiText";
import type { TranscriptSegment, TranscriptSummary, TranscriptTranslation } from "@/lib/types";

/** How often new transcript lines are picked up for translation. */
const TRANSLATE_TICK_MS = 5000;
/** How often the running summary is refreshed. */
const SUMMARY_TICK_MS = 30000;
/** After a failed request, wait this long before trying again (provider down / rate-limited). */
const ERROR_BACKOFF_MS = 30000;
/** Hard cap for the one final flush at stop, so finalizing a recording never hangs on AI. */
const FLUSH_TIMEOUT_MS = 12000;

export interface LiveAiTextState {
  /** Translated prefix of the live transcript — aligned one-for-one with its first N segments. */
  translatedSegments: TranscriptSegment[];
  translatedCount: number;
  summary: string | null;
  /** A request is currently in flight (drives the card's busy indicator). */
  busy: boolean;
  error: string | null;
}

export interface LiveAiTextResult {
  state: LiveAiTextState;
  /**
   * Called once at finalize, after the recording has stopped: translates any
   * untranslated tail (bounded by FLUSH_TIMEOUT_MS — a hung provider must
   * never delay saving the recording) and returns what's safe to attach to
   * the saved entry. Untranslated lines keep their original text, preserving
   * the one-for-one alignment TranscriptTranslation depends on.
   */
  flush: (finalSegments: TranscriptSegment[]) => Promise<{
    translation?: TranscriptTranslation;
    summary?: TranscriptSummary;
  }>;
}

/**
 * Live translation + running summary for an active recording session, driven
 * by the session's *final* transcript lines (interim text isn't translated —
 * it changes every word). Two throttled loops share one request slot so
 * requests never overlap:
 * - every TRANSLATE_TICK_MS, any untranslated lines are translated and
 *   appended (each line goes to the provider shortly after it's captured,
 *   which is the point of the feature);
 * - every SUMMARY_TICK_MS, the running summary is updated incrementally
 *   (previous summary + new lines) rather than rebuilt from the whole
 *   transcript, keeping the per-tick request bounded on hour-long sessions.
 * A failed request backs off before retrying so a down provider doesn't turn
 * into a request every tick. The config is re-read per request, so changing
 * providers/settings mid-recording is picked up on the next tick.
 */
export function useLiveAiText(
  segments: TranscriptSegment[],
  enabled: boolean,
  language: string,
): LiveAiTextResult {
  const [state, setState] = useState<LiveAiTextState>({
    translatedSegments: [],
    translatedCount: 0,
    summary: null,
    busy: false,
    error: null,
  });

  // Mutable mirrors for the interval callbacks — the ticks read the latest
  // props/state without re-creating the intervals (and without stale-closure
  // races against in-flight requests).
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const languageRef = useRef(language);
  languageRef.current = language;
  const stateRef = useRef(state);
  stateRef.current = state;
  const inFlightRef = useRef(false);
  const errorBackoffUntilRef = useRef(0);
  // Lines already folded into the running summary; a tick only updates it
  // when something new arrived, and after an error the same lines are
  // retried against the unchanged previous summary.
  const summarizedCountRef = useRef(0);

  // Switching the target language mid-recording restarts both artifacts from
  // scratch — a translation that changes language halfway is worse than a
  // short re-translate delay, and the summary must be in one language.
  const restartOnLanguageChangeRef = useRef(language);
  if (language !== restartOnLanguageChangeRef.current) {
    restartOnLanguageChangeRef.current = language;
    if (stateRef.current.translatedCount > 0 || stateRef.current.summary) {
      setState({
        translatedSegments: [],
        translatedCount: 0,
        summary: null,
        busy: false,
        error: null,
      });
      summarizedCountRef.current = 0;
    }
  }

  useEffect(() => {
    if (!enabled) return;

    async function runTranslate() {
      const current = stateRef.current;
      const fresh = segmentsRef.current.slice(current.translatedCount);
      if (fresh.length === 0) return;
      const config = readLlmConfig();
      if (!isLlmReady(config)) return;
      inFlightRef.current = true;
      setState((prev) => ({ ...prev, busy: true }));
      try {
        const translated = await translateTranscriptSegments(
          config,
          fresh,
          speechLanguageName(languageRef.current),
        );
        setState((prev) => ({
          ...prev,
          translatedSegments: [...prev.translatedSegments, ...translated],
          translatedCount: prev.translatedCount + translated.length,
          busy: false,
          error: null,
        }));
      } catch (error) {
        errorBackoffUntilRef.current = Date.now() + ERROR_BACKOFF_MS;
        setState((prev) => ({
          ...prev,
          busy: false,
          error: error instanceof Error ? error.message : "Translation failed.",
        }));
      } finally {
        inFlightRef.current = false;
      }
    }

    async function runSummary() {
      const current = stateRef.current;
      const fresh = segmentsRef.current.slice(summarizedCountRef.current);
      if (fresh.length === 0) return;
      const config = readLlmConfig();
      if (!isLlmReady(config)) return;
      inFlightRef.current = true;
      setState((prev) => ({ ...prev, busy: true }));
      try {
        // Feed the original lines (not the translation) — the summary's
        // target language is requested explicitly either way, and the
        // original is what exists even before the first translation lands.
        const text = fresh.map((segment) => segment.text).join("\n");
        const summary = await updateRunningSummary(
          config,
          current.summary,
          text,
          speechLanguageName(languageRef.current),
        );
        summarizedCountRef.current = segmentsRef.current.length;
        setState((prev) => ({ ...prev, summary, busy: false, error: null }));
      } catch (error) {
        errorBackoffUntilRef.current = Date.now() + ERROR_BACKOFF_MS;
        setState((prev) => ({
          ...prev,
          busy: false,
          error: error instanceof Error ? error.message : "Summarization failed.",
        }));
      } finally {
        inFlightRef.current = false;
      }
    }

    function tick(kind: "translate" | "summary") {
      if (inFlightRef.current) return;
      if (Date.now() < errorBackoffUntilRef.current) return;
      const config = readLlmConfig();
      if (!isLlmReady(config)) return;
      void (kind === "translate" ? runTranslate() : runSummary());
    }

    const translateTimer = setInterval(() => tick("translate"), TRANSLATE_TICK_MS);
    const summaryTimer = setInterval(() => tick("summary"), SUMMARY_TICK_MS);
    return () => {
      clearInterval(translateTimer);
      clearInterval(summaryTimer);
    };
  }, [enabled]);

  // Stable identity (everything it reads is a ref): the card can put it
  // straight into useRecordingSession's finalize chain without forcing that
  // chain to be rebuilt — or the callback re-registered — every render.
  const flush = useCallback(async (finalSegments: TranscriptSegment[]) => {
    const result: {
      translation?: TranscriptTranslation;
      summary?: TranscriptSummary;
    } = {};
    const current = stateRef.current;
    const languageName = speechLanguageName(languageRef.current);

    // Only attach a translation when it covers the whole transcript — partial
    // coverage would silently mix languages in the saved entry's translated
    // view. The flush pass usually closes the small tick-interval gap; if it
    // can't in time (or the provider is down), the translation is skipped
    // rather than saved half-done. Saving the recording itself never waits
    // longer than FLUSH_TIMEOUT_MS.
    let translatedSegments = current.translatedSegments;
    if (current.translatedCount < finalSegments.length && enabledRef.current) {
      const config = readLlmConfig();
      if (isLlmReady(config)) {
        try {
          const tail = await Promise.race([
            translateTranscriptSegments(
              config,
              finalSegments.slice(current.translatedCount),
              languageName,
            ),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), FLUSH_TIMEOUT_MS)),
          ]);
          if (tail) translatedSegments = [...translatedSegments, ...tail];
        } catch {
          // Fall through with whatever was translated before — the recording
          // must not be lost to an AI failure.
        }
      }
    }
    if (translatedSegments.length === finalSegments.length && finalSegments.length > 0) {
      result.translation = {
        language: languageRef.current,
        segments: translatedSegments,
        createdAt: Date.now(),
      };
    }
    if (current.summary) {
      result.summary = {
        language: languageRef.current,
        text: current.summary,
        createdAt: Date.now(),
      };
    }
    return result;
  }, []);

  return { state, flush };
}
