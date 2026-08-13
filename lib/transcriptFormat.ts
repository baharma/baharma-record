import { formatDuration } from "./mediaFormat";
import type { RecordingEntry, TranscriptSegment, TranscriptSource } from "./types";

/** How far apart two same-source segments can be and still read as one utterance. */
const MAX_GROUP_GAP_SECONDS = 15;
/** Keeps merged lines from growing into unreadable walls (and preserves seek points). */
const MAX_GROUP_CHARS = 400;

export function sourceShortLabel(source: TranscriptSource | undefined): string | null {
  if (!source) return null;
  return source === "mic" ? "Mic" : "Tab";
}

/**
 * Merges runs of consecutive segments from the same source into single
 * lines. Speech recognition emits short fragments, so a raw dump reads as a
 * choppy column; grouping turns each speaker's run into a sentence while
 * keeping enough separate lines that timestamps stay useful.
 */
export function groupTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const grouped: TranscriptSegment[] = [];
  for (const segment of segments) {
    const previous = grouped[grouped.length - 1];
    const canMerge =
      previous !== undefined &&
      previous.source === segment.source &&
      segment.time - previous.time <= MAX_GROUP_GAP_SECONDS &&
      previous.text.length + segment.text.length + 1 <= MAX_GROUP_CHARS;

    if (canMerge) {
      grouped[grouped.length - 1] = {
        ...previous,
        text: `${previous.text} ${segment.text}`,
      };
    } else {
      grouped.push({ ...segment });
    }
  }
  return grouped;
}

/**
 * Renders a transcript as readable text: one line per utterance, prefixed
 * with its timestamp and (for mixed recordings) which side it came from, so
 * a copied or exported transcript still carries the context the on-screen
 * badges give you. Used by both "Copy Transcript" and the exported
 * transcript.txt so the two never drift apart.
 */
export function formatTranscriptText(
  segments: TranscriptSegment[] | null,
  options: { editedManually?: boolean } = {},
): string {
  if (!segments || segments.length === 0) return "";
  // A hand-written transcript is already prose — don't impose timestamps on it.
  if (options.editedManually) return segments[0].text;

  return groupTranscriptSegments(segments)
    .map((segment) => {
      const label = sourceShortLabel(segment.source);
      const prefix = label ? `[${formatDuration(segment.time)}] [${label}]` : `[${formatDuration(segment.time)}]`;
      return `${prefix} ${segment.text}`;
    })
    .join("\n");
}

export function formatRecordingTranscript(recording: RecordingEntry): string {
  return formatTranscriptText(recording.transcriptSegments, {
    editedManually: recording.transcriptEditedManually,
  });
}
