import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import {
  WHISPER_MODEL_ID,
  type ModelFileProgress,
  type WorkerRequest,
  type WorkerResponse,
} from "./types";
import { stripHallucinatedRepetition } from "./repetition";
import type { TranscriptSegment } from "@/lib/types";

// The multi-threaded WASM backend needs SharedArrayBuffer, which requires
// the page to be served with Cross-Origin-Opener-Policy/Cross-Origin-
// Embedder-Policy headers. Since this app can be exported as static files
// and served by any host (no custom headers guaranteed), force the
// single-threaded backend so transcription works everywhere out of the box.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
}

// Avoid `/// <reference lib="webworker" />`: it conflicts with the "dom" lib
// already used by the rest of this TypeScript project. `self` is typed
// loosely here on purpose.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

interface AsrChunk {
  timestamp: [number, number | null];
  text: string;
}

interface AsrOutput {
  text: string;
  chunks?: AsrChunk[];
}


let transcriberPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function getTranscriber(
  onProgress: (progress: ModelFileProgress) => void,
): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!transcriberPromise) {
    transcriberPromise = pipeline("automatic-speech-recognition", WHISPER_MODEL_ID, {
      progress_callback: (data: unknown) => onProgress(data as ModelFileProgress),
      device: "wasm",
      // See the comment on WHISPER_MODEL_ID in ./types.ts for why fp32.
      dtype: "fp32",
    }) as Promise<AutomaticSpeechRecognitionPipeline>;
  }
  return transcriberPromise;
}

ctx.onmessage = async (event) => {
  const { type, requestId, audio, language } = event.data;
  if (type !== "transcribe") return;

  try {
    ctx.postMessage({ type: "status", requestId, phase: "loading-model" });
    const transcriber = await getTranscriber((progress) => {
      ctx.postMessage({ type: "progress", requestId, progress });
    });

    ctx.postMessage({ type: "status", requestId, phase: "transcribing" });
    const output = (await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      // Without an explicit language, transformers.js doesn't reliably
      // auto-detect — it silently falls back to English.
      language,
      task: "transcribe",
      // Curb the runaway-repetition failure mode at generation time. A
      // 6-gram is long enough that real speech practically never repeats
      // one verbatim, so this only bites on degenerate loops.
      no_repeat_ngram_size: 6,
      repetition_penalty: 1.15,
    })) as AsrOutput | AsrOutput[];

    const result = Array.isArray(output) ? output[0] : output;
    const rawSegments: TranscriptSegment[] = (result.chunks ?? [])
      .map(
        (chunk: AsrChunk): TranscriptSegment => ({
          time: chunk.timestamp[0] ?? 0,
          text: chunk.text.trim(),
        }),
      )
      .filter((segment) => segment.text.length > 0);

    // Belt-and-braces: drop anything that still came out degenerate, so a
    // hallucinated wall of one repeated word never reaches the transcript.
    const segments = stripHallucinatedRepetition(rawSegments);

    ctx.postMessage({ type: "result", requestId, segments });
  } catch (error) {
    ctx.postMessage({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
