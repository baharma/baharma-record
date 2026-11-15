/**
 * Cloud/API-based transcription: an alternative to the local Xenova/Whisper
 * model in whisper.worker.ts, for when a user would rather trade "runs
 * entirely offline" for "fast, and doesn't tax this device" by supplying
 * their own API key. Audio goes straight from the browser to the provider —
 * this app has no backend to proxy it through (see CLAUDE.md's client-only
 * architecture note), so the key necessarily lives in this browser's
 * localStorage and is sent directly to whichever endpoint is configured.
 *
 * OpenAI, Groq, and "custom" all speak the same OpenAI-style multipart
 * `POST {baseUrl}/audio/transcriptions` shape (see cloudTranscribe.ts):
 * OpenAI and Groq both implement it natively (Groq's free tier makes it a
 * practical "free" option here), and "custom" lets a user point at any other
 * compatible endpoint — a different vendor, a self-hosted server, a router —
 * without this app needing to special-case it. Hugging Face's Inference API
 * is the one exception: its request/response shape is entirely different
 * (JSON with base64 audio, not multipart; model id in the URL path, not a
 * form field) and gets its own code path in cloudTranscribe.ts — but it's
 * included here as a preset for the same reason Groq is: a genuinely free
 * tier, not just pay-as-you-go.
 *
 * 9Router (https://github.com/decolua/9router) is a self-hosted
 * OpenAI-compatible AI gateway whose STT endpoint is that same multipart
 * `/v1/audio/transcriptions` shape, so it rides the shared request builder
 * too. It gets its own preset (rather than being left to "custom") because
 * its default origin is a locally running gateway and its key/URL can come
 * from build-time env vars instead of localStorage — both 9Router-specific
 * concerns the generic providers don't have.
 */
export type CloudProviderId = "openai" | "groq" | "huggingface" | "9router" | "custom";

export interface CloudProviderOption {
  id: CloudProviderId;
  label: string;
  /** Base URL with no trailing slash, or "" for "custom" — the user supplies their own. */
  baseUrl: string;
  defaultModel: string;
}

/**
 * Default origin of a locally running 9Router instance (see the RINGKASAN
 * rebuild notes). Stored /v1-suffixed because the OpenAI-compatible request
 * builder appends only "/audio/transcriptions" — and
 * normalizeNineRouterBaseUrl appends "/v1" exactly once, so a user pasting
 * the bare origin into the override field works too.
 */
export const NINE_ROUTER_DEFAULT_BASE_URL = "http://127.0.0.1:20128/v1";

export const CLOUD_PROVIDERS: CloudProviderOption[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", defaultModel: "whisper-1" },
  {
    id: "groq",
    label: "Groq — has a free tier",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "whisper-large-v3-turbo",
  },
  {
    id: "huggingface",
    label: "Hugging Face — free tier",
    baseUrl: "https://router.huggingface.co/hf-inference/models",
    defaultModel: "openai/whisper-large-v3",
  },
  {
    id: "9router",
    label: "9Router (self-hosted gateway)",
    // The gateway forwards to whichever upstream STT provider is configured
    // in it, so the expected model id depends on that upstream — this is just
    // the common OpenAI-style default; edit it to match the gateway's setup.
    baseUrl: NINE_ROUTER_DEFAULT_BASE_URL,
    defaultModel: "whisper-1",
  },
  { id: "custom", label: "Custom (OpenAI-compatible)", baseUrl: "", defaultModel: "whisper-1" },
];

export function cloudProvider(id: CloudProviderId): CloudProviderOption {
  return CLOUD_PROVIDERS.find((option) => option.id === id) ?? CLOUD_PROVIDERS[0];
}

// localStorage keys — shared between every place that reads or writes this
// config (TranscriptPanel's inline controls, SettingsModal's centralized
// page) so a value set in one shows up pre-filled in the other.
export const CLOUD_PROVIDER_STORAGE_KEY = "baharma-record:cloud-provider";
export const CLOUD_BASE_URL_STORAGE_KEY = "baharma-record:cloud-base-url";
export const cloudApiKeyStorageKey = (provider: CloudProviderId) =>
  `baharma-record:cloud-api-key:${provider}`;
export const cloudModelStorageKey = (provider: CloudProviderId) =>
  `baharma-record:cloud-model:${provider}`;
// Summary & Translation (lib/aiText.ts) pick their own provider (independent
// of the batch one above — text features default to a self-hosted 9Router
// gateway, speech features to a hosted vendor), while the per-provider key
// and model keys are shared with the batch section so the same account only
// ever gets entered once.
export const LLM_PROVIDER_STORAGE_KEY = "baharma-record:llm-provider";
/** "off" (default) asks reasoning-capable gateways not to think; "default" lets the model decide. */
export const LLM_THINKING_STORAGE_KEY = "baharma-record:llm-thinking";
export const cloudLlmModelStorageKey = (provider: CloudProviderId) =>
  `baharma-record:cloud-llm-model:${provider}`;
export const DEFAULT_LLM_MODELS: Record<CloudProviderId, string> = {
  openai: "gpt-4o-mini",
  groq: "llama-3.3-70b-versatile",
  // Hugging Face doesn't support these features at all (see aiText.ts) — the
  // empty string only serves as the SettingsModal placeholder.
  huggingface: "",
  "9router": "gpt-4o-mini",
  custom: "gpt-4o-mini",
};
// 9Router's gateway origin gets its own override key (CLOUD_BASE_URL_STORAGE_KEY
// belongs to the "custom" provider) — a 9Router instance may run on another
// port or a remote host, and that choice shouldn't clobber a separately
// configured custom endpoint.
export const NINE_ROUTER_BASE_URL_STORAGE_KEY = "baharma-record:9router-base-url";

// Build-time env fallbacks for 9Router, so a fixed gateway setup (e.g. the
// planned desktop rebuild, where the gateway origin is known ahead of time)
// doesn't require typing the key into every browser profile. NEXT_PUBLIC_*
// vars are inlined into the client bundle at build time by Next.js — changing
// them needs a dev-server restart or a rebuild, which is also why they're a
// fallback rather than the primary source: a value typed in the UI (or saved
// in localStorage) always wins, and stays editable at runtime.
export function nineRouterEnvApiKey(): string {
  return process.env.NEXT_PUBLIC_9ROUTER_API_KEY?.trim() ?? "";
}

export function nineRouterEnvBaseUrl(): string {
  return process.env.NEXT_PUBLIC_9ROUTER_BASE_URL?.trim() ?? "";
}

/**
 * Appends "/v1" exactly once: 9Router's API lives at `{origin}/v1/...` and
 * users naturally paste either the bare origin (`http://127.0.0.1:20128`) or
 * the full base (`.../v1`) — accepting both without ever doubling the suffix
 * (the rebuild notes flag double-"/v1" as the classic integration mistake).
 */
export function normalizeNineRouterBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * The base URL actually used for a 9Router request: the origin saved in the
 * UI, else NEXT_PUBLIC_9ROUTER_BASE_URL, else the default local gateway —
 * normalized to end in "/v1" whichever way it resolves.
 */
export function nineRouterBaseUrl(savedOverride: string | null | undefined): string {
  const chosen = savedOverride?.trim() || nineRouterEnvBaseUrl() || NINE_ROUTER_DEFAULT_BASE_URL;
  return normalizeNineRouterBaseUrl(chosen);
}

/**
 * The API key actually sent for a cloud run: what the user saved if they
 * typed one, else — 9Router only — the build-time env value. Other providers
 * get no env fallback (their keys are per-user account secrets typed per
 * browser), while a self-hosted gateway commonly runs with one gateway token
 * that env config expresses well.
 */
export function effectiveCloudApiKey(
  provider: CloudProviderId,
  savedKey: string | null | undefined,
): string {
  if (savedKey && savedKey.trim().length > 0) return savedKey.trim();
  return provider === "9router" ? nineRouterEnvApiKey() : "";
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
