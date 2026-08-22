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
    const message = body?.error?.message ?? body?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // Body wasn't JSON (or was empty) — fall through to the status text.
  }
  return response.statusText || `HTTP ${response.status}`;
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
export async function transcribeWithCloudProvider(
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
