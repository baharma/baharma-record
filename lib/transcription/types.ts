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
 * tune: "base" is markedly more accurate (especially on non-English and on
 * sung vocals, where "tiny" struggles badly) but is ~2x the download and
 * ~2x slower, which on an hour-long recording is the difference between a
 * long wait and a much longer one.
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
