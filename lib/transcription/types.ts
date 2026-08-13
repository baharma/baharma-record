import type { TranscriptSegment } from "@/lib/types";

/**
 * Multilingual Whisper model, run entirely client-side via onnxruntime-web.
 * "tiny" keeps the one-time download as small as practical; swap for
 * "Xenova/whisper-base" (or larger) for better accuracy at the cost of a
 * bigger download. Loaded at fp32 (see whisper.worker.ts) rather than a
 * quantized dtype: the quantized/fp16 exports currently hit a graph-
 * optimizer bug in the onnxruntime-web dev build transformers.js depends
 * on (fails with "Missing required scale for DequantizeLinear" or a
 * LayerNorm fusion error when creating the session) — fp32 avoids that
 * code path entirely, at the cost of a larger download (~150MB for tiny).
 */
export const WHISPER_MODEL_ID = "Xenova/whisper-tiny";

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
};

export type WorkerResponse =
  | { type: "status"; requestId: string; phase: "loading-model" | "transcribing" }
  | { type: "progress"; requestId: string; progress: ModelFileProgress }
  | { type: "result"; requestId: string; segments: TranscriptSegment[] }
  | { type: "error"; requestId: string; message: string };
