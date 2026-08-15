import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import {
  type ModelFileProgress,
  type WorkerRequest,
  type WorkerResponse,
} from "./types";
import { findFirstGap, type Interval } from "./coverage";
import { isAllNonSpeech, screenNonSpeechHallucinations } from "./hallucination";
import { stripHallucinatedRepetition } from "./repetition";
import {
  findNextAudibleSample,
  findSpeechRegions,
  shouldSplitIntoRegions,
  totalAudibleSeconds,
} from "./speechRegions";
import { WHISPER_SAMPLE_RATE } from "@/lib/audioDecode";
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

interface SliceResult {
  segments: TranscriptSegment[];
  /** Timespans this pass's output actually accounts for, in absolute time. */
  intervals: Interval[];
}
/**
 * How much audio a single continuation pass is handed. Matches
 * chunk_length_s, which is how much Whisper looks at in one go anyway, so
 * capping here costs no context — but it keeps each pass a fixed price
 * instead of re-processing the whole remaining clip every time (which turns
 * a repeatedly-stalling model into quadratic work).
 */
const CONTINUATION_WINDOW_SECONDS = 30;

/**
 * How much audio the first sweep transcribes per step. Only a progress
 * granularity knob — the model chunks at chunk_length_s internally either
 * way — so it's kept wide enough that its own boundaries (which don't get
 * transformers.js's stride overlap) stay rare.
 */
const INITIAL_WINDOW_SECONDS = 300;

/**
 * How many gap-recovery passes a clip is allowed, scaled to its own length.
 * A fixed cap can't work across the range this app records: 24 passes is
 * generous for a 25s voice note but covers only 12 minutes of an hour-long
 * recording, which on music can stall in most of its ~120 internal chunks and
 * would silently keep the rest untranscribed. Budgeting 1.5 windows per
 * window of clip keeps worst-case recovery work proportional to the recording
 * rather than unbounded.
 */
function continuationPassBudget(audioSeconds: number): number {
  return Math.max(8, Math.ceil((audioSeconds / CONTINUATION_WINDOW_SECONDS) * 1.5));
}

// Keyed by model id: switching models mustn't discard the pipeline already
// downloaded for the other one, or going back to it would re-download it.
const transcriberPromises = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();

function getTranscriber(
  modelId: string,
  onProgress: (progress: ModelFileProgress) => void,
): Promise<AutomaticSpeechRecognitionPipeline> {
  const existing = transcriberPromises.get(modelId);
  if (existing) return existing;

  const created = pipeline("automatic-speech-recognition", modelId, {
    progress_callback: (data: unknown) => onProgress(data as ModelFileProgress),
    device: "wasm",
    // See the comment on WHISPER_MODELS in ./types.ts for why fp32.
    dtype: "fp32",
  }) as Promise<AutomaticSpeechRecognitionPipeline>;
  // A failed load must not be cached, or every later attempt replays the
  // same rejection without ever retrying the download.
  created.catch(() => transcriberPromises.delete(modelId));
  transcriberPromises.set(modelId, created);
  return created;
}

ctx.onmessage = async (event) => {
  const { type, requestId, audio, language, modelId } = event.data;
  if (type !== "transcribe") return;

  try {
    ctx.postMessage({ type: "status", requestId, phase: "loading-model" });
    const transcriber = await getTranscriber(modelId, (progress) => {
      ctx.postMessage({ type: "progress", requestId, progress });
    });

    ctx.postMessage({ type: "status", requestId, phase: "transcribing" });

    async function transcribeSlice(
      slice: Float32Array,
      offsetSeconds: number,
    ): Promise<SliceResult> {
      const output = (await transcriber(slice, {
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
      const chunks = result.chunks ?? [];

      // What the model actually emitted output for — the basis for finding
      // audio it left behind. A chunk that reports no end timestamp counts
      // only as its start instant.
      const intervals = chunks.map((chunk): Interval => {
        const start = chunk.timestamp[0] ?? 0;
        return {
          start: offsetSeconds + start,
          end: offsetSeconds + (chunk.timestamp[1] ?? start),
        };
      });

      const segments = chunks
        .map(
          (chunk: AsrChunk): TranscriptSegment => ({
            time: offsetSeconds + (chunk.timestamp[0] ?? 0),
            text: chunk.text.trim(),
          }),
        )
        .filter((segment) => segment.text.length > 0);

      return { segments, intervals };
    }

    const audioSeconds = audio.length / WHISPER_SAMPLE_RATE;
    const reportProgress = (
      processedSeconds: number,
      phase: "transcribing" | "recovering",
    ) => {
      ctx.postMessage({
        type: "transcribe-progress",
        requestId,
        progress: {
          processedSeconds: Math.min(processedSeconds, audioSeconds),
          totalSeconds: audioSeconds,
          phase,
        },
      });
    };

    // Silence-heavy audio (a call with long pauses, a tab that's mostly
    // quiet) makes Whisper collapse the whole recording into one bogus
    // segment and swallow the speech in between — the cause of transcripts
    // that appear to jump from one timestamp to a far later one. Splitting
    // on speech regions first keeps every utterance and its real timestamp.
    // Continuous speech skips this and takes the plain chunked path.
    const regions = findSpeechRegions(audio, WHISPER_SAMPLE_RATE);
    const rawSegments: TranscriptSegment[] = [];
    // Only what the model produced output for — deliberately not the spans it
    // was *handed*. Stopping early mid-slice is exactly the failure being
    // recovered from, so an attempted span proves nothing about coverage.
    const covered: Interval[] = [];
    if (shouldSplitIntoRegions(regions, audio.length)) {
      // Sequentially, not Promise.all: every region shares one pipeline
      // instance, and overlapping inference calls on a single ONNX session
      // aren't safe.
      for (const region of regions) {
        const pass = await transcribeSlice(
          audio.slice(region.startSample, region.endSample),
          region.startSample / WHISPER_SAMPLE_RATE,
        );
        rawSegments.push(...pass.segments);
        covered.push(...pass.intervals);
        reportProgress(region.endSample / WHISPER_SAMPLE_RATE, "transcribing");
      }
    } else {
      // Walked in windows rather than handed over whole: an hour-long
      // recording is otherwise one opaque call with no way to report
      // progress, leaving the UI unable to distinguish a long run from a
      // hung one. Windows are far wider than chunk_length_s, so the model
      // still does its own 30s chunking (and stride overlap) inside each.
      const windowSamples = INITIAL_WINDOW_SECONDS * WHISPER_SAMPLE_RATE;
      for (let start = 0; start < audio.length; start += windowSamples) {
        const end = Math.min(audio.length, start + windowSamples);
        const pass = await transcribeSlice(
          audio.slice(start, end),
          start / WHISPER_SAMPLE_RATE,
        );
        rawSegments.push(...pass.segments);
        covered.push(...pass.intervals);
        reportProgress(end / WHISPER_SAMPLE_RATE, "transcribing");
      }
    }

    // Whisper regularly stops generating before its input runs out — music
    // and singing are the worst offenders. Neither path above revisits what
    // it skipped, so audio would silently never reach the transcript. Sweep
    // the timeline for stretches nothing accounts for and give each one its
    // own dedicated pass, so no gap — however long — ends the transcript.
    const passBudget = continuationPassBudget(audioSeconds);
    for (let pass = 0; pass < passBudget; pass++) {
      const gap = findFirstGap(covered, audioSeconds);
      if (gap === null) break;

      // findFirstGap always returns the earliest uncovered stretch and every
      // iteration marks that stretch covered, so this advances monotonically.
      reportProgress(gap.start, "recovering");

      const gapEndSample = Math.ceil(gap.end * WHISPER_SAMPLE_RATE);
      const audibleSample = findNextAudibleSample(
        audio,
        WHISPER_SAMPLE_RATE,
        Math.floor(gap.start * WHISPER_SAMPLE_RATE),
      );

      if (audibleSample === null || audibleSample >= gapEndSample) {
        // Genuinely silent stretch — nothing to recover. Mark it accounted
        // for so the sweep moves on to the next gap.
        covered.push(gap);
        continue;
      }

      const sliceEndSample = Math.min(
        gapEndSample,
        audibleSample + CONTINUATION_WINDOW_SECONDS * WHISPER_SAMPLE_RATE,
      );
      const continuation = await transcribeSlice(
        audio.slice(audibleSample, sliceEndSample),
        audibleSample / WHISPER_SAMPLE_RATE,
      );
      // Recovery re-attempts audio the model gave up on — but on an
      // instrumental stretch, giving up was the *right* answer, and pushing
      // it to try again just invents dialogue that was never spoken. Keep
      // this pass's text only when it found something that reads as real
      // speech; otherwise treat the stretch as handled and move on.
      if (!isAllNonSpeech(continuation.segments)) {
        rawSegments.push(...continuation.segments);
        covered.push(...continuation.intervals);
      }
      // Mark the attempted window covered either way. This window just had a
      // dedicated attempt, so retrying it would loop forever on audio the
      // model simply can't transcribe — and it guarantees the sweep ends.
      covered.push({ start: gap.start, end: sliceEndSample / WHISPER_SAMPLE_RATE });
    }

    rawSegments.sort((a, b) => a.time - b.time);

    // Belt-and-braces: drop anything that still came out degenerate, so a
    // hallucinated wall of one repeated word never reaches the transcript,
    // then drop the non-speech fillers background music provokes.
    const segments = screenNonSpeechHallucinations(
      stripHallucinatedRepetition(rawSegments),
    );

    ctx.postMessage({
      type: "result",
      requestId,
      segments,
      speechSeconds: totalAudibleSeconds(audio, WHISPER_SAMPLE_RATE),
      audioSeconds,
    });
  } catch (error) {
    ctx.postMessage({
      type: "error",
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
