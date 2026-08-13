const WHISPER_SAMPLE_RATE = 16000;

/**
 * Decodes an audio Blob into mono PCM samples at 16kHz — the input format
 * Whisper models expect. Runs entirely client-side via the Web Audio API.
 */
export async function decodeAudioTo16kMono(blob: Blob): Promise<Float32Array> {
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
    return decoded.getChannelData(0);
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
  return resampled.getChannelData(0);
}
