/**
 * Energy-based speech detection, used to split silence-heavy recordings
 * before they reach Whisper.
 *
 * Why this exists: fed a long stretch of silence, Whisper doesn't just skip
 * it — it collapses the whole recording into one bogus segment with a
 * nonsense timespan (measured: an 80s clip with speech at 5s/40s/70s came
 * back as a single `[0 → 73]` segment whose text mashed two sentences
 * together and dropped the third). That's what makes a transcript appear to
 * "skip" from one timestamp to a far later one. Transcribing each speech
 * region separately, then offsetting its timestamps, keeps the timeline
 * honest and stops silence from being hallucinated over.
 *
 * Continuous speech is unaffected — see `shouldSplitIntoRegions`.
 */

export interface SpeechRegion {
  startSample: number;
  endSample: number;
}

const WINDOW_SECONDS = 0.03;
/** Speech quieter than this (absolute) is never considered speech. */
const ABSOLUTE_FLOOR = 0.006;
/** Speech must exceed the estimated noise floor by this factor. */
const NOISE_FLOOR_MULTIPLE = 2.5;
/** Silence shorter than this doesn't split a region (keeps sentences whole). */
const MERGE_GAP_SECONDS = 0.7;
/** Regions shorter than this are discarded as blips. */
const MIN_REGION_SECONDS = 0.35;
/** Kept either side of a region so words aren't clipped. */
const PAD_SECONDS = 0.25;
/**
 * If speech covers at least this share of the recording, it's treated as
 * continuous and left alone — plain chunking already handles that case well,
 * so there's no reason to change behaviour (or pay for extra model calls).
 */
export const CONTINUOUS_SPEECH_RATIO = 0.7;

function windowRms(samples: Float32Array, start: number, end: number): number {
  let sumSquares = 0;
  for (let i = start; i < end; i++) sumSquares += samples[i] * samples[i];
  return Math.sqrt(sumSquares / Math.max(1, end - start));
}

/** Estimates the noise floor as a low percentile of per-window loudness. */
function estimateNoiseFloor(levels: number[]): number {
  if (levels.length === 0) return 0;
  const sorted = [...levels].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.1)];
}

export function findSpeechRegions(samples: Float32Array, sampleRate: number): SpeechRegion[] {
  const windowSize = Math.max(1, Math.round(WINDOW_SECONDS * sampleRate));
  const levels: number[] = [];
  for (let start = 0; start < samples.length; start += windowSize) {
    levels.push(windowRms(samples, start, Math.min(samples.length, start + windowSize)));
  }

  const threshold = Math.max(ABSOLUTE_FLOOR, estimateNoiseFloor(levels) * NOISE_FLOOR_MULTIPLE);
  const mergeWindows = Math.round(MERGE_GAP_SECONDS / WINDOW_SECONDS);
  const padSamples = Math.round(PAD_SECONDS * sampleRate);
  const minRegionSamples = Math.round(MIN_REGION_SECONDS * sampleRate);

  const regions: SpeechRegion[] = [];
  let regionStart: number | null = null;
  let quietRun = 0;

  for (let i = 0; i < levels.length; i++) {
    const isSpeech = levels[i] > threshold;
    if (isSpeech) {
      if (regionStart === null) regionStart = i * windowSize;
      quietRun = 0;
    } else if (regionStart !== null) {
      quietRun++;
      if (quietRun >= mergeWindows) {
        regions.push({ startSample: regionStart, endSample: (i - quietRun + 1) * windowSize });
        regionStart = null;
        quietRun = 0;
      }
    }
  }
  if (regionStart !== null) regions.push({ startSample: regionStart, endSample: samples.length });

  return regions
    .map((region) => ({
      startSample: Math.max(0, region.startSample - padSamples),
      endSample: Math.min(samples.length, region.endSample + padSamples),
    }))
    .filter((region) => region.endSample - region.startSample >= minRegionSamples);
}

/** Total samples covered by the given regions. */
export function totalRegionSamples(regions: SpeechRegion[]): number {
  return regions.reduce((sum, region) => sum + (region.endSample - region.startSample), 0);
}

/**
 * True when the recording is sparse enough that per-region transcription is
 * worth it. Continuous speech is left on the plain chunked path.
 */
export function shouldSplitIntoRegions(
  regions: SpeechRegion[],
  totalSamples: number,
): boolean {
  if (regions.length === 0 || totalSamples === 0) return false;
  // A single region still counts: a recording that's one burst of speech
  // followed by minutes of silence must be trimmed to the speech, otherwise
  // all that silence goes to the model and invites hallucination (and leaves
  // the closing segment without an end timestamp).
  return totalRegionSamples(regions) / totalSamples < CONTINUOUS_SPEECH_RATIO;
}
