import type { CloudTranscribeConfig } from "@/lib/transcription/cloudProviders";
import type { TranscriptionResult } from "@/lib/transcription/types";
import type { TranscriptSegment } from "@/lib/types";

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  return "webm";
}

interface CloudSegment {
  start: number;
  end: number;
  text: string;
}

interface CloudTranscriptionResponse {
  duration?: number;
  segments?: CloudSegment[];
  text?: string;
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const message =
      body?.error?.message ?? body?.message ?? (typeof body?.error === "string" ? body.error : undefined);
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // Body wasn't JSON (or was empty) — fall through to the status text.
  }
  return response.statusText || `HTTP ${response.status}`;
}

/**
 * Converts to base64 in fixed-size chunks rather than
 * `btoa(String.fromCharCode(...bytes))` in one shot — spreading a
 * multi-hour recording's whole byte array into `String.fromCharCode`'s
 * arguments blows the call stack. 32KB is the conventional safe chunk size
 * for this pattern.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Hugging Face's Inference API for automatic-speech-recognition doesn't
 * share OpenAI's request/response shape at all (JSON body with base64
 * audio, not multipart form; model id is part of the URL path, not a form
 * field; no language parameter; timestamps come back as "chunks", not
 * "segments") — verified against
 * https://huggingface.co/docs/inference-providers/tasks/automatic-speech-recognition
 * since guessing an unverified API shape wastes a debugging round-trip more
 * than it saves. `language` is accepted for a consistent call signature but
 * unused: the API has no documented way to force it, unlike every other
 * provider here.
 */
async function transcribeWithHuggingFace(
  audioBlob: Blob,
  config: CloudTranscribeConfig,
): Promise<TranscriptionResult> {
  if (!config.apiKey.trim()) {
    throw new Error("No API key is configured for this provider.");
  }
  const model = config.model.trim() || "openai/whisper-large-v3";
  const base64Audio = arrayBufferToBase64(await audioBlob.arrayBuffer());

  let response: Response;
  try {
    response = await fetch(
      `${config.baseUrl.trim().replace(/\/+$/, "")}/${model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          inputs: base64Audio,
          parameters: { return_timestamps: true },
        }),
      },
    );
  } catch {
    throw new Error(
      "Couldn't reach the Hugging Face Inference API — check your network connection and " +
        "that the model is available for serverless inference.",
    );
  }

  if (!response.ok) {
    throw new Error(
      `Cloud transcription failed (${response.status}): ${await readErrorDetail(response)}`,
    );
  }

  const data: { text?: string; chunks?: { text: string; timestamp?: [number, number] }[] } =
    await response.json();
  const chunks = data.chunks ?? [];
  const segments: TranscriptSegment[] =
    chunks.length > 0
      ? chunks
          .map((chunk) => ({ time: chunk.timestamp?.[0] ?? 0, text: chunk.text.trim() }))
          .filter((segment) => segment.text.length > 0)
      : data.text?.trim()
        ? [{ time: 0, text: data.text.trim() }]
        : [];

  const audioSeconds = chunks.length > 0 ? (chunks[chunks.length - 1].timestamp?.[1] ?? 0) : 0;
  return { segments, speechSeconds: audioSeconds, audioSeconds };
}

/**
 * Sends audio straight from the browser to a user-configured,
 * OpenAI-compatible `/audio/transcriptions` endpoint instead of running
 * Whisper locally — see cloudProviders.ts for why this covers OpenAI, Groq,
 * and arbitrary "custom" endpoints with one code path. No local
 * decode/silence-check/hallucination-screening runs here (unlike
 * useTranscriber's local path): a hosted API has its own signal handling,
 * and re-decoding a possibly hour-long recording just to inspect it would
 * undercut the whole point of offloading work off this device.
 */
async function transcribeWithOpenAiCompatible(
  audioBlob: Blob,
  language: string,
  config: CloudTranscribeConfig,
): Promise<TranscriptionResult> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("No API base URL is configured for this provider.");
  }
  if (!config.apiKey.trim()) {
    throw new Error("No API key is configured for this provider.");
  }
  if (!config.model.trim()) {
    throw new Error("No model is configured for this provider.");
  }

  const form = new FormData();
  form.append("file", audioBlob, `audio.${extensionForMimeType(audioBlob.type)}`);
  form.append("model", config.model.trim());
  form.append("language", language);
  form.append("response_format", "verbose_json");

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey.trim()}` },
      body: form,
    });
  } catch {
    throw new Error(
      "Couldn't reach the cloud transcription endpoint — check the base URL, your network " +
        "connection, and that the provider allows direct requests from a browser (CORS).",
    );
  }

  if (!response.ok) {
    throw new Error(
      `Cloud transcription failed (${response.status}): ${await readErrorDetail(response)}`,
    );
  }

  const data: CloudTranscriptionResponse = await response.json();
  const rawSegments = data.segments ?? [];
  const segments: TranscriptSegment[] =
    rawSegments.length > 0
      ? rawSegments
          .map((segment) => ({ time: segment.start, text: segment.text.trim() }))
          .filter((segment) => segment.text.length > 0)
      : data.text?.trim()
        ? [{ time: 0, text: data.text.trim() }]
        : [];

  const lastEnd = rawSegments.length > 0 ? rawSegments[rawSegments.length - 1].end : 0;
  // The API doesn't report how much of the clip was audible the way the
  // local speechRegions.ts pass does — treat the whole reported duration as
  // "speech" so AppClient's local-only coverage heuristics don't fire on a
  // number this path can't actually measure.
  const audioSeconds = data.duration ?? lastEnd;

  return { segments, speechSeconds: audioSeconds, audioSeconds };
}

/**
 * Entry point for every cloud provider — dispatches to whichever request
 * shape the chosen provider actually speaks. Hugging Face gets its own path
 * (see transcribeWithHuggingFace); OpenAI, Groq, and "custom" all share the
 * one OpenAI-compatible request builder.
 */
export async function transcribeWithCloudProvider(
  audioBlob: Blob,
  language: string,
  config: CloudTranscribeConfig,
): Promise<TranscriptionResult> {
  if (config.provider === "huggingface") {
    return transcribeWithHuggingFace(audioBlob, config);
  }
  return transcribeWithOpenAiCompatible(audioBlob, language, config);
}
