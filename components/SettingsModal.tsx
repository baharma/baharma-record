"use client";

import { useState } from "react";
import { readLocalStorage, writeLocalStorage } from "@/lib/localStorage";
import {
  CLOUD_BASE_URL_STORAGE_KEY,
  CLOUD_PROVIDER_STORAGE_KEY,
  CLOUD_PROVIDERS,
  DEFAULT_LLM_MODELS,
  NINE_ROUTER_BASE_URL_STORAGE_KEY,
  cloudApiKeyStorageKey,
  cloudLlmModelStorageKey,
  cloudModelStorageKey,
  cloudProvider,
  nineRouterEnvApiKey,
  type CloudProviderId,
} from "@/lib/transcription/cloudProviders";
import DeepgramKeysField from "./DeepgramKeysField";
import { DEEPGRAM_KEY_STORAGE_KEY } from "@/lib/transcription/deepgramLive";

interface Props {
  onClose: () => void;
}

/**
 * A single place to configure every API key this app can use, instead of
 * only inline in the two flows that need one (NewSourceModal's live tab
 * transcription toggle, TranscriptPanel's cloud batch transcription).
 * Reads and writes the exact same localStorage keys those already use, so
 * this is purely a convenience — nothing here is new state, and skipping
 * this screen entirely (configuring inline instead, like before) still
 * works exactly as it did.
 */
export function SettingsModal({ onClose }: Props) {
  const [deepgramApiKey, setDeepgramApiKey] = useState(
    () => readLocalStorage(DEEPGRAM_KEY_STORAGE_KEY) ?? "",
  );

  const [cloudProviderId, setCloudProviderId] = useState<CloudProviderId>(() => {
    const saved = readLocalStorage(CLOUD_PROVIDER_STORAGE_KEY);
    return CLOUD_PROVIDERS.some((option) => option.id === saved)
      ? (saved as CloudProviderId)
      : CLOUD_PROVIDERS[0].id;
  });
  const [cloudApiKey, setCloudApiKey] = useState(
    () => readLocalStorage(cloudApiKeyStorageKey(cloudProviderId)) ?? "",
  );
  const [cloudModel, setCloudModel] = useState(() => {
    const saved = readLocalStorage(cloudModelStorageKey(cloudProviderId));
    return saved && saved.length > 0 ? saved : cloudProvider(cloudProviderId).defaultModel;
  });
  const [customBaseUrl, setCustomBaseUrl] = useState(
    () => readLocalStorage(CLOUD_BASE_URL_STORAGE_KEY) ?? "",
  );
  // 9Router's gateway origin override — empty means "fall back to
  // NEXT_PUBLIC_9ROUTER_BASE_URL, else the default local gateway"; the raw
  // saved text is shown/edited, normalization happens at request time.
  const [nineRouterOrigin, setNineRouterOrigin] = useState(
    () => readLocalStorage(NINE_ROUTER_BASE_URL_STORAGE_KEY) ?? "",
  );
  // Summary & Translation's text (LLM) model — empty means "use the
  // provider's default" (shown as the placeholder).
  const [llmModel, setLlmModel] = useState(
    () => readLocalStorage(cloudLlmModelStorageKey(cloudProviderId)) ?? "",
  );

  // Each provider remembers its own key/model — same render-time-adjustment
  // pattern as TranscriptPanel's identical picker (see the comment there for
  // why this runs during render instead of in an effect).
  const [loadedProviderId, setLoadedProviderId] = useState(cloudProviderId);
  if (cloudProviderId !== loadedProviderId) {
    setLoadedProviderId(cloudProviderId);
    setCloudApiKey(readLocalStorage(cloudApiKeyStorageKey(cloudProviderId)) ?? "");
    const savedModel = readLocalStorage(cloudModelStorageKey(cloudProviderId));
    setCloudModel(savedModel && savedModel.length > 0 ? savedModel : cloudProvider(cloudProviderId).defaultModel);
    // Same per-provider memory for the Summary & Translation text model.
    setLlmModel(readLocalStorage(cloudLlmModelStorageKey(cloudProviderId)) ?? "");
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="px-1 text-xl leading-none text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Remembered in this browser and used automatically wherever needed — starting a new
          recording, or transcribing one afterward. Sent only to the provider you pick below;
          this app has no backend of its own to hold it instead.
        </p>

        <section className="mt-4">
          <h3 className="text-sm font-semibold">Live Tab Transcription</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            Deepgram API key(s) — add more than one and the next is used automatically if one fails or runs out of credit. Used when &quot;Live transcript for tab audio&quot; is turned on
            while starting a new Tab or Tab + Mic recording.
          </p>
          <DeepgramKeysField
                      value={deepgramApiKey}
                      onChange={(next) => {
                        setDeepgramApiKey(next);
                        writeLocalStorage(DEEPGRAM_KEY_STORAGE_KEY, next);
                      }}
                    />
        </section>

        <section className="mt-4">
          <h3 className="text-sm font-semibold">Cloud Batch Transcription</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            Used by &quot;Transcribe Audio&quot; / &quot;Transcribe Tab Audio&quot; when the Cloud
            (API key) engine is selected instead of the local offline model.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <select
              value={cloudProviderId}
              onChange={(event) => {
                const next = event.target.value as CloudProviderId;
                setCloudProviderId(next);
                writeLocalStorage(CLOUD_PROVIDER_STORAGE_KEY, next);
              }}
              className="rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
            >
              {CLOUD_PROVIDERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              type="password"
              value={cloudApiKey}
              onChange={(event) => {
                setCloudApiKey(event.target.value);
                writeLocalStorage(cloudApiKeyStorageKey(cloudProviderId), event.target.value);
              }}
              placeholder={
                cloudProviderId === "9router" && nineRouterEnvApiKey()
                  ? "API key (from env)"
                  : "API key"
              }
              autoComplete="off"
              className="min-w-32 flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
              title={
                cloudProviderId === "9router"
                  ? "Left empty, NEXT_PUBLIC_9ROUTER_API_KEY (build-time env) is used instead"
                  : undefined
              }
            />
          </div>
          {cloudProviderId === "custom" && (
            <input
              type="text"
              value={customBaseUrl}
              onChange={(event) => {
                setCustomBaseUrl(event.target.value);
                writeLocalStorage(CLOUD_BASE_URL_STORAGE_KEY, event.target.value);
              }}
              placeholder="https://.../v1"
              className="mt-2 w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
              title="Base URL of a provider with its own /audio/transcriptions (speech-to-text) endpoint, without that trailing path — a chat/completions-only API (e.g. most agentic coding gateways) won't work here"
            />
          )}
          {cloudProviderId === "9router" && (
            <input
              type="text"
              value={nineRouterOrigin}
              onChange={(event) => {
                setNineRouterOrigin(event.target.value);
                writeLocalStorage(NINE_ROUTER_BASE_URL_STORAGE_KEY, event.target.value);
              }}
              placeholder="http://127.0.0.1:20128"
              className="mt-2 w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
              title="Origin of your 9Router gateway (github.com/decolua/9router) — /v1 is appended automatically if missing. Empty uses NEXT_PUBLIC_9ROUTER_BASE_URL, else the default locally-running gateway at http://127.0.0.1:20128. The model id below must match the STT provider configured inside your gateway."
            />
          )}
          <input
            type="text"
            value={cloudModel}
            onChange={(event) => {
              setCloudModel(event.target.value);
              writeLocalStorage(cloudModelStorageKey(cloudProviderId), event.target.value);
            }}
            placeholder="model id"
            className="mt-2 w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
            title="The model id this provider expects, e.g. whisper-1 or whisper-large-v3-turbo"
          />
        </section>

        <section className="mt-4">
          <h3 className="text-sm font-semibold">Summary &amp; Translation</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            Used by the &quot;Translate&quot; and &quot;Summarize&quot; buttons in a recording&apos;s
            transcript view. Runs on the same provider and API key as Cloud Batch Transcription
            above, through its chat endpoint — only the text model differs. Hugging Face doesn&apos;t
            support these two features.
          </p>
          <input
            type="text"
            value={llmModel}
            onChange={(event) => {
              setLlmModel(event.target.value);
              writeLocalStorage(cloudLlmModelStorageKey(cloudProviderId), event.target.value);
            }}
            disabled={cloudProviderId === "huggingface"}
            placeholder={DEFAULT_LLM_MODELS[cloudProviderId] || "not available for this provider"}
            className="mt-2 w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
            title="The text (LLM) model id this provider expects, e.g. gpt-4o-mini — leave empty to use the provider's default shown as the placeholder"
          />
        </section>

        <button
          onClick={onClose}
          className="mt-5 w-full rounded-md bg-zinc-900 py-1.5 text-sm font-medium text-white hover:opacity-90 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Done
        </button>
      </div>
    </div>
  );
}
