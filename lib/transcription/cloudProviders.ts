/**
 * Cloud/API-based transcription: an alternative to the local Xenova/Whisper
 * model in whisper.worker.ts, for when a user would rather trade "runs
 * entirely offline" for "fast, and doesn't tax this device" by supplying
 * their own API key. Audio goes straight from the browser to the provider —
 * this app has no backend to proxy it through (see CLAUDE.md's client-only
 * architecture note), so the key necessarily lives in this browser's
 * localStorage and is sent directly to whichever endpoint is configured.
 *
 * All three options speak the same OpenAI-style multipart
 * `POST {baseUrl}/audio/transcriptions` shape (see cloudTranscribe.ts):
 * OpenAI and Groq both implement it natively (Groq's free tier makes it the
 * practical "free" option here), and "custom" lets a user point at any other
 * compatible endpoint — a different vendor, a self-hosted server, a router —
 * without this app needing to special-case it.
 */
export type CloudProviderId = "openai" | "groq" | "custom";

export interface CloudProviderOption {
  id: CloudProviderId;
  label: string;
  /** Base URL with no trailing slash, or "" for "custom" — the user supplies their own. */
  baseUrl: string;
  defaultModel: string;
}

export const CLOUD_PROVIDERS: CloudProviderOption[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "whisper-1" },
  {
    id: "groq",
    label: "Groq — has a free tier",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "whisper-large-v3-turbo",
  },
  { id: "custom", label: "Custom (OpenAI-compatible)", baseUrl: "", defaultModel: "whisper-1" },
];

export function cloudProvider(id: CloudProviderId): CloudProviderOption {
  return CLOUD_PROVIDERS.find((option) => option.id === id) ?? CLOUD_PROVIDERS[0];
}

export interface CloudTranscribeConfig {
  provider: CloudProviderId;
  /** The base URL actually used for the request — the provider's default, or the custom override. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Which engine to run a transcription request through — the user's choice per run. */
export type TranscribeEngineRequest =
  | { engine: "local"; modelId: string }
  | { engine: "cloud"; config: CloudTranscribeConfig };
