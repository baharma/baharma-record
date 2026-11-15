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

/**
 * An LLM-translated copy of transcriptSegments (see lib/aiText.ts), kept
 * alongside — never instead of — the original so the user can switch views.
 * Segment times mirror the original's one-for-one, so click-to-seek keeps
 * working in the translated view. Cleared whenever transcriptSegments is
 * replaced (re-transcribe, manual edit, remove tab lines, undo): a
 * translation aligned to a stale transcript would be silently wrong.
 */
export interface TranscriptTranslation {
  /** Target language code (lib/speechLanguage.ts), e.g. "en". */
  language: string;
  segments: TranscriptSegment[];
  createdAt: number;
}

/**
 * An LLM-generated summary of the transcript (see lib/aiText.ts) — plain
 * text, written in `language`. Cleared alongside TranscriptTranslation
 * whenever the transcript it was derived from is replaced.
 */
export interface TranscriptSummary {
  language: string;
  text: string;
  createdAt: number;
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
  /**
   * Optional LLM translation of transcriptSegments — see TranscriptTranslation.
   * Older records predate this field and read as undefined at runtime.
   */
  translation?: TranscriptTranslation;
  /** Optional LLM summary of transcriptSegments — see TranscriptSummary. */
  summary?: TranscriptSummary;
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
  liveCloudTab?: { apiKeys: string[]; language: string };
  /**
   * "tab" or "mixed" sessions only: live *on-device* transcription of the
   * tab-side audio — the free, no-API-key alternative to liveCloudTab above,
   * using the app's own local Whisper pipeline instead of Deepgram. Mutually
   * exclusive with liveCloudTab in the UI (NewSourceModal) since both would
   * tag segments "tab" on the same timeline. `transcribeWindow` is the local
   * live Whisper worker's request function (see hooks/useLiveTranscriber.ts)
   * threaded down from AppClient, mirroring how `extraCleanup` below is
   * already a function value living on this in-memory-only type.
   */
  localLiveTab?: {
    language: string;
    /** One of LIVE_WHISPER_MODELS' ids — picked in NewSourceModal, fixed for the session. */
    modelId: string;
    transcribeWindow: (
      samples: Float32Array,
      language: string,
      modelId: string,
    ) => Promise<{ text: string }>;
  };
  /**
   * For "mixed" (tab + mic) sessions: stops the original tab/mic streams
   * and closes the AudioContext used to mix them. `stream` itself is a
   * synthetic MediaStreamAudioDestinationNode output — stopping its track
   * doesn't stop the sources that feed it.
   */
  extraCleanup?: () => void;
}
