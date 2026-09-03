import { ABSOLUTE_FLOOR, windowRms } from "./speechRegions";

/**
 * Incremental, stateful voice-activity detector for a live audio stream —
 * distinct from speechRegions.ts's findSpeechRegions, which needs the whole
 * clip up front to estimate a noise floor percentile. This instead watches a
 * growing buffer chunk-by-chunk and reports when it's time to cut a window
 * off and send it for transcription: either a natural pause after some
 * speech, or a hard cap so a long uninterrupted monologue still gets
 * transcribed incrementally instead of one ever-growing buffer.
 *
 * Cutting on real pauses is what makes the difference between whole
 * sentences and mid-word fragments, so the threshold can't be the plain
 * ABSOLUTE_FLOOR speechRegions.ts's own scanning helpers use: tab audio
 * routinely carries a music bed or room tone that never drops below it, so
 * an absolute floor alone finds *no* pauses at all and every window ends up
 * cut by the hard cap instead (measured on a talking-head video with
 * background music: every single cut was the cap). Hence the adaptive floor
 * below, with ABSOLUTE_FLOOR kept only as a lower bound so genuinely silent
 * audio can't be scaled into "speech".
 */

const ANALYSIS_WINDOW_SECONDS = 0.03;
/** Trailing silence after some speech that counts as "the utterance ended". */
const SILENCE_GAP_SECONDS = 0.6;
/** A window this short right after a cut isn't worth a model call. */
const MIN_CUT_SECONDS = 1;
/** Hard cap so continuous speech (a monologue) still cuts periodically. */
export const MAX_WINDOW_SECONDS = 12;
/**
 * Kept from the end of a cut window and carried into the next one, so a cut
 * landing mid-word still gives the model enough left-context to transcribe
 * it fully. Trade-off: the carried audio can make the same word appear at
 * the end of one window's text and the start of the next's — accepted for
 * v1 rather than building token-level de-duplication across live windows.
 */
const OVERLAP_SECONDS = 0.25;
/** Speech must exceed the tracked noise floor by this much (as speechRegions.ts does). */
const NOISE_FLOOR_MULTIPLE = 2.5;
/**
 * How fast the noise floor is allowed to creep *up* per analysis window. It
 * follows a drop instantly (a real pause should register immediately) but
 * rises slowly, so a long stretch of speech can't drag the floor up with it
 * and start mislabelling that same speech as silence. ~1.7%/s.
 */
const NOISE_FLOOR_RISE = 1.0005;
/**
 * Ceiling on the noise floor, as a fraction of the loudest recent audio.
 * Without it, capture starting mid-sentence seeds the floor at *speech*
 * level, and since the floor only drops on quieter audio the detector stays
 * deaf until the first pause — measured: the first cut slipped from 3.6s to
 * 8.7s. Speech runs far enough above its own background that a floor this
 * far below the peak is always the background, never the speech.
 */
const PEAK_TO_FLOOR_RATIO = 6;
/** How fast the tracked peak decays, so an old loud moment can't pin the ceiling up. */
const PEAK_DECAY = 0.9995;

/**
 * How much louder a window's loud frames must be than its quiet ones for it
 * to read as speech rather than sustained sound. Speech constantly falls away
 * between syllables and words; music, applause and room tone hold a far
 * steadier level. This is the one signal available *before* the model runs
 * that separates the two, and getting it right matters more here than
 * anywhere else in the live path: fed music, Whisper doesn't stay quiet or
 * emit something obviously broken — it invents fluent, plausible dialogue
 * that no text-level screen can tell from a real transcript.
 *
 * Measured as a ratio between high and low percentiles rather than as "how
 * far frames dip below the median", because speech over a *loud music bed*
 * never dips far below its own median — the bed holds the floor up — yet
 * still swings widely between the two. Measured on that case: the dip
 * measure scored it 0.000, identical to pure music, and would have silently
 * dropped real speech.
 *
 * The two errors cost wildly different amounts: letting music through invents
 * dialogue a human can at least see is wrong, while rejecting speech loses
 * words that were really said and leaves no trace at all. So the threshold
 * sits just above the sustained-sound band rather than midway between the
 * two. Measured on synthetic envelopes (steady per window to within ~0.02):
 *
 *   speech, quiet room                 7.3     speech, slow (2 syl/s)   7.9
 *   speech over a loud music bed       3.5     speech, heavily
 *   sustained instrumental             1.6       compressed / loud bg   1.9
 *   rhythmic beat, never silent        1.5     applause / steady noise  1.1
 *
 * Note what this does *not* catch: music with real dynamics — drum hits,
 * breaks, vocals — swings as widely as speech does and goes to the model like
 * anything else. This gate is for *sustained* sound (room tone, hum, pads,
 * applause), which is where Whisper hallucinates most reliably.
 */
export const MIN_SPEECH_DYNAMIC_RANGE = 1.8;
/** Percentiles compared for that range — robust to a single loud or quiet frame. */
const LOW_PERCENTILE = 0.1;
const HIGH_PERCENTILE = 0.9;

/** A window of audio cut for transcription, with where it sits on the timeline. */
export interface VadWindow {
  samples: Float32Array;
  /** Seconds from the start of capture to the first sample of this window. */
  startSeconds: number;
  /**
   * Ratio of the window's loud frames to its quiet ones — compare against
   * MIN_SPEECH_DYNAMIC_RANGE. Computed from the frame levels the cut logic
   * already measured, so it costs nothing extra.
   */
  dynamicRange: number;
}

function dynamicRange(levels: number[]): number {
  if (levels.length === 0) return 0;
  const sorted = [...levels].sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * LOW_PERCENTILE)];
  const high = sorted[Math.floor(sorted.length * HIGH_PERCENTILE)];
  // Nothing audible at all: silence, not music. localLive.ts's peak check
  // owns that case, so don't claim anything about it here.
  if (high <= 0) return 0;
  // Frames genuinely reaching zero are as speech-like as audio gets — a real
  // pause — so don't let the division blow up into a meaningless number.
  if (low <= 0) return Number.POSITIVE_INFINITY;
  return high / low;
}

function concatFloat32(chunks: Float32Array[], totalLength: number): Float32Array {
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export class LiveVad {
  private readonly sampleRate: number;
  private readonly analysisWindowSamples: number;
  private readonly minCutSamples: number;
  private readonly maxWindowSamples: number;
  private readonly overlapSamples: number;

  private buffer: Float32Array[] = [];
  private bufferedSamples = 0;
  private trailingSilentSamples = 0;
  private hasSpeechInBuffer = false;
  /** Every sample ever pushed — how a cut window's place on the timeline is known. */
  private totalPushedSamples = 0;
  private noiseFloor: number | null = null;
  private recentPeak = 0;
  /** Per-frame levels for the window being built, for its speech/sustained-sound score. */
  private frameLevels: number[] = [];

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.analysisWindowSamples = Math.max(1, Math.round(ANALYSIS_WINDOW_SECONDS * sampleRate));
    this.minCutSamples = Math.round(MIN_CUT_SECONDS * sampleRate);
    this.maxWindowSamples = Math.round(MAX_WINDOW_SECONDS * sampleRate);
    this.overlapSamples = Math.round(OVERLAP_SECONDS * sampleRate);
  }

  /** Feed newly-captured audio in. Returns a window to transcribe if a cut just fired. */
  push(chunk: Float32Array): VadWindow | null {
    this.buffer.push(chunk);
    this.bufferedSamples += chunk.length;
    this.totalPushedSamples += chunk.length;

    for (let start = 0; start < chunk.length; start += this.analysisWindowSamples) {
      const end = Math.min(chunk.length, start + this.analysisWindowSamples);
      const level = windowRms(chunk, start, end);
      this.frameLevels.push(level);

      this.recentPeak = Math.max(level, this.recentPeak * PEAK_DECAY);
      this.noiseFloor =
        this.noiseFloor === null
          ? level
          : level < this.noiseFloor
            ? level
            : Math.min(level, this.noiseFloor * NOISE_FLOOR_RISE);

      const floor = Math.min(this.noiseFloor, this.recentPeak / PEAK_TO_FLOOR_RATIO);
      const threshold = Math.max(ABSOLUTE_FLOOR, floor * NOISE_FLOOR_MULTIPLE);
      if (level > threshold) {
        this.hasSpeechInBuffer = true;
        this.trailingSilentSamples = 0;
      } else {
        this.trailingSilentSamples += end - start;
      }
    }

    const silenceTriggered =
      this.hasSpeechInBuffer &&
      this.trailingSilentSamples / this.sampleRate >= SILENCE_GAP_SECONDS &&
      this.bufferedSamples >= this.minCutSamples;
    const capTriggered = this.bufferedSamples >= this.maxWindowSamples;

    if (!silenceTriggered && !capTriggered) return null;
    return this.cut();
  }

  /** Forces out whatever's buffered, e.g. when the session is stopping. Null if nothing to send. */
  flush(): VadWindow | null {
    if (this.bufferedSamples < this.minCutSamples) return null;
    return this.cut();
  }

  private cut(): VadWindow {
    const samples = concatFloat32(this.buffer, this.bufferedSamples);
    // The buffer always holds the most recent `bufferedSamples` of the
    // stream (the carried overlap below is a copy of already-counted
    // samples), so this is where the window starts on the timeline.
    const startSeconds = (this.totalPushedSamples - this.bufferedSamples) / this.sampleRate;
    const windowDynamicRange = dynamicRange(this.frameLevels);
    // The carried overlap's frames are dropped along with the rest: 250ms of
    // a window at least 1s long can't meaningfully move the fraction, and
    // keeping them would mean tracking which frames belong to which window.
    this.frameLevels = [];

    const overlap = samples.subarray(Math.max(0, samples.length - this.overlapSamples));
    this.buffer = overlap.length > 0 ? [new Float32Array(overlap)] : [];
    this.bufferedSamples = overlap.length;
    // The carried-over tail's own silence doesn't count toward a fresh
    // silence-gap trigger until new speech actually starts it fresh.
    this.trailingSilentSamples = 0;
    this.hasSpeechInBuffer = false;

    return { samples, startSeconds, dynamicRange: windowDynamicRange };
  }
}
