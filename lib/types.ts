export type SourceType = "tab" | "mic" | "mixed";

export function sourceTypeLabel(sourceType: SourceType): string {
  if (sourceType === "tab") return "Tab/Window Audio";
  if (sourceType === "mixed") return "Tab + Mic (Mixed)";
  return "Microphone";
}

export type TranscriptSource = "mic" | "tab";

export interface TranscriptSegment {
  /** Seconds elapsed since the start of the recording. */
  time: number;
  text: string;
  /**
   * For "mixed" recordings only: which side this segment came from — the
   * live microphone transcript, or a later Whisper pass over the isolated
   * tab audio. Segments from other source types leave this unset.
   */
  source?: TranscriptSource;
}

export interface RecordingEntry {
  id: string;
  label: string;
  sourceType: SourceType;
  createdAt: number;
  durationSeconds: number;
  audioBlob: Blob;
  audioMimeType: string;
  /**
   * True if audioBlob's container also has a video track (screen/tab/webcam
   * video). Older records predate this field and read as undefined at
   * runtime despite the type — always access via Boolean(entry.hasVideo).
   */
  hasVideo: boolean;
  transcriptSegments: TranscriptSegment[] | null;
  /** True once the transcript has been overwritten by the user. */
  transcriptEditedManually: boolean;
  /**
   * "mixed" recordings only: the isolated tab/window audio, recorded in
   * parallel with the mixed track purely so "Transcribe Tab Audio" can run
   * Whisper on a clean signal (not tangled with mic speech) and merge the
   * result into transcriptSegments. Cleared back to null once used.
   */
  secondaryAudioBlob: Blob | null;
  secondaryAudioMimeType: string | null;
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
   * "mixed" sessions only: the isolated tab-only stream, recorded in
   * parallel (separate MediaRecorder) purely to produce a clean blob for
   * later tab-side transcription — see RecordingEntry.secondaryAudioBlob.
   */
  secondaryStream?: MediaStream;
  /**
   * "tab" or "mixed" sessions only: live cloud transcription (Deepgram) of
   * the tab-side audio — the one case the browser's own SpeechRecognition
   * can't help with, since it only ever listens to the physical microphone.
   * See hooks/useRecordingSession.ts and lib/transcription/deepgramLive.ts.
   * Segments arrive tagged "tab", merged by time into the same
   * transcriptSegments the mic side (if any) already populates.
   */
  liveCloudTab?: { apiKey: string; language: string };
  /**
   * For "mixed" (tab + mic) sessions: stops the original tab/mic streams
   * and closes the AudioContext used to mix them. `stream` itself is a
   * synthetic MediaStreamAudioDestinationNode output — stopping its track
   * doesn't stop the sources that feed it.
   */
  extraCleanup?: () => void;
}
