export const WHISPER_SAMPLE_RATE = 16000;

/**
 * Peak amplitude (0..1) below which audio is treated as having no audible
 * content (~-46 dBFS). Whisper doesn't just return nothing for silence — it
 * hallucinates, typically a single word repeated for pages ("yang yang yang
 * …"), because transformers.js doesn't expose Whisper's own no-speech /
 * logprob / compression-ratio guards. So silence has to be caught up front.
 */
export const SILENCE_PEAK_THRESHOLD = 0.005;

/** Below this peak, audio is boosted before transcription (see normalizeForSpeech). */
const QUIET_PEAK_THRESHOLD = 0.35;
const NORMALIZE_TARGET_PEAK = 0.9;
const MAX_NORMALIZE_GAIN = 12;

export interface DecodedAudio {
  samples: Float32Array;
  /** Highest absolute sample value, 0..1. */
  peak: number;
  /** Root-mean-square level, 0..1. */
  rms: number;
}

function measureLevels(samples: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    const magnitude = value < 0 ? -value : value;
    if (magnitude > peak) peak = magnitude;
    sumSquares += value * value;
  }
  return { peak, rms: Math.sqrt(sumSquares / Math.max(1, samples.length)) };
}

/**
 * Scales quiet-but-audible audio up toward full scale, in place. Tab/system
 * audio is often captured far quieter than mic input, and a weak signal is a
 * major driver of Whisper hallucination. Gain is capped so near-silent noise
 * floors don't get amplified into garbage.
 */
export function normalizeForSpeech(audio: DecodedAudio): DecodedAudio {
  if (audio.peak <= SILENCE_PEAK_THRESHOLD || audio.peak >= QUIET_PEAK_THRESHOLD) {
    return audio;
  }
  const gain = Math.min(MAX_NORMALIZE_GAIN, NORMALIZE_TARGET_PEAK / audio.peak);
  const { samples } = audio;
  for (let i = 0; i < samples.length; i++) {
    samples[i] = samples[i] * gain;
  }
  return { samples, peak: audio.peak * gain, rms: audio.rms * gain };
}

/**
 * Averages an AudioBuffer's channels down to one Float32Array. Always a
 * standalone copy, never a view onto the AudioBuffer: the caller transfers
 * this array's ArrayBuffer to the worker, which would otherwise detach
 * storage the AudioBuffer still owns. Copying also lets the AudioBuffer be
 * collected instead of being pinned for the whole transcription.
 */
function downmixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return new Float32Array(buffer.getChannelData(0));

  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < mono.length; i++) mono[i] += data[i];
  }
  const scale = 1 / buffer.numberOfChannels;
  for (let i = 0; i < mono.length; i++) mono[i] *= scale;
  return mono;
}

/**
 * Decodes an audio Blob into mono PCM samples at 16kHz — the input format
 * Whisper models expect. Runs entirely client-side via the Web Audio API.
 *
 * Decoding happens *into* a 16kHz context on purpose: decodeAudioData
 * resamples to the context's rate, so the samples never expand to the file's
 * native rate first. That matters at the lengths this app records — measured
 * on 10min/48kHz/stereo, the buffer goes from 220MB to 73MB (3x), which over
 * an hour is the difference between ~1.3GB and ~440MB — and it removes the
 * separate OfflineAudioContext resample pass (and its own full-size buffer)
 * entirely.
 */
export async function decodeAudioTo16kMono(blob: Blob): Promise<DecodedAudio> {
  const arrayBuffer = await blob.arrayBuffer();
  const OfflineAudioContextCtor =
    window.OfflineAudioContext ||
    (window as typeof window & { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!OfflineAudioContextCtor) {
    throw new Error("Web Audio API is not supported in this browser.");
  }

  // Length/channels here only describe this context's (unused) render target
  // — decodeAudioData returns a buffer sized by the source audio.
  const context = new OfflineAudioContextCtor(1, 1, WHISPER_SAMPLE_RATE);
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(arrayBuffer);
  } catch (error) {
    throw new Error(
      "This recording couldn't be decoded for transcription. Very long recordings can " +
        "exhaust available memory — try transcribing a shorter recording. " +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const samples = downmixToMono(decoded);
  return { samples, ...measureLevels(samples) };
}
