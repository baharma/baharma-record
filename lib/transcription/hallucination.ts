import type { TranscriptSegment } from "@/lib/types";

/**
 * Screens Whisper's *non-speech* hallucination mode: fed background music,
 * room tone, or applause, it doesn't stay quiet — it emits stock filler
 * ("you", "Thank you.", "Terima kasih.") or a sound annotation ("[Music]",
 * "♪"), which reads as dialogue that was never spoken.
 *
 * transformers.js exposes neither of the signals Whisper itself uses to
 * suppress this (`no_speech_threshold`, `logprob_threshold`) — verified
 * absent from the ASR pipeline in 4.2.0, which returns only text and
 * timestamps — so the output has to be screened here instead.
 *
 * The hard part is that the stock phrases are also real things people say.
 * What separates them is *isolation*: "Terima kasih" answered mid-conversation
 * sits among real speech, while the same words hallucinated over an
 * instrumental stretch stand alone. So phrase matching alone never drops
 * anything — it must also be unaccompanied (see screenNonSpeechHallucinations).
 *
 * Kept free of browser/model imports so it stays unit-testable on its own.
 */

/** How far to look for real speech before calling a stock phrase isolated. */
const ISOLATION_WINDOW_SECONDS = 30;
/** Word count at which a line is trusted as real speech rather than filler. */
const SUBSTANTIVE_WORD_COUNT = 3;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whisper's stock output on non-speech audio, largely inherited from the
 * subtitle corpora it was trained on. Matched only in isolation, never on
 * sight — every one of these is also a real thing someone might say.
 */
const STOCK_PHRASES = new Set([
  // English
  "you",
  "thank you",
  "thank you very much",
  "thank you so much",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching this video",
  "please subscribe",
  "subscribe",
  "don t forget to subscribe",
  "like and subscribe",
  "bye",
  "bye bye",
  "goodbye",
  "the end",
  "to be continued",
  "okay",
  "ok",
  "oh",
  "hmm",
  "mm",
  "uh",
  "ah",
  // Indonesian
  "terima kasih",
  "terima kasih banyak",
  "terima kasih telah menonton",
  "terima kasih sudah menonton",
  "sampai jumpa",
  "selamat menonton",
  "jangan lupa subscribe",
  // Subtitle-corpus credits that leak in as "speech"
  "subtitles by the amara org community",
  "subtitles by the amara org",
  "amara org",
]);

/** Tokens below this count are too short to judge as gibberish. */
const GIBBERISH_MIN_TOKENS = 8;
/** Share of single-character tokens above which a line isn't language. */
const GIBBERISH_SINGLE_CHAR_RATIO = 0.7;

/**
 * The letter-soup shape Whisper falls into on sustained non-speech tones —
 * "E-E-E-E-O-E-E-U-E-E-I-E-E-N-M-E-E-L". It slips past the repetition screen
 * because the letters vary enough to look diverse. Gated on both length and
 * density so genuine spelled-out initials ("B B C") stay untouched.
 */
function isGibberishTokenSoup(text: string): boolean {
  const tokens = normalize(text).split(" ").filter(Boolean);
  if (tokens.length < GIBBERISH_MIN_TOKENS) return false;
  const singles = tokens.filter((token) => token.length === 1).length;
  return singles / tokens.length >= GIBBERISH_SINGLE_CHAR_RATIO;
}

/**
 * Text that is never dialogue no matter what surrounds it: a sound annotation
 * Whisper emits for non-speech audio, a line with no words at all, or letter
 * soup. Safe to drop unconditionally — real speech is never *only* a
 * bracketed annotation, a run of punctuation, or a wall of single letters.
 */
export function isNonSpeechArtifact(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  // Music/sound symbols, alone or repeated: "♪", "♪♪♪", "* * *".
  if (/^[\s♪♫♬♩*~\-—_.…!?,]+$/u.test(trimmed)) return true;

  // A whole-line annotation: "[Music]", "(applause)", "[Musik latar]".
  if (/^[[(][^\])]*[\])]$/u.test(trimmed)) return true;

  return isGibberishTokenSoup(trimmed);
}

/** One of Whisper's stock non-speech fillers, ignoring case and punctuation. */
export function isStockHallucination(text: string): boolean {
  return STOCK_PHRASES.has(normalize(text));
}

/** A line substantial enough to vouch for real speech happening around it. */
function isSubstantiveSpeech(text: string): boolean {
  if (isNonSpeechArtifact(text) || isStockHallucination(text)) return false;
  return normalize(text).split(" ").filter(Boolean).length >= SUBSTANTIVE_WORD_COUNT;
}

/**
 * Drops Whisper's non-speech hallucinations while leaving real dialogue
 * alone. Sound annotations go unconditionally; stock filler goes only when
 * no substantive speech sits within ISOLATION_WINDOW_SECONDS either side of
 * it, which is what tells "Terima kasih" answered in a conversation apart
 * from "Terima kasih" invented over an instrumental break.
 */
export function screenNonSpeechHallucinations(
  segments: TranscriptSegment[],
): TranscriptSegment[] {
  const withoutArtifacts = segments.filter((segment) => !isNonSpeechArtifact(segment.text));

  return withoutArtifacts.filter((segment) => {
    if (!isStockHallucination(segment.text)) return true;
    return withoutArtifacts.some(
      (other) =>
        other !== segment &&
        Math.abs(other.time - segment.time) <= ISOLATION_WINDOW_SECONDS &&
        isSubstantiveSpeech(other.text),
    );
  });
}

/**
 * True when a pass produced nothing but non-speech hallucination — the shape
 * of a stretch that is background music rather than dialogue.
 *
 * Used to discard a gap-recovery pass's output wholesale. Recovery exists to
 * re-attempt audio the model gave up on, but on instrumental stretches
 * "giving up" was the *correct* answer, and forcing another pass just invents
 * dialogue that was never there.
 */
export function isAllNonSpeech(segments: TranscriptSegment[]): boolean {
  if (segments.length === 0) return true;
  return !segments.some((segment) => isSubstantiveSpeech(segment.text));
}
