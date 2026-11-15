/**
 * LLM text features over transcripts — translation and summarization —
 * speaking the OpenAI-style `POST {baseUrl}/chat/completions` shape with a
 * *text* model. 9Router exposes that same shape for summaries and
 * translations per its integration contract, so one code path covers OpenAI,
 * Groq, 9Router, and custom endpoints. Hugging Face is the one exclusion:
 * its preset baseUrl points at the STT-shaped models route (not
 * /v1/chat/completions) and its request shape differs, same reason it has
 * its own path in cloudTranscribe.ts.
 *
 * Unlike the STT path there's no "local offline" alternative here — the
 * local Whisper worker only does speech-to-text, so these features always
 * need a provider configured. The provider choice is their own
 * (LLM_PROVIDER_STORAGE_KEY, defaulting to 9Router) rather than the batch
 * transcription one: a user can transcribe with Groq's free whisper tier
 * while summarizing through their own gateway, and a 9Router gateway may run
 * without an API key at all, which the hosted vendors can't.
 */
import {
  CLOUD_BASE_URL_STORAGE_KEY,
  CLOUD_PROVIDERS,
  DEFAULT_LLM_MODELS,
  LLM_PROVIDER_STORAGE_KEY,
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

// Shared by every "what language should AI text come out in" control — the
// detail view's Translate/Summarize row and the live card's translation
// toggle — so they default consistently and changing it in one place carries.
export const AI_TARGET_LANGUAGE_STORAGE_KEY = "baharma-record:ai-target-language";
// Whether the live card translates/summarizes while recording. Default on:
// the control only ever shows when a working provider is configured anyway.
export const LIVE_AI_ENABLED_STORAGE_KEY = "baharma-record:live-ai-enabled";

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
 * consumer (TranscriptPanel's readiness gating, the live card's, the actual
 * requests, SettingsModal's "Load models") resolves it identically. The
 * provider is the text features' own choice, falling back to 9Router when
 * nothing valid is saved — Hugging Face included, since its preset baseUrl
 * is the STT-shaped models route, not /v1/chat/completions.
 */
export function readLlmConfig(): LlmConfig {
  const saved = readLocalStorage(LLM_PROVIDER_STORAGE_KEY);
  const provider: CloudProviderId =
    saved && saved !== "huggingface" && CLOUD_PROVIDERS.some((option) => option.id === saved)
      ? (saved as CloudProviderId)
      : "9router";
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

// A self-hosted gateway (9Router) and a user-supplied custom endpoint may run
// without authentication — an empty key is a legitimate configuration there,
// while OpenAI/Groq keys are account secrets that always exist.
function llmKeyIsOptional(provider: CloudProviderId): boolean {
  return provider === "9router" || provider === "custom";
}

export function llmNotReadyReason(config: LlmConfig): string | null {
  if (!llmSupported(config.provider)) {
    return `${cloudProvider(config.provider).label} doesn't expose the chat endpoint these features need.`;
  }
  if (!config.baseUrl) {
    return "No base URL is configured for this provider — add it in Settings → Summary & Translation.";
  }
  if (!config.model) {
    return "No text model is configured — set one in Settings → Summary & Translation.";
  }
  if (!config.apiKey && !llmKeyIsOptional(config.provider)) {
    return "No API key is configured — add one in Settings → Summary & Translation.";
  }
  return null;
}

export function isLlmReady(config: LlmConfig): boolean {
  return llmNotReadyReason(config) === null;
}

async function chatCompletion(
  config: LlmConfig,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: {
        // A gateway may run without auth — send the header only when there's
        // actually a key to send.
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
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
    if (signal?.aborted) {
      // The abort came from the caller's timeout, not the network — say so.
      throw new Error("The provider took too long to answer.");
    }
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

  let data: { choices?: { message?: { content?: string } }[] };
  try {
    data = await response.json();
  } catch {
    if (signal?.aborted) {
      throw new Error("The provider took too long to answer.");
    }
    throw new Error("The provider returned an unreadable response.");
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("The provider returned an empty response.");
  }
  return content;
}

/**
 * Lists the model ids a provider offers, for the SettingsModal's "Load
 * models" button: an OpenAI-style `GET {baseUrl}/models`, same optional auth
 * as chatCompletion. Picking an id from this list is a convenience only — a
 * model appearing here doesn't prove it can actually translate or summarize
 * well.
 */
export async function listLlmModels(config: LlmConfig): Promise<string[]> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
    });
  } catch {
    throw new Error(
      "Couldn't reach the provider's models endpoint — check the base URL, your network " +
        "connection, and that the provider allows direct requests from a browser (CORS).",
    );
  }
  if (!response.ok) {
    throw new Error(
      `Listing models failed (${response.status}): ${await readErrorDetail(response)}`,
    );
  }
  const data: { data?: { id?: unknown }[] } = await response.json();
  const ids = (data.data ?? [])
    .map((item) => item?.id)
    .filter((id): id is string => typeof id === "string");
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

// Bound per-request prompt size: hour-long transcripts run hundreds of lines,
// and one request with all of them overflows smaller LLM context windows and
// degrades translation quality. Sequential batches (never Promise.all — same
// one-request-at-a-time politeness as the Whisper worker) also keep alignment
// trivial: batch N's replies map back onto batch N's segments one-for-one.
const MAX_CHARS_PER_REQUEST = 12000;

const TRANSLATOR_SYSTEM =
  "You are a precise translator. You translate transcript lines exactly one for one, " +
  "without merging, splitting, reordering, omitting, or adding any line.";

/**
 * Distinguishable from network/model errors on purpose: a misaligned reply
 * (the model merged or split lines) is usually fixed by re-asking per line,
 * so translateSegmentsResilient retries on exactly this class and nothing
 * else — a dead endpoint or a bad key fails a 20-line batch just as fast as
 * twenty single-line ones.
 */
export class TranslationMisalignedError extends Error {
  constructor(expected: number) {
    super(
      `The translation came back misaligned (expected ${expected} lines) — try again, ` +
        "or pick a stronger text model in Settings.",
    );
    this.name = "TranslationMisalignedError";
  }
}

/**
 * Translates each segment and returns the texts one-for-one with the input —
 * the alignment contract every caller depends on.
 */
export async function translateSegmentTexts(
  config: LlmConfig,
  segments: TranscriptSegment[],
  targetLanguageName: string,
  signal?: AbortSignal,
  contextLines?: string[],
): Promise<string[]> {
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

  const texts: string[] = [];
  for (const batch of batches) {
    const numbered = batch.map((segment, idx) => `${idx + 1}| ${segment.text}`).join("\n");
    // Short live-transcript fragments translate poorly in isolation, so the
    // caller can pass the lines directly before the batch as read-only
    // context — clearly separated, and excluded from the reply contract
    // (parseJsonStringArray still enforces one string per numbered line).
    const contextBlock =
      contextLines && contextLines.length > 0
        ? "Earlier lines, for context only. Do NOT translate them and do NOT include them in " +
          `your reply:\n${contextLines.join("\n")}\n\n`
        : "";
    const reply = await chatCompletion(
      config,
      TRANSLATOR_SYSTEM,
      `Translate every line below into ${targetLanguageName}.\n` +
        `Reply with ONLY a JSON array of strings — one string per input line, in the same ` +
        `order, so the array length is exactly ${batch.length}.\n` +
        `Keep the meaning and tone; keep names, numbers, and technical terms intact.\n\n` +
        `${contextBlock}Lines:\n${numbered}`,
      signal,
    );
    texts.push(...parseJsonStringArray(reply, batch.length));
  }
  return texts;
}

export async function translateTranscriptSegments(
  config: LlmConfig,
  segments: TranscriptSegment[],
  targetLanguageName: string,
  signal?: AbortSignal,
): Promise<TranscriptSegment[]> {
  const texts = await translateSegmentTexts(config, segments, targetLanguageName, signal);
  // Times and source tags mirror the original one-for-one so the translated
  // view keeps click-to-seek and the MIC/TAB badges working.
  return segments.map((segment, idx) => ({
    time: segment.time,
    text: texts[idx],
    source: segment.source,
  }));
}

/**
 * translateSegmentTexts with a repair pass for the one failure mode a retry
 * can actually fix: a model that merged or split lines. Only a
 * misalignment — not a network or auth error — triggers it, and only when
 * there is more than one segment; each line is then translated in its own
 * sequential request, which can't be misaligned into a wrong pairing.
 */
export async function translateSegmentsResilient(
  config: LlmConfig,
  segments: TranscriptSegment[],
  targetLanguageName: string,
  signal?: AbortSignal,
  contextLines?: string[],
): Promise<string[]> {
  try {
    return await translateSegmentTexts(config, segments, targetLanguageName, signal, contextLines);
  } catch (error) {
    if (!(error instanceof TranslationMisalignedError) || segments.length <= 1) throw error;
    const texts: string[] = [];
    for (const segment of segments) {
      texts.push(
        (await translateSegmentTexts(config, [segment], targetLanguageName, signal, contextLines))[0],
      );
    }
    return texts;
  }
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
    throw new TranslationMisalignedError(expectedLength);
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

/**
 * Incremental summary for the *live* card (useLiveAiText.ts): instead of
 * re-summarizing the whole growing transcript every tick, the model updates
 * the previous summary with only the lines that arrived since — one cheap
 * request per tick instead of an ever-growing one. A fresh summary (null
 * previous) summarizes from scratch.
 */
export async function updateRunningSummary(
  config: LlmConfig,
  previousSummary: string | null,
  transcriptText: string,
  languageName: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!previousSummary) {
    return chatCompletion(
      config,
      SUMMARIZER_SYSTEM,
      `Summarize the following live transcript so far, in ${languageName}.\n\n${transcriptText}`,
      signal,
    );
  }
  return chatCompletion(
    config,
    SUMMARIZER_SYSTEM,
    `You maintain a running summary of a live transcript. Update the summary below so it ` +
      `also covers the new lines — keep what's still relevant, add what's new, drop nothing ` +
      `important. Reply with the full updated summary only, in ${languageName}.\n\n` +
      `CURRENT SUMMARY:\n${previousSummary}\n\nNEW TRANSCRIPT LINES:\n${transcriptText}`,
    signal,
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
