"use client";

import { useState } from "react";
import { readLocalStorage, writeLocalStorage } from "@/lib/localStorage";
import {
  CLOUD_BASE_URL_STORAGE_KEY,
  CLOUD_PROVIDER_STORAGE_KEY,
  CLOUD_PROVIDERS,
  cloudApiKeyStorageKey,
  cloudModelStorageKey,
  cloudProvider,
  type CloudProviderId,
} from "@/lib/transcription/cloudProviders";
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

  // Each provider remembers its own key/model — same render-time-adjustment
  // pattern as TranscriptPanel's identical picker (see the comment there for
  // why this runs during render instead of in an effect).
  const [loadedProviderId, setLoadedProviderId] = useState(cloudProviderId);
  if (cloudProviderId !== loadedProviderId) {
    setLoadedProviderId(cloudProviderId);
    setCloudApiKey(readLocalStorage(cloudApiKeyStorageKey(cloudProviderId)) ?? "");
    const savedModel = readLocalStorage(cloudModelStorageKey(cloudProviderId));
    setCloudModel(savedModel && savedModel.length > 0 ? savedModel : cloudProvider(cloudProviderId).defaultModel);
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
            Deepgram API key — used when &quot;Live transcript for tab audio&quot; is turned on
            while starting a new Tab or Tab + Mic recording.
          </p>
          <input
            type="password"
            value={deepgramApiKey}
            onChange={(event) => {
              setDeepgramApiKey(event.target.value);
              writeLocalStorage(DEEPGRAM_KEY_STORAGE_KEY, event.target.value);
            }}
            placeholder="Deepgram API key"
            autoComplete="off"
            className="mt-2 w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
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
              placeholder="API key"
              autoComplete="off"
              className="min-w-32 flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
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
