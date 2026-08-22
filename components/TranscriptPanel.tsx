"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TranscriberStatus } from "@/hooks/useTranscriber";
import { readLocalStorage, writeLocalStorage } from "@/lib/localStorage";
import { formatDuration } from "@/lib/mediaFormat";
import { defaultSpeechLanguageCode, SPEECH_LANGUAGES } from "@/lib/speechLanguage";
import { formatRecordingTranscript } from "@/lib/transcriptFormat";
import {
  CLOUD_PROVIDERS,
  cloudProvider,
  type CloudProviderId,
  type TranscribeEngineRequest,
} from "@/lib/transcription/cloudProviders";
import {
  DEFAULT_WHISPER_MODEL_ID,
  WHISPER_MODELS,
  type ModelFileProgress,
  type TranscribeProgress,
} from "@/lib/transcription/types";
import type { RecordingEntry, TranscriptSegment } from "@/lib/types";

interface Props {
  recording: RecordingEntry;
  currentTime: number;
  onSeek: (time: number) => void;
  onSaveTranscript: (segments: TranscriptSegment[]) => Promise<void> | void;
  onAutoTranscribe: (language: string, request: TranscribeEngineRequest) => void;
  isTranscribing: boolean;
  transcriberBusyElsewhere: boolean;
  transcriberStatus: TranscriberStatus;
  transcriberProgress: ModelFileProgress | null;
  transcriberTranscribeProgress: TranscribeProgress | null;
  hasPreviousTranscript: boolean;
  onUndoTranscript: () => void;
  onRemoveTabLines: () => void;
}

const MODEL_STORAGE_KEY = "baharma-record:whisper-model";
const ENGINE_STORAGE_KEY = "baharma-record:transcribe-engine";
const CLOUD_PROVIDER_STORAGE_KEY = "baharma-record:cloud-provider";
const CLOUD_BASE_URL_STORAGE_KEY = "baharma-record:cloud-base-url";
const cloudApiKeyStorageKey = (provider: CloudProviderId) => `baharma-record:cloud-api-key:${provider}`;
const cloudModelStorageKey = (provider: CloudProviderId) => `baharma-record:cloud-model:${provider}`;

function progressLabel(
  status: TranscriberStatus,
  progress: ModelFileProgress | null,
  transcribeProgress: TranscribeProgress | null,
): string {
  if (status === "decoding") return "Preparing audio…";
  if (status === "loading-model") {
    if (progress?.file && typeof progress.loaded === "number" && typeof progress.total === "number" && progress.total > 0) {
      const percent = Math.round((progress.loaded / progress.total) * 100);
      return `Downloading speech-to-text model… ${progress.file} (${percent}%)`;
    }
    return "Downloading speech-to-text model… (first use only, then cached for offline use)";
  }
  if (status === "transcribing") {
    if (transcribeProgress && transcribeProgress.totalSeconds > 0) {
      const { processedSeconds, totalSeconds, phase } = transcribeProgress;
      const percent = Math.round((processedSeconds / totalSeconds) * 100);
      const done = `${formatDuration(processedSeconds)} / ${formatDuration(totalSeconds)} (${percent}%)`;
      return phase === "recovering"
        ? `Re-checking stretches the model skipped… ${done}`
        : `Transcribing audio… ${done}`;
    }
    return "Transcribing audio…";
  }
  return "Working…";
}

function sourceBadge(source: TranscriptSegment["source"]) {
  if (!source) return null;
  const isMic = source === "mic";
  return (
    <span
      className={`mr-2 rounded px-1 py-0.5 text-[10px] font-semibold ${
        isMic
          ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
          : "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-400"
      }`}
    >
      {isMic ? "MIC" : "TAB"}
    </span>
  );
}

export function TranscriptPanel({
  recording,
  currentTime,
  onSeek,
  onSaveTranscript,
  onAutoTranscribe,
  isTranscribing,
  transcriberBusyElsewhere,
  transcriberStatus,
  transcriberProgress,
  transcriberTranscribeProgress,
  hasPreviousTranscript,
  onUndoTranscript,
  onRemoveTabLines,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [language, setLanguage] = useState(() => defaultSpeechLanguageCode());
  // Remembered across recordings: re-picking a model before every run is
  // needless friction, and the choice is a standing preference (speed vs
  // accuracy) rather than a per-recording one.
  const [modelId, setModelId] = useState(() => {
    const saved = readLocalStorage(MODEL_STORAGE_KEY);
    return WHISPER_MODELS.some((model) => model.id === saved) ? saved! : DEFAULT_WHISPER_MODEL_ID;
  });
  // Cloud transcription: an additive alternative to the local Whisper model
  // above — sends audio to a user-configured API instead of running it in
  // this browser. See lib/transcription/cloudProviders.ts.
  const [engine, setEngine] = useState<"local" | "cloud">(() =>
    readLocalStorage(ENGINE_STORAGE_KEY) === "cloud" ? "cloud" : "local",
  );
  const [cloudProviderId, setCloudProviderId] = useState<CloudProviderId>(() => {
    const saved = readLocalStorage(CLOUD_PROVIDER_STORAGE_KEY);
    return CLOUD_PROVIDERS.some((option) => option.id === saved)
      ? (saved as CloudProviderId)
      : CLOUD_PROVIDERS[0].id;
  });
  const [apiKey, setApiKey] = useState(
    () => readLocalStorage(cloudApiKeyStorageKey(cloudProviderId)) ?? "",
  );
  const [customBaseUrl, setCustomBaseUrl] = useState(
    () => readLocalStorage(CLOUD_BASE_URL_STORAGE_KEY) ?? "",
  );
  const [cloudModel, setCloudModel] = useState(() => {
    const saved = readLocalStorage(cloudModelStorageKey(cloudProviderId));
    return saved && saved.length > 0 ? saved : cloudProvider(cloudProviderId).defaultModel;
  });

  // Each provider remembers its own key/model, so switching providers
  // doesn't clobber what was typed for another one. Adjusted during render
  // (React's sanctioned pattern for "reset state when a value changes")
  // rather than in an effect, which would cost an extra render pass.
  const [loadedProviderId, setLoadedProviderId] = useState(cloudProviderId);
  if (cloudProviderId !== loadedProviderId) {
    setLoadedProviderId(cloudProviderId);
    setApiKey(readLocalStorage(cloudApiKeyStorageKey(cloudProviderId)) ?? "");
    const savedModel = readLocalStorage(cloudModelStorageKey(cloudProviderId));
    setCloudModel(savedModel && savedModel.length > 0 ? savedModel : cloudProvider(cloudProviderId).defaultModel);
  }

  const cloudReady =
    engine !== "cloud" ||
    (apiKey.trim().length > 0 &&
      cloudModel.trim().length > 0 &&
      (cloudProviderId !== "custom" || customBaseUrl.trim().length > 0));

  const [copied, setCopied] = useState(false);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const segments = recording.transcriptSegments;
  const hasSegments = Boolean(segments && segments.length > 0);
  const isFreeform = recording.transcriptEditedManually;
  const isMixed = recording.sourceType === "mixed";

  // "mixed" recordings get the mic side automatically (live transcript);
  // the tab side needs an explicit Whisper pass over the isolated audio
  // recorded alongside it. That audio is kept around (not discarded after
  // first use) so this can be re-run any time, e.g. with a different
  // language — each run replaces only the tab-sourced segments.
  const tabAlreadyCovered = isFreeform || Boolean(segments?.some((s) => s.source === "tab"));
  const canTranscribeTab = isMixed && Boolean(recording.secondaryAudioBlob);
  const showTranscribeControls = isMixed ? canTranscribeTab : true;
  const transcribeButtonLabel = isTranscribing
    ? "Transcribing…"
    : isMixed
      ? tabAlreadyCovered
        ? "Re-transcribe Tab Audio"
        : "Transcribe Tab Audio"
      : hasSegments
        ? "Re-transcribe Audio"
        : "Transcribe Audio";

  const activeIndex = useMemo(() => {
    if (isFreeform || !segments || segments.length === 0) return -1;
    let idx = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].time <= currentTime) idx = i;
      else break;
    }
    return idx;
  }, [segments, currentTime, isFreeform]);

  useEffect(() => {
    if (activeIndex >= 0) {
      activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeIndex]);

  function startEditing() {
    if (segments && segments.length > 0) {
      setDraft(isFreeform ? segments[0].text : segments.map((s) => s.text).join("\n"));
    } else {
      setDraft("");
    }
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    try {
      const text = draft.trim();
      await onSaveTranscript(text.length > 0 ? [{ time: 0, text }] : []);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function copyTranscript() {
    const text = formatRecordingTranscript(recording);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied/unavailable — fail silently, no
      // destructive fallback needed since the button is purely additive.
    }
  }

  if (editing) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <textarea
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type or paste the transcript here…"
          className="w-full flex-1 resize-none rounded-md border border-zinc-300 bg-transparent p-3 text-sm dark:border-zinc-700"
        />
        <div className="mt-3 flex gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {saving ? "Saving…" : "Save Transcript"}
          </button>
          <button
            onClick={() => setEditing(false)}
            disabled={saving}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!hasSegments && (
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          {recording.sourceType === "tab" ? (
            <p>
              Tab/window recordings don&apos;t get a live transcript while recording — the
              browser&apos;s speech recognition can only listen to the microphone, not shared tab
              audio. Use &quot;Transcribe Audio&quot; below to generate one automatically from the
              recording (runs entirely in your browser), or add one manually.
            </p>
          ) : isMixed ? (
            <p>
              No mic speech was detected and the tab audio hasn&apos;t been transcribed yet. Use
              &quot;Transcribe Tab Audio&quot; below to generate a transcript from the tab side, or
              add one manually.
            </p>
          ) : (
            <p>
              No transcript was captured for this recording. Use &quot;Transcribe Audio&quot;
              below to generate one automatically, or add one manually.
            </p>
          )}
        </div>
      )}
      {isMixed && canTranscribeTab && (
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          {tabAlreadyCovered ? (
            <p>
              Tab lines look wrong? They come from the offline Whisper model, which is much less
              accurate than the live MIC transcript — especially on voice-chat audio. Try a
              different language and &quot;Re-transcribe Tab Audio&quot;, or remove them entirely.
            </p>
          ) : (
            <p>
              <strong>Listening through speakers?</strong> Your mic already picks up the tab audio,
              so the live MIC transcript below is the accurate one — you probably don&apos;t need
              this. &quot;Transcribe Tab Audio&quot; is for headphone users, and is noticeably less
              accurate.
            </p>
          )}
        </div>
      )}
      {hasSegments && !isMixed && (
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          Wrong result? Pick a different language and click &quot;Re-transcribe Audio&quot;, or
          use &quot;Undo&quot; below to go back to what was there before.
        </div>
      )}

      {isTranscribing && (
        <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300">
          {progressLabel(transcriberStatus, transcriberProgress, transcriberTranscribeProgress)}
        </div>
      )}

      {/* min-h-0 is load-bearing: a flex item defaults to min-height:auto, so
          without it this grows to fit the transcript instead of scrolling —
          shoving the action buttons below the bottom of the modal. */}
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {!hasSegments ? (
          <p className="text-sm italic text-zinc-400">No transcript text yet.</p>
        ) : isFreeform ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{segments![0].text}</p>
        ) : (
          <div className="space-y-1">
            {segments!.map((segment, i) => (
              <button
                key={i}
                ref={i === activeIndex ? activeRef : undefined}
                onClick={() => onSeek(segment.time)}
                className={`w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  i === activeIndex
                    ? "bg-amber-100 dark:bg-amber-900/40"
                    : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
              >
                <span className="mr-2 font-mono text-xs text-zinc-400">
                  {formatDuration(segment.time)}
                </span>
                {isMixed && sourceBadge(segment.source)}
                {segment.text}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2">
        {showTranscribeControls && (
          <>
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              disabled={isTranscribing || transcriberBusyElsewhere}
              className="rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
              title="Language spoken in this recording"
            >
              {SPEECH_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name}
                </option>
              ))}
            </select>
            <select
              value={engine}
              onChange={(event) => {
                const next = event.target.value as "local" | "cloud";
                setEngine(next);
                writeLocalStorage(ENGINE_STORAGE_KEY, next);
              }}
              disabled={isTranscribing || transcriberBusyElsewhere}
              className="rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
              title="Run transcription locally in this browser, or send audio to a cloud API"
            >
              <option value="local">Local (offline)</option>
              <option value="cloud">Cloud (API key)</option>
            </select>
            {engine === "local" ? (
              <select
                value={modelId}
                onChange={(event) => {
                  setModelId(event.target.value);
                  writeLocalStorage(MODEL_STORAGE_KEY, event.target.value);
                }}
                disabled={isTranscribing || transcriberBusyElsewhere}
                className="rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
                title="Bigger models are more accurate but download slower and take longer to run"
              >
                {WHISPER_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label} ({model.sizeLabel})
                  </option>
                ))}
              </select>
            ) : (
              <>
                <select
                  value={cloudProviderId}
                  onChange={(event) => {
                    const next = event.target.value as CloudProviderId;
                    setCloudProviderId(next);
                    writeLocalStorage(CLOUD_PROVIDER_STORAGE_KEY, next);
                  }}
                  disabled={isTranscribing || transcriberBusyElsewhere}
                  className="rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
                  title="Any provider exposing an OpenAI-style /audio/transcriptions endpoint works"
                >
                  {CLOUD_PROVIDERS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    writeLocalStorage(cloudApiKeyStorageKey(cloudProviderId), event.target.value);
                  }}
                  disabled={isTranscribing || transcriberBusyElsewhere}
                  placeholder="API key"
                  autoComplete="off"
                  className="w-32 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
                  title="Stored only in this browser (localStorage) and sent directly to the provider — this app has no backend to hold it instead"
                />
                {cloudProviderId === "custom" && (
                  <input
                    type="text"
                    value={customBaseUrl}
                    onChange={(event) => {
                      setCustomBaseUrl(event.target.value);
                      writeLocalStorage(CLOUD_BASE_URL_STORAGE_KEY, event.target.value);
                    }}
                    disabled={isTranscribing || transcriberBusyElsewhere}
                    placeholder="https://.../v1"
                    className="w-40 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
                    title="Base URL of an OpenAI-compatible API, without the trailing /audio/transcriptions"
                  />
                )}
                <input
                  type="text"
                  value={cloudModel}
                  onChange={(event) => {
                    setCloudModel(event.target.value);
                    writeLocalStorage(cloudModelStorageKey(cloudProviderId), event.target.value);
                  }}
                  disabled={isTranscribing || transcriberBusyElsewhere}
                  placeholder="model id"
                  className="w-32 rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
                  title="The model id this provider expects, e.g. whisper-1 or whisper-large-v3-turbo"
                />
              </>
            )}
            <button
              onClick={() => {
                const request: TranscribeEngineRequest =
                  engine === "local"
                    ? { engine: "local", modelId }
                    : {
                        engine: "cloud",
                        config: {
                          provider: cloudProviderId,
                          baseUrl:
                            cloudProviderId === "custom"
                              ? customBaseUrl.trim()
                              : cloudProvider(cloudProviderId).baseUrl,
                          apiKey: apiKey.trim(),
                          model: cloudModel.trim(),
                        },
                      };
                onAutoTranscribe(language, request);
              }}
              disabled={isTranscribing || transcriberBusyElsewhere || !cloudReady}
              className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              title={
                transcriberBusyElsewhere
                  ? "Another recording is currently being transcribed"
                  : !cloudReady
                    ? "Enter an API key (and base URL, for a custom provider) to use cloud transcription"
                    : undefined
              }
            >
              {transcribeButtonLabel}
            </button>
          </>
        )}
        {isMixed && tabAlreadyCovered && !isFreeform && (
          <button
            onClick={onRemoveTabLines}
            disabled={isTranscribing}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
            title="Delete every TAB-labelled line, keeping the live MIC transcript"
          >
            Remove Tab Lines
          </button>
        )}
        {hasPreviousTranscript && (
          <button
            onClick={onUndoTranscript}
            disabled={isTranscribing}
            className="rounded-md border border-amber-300 px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/30"
            title="Revert to the transcript that was there before your last change"
          >
            Undo
          </button>
        )}
        {hasSegments && (
          <button
            onClick={copyTranscript}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {copied ? "Copied!" : "Copy Transcript"}
          </button>
        )}
        <button
          onClick={startEditing}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {hasSegments ? "Edit Transcript" : "Add Transcript Manually"}
        </button>
      </div>
    </div>
  );
}
