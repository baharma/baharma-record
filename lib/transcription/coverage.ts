/**
 * Tracks which parts of a clip the transcript actually accounts for, so audio
 * the model skipped can be found and given another pass.
 *
 * Why this exists: Whisper regularly stops generating before its input runs
 * out (music and singing worst of all), and transformers.js splits long audio
 * into 30s chunks generated independently — so an early stop happens *per
 * chunk*, scattering holes through a long recording rather than only cutting
 * the end off. Comparing produced timespans against the clip is what surfaces
 * those holes.
 *
 * Kept free of browser/model imports so it stays unit-testable on its own.
 */

/** A timespan of the clip, in absolute seconds. */
export interface Interval {
  start: number;
  end: number;
}

/** A hole shorter than this is timestamp slop, not missing audio. */
export const MIN_GAP_SECONDS = 2;

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/**
 * The earliest stretch of the clip that `covered` doesn't account for, or
 * null once everything but slop is covered.
 */
export function findFirstGap(covered: Interval[], audioSeconds: number): Interval | null {
  let cursor = 0;
  for (const interval of mergeIntervals(covered)) {
    if (interval.start - cursor >= MIN_GAP_SECONDS) {
      return { start: cursor, end: interval.start };
    }
    cursor = Math.max(cursor, interval.end);
  }
  return audioSeconds - cursor >= MIN_GAP_SECONDS
    ? { start: cursor, end: audioSeconds }
    : null;
}
