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
 * Decodes an audio Blob into mono PCM samples at 16kHz — the input format
 * Whisper models expect. Runs entirely client-side via the Web Audio API.
 */
export async function decodeAudioTo16kMono(blob: Blob): Promise<DecodedAudio> {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("Web Audio API is not supported in this browser.");
  }

  const audioContext = new AudioContextCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await audioContext.decodeAudioData(arrayBuffer);
  } finally {
    await audioContext.close();
  }

  if (decoded.sampleRate === WHISPER_SAMPLE_RATE && decoded.numberOfChannels === 1) {
    const samples = decoded.getChannelData(0);
    return { samples, ...measureLevels(samples) };
  }

  const offlineContext = new OfflineAudioContext(
    1,
    Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE),
    WHISPER_SAMPLE_RATE,
  );
  const source = offlineContext.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineContext.destination);
  source.start();
  const resampled = await offlineContext.startRendering();
  const samples = resampled.getChannelData(0);
  return { samples, ...measureLevels(samples) };
}
