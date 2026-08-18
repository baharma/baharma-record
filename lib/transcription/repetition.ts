import type { TranscriptSegment } from "@/lib/types";

/**
 * Detects Whisper's degenerate-repetition failure mode, in either of two
 * shapes: a handful of words (often just one) repeated for the whole
 * segment, e.g. "yang yang yang …"; or one anchor word alternating with a
 * different garbled filler each time, e.g. "kembali kembaling kembali
 * kembalan kembali kembar …" — diverse enough in raw vocabulary to dodge
 * the first check, but still dominated by the one recurring word. Shows up
 * on quiet, noisy, or non-speech audio, and on speech in a language the
 * model handles poorly. transformers.js doesn't expose Whisper's own
 * compression-ratio / logprob / no-speech guards that normally suppress
 * this, so output has to be screened here instead.
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
  if (uniqueCount <= Math.max(2, Math.floor(words.length * 0.15))) return true;

  // A second shape of the same failure: one anchor word recurs at roughly
  // every other position while Whisper fills the gaps with a *different*
  // garbled near-miss each time (e.g. "kembali kembaling kembali kembalan
  // kembali kembar …"), so the line stays "diverse" by the unique-word
  // count above while still being nonsense. Catch it by the single most
  // frequent word's share of the line instead of overall diversity.
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const maxCount = Math.max(...counts.values());
  return maxCount / words.length >= 0.35;
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
