import type { TranscriptSegment } from "@/lib/types";

/**
 * Multilingual Whisper models, run entirely client-side via onnxruntime-web.
 * All are loaded at fp32 (see whisper.worker.ts) rather than a quantized
 * dtype: the quantized/fp16 exports currently hit a graph-optimizer bug in
 * the onnxruntime-web dev build transformers.js depends on (fails with
 * "Missing required scale for DequantizeLinear" or a LayerNorm fusion error
 * when creating the session) — fp32 avoids that code path entirely, at the
 * cost of a larger download.
 *
 * The choice is the user's because it's a genuine trade, not a default to
 * tune: each step up is markedly more accurate (especially on non-English,
 * on sung vocals, and on code-switched speech — a smaller model is quicker
 * to fall back to the nearest in-language word it knows for a foreign term
 * it doesn't have the capacity to place) but roughly doubles both the
 * download and the runtime, which on an hour-long recording is the
 * difference between a long wait and a much longer one. "Small" in
 * particular is a real commitment: ~970MB (vs. tiny's ~150MB) and several
 * times slower, since this app runs fp32 on wasm with no GPU.
 */
export interface WhisperModelOption {
  id: string;
  label: string;
  /** Approximate one-time download, shown in the picker. */
  sizeLabel: string;
}

export const WHISPER_MODELS: WhisperModelOption[] = [
  { id: "Xenova/whisper-tiny", label: "Tiny — fastest", sizeLabel: "~150MB" },
  { id: "Xenova/whisper-base", label: "Base — more accurate", sizeLabel: "~290MB" },
  { id: "Xenova/whisper-small", label: "Small — most accurate", sizeLabel: "~970MB" },
];

export const DEFAULT_WHISPER_MODEL_ID = WHISPER_MODELS[0].id;

export interface ModelFileProgress {
  file: string;
  status: string;
  loaded?: number;
  total?: number;
}

export type WorkerRequest = {
  type: "transcribe";
  requestId: string;
  audio: Float32Array;
  /** 2-letter Whisper language code, e.g. "id" — see lib/speechLanguage.ts. */
  language: string;
  /** One of WHISPER_MODELS' ids. */
  modelId: string;
};

/** How far through the clip transcription has got. */
export interface TranscribeProgress {
  processedSeconds: number;
  totalSeconds: number;
  /** "recovering" = the second sweep re-checking stretches the model skipped. */
  phase: "transcribing" | "recovering";
}

export type WorkerResponse =
  | { type: "status"; requestId: string; phase: "loading-model" | "transcribing" }
  | { type: "progress"; requestId: string; progress: ModelFileProgress }
  | { type: "transcribe-progress"; requestId: string; progress: TranscribeProgress }
  | {
      type: "result";
      requestId: string;
      segments: TranscriptSegment[];
      /** Seconds of the clip that actually contained audible sound. */
      speechSeconds: number;
      /** Total length of the clip that was transcribed. */
      audioSeconds: number;
    }
  | { type: "error"; requestId: string; message: string };

/**
 * The common shape both transcription engines resolve to — the local worker
 * (via useTranscriber) and cloud providers (via cloudTranscribe.ts) — so
 * callers (AppClient's handleAutoTranscribe) don't need to know which one ran.
 */
export interface TranscriptionResult {
  segments: TranscriptSegment[];
  /** Seconds of the clip that actually contained audible sound. */
  speechSeconds: number;
  /** Total length of the clip that was transcribed. */
  audioSeconds: number;
}
