"use client";

import { useState } from "react";
import {
  isDisplayMediaSupported,
  isSpeechRecognitionSupported,
  isVideoRecordingSupported,
} from "@/lib/browserSupport";
import { generateId } from "@/lib/id";
import { readLocalStorage, writeLocalStorage } from "@/lib/localStorage";
import {
  acquireMicrophoneStream,
  acquireTabAudioStream,
  friendlyErrorMessage,
} from "@/lib/mediaAcquisition";
import { defaultSpeechLanguageCode, speechRecognitionLocale, SPEECH_LANGUAGES } from "@/lib/speechLanguage";
import { DEEPGRAM_KEY_STORAGE_KEY } from "@/lib/transcription/deepgramLive";
import {
  DEFAULT_LIVE_WHISPER_MODEL_ID,
  LIVE_WHISPER_MODELS,
  type InferenceDevice,
  type ModelFileProgress,
} from "@/lib/transcription/types";
import type { PendingSession } from "@/lib/types";

const LIVE_MODEL_STORAGE_KEY = "baharma-record:live-whisper-model";

type Choice = "tab" | "mic" | "both";
type Step = "choose" | "label";
/** Live transcription for tab-side audio: none, Deepgram (cloud), or the local Whisper worker. */
type TabLiveMode = "none" | "cloud" | "local";

interface Props {
  onClose: () => void;
  onSessionsCreated: (sessions: PendingSession[]) => void;
  onError: (message: string) => void;
  /** Local on-device live transcription — see hooks/useLiveTranscriber.ts. */
  transcribeLocalWindow: (
    samples: Float32Array,
    language: string,
    modelId: string,
  ) => Promise<{ text: string }>;
  localModelLoading: boolean;
  localModelLoadProgress: ModelFileProgress | null;
  /** Which backend the local live model loaded on, once known. */
  localDevice: InferenceDevice | null;
}

function defaultLabel(choice: Choice): string {
  const when = new Date().toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  if (choice === "tab") return `Tab Recording – ${when}`;
  if (choice === "mic") return `Mic Recording – ${when}`;
  return `Tab + Mic Recording – ${when}`;
}

export function NewSourceModal({
  onClose,
  onSessionsCreated,
  onError,
  transcribeLocalWindow,
  localModelLoading,
  localModelLoadProgress,
  localDevice,
}: Props) {
  const [step, setStep] = useState<Step>("choose");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [label, setLabel] = useState("");
  const [language, setLanguage] = useState(() => defaultSpeechLanguageCode());
  const [includeVideo, setIncludeVideo] = useState(false);
  const [busy, setBusy] = useState(false);
  // Live transcription for tab audio — the one case SpeechRecognition can't
  // help with. Opt-in and additive: "none" reproduces the exact existing
  // behavior for "tab"/"both" sessions. Cloud (Deepgram) and local (on-device
  // Whisper) are mutually exclusive — both would tag segments "tab" on the
  // same timeline, so running both at once would just double up text.
  const [tabLiveMode, setTabLiveMode] = useState<TabLiveMode>("none");
  const [deepgramApiKey, setDeepgramApiKey] = useState(() => readLocalStorage(DEEPGRAM_KEY_STORAGE_KEY) ?? "");
  const [liveModelId, setLiveModelId] = useState(() => {
    const saved = readLocalStorage(LIVE_MODEL_STORAGE_KEY);
    return LIVE_WHISPER_MODELS.some((model) => model.id === saved)
      ? saved!
      : DEFAULT_LIVE_WHISPER_MODEL_ID;
  });

  const displaySupported = isDisplayMediaSupported();
  const speechSupported = isSpeechRecognitionSupported();
  const videoSupported = isVideoRecordingSupported();
  // Guards against "Deepgram" being picked with no key: without this,
  // confirm() below just silently drops liveCloudTab and starts a normal
  // recording — technically not an error, but confusing (the user thinks
  // they'll get a live tab transcript and won't). Block "Start Recording"
  // instead so the mismatch is obvious before the session starts.
  const liveCloudTabMissingKey = tabLiveMode === "cloud" && deepgramApiKey.trim().length === 0;

  function pick(next: Choice) {
    setChoice(next);
    setLabel("");
    setIncludeVideo(false);
    setTabLiveMode("none");
    setStep("label");
  }

  function back() {
    setStep("choose");
    setChoice(null);
  }

  async function confirm() {
    if (!choice) return;
    setBusy(true);
    const acquiredStreams: MediaStream[] = [];
    let audioContext: AudioContext | null = null;
    try {
      const baseLabel = label.trim() || defaultLabel(choice);
      const recognitionLang = speechRecognitionLocale(language);
      const sessions: PendingSession[] = [];
      const liveCloudTab =
        tabLiveMode === "cloud" && deepgramApiKey.trim().length > 0
          ? { apiKey: deepgramApiKey.trim(), language }
          : undefined;
      const localLiveTab =
        tabLiveMode === "local"
          ? { language, modelId: liveModelId, transcribeWindow: transcribeLocalWindow }
          : undefined;

      if (choice === "tab") {
        const tabStream = await acquireTabAudioStream({ includeVideo });
        acquiredStreams.push(tabStream);
        sessions.push({
          id: generateId(),
          sourceType: "tab",
          label: baseLabel,
          stream: tabStream,
          // Only "tab" sessions with a live transcription option enabled get
          // a transcript at all — the browser's own SpeechRecognition can't
          // listen to tab audio, so without one there's nothing to save.
          enableTranscript: Boolean(liveCloudTab) || Boolean(localLiveTab),
          recognitionLang,
          liveCloudTab,
          localLiveTab,
        });
      } else if (choice === "mic") {
        const micStream = await acquireMicrophoneStream({ includeVideo });
        acquiredStreams.push(micStream);
        sessions.push({
          id: generateId(),
          sourceType: "mic",
          label: baseLabel,
          stream: micStream,
          enableTranscript: speechSupported,
          recognitionLang,
        });
      } else {
        // "both": mix tab + mic audio into a single recorded track via the
        // Web Audio API. Live transcription still works even though the
        // recorded stream is the mix — SpeechRecognition never consumes
        // `stream` at all, it listens to the physical microphone directly
        // (see useRecordingSession.ts), independent of what's being recorded.
        // Mic never contributes video here — only the tab side has one.
        const tabStream = await acquireTabAudioStream({ includeVideo });
        acquiredStreams.push(tabStream);
        const micStream = await acquireMicrophoneStream();
        acquiredStreams.push(micStream);

        audioContext = new AudioContext();
        const destination = audioContext.createMediaStreamDestination();
        audioContext.createMediaStreamSource(tabStream).connect(destination);
        audioContext.createMediaStreamSource(micStream).connect(destination);
        const context = audioContext;

        // Primary recorded stream: mixed audio, plus the tab's video track
        // (if requested) riding alongside it so one MediaRecorder captures
        // both.
        const primaryTracks: MediaStreamTrack[] = [...destination.stream.getAudioTracks()];
        if (includeVideo) primaryTracks.push(...tabStream.getVideoTracks());

        sessions.push({
          id: generateId(),
          sourceType: "mixed",
          label: baseLabel,
          stream: new MediaStream(primaryTracks),
          enableTranscript: speechSupported,
          recognitionLang,
          // Isolated, audio-only tab track recorded in parallel (separately
          // from the mix, and never carrying video even if includeVideo) so
          // "Transcribe Tab Audio" can later run Whisper on a clean signal —
          // see RecordingEntry.secondaryAudioBlob. The same isolated stream
          // also feeds live tab transcription (cloud or local), if enabled.
          secondaryStream: new MediaStream(tabStream.getAudioTracks()),
          liveCloudTab,
          localLiveTab,
          extraCleanup: () => {
            tabStream.getTracks().forEach((track) => track.stop());
            micStream.getTracks().forEach((track) => track.stop());
            context.close().catch(() => {});
          },
        });
      }

      onSessionsCreated(sessions);
    } catch (error) {
      acquiredStreams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      audioContext?.close().catch(() => {});
      onError(friendlyErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(event) => event.stopPropagation()}
      >
        {step === "choose" && (
          <>
            <h2 className="text-lg font-semibold">Record New Source</h2>
            <p className="mt-1 text-sm text-zinc-500">Choose what you&apos;d like to record.</p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => pick("tab")}
                disabled={!displaySupported}
                className="rounded-lg border border-zinc-200 p-3 text-left hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <p className="font-medium">Tab / Window / Screen Audio</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Pick a specific browser tab (e.g. a meeting or Discord call). Audio only — no
                  automatic transcript.
                </p>
              </button>
              <button
                onClick={() => pick("mic")}
                className="rounded-lg border border-zinc-200 p-3 text-left hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <p className="font-medium">Microphone</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {speechSupported
                    ? "Audio + live text transcript."
                    : "Audio only — live transcription isn't supported in this browser."}
                </p>
              </button>
              <button
                onClick={() => pick("both")}
                disabled={!displaySupported}
                className="rounded-lg border border-zinc-200 p-3 text-left hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <p className="font-medium">Tab + Mic Simultaneously</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  Tab audio and your microphone mixed together into a single recording — one file,
                  {speechSupported ? " with a live transcript." : " no live transcript in this browser."}
                  {speechSupported &&
                    " Best results with speakers (not headphones): your mic then hears both sides, so the live transcript covers everything."}
                </p>
              </button>
            </div>
            <button
              onClick={onClose}
              className="mt-4 w-full rounded-md border border-zinc-300 py-1.5 text-sm dark:border-zinc-700"
            >
              Cancel
            </button>
          </>
        )}

        {step === "label" && choice && (
          <>
            <h2 className="text-lg font-semibold">Name this recording</h2>
            <p className="mt-1 text-sm text-zinc-500">
              {choice === "tab" &&
                'e.g. "Client Meeting - Zoom" or "Team Discussion - Discord". Your browser will now ask you to pick a tab to share.'}
              {choice === "mic" && 'e.g. "My Notes" or "Podcast Draft".'}
              {choice === "both" &&
                'e.g. "Client Meeting". Your browser will ask you to pick a tab to share, then for microphone access — both get mixed into one recording.'}
            </p>
            <p className="mt-1 text-sm text-zinc-500">
              {choice === "both" && speechSupported &&
                "Tip: play the tab through speakers rather than headphones. Your mic then hears the other side too, so the live transcript captures the whole conversation accurately — no separate (and much less accurate) offline pass needed."}
            </p>
            <input
              autoFocus
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={defaultLabel(choice)}
              className="mt-3 w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
            />

            <label
              className={`mt-3 flex items-center gap-2 text-sm ${
                videoSupported ? "" : "opacity-50"
              }`}
              title={
                videoSupported
                  ? undefined
                  : "This browser can't record video (no supported MediaRecorder video format)."
              }
            >
              <input
                type="checkbox"
                checked={includeVideo}
                disabled={!videoSupported}
                onChange={(event) => setIncludeVideo(event.target.checked)}
              />
              {choice === "mic" ? "Also record webcam video" : "Also include video"}
            </label>

            {choice === "tab" && (
              <p className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                ⚠️ Tab/window audio can&apos;t be auto-transcribed live by the browser itself —
                its built-in speech recognition only listens to the microphone. Pick a live
                transcription option below for a live transcript anyway, or transcribe it
                automatically (or manually) after recording instead.
              </p>
            )}

            {(choice === "tab" || choice === "both") && (
              <div className="mt-3 rounded-md border border-zinc-200 p-2 dark:border-zinc-800">
                <p className="text-sm font-medium">Live transcript for tab audio</p>
                <div className="mt-1.5 flex flex-col gap-1.5">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="tabLiveMode"
                      checked={tabLiveMode === "none"}
                      onChange={() => setTabLiveMode("none")}
                    />
                    Off (transcribe afterward instead)
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="tabLiveMode"
                      checked={tabLiveMode === "cloud"}
                      onChange={() => setTabLiveMode("cloud")}
                    />
                    Cloud, via Deepgram API key (most accurate)
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="tabLiveMode"
                      checked={tabLiveMode === "local"}
                      onChange={() => setTabLiveMode("local")}
                    />
                    On-device, via this app&apos;s local Whisper model (free, no API key)
                  </label>
                </div>

                {tabLiveMode === "cloud" && (
                  <>
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
                    {liveCloudTabMissingKey ? (
                      <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                        Enter a Deepgram API key to continue, or pick a different option above —
                        otherwise &quot;Start Recording&quot; below stays disabled. (Get a key
                        from <span className="font-mono">console.deepgram.com</span> — a key from
                        another service like OpenAI won&apos;t work here, this is specifically
                        Deepgram&apos;s streaming API.)
                      </p>
                    ) : (
                      <p className="mt-1 text-xs text-zinc-500">
                        Sent directly from this browser to Deepgram — this app has no backend to
                        hold it instead. The tab audio is always recorded normally regardless, so
                        this can be left off and transcribed afterward instead.
                      </p>
                    )}
                  </>
                )}

                {tabLiveMode === "local" && (
                  <>
                    <select
                      value={liveModelId}
                      onChange={(event) => {
                        setLiveModelId(event.target.value);
                        writeLocalStorage(LIVE_MODEL_STORAGE_KEY, event.target.value);
                      }}
                      className="mt-2 w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
                    >
                      {LIVE_WHISPER_MODELS.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label} ({model.sizeLabel})
                        </option>
                      ))}
                    </select>
                    <p className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                      Runs this app&apos;s local Whisper model in short chunks as you record — free
                      and fully on-device, but noticeably less accurate than Deepgram or a full
                      after-the-fact transcription (each chunk is transcribed with little
                      surrounding context), and keeps the CPU busy for the whole recording.
                      {localDevice === "wasm" && (
                        <>
                          {" "}
                          <strong>This browser is running it on the CPU</strong> (no WebGPU), where
                          only the smallest model reliably keeps pace — a larger one may fall
                          behind and lag further and further behind the audio.
                        </>
                      )}
                      {localDevice === "webgpu" && (
                        <> Running on the GPU (WebGPU), so a larger model is realistic here.</>
                      )}
                      {localModelLoading && (
                        <>
                          {" "}
                          Downloading the model now (first time only
                          {localModelLoadProgress?.total
                            ? ` — ${Math.round(
                                ((localModelLoadProgress.loaded ?? 0) / localModelLoadProgress.total) * 100,
                              )}%`
                            : ""}
                          )…
                        </>
                      )}
                    </p>
                  </>
                )}
              </div>
            )}

            {(((choice === "mic" || choice === "both") && speechSupported) ||
              ((choice === "tab" || choice === "both") &&
                ((tabLiveMode === "cloud" && !liveCloudTabMissingKey) || tabLiveMode === "local"))) && (
              <>
                <label className="mt-3 block text-xs text-zinc-500">
                  Language spoken (for live transcription)
                </label>
                <select
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                  className="mt-1 w-full rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-700"
                >
                  {SPEECH_LANGUAGES.map((lang) => (
                    <option key={lang.code} value={lang.code}>
                      {lang.name}
                    </option>
                  ))}
                </select>
                <p className="mt-2 rounded-md bg-green-50 p-2 text-xs text-green-800 dark:bg-green-950/30 dark:text-green-300">
                  ✓ This recording will include a live transcript.
                </p>
              </>
            )}

            <div className="mt-4 flex gap-2">
              <button
                onClick={confirm}
                disabled={busy || liveCloudTabMissingKey}
                title={
                  liveCloudTabMissingKey
                    ? "Enter a Deepgram API key (or turn off live tab transcription) to continue"
                    : undefined
                }
                className="flex-1 rounded-md bg-zinc-900 py-2 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {busy ? "Requesting access…" : "Start Recording"}
              </button>
              <button
                onClick={back}
                disabled={busy}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
              >
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
