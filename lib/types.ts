export type SourceType = "tab" | "mic" | "mixed";

export function sourceTypeLabel(sourceType: SourceType): string {
  if (sourceType === "tab") return "Tab/Window Audio";
  if (sourceType === "mixed") return "Tab + Mic (Mixed)";
  return "Microphone";
}

export interface TranscriptSegment {
  /** Seconds elapsed since the start of the recording. */
  time: number;
  text: string;
}

export interface RecordingEntry {
  id: string;
  label: string;
  sourceType: SourceType;
  createdAt: number;
  durationSeconds: number;
  audioBlob: Blob;
  audioMimeType: string;
  transcriptSegments: TranscriptSegment[] | null;
  /** True once the transcript has been overwritten by the user. */
  transcriptEditedManually: boolean;
}

/** A live recording that hasn't been saved to the library yet. */
export interface PendingSession {
  id: string;
  sourceType: SourceType;
  label: string;
  stream: MediaStream;
  enableTranscript: boolean;
  /** BCP-47 locale tag for live transcription, e.g. "id-ID" — see lib/speechLanguage.ts. */
  recognitionLang: string;
  /**
   * For "mixed" (tab + mic) sessions: stops the original tab/mic streams
   * and closes the AudioContext used to mix them. `stream` itself is a
   * synthetic MediaStreamAudioDestinationNode output — stopping its track
   * doesn't stop the sources that feed it.
   */
  extraCleanup?: () => void;
}
