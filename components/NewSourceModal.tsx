"use client";

import { useState } from "react";
import {
  isDisplayMediaSupported,
  isSpeechRecognitionSupported,
  isVideoRecordingSupported,
} from "@/lib/browserSupport";
import { generateId } from "@/lib/id";
import {
  acquireMicrophoneStream,
  acquireTabAudioStream,
  friendlyErrorMessage,
} from "@/lib/mediaAcquisition";
import { defaultSpeechLanguageCode, speechRecognitionLocale, SPEECH_LANGUAGES } from "@/lib/speechLanguage";
import type { PendingSession } from "@/lib/types";

type Choice = "tab" | "mic" | "both";
type Step = "choose" | "label";

interface Props {
  onClose: () => void;
  onSessionsCreated: (sessions: PendingSession[]) => void;
  onError: (message: string) => void;
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

export function NewSourceModal({ onClose, onSessionsCreated, onError }: Props) {
  const [step, setStep] = useState<Step>("choose");
  const [choice, setChoice] = useState<Choice | null>(null);
  const [label, setLabel] = useState("");
  const [language, setLanguage] = useState(() => defaultSpeechLanguageCode());
  const [includeVideo, setIncludeVideo] = useState(false);
  const [busy, setBusy] = useState(false);

  const displaySupported = isDisplayMediaSupported();
  const speechSupported = isSpeechRecognitionSupported();
  const videoSupported = isVideoRecordingSupported();

  function pick(next: Choice) {
    setChoice(next);
    setLabel("");
    setIncludeVideo(false);
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

      if (choice === "tab") {
        const tabStream = await acquireTabAudioStream({ includeVideo });
        acquiredStreams.push(tabStream);
        sessions.push({
          id: generateId(),
          sourceType: "tab",
          label: baseLabel,
          stream: tabStream,
          enableTranscript: false,
          recognitionLang,
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
          // see RecordingEntry.secondaryAudioBlob.
          secondaryStream: new MediaStream(tabStream.getAudioTracks()),
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
                ⚠️ Tab/window audio can&apos;t be auto-transcribed while recording — the
                browser&apos;s speech recognition only listens to the microphone. You can
                transcribe it automatically or add a transcript manually afterward.
              </p>
            )}
            {(choice === "mic" || choice === "both") && speechSupported && (
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
                disabled={busy}
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
