/**
 * LLM text features over transcripts — translation and summarization —
 * riding the same cloud provider config as cloud batch transcription (see
 * cloudProviders.ts) but through its OpenAI-style
 * `POST {baseUrl}/chat/completions` endpoint with a *text* model instead of
 * the speech one. 9Router exposes that same shape for summaries and
 * translations per its integration contract, so one code path covers OpenAI,
 * Groq, 9Router, and custom endpoints. Hugging Face is the one exclusion:
 * its preset baseUrl points at the STT-shaped models route (not
 * /v1/chat/completions) and its request shape differs, same reason it has
 * its own path in cloudTranscribe.ts.
 *
 * Unlike the STT path there's no "local offline" alternative here — the
 * local Whisper worker only does speech-to-text, so these features always
 * need a cloud provider configured.
 */
import {
  CLOUD_BASE_URL_STORAGE_KEY,
  CLOUD_PROVIDER_STORAGE_KEY,
  CLOUD_PROVIDERS,
  DEFAULT_LLM_MODELS,
  NINE_ROUTER_BASE_URL_STORAGE_KEY,
  cloudApiKeyStorageKey,
  cloudLlmModelStorageKey,
  cloudProvider,
  effectiveCloudApiKey,
  nineRouterBaseUrl,
  type CloudProviderId,
} from "./transcription/cloudProviders";
import { readErrorDetail } from "./transcription/cloudTranscribe";
import { readLocalStorage } from "./localStorage";
import { SPEECH_LANGUAGES } from "./speechLanguage";
import type { TranscriptSegment } from "./types";

export function llmSupported(provider: CloudProviderId): boolean {
  return provider !== "huggingface";
}

export interface LlmConfig {
  provider: CloudProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Resolves the display name for a speech-language code, e.g. "id" → "Indonesian". */
export function speechLanguageName(code: string): string {
  return SPEECH_LANGUAGES.find((lang) => lang.code === code)?.name ?? code;
}

/**
 * Reads the effective LLM config out of localStorage in one place so every
 * consumer (TranscriptPanel's readiness gating, AppClient's requests,
 * SettingsModal's placeholder) resolves it identically — provider, key, and
 * base URL are shared with cloud batch transcription; the model is the LLM
 * one, falling back to the provider default when the user hasn't set it.
 */
export function readLlmConfig(): LlmConfig {
  const saved = readLocalStorage(CLOUD_PROVIDER_STORAGE_KEY);
  const provider: CloudProviderId = CLOUD_PROVIDERS.some((option) => option.id === saved)
    ? (saved as CloudProviderId)
    : CLOUD_PROVIDERS[0].id;
  return {
    provider,
    baseUrl: llmBaseUrl(provider),
    apiKey: effectiveCloudApiKey(provider, readLocalStorage(cloudApiKeyStorageKey(provider))),
    model:
      readLocalStorage(cloudLlmModelStorageKey(provider))?.trim() ||
      DEFAULT_LLM_MODELS[provider],
  };
}

function llmBaseUrl(provider: CloudProviderId): string {
  if (!llmSupported(provider)) return "";
  if (provider === "custom") {
    return readLocalStorage(CLOUD_BASE_URL_STORAGE_KEY)?.trim() ?? "";
  }
  if (provider === "9router") {
    return nineRouterBaseUrl(readLocalStorage(NINE_ROUTER_BASE_URL_STORAGE_KEY));
  }
  return cloudProvider(provider).baseUrl;
}

export function isLlmReady(config: LlmConfig): boolean {
  return llmSupported(config.provider) && Boolean(config.baseUrl && config.apiKey && config.model);
}

async function chatCompletion(config: LlmConfig, system: string, user: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
      }),
    });
  } catch {
    throw new Error(
      "Couldn't reach the provider's chat endpoint — check the base URL, your network " +
        "connection, and that the provider allows direct requests from a browser (CORS).",
    );
  }

  if (!response.ok) {
    throw new Error(
      `The text request failed (${response.status}): ${await readErrorDetail(response)}`,
    );
  }

  const data: { choices?: { message?: { content?: string } }[] } = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("The provider returned an empty response.");
  }
  return content;
}

// Bound per-request prompt size: hour-long transcripts run hundreds of lines,
// and one request with all of them overflows smaller LLM context windows and
// degrades translation quality. Sequential batches (never Promise.all — same
// one-request-at-a-time politeness as the Whisper worker) also give per-batch
// progress and keep alignment trivial: batch N's replies map back onto batch
// N's segments one-for-one.
const MAX_CHARS_PER_REQUEST = 12000;

export interface AiTextProgress {
  doneSteps: number;
  totalSteps: number;
}

export async function translateTranscriptSegments(
  config: LlmConfig,
  segments: TranscriptSegment[],
  targetLanguageName: string,
  onProgress?: (progress: AiTextProgress) => void,
): Promise<TranscriptSegment[]> {
  // Group whole segments into batches under the char budget (a single segment
  // over the budget still goes alone — splitting one utterance mid-line isn't
  // worth it).
  const batches: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let currentChars = 0;
  for (const segment of segments) {
    const lineChars = segment.text.length + 8; // "NNNN| " numbering overhead
    if (current.length > 0 && currentChars + lineChars > MAX_CHARS_PER_REQUEST) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(segment);
    currentChars += lineChars;
  }
  if (current.length > 0) batches.push(current);

  const translated: TranscriptSegment[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    onProgress?.({ doneSteps: i, totalSteps: batches.length });
    const numbered = batch.map((segment, idx) => `${idx + 1}| ${segment.text}`).join("\n");
    const reply = await chatCompletion(
      config,
      "You are a precise translator. You translate transcript lines exactly one for one, " +
        "without merging, splitting, reordering, omitting, or adding any line.",
      `Translate every line below into ${targetLanguageName}.\n` +
        `Reply with ONLY a JSON array of strings — one string per input line, in the same ` +
        `order, so the array length is exactly ${batch.length}.\n` +
        `Keep the meaning and tone; keep names, numbers, and technical terms intact.\n\n` +
        `Lines:\n${numbered}`,
    );
    const parsed = parseJsonStringArray(reply, batch.length);
    batch.forEach((segment, idx) => {
      // Times and source tags mirror the original one-for-one so the
      // translated view keeps click-to-seek and the MIC/TAB badges working.
      translated.push({ time: segment.time, text: parsed[idx], source: segment.source });
    });
  }
  onProgress?.({ doneSteps: batches.length, totalSteps: batches.length });
  return translated;
}

/**
 * Models wrap JSON in prose or code fences often enough that taking
 * `JSON.parse`'s result on faith isn't enough — extract the array, then
 * verify the length one-for-one: a misaligned reply would map translations
 * onto the wrong segments, which is worse than a visible failure to retry.
 */
function parseJsonStringArray(reply: string, expectedLength: number): string[] {
  let text = reply.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The model's translation reply wasn't valid JSON — try again.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== expectedLength ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new Error(
      `The translation came back misaligned (expected ${expectedLength} lines) — try again, ` +
        "or pick a stronger text model in Settings.",
    );
  }
  return (parsed as string[]).map((item) => item.trim());
}

const SUMMARIZER_SYSTEM =
  "You summarize meeting, call, and voice-note transcripts. Be concrete: cover the main " +
  "topics discussed, decisions made, and any action items, owners, or deadlines explicitly " +
  "mentioned. Never invent content that isn't in the transcript. Write in the requested " +
  "language, as plain text with short bullet points.";

export async function summarizeTranscript(
  config: LlmConfig,
  transcriptText: string,
  languageName: string,
): Promise<string> {
  if (transcriptText.length <= MAX_CHARS_PER_REQUEST) {
    return chatCompletion(
      config,
      SUMMARIZER_SYSTEM,
      `Summarize the following transcript in ${languageName}.\n\n${transcriptText}`,
    );
  }

  // Map-reduce for long transcripts (recordings here can run over an hour,
  // beyond what fits — or summarizes well — in one request): summarize each
  // chunk's part independently and sequentially, then condense the partial
  // summaries into one final summary. Line-boundary chunking keeps utterances
  // intact for the map pass.
  const chunks = splitIntoChunks(transcriptText, MAX_CHARS_PER_REQUEST);
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    partials.push(
      await chatCompletion(
        config,
        SUMMARIZER_SYSTEM,
        `This is part ${i + 1} of ${chunks.length} of a longer transcript. Summarize what ` +
          `happens in this part, in ${languageName}, in a few bullet points.\n\n${chunks[i]}`,
      ),
    );
  }
  return chatCompletion(
    config,
    SUMMARIZER_SYSTEM,
    `Below are summaries of ${chunks.length} consecutive parts of one transcript. Combine ` +
      `them into one overall summary in ${languageName}: the main topics, decisions, and ` +
      `action items, without repeating what the parts have in common.\n\n` +
      partials.join("\n\n"),
  );
}

function splitIntoChunks(text: string, maxChars: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const line of lines) {
    if (current.length > 0 && currentChars + line.length + 1 > maxChars) {
      chunks.push(current.join("\n"));
      current = [];
      currentChars = 0;
    }
    current.push(line);
    currentChars += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
}
