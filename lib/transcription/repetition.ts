import type { TranscriptSegment } from "@/lib/types";

/**
 * Detects Whisper's degenerate-repetition failure mode — a handful of words
 * (often just one) repeated for the whole segment, e.g. "yang yang yang …".
 * It shows up on quiet, noisy, or non-speech audio. transformers.js doesn't
 * expose Whisper's own compression-ratio / logprob / no-speech guards that
 * normally suppress this, so output has to be screened here instead.
 *
 * Kept free of browser/model imports so it stays unit-testable on its own.
 */
export function isDegenerateRepetition(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  // Short lines are left alone: real speech genuinely repeats itself over a
  // few words ("no no no"), and the failure mode is always long-winded.
  if (words.length < 8) return false;
  const uniqueCount = new Set(words).size;
  return uniqueCount <= Math.max(2, Math.floor(words.length * 0.15));
}

/** Removes consecutive segments whose text is identical to the previous one. */
export function dropRepeatedNeighbours(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.filter(
    (segment, index) => index === 0 || segment.text !== segments[index - 1].text,
  );
}

/** Screens a freshly-transcribed segment list for hallucinated repetition. */
export function stripHallucinatedRepetition(segments: TranscriptSegment[]): TranscriptSegment[] {
  return dropRepeatedNeighbours(segments.filter((segment) => !isDegenerateRepetition(segment.text)));
}
