import { measureLevels, SILENCE_PEAK_THRESHOLD, WHISPER_SAMPLE_RATE } from "@/lib/audioDecode";
import { LiveVad, MIN_SPEECH_DYNAMIC_RANGE, type VadWindow } from "./liveVad";

/**
 * Live, on-device transcription for tab/window audio — the free, no-API-key
 * alternative to deepgramLive.ts's cloud path, for the one stream the
 * browser's own SpeechRecognition can never listen to (see
 * useRecordingSession.ts). Same `start___(stream, options, handlers): { stop }`
 * contract as deepgramLive.ts, so it plugs into the recording session hook
 * the same way.
 *
 * Unlike Deepgram, there's no server doing continuous streaming ASR here —
 * this taps raw PCM off the stream via the Web Audio API, hands short
 * VAD-cut windows (see ./liveVad) to the caller-supplied `transcribeWindow`
 * (a local Whisper worker call, wired up in hooks/useLiveTranscriber.ts),
 * and reports whatever text comes back. Whisper has no true partial
 * hypothesis, so this only ever reports finished text per window — there is
 * no interim/onInterim here, unlike the Deepgram path.
 */
export interface LocalLiveOptions {
  /** 2-letter Whisper language code, e.g. "id" — see lib/speechLanguage.ts. */
  language: string;
  /** One of LIVE_WHISPER_MODELS' ids — see lib/transcription/types.ts. */
  modelId: string;
  transcribeWindow: (
    samples: Float32Array,
    language: string,
    modelId: string,
  ) => Promise<{ text: string }>;
}

export interface LocalLiveHandlers {
  /**
   * `startSeconds` is when this text's audio was *captured*, counted from the
   * start of this session — deliberately not when the result arrived. Local
   * inference takes seconds per window (and the very first window also waits
   * on the model loading), so stamping on arrival pushed every line minutes
   * late on the timeline: a recording whose speech began at 0:02 showed its
   * first line at 0:49.
   */
  onFinal: (text: string, startSeconds: number) => void;
  /** A problem worth surfacing — the session continues without live tab transcription. */
  onError: (message: string) => void;
  /** Nothing more will arrive (after a requested stop, or a fatal error). */
  onEnded: () => void;
}

export interface LocalLiveSession {
  stop: () => void;
}

/** Samples per ScriptProcessorNode callback — a few hundred ms at 16kHz. */
const PROCESSOR_BUFFER_SIZE = 4096;

export function startLocalLiveTranscription(
  stream: MediaStream,
  options: LocalLiveOptions,
  handlers: LocalLiveHandlers,
): LocalLiveSession {
  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    handlers.onError("This browser can't capture audio for live on-device transcription.");
    handlers.onEnded();
    return { stop: () => {} };
  }

  const audioContext = new AudioContextCtor({ sampleRate: WHISPER_SAMPLE_RATE });
  const source = audioContext.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated in favor of AudioWorkletNode, but it's
  // universally supported in the desktop-Chrome-only browsers this app
  // already requires, and the per-callback work here (copying a small
  // Float32Array) is cheap enough that main-thread jank isn't a real
  // concern — accepted v1 trade, not worth the extra worklet-module wiring.
  const processor = audioContext.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
  // ScriptProcessorNode only fires onaudioprocess once it's connected
  // through to a destination. Route through a silenced GainNode so this tap
  // doesn't produce an audible echo of the tab audio.
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;

  const vad = new LiveVad(audioContext.sampleRate);

  let stopped = false;
  let ended = false;
  let processing = false;
  const queue: VadWindow[] = [];

  function endOnce() {
    if (ended) return;
    ended = true;
    handlers.onEnded();
  }

  async function drainQueue() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const window = queue.shift()!;
        try {
          // Skip the model call entirely on a basically-silent window — the
          // same guard useTranscriber.ts applies before the batch pass, and
          // for the same reason: weak/absent signal is a major driver of
          // Whisper hallucination.
          if (measureLevels(window.samples).peak <= SILENCE_PEAK_THRESHOLD) continue;
          // Loud but *sustained* audio — music, applause, room tone — is the
          // other half of the same problem, and the more damaging half: on it
          // Whisper invents fluent dialogue that reads like a real
          // transcript, so nothing downstream can tell it apart afterward.
          // Rejecting it here, before the model ever sees it, is the only
          // point where the audio itself is still available to judge by.
          if (window.dynamicRange < MIN_SPEECH_DYNAMIC_RANGE) continue;
          const { text } = await options.transcribeWindow(
            window.samples,
            options.language,
            options.modelId,
          );
          const trimmed = text.trim();
          if (trimmed.length > 0) handlers.onFinal(trimmed, window.startSeconds);
        } catch (error) {
          handlers.onError(
            error instanceof Error
              ? error.message
              : "Live on-device transcription failed on part of the tab audio.",
          );
        }
      }
    } finally {
      processing = false;
      if (stopped && queue.length === 0) endOnce();
    }
  }

  function enqueue(window: VadWindow) {
    queue.push(window);
    // Deliberately not awaited: this function is only ever called from a
    // synchronous context (onaudioprocess, or stop()'s flush), and
    // drainQueue's own `processing` guard is what keeps at most one
    // transcribeWindow call in flight at a time — the ONNX-session
    // constraint useLiveTranscriber's worker relies on.
    void drainQueue();
  }

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    // event.inputBuffer's backing storage is reused by the browser between
    // callbacks, so this must be copied before handing it to the VAD, which
    // may hold onto it across multiple pushes.
    const cut = vad.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    if (cut) enqueue(cut);
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioContext.destination);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      processor.disconnect();
      source.disconnect();
      silentGain.disconnect();
      audioContext.close().catch(() => {});

      const trailing = vad.flush();
      if (trailing) {
        enqueue(trailing);
      } else if (!processing) {
        endOnce();
      }
      // If trailing is null but a window is still processing, or if trailing
      // was just enqueued, drainQueue's own finally block calls endOnce once
      // the queue is empty — mirrors deepgramLive.ts's stop()-flush pattern.
    },
  };
}
