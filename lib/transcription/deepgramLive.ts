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
  /**
   * One or more keys, tried in order. When the connection with the current
   * key fails (rejected, quota exhausted, dropped), the session reconnects
   * with the next one on the same stream instead of ending.
   */
  apiKeys: string[];
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

/** Splits a pasted list of keys (one per line, or comma/space separated) into distinct non-empty keys. */
export function parseDeepgramKeys(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).map((key) => key.trim()).filter(Boolean))];
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
  if (
    options.apiKeys.length === 0 ||
    !mimeType ||
    typeof MediaRecorder === "undefined" ||
    typeof WebSocket === "undefined"
  ) {
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
  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  const keys = options.apiKeys;

  let socket: WebSocket | null = null;
  let activeRecorder: MediaRecorder | null = null;
  let stopped = false;
  let ended = false;

  function endOnce() {
    if (ended) return;
    ended = true;
    handlers.onEnded();
  }

  function connect(keyIndex: number) {
    const ws = new WebSocket(url, ["token", keys[keyIndex]]);
    socket = ws;
    let recorder: MediaRecorder | null = null;
    /** Whether the connection ever established — see onclose for why it matters. */
    let opened = false;

    ws.onopen = () => {
      opened = true;
      if (stopped) return;
      recorder = new MediaRecorder(stream, { mimeType: mimeType! });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(event.data);
        }
      };
      // Small chunks for low latency — this is a live preview, not the
      // recording of record (that's the separate secondary MediaRecorder in
      // useRecordingSession.ts, reading the same stream in parallel).
      // A fresh recorder per connection also means each socket's first chunk
      // carries the container header Deepgram needs to decode the stream.
      activeRecorder = recorder;
      recorder.start(250);
    };

    ws.onmessage = (event) => {
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

    ws.onerror = () => {
      // The WebSocket spec deliberately gives JS no detail on an "error" event
      // (no status code, no message), so there is nothing useful to report from
      // here — `onclose` always fires right after and is where the actual
      // diagnosis happens. Kept at warn rather than error precisely because it
      // carries no information: at error level it trips Next's dev error
      // overlay, interrupting the user with a message that by construction
      // can't tell them anything.
      console.warn("Deepgram live transcription: WebSocket error (detail follows in the close event).");
    };

    ws.onclose = (event) => {
      if (recorder && recorder.state !== "inactive") recorder.stop();
      // Code 1000 is a normal closure — either our own stop() below, or
      // Deepgram's own clean shutdown after it.
      if (!stopped && event.code !== 1000) {
        const detail = `code ${event.code}${event.reason ? `: ${event.reason}` : ""}`;
        // Fail over to the next key, if any: a rejected or out-of-credit key
        // and a dropped connection look alike from here, and either way the
        // next key is the best available recovery.
        if (keyIndex + 1 < keys.length) {
          handlers.onError(
            `Deepgram key ${keyIndex + 1} of ${keys.length} failed (${detail}); ` +
              `switched to key ${keyIndex + 2}.`,
          );
          connect(keyIndex + 1);
          return;
        }
        // Never having opened means the failure happened during the HTTP
        // upgrade, before the WebSocket existed — which is how Deepgram rejects
        // a bad key. Browsers deliberately hide that HTTP status (401/403) from
        // page scripts, reporting only an opaque 1006 with no reason, so this
        // has to be inferred rather than read. Saying so beats surfacing a bare
        // "code 1006" the user can't act on.
        handlers.onError(
          opened
            ? `Live cloud transcription for tab audio disconnected mid-recording (${detail}). ` +
                "The recording itself continues normally; the tab audio can still be transcribed " +
                'afterward with "Transcribe Tab Audio".'
            : `Live cloud transcription for tab audio couldn't connect to Deepgram (${detail}). ` +
                "The connection was refused before it opened, which usually means the API key was " +
                "rejected — check that it's a Deepgram key (not another service's), that it hasn't " +
                "expired, and that the account still has credit. Browsers hide the real HTTP status " +
                "from the page, so this can't be reported more precisely. The recording itself " +
                "continues normally, and the on-device live option needs no key at all.",
        );
      }
      endOnce();
    };
  }

  connect(0);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (activeRecorder && activeRecorder.state !== "inactive") activeRecorder.stop();
      const ws = socket;
      if (!ws) return;
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "CloseStream" }));
        } catch {
          // ignore
        }
        // Give Deepgram a moment to flush trailing results before closing —
        // closing immediately can drop the last few words, the same
        // finalize race useRecordingSession.ts's recorder/recognition
        // handling guards against.
        setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) ws.close();
        }, 1500);
      } else {
        ws.close();
      }
    },
  };
}
