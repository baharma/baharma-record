import { pickSupportedMimeType } from "@/lib/mediaFormat";

// Shared between NewSourceModal's inline field and SettingsModal's
// centralized page — same key, so a value set in one shows up in the other.
export const DEEPGRAM_KEY_STORAGE_KEY = "baharma-record:deepgram-api-key";

/**
 * Live streaming transcription for tab/window audio via Deepgram
 * (wss://api.deepgram.com/v1/listen) — the "live, like the mic" option for
 * the one stream the browser's own SpeechRecognition can never listen to
 * (see useRecordingSession.ts's notes: it only ever hears the physical
 * microphone, regardless of what's being recorded).
 *
 * This is deliberately the one place in the app that speaks a specific
 * vendor's proprietary protocol rather than a generic shape (contrast
 * cloudTranscribe.ts's OpenAI-compatible REST endpoint, used for
 * after-the-fact batch transcription): true low-latency streaming ASR isn't
 * a shape multiple vendors share the way batch transcription is — it needs
 * a persistent WebSocket, and each vendor's message protocol differs.
 * Deepgram was picked here for having a documented client-only auth path
 * (below) and a free trial tier.
 *
 * Browser WebSockets can't send custom headers, so the API key goes in the
 * `Sec-WebSocket-Protocol` list instead (["token", apiKey]) — Deepgram's own
 * documented workaround for browser clients. Same trust model as
 * cloudTranscribe.ts's API keys: sent straight from this browser, since the
 * app has no backend to broker it through. If Deepgram changes this API,
 * re-check the current docs — this integration can't be exercised against a
 * live Deepgram account from this codebase's own test setup.
 */
export interface DeepgramLiveOptions {
  apiKey: string;
  /** 2-letter language code, e.g. "en", "id" — see lib/speechLanguage.ts. */
  language: string;
  /** Deepgram model id. Defaults to "nova-2"; override if an account needs a different one. */
  model?: string;
}

export interface DeepgramLiveHandlers {
  onFinal: (text: string) => void;
  onInterim: (text: string) => void;
  /** A problem worth surfacing — the session continues without live tab transcription. */
  onError: (message: string) => void;
  /** Nothing more will arrive (after a requested stop, or a fatal error). */
  onEnded: () => void;
}

export interface DeepgramLiveSession {
  stop: () => void;
}

export function startDeepgramLiveTranscription(
  stream: MediaStream,
  options: DeepgramLiveOptions,
  handlers: DeepgramLiveHandlers,
): DeepgramLiveSession {
  const mimeType = pickSupportedMimeType();
  if (!mimeType || typeof MediaRecorder === "undefined" || typeof WebSocket === "undefined") {
    handlers.onError("This browser can't stream audio for live cloud transcription.");
    handlers.onEnded();
    return { stop: () => {} };
  }

  const params = new URLSearchParams({
    model: options.model?.trim() || "nova-2",
    language: options.language,
    interim_results: "true",
    punctuate: "true",
    smart_format: "true",
  });
  const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, [
    "token",
    options.apiKey,
  ]);

  let recorder: MediaRecorder | null = null;
  let stopped = false;
  let ended = false;

  function endOnce() {
    if (ended) return;
    ended = true;
    handlers.onEnded();
  }

  socket.onopen = () => {
    if (stopped) return;
    recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
        socket.send(event.data);
      }
    };
    // Small chunks for low latency — this is a live preview, not the
    // recording of record (that's the separate secondary MediaRecorder in
    // useRecordingSession.ts, reading the same stream in parallel).
    recorder.start(250);
  };

  socket.onmessage = (event) => {
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!data || typeof data !== "object" || (data as { type?: string }).type !== "Results") return;
    const result = data as {
      is_final?: boolean;
      channel?: { alternatives?: { transcript?: string }[] };
    };
    const transcript = result.channel?.alternatives?.[0]?.transcript ?? "";
    if (!transcript) return;
    if (result.is_final) {
      handlers.onFinal(transcript.trim());
    } else {
      handlers.onInterim(transcript);
    }
  };

  socket.onerror = () => {
    handlers.onError(
      "Live cloud transcription for tab audio hit a connection error — check the Deepgram API " +
        "key. The recording itself continues normally; the tab audio can still be transcribed " +
        'afterward with "Transcribe Tab Audio".',
    );
  };

  socket.onclose = () => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    endOnce();
  };

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (recorder && recorder.state !== "inactive") recorder.stop();
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: "CloseStream" }));
        } catch {
          // ignore
        }
        // Give Deepgram a moment to flush trailing results before closing —
        // closing immediately can drop the last few words, the same
        // finalize race useRecordingSession.ts's recorder/recognition
        // handling guards against.
        setTimeout(() => {
          if (socket.readyState === WebSocket.OPEN) socket.close();
        }, 1500);
      } else {
        socket.close();
      }
    },
  };
}
