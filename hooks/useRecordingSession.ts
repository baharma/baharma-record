"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { generateId } from "@/lib/id";
import { getSpeechRecognitionConstructor } from "@/lib/browserSupport";
import { pickSupportedMimeType } from "@/lib/mediaFormat";
import type { RecordingEntry, SourceType, TranscriptSegment } from "@/lib/types";

export type SessionStatus = "recording" | "stopping" | "stopped";

interface UseRecordingSessionOptions {
  sourceType: SourceType;
  label: string;
  stream: MediaStream;
  enableTranscript: boolean;
  /** BCP-47 locale tag for live transcription, e.g. "id-ID". */
  recognitionLang: string;
  /** See PendingSession.secondaryStream — recorded in parallel, separately. */
  secondaryStream?: MediaStream;
  /** See PendingSession.extraCleanup — invoked alongside stopping `stream`. */
  extraCleanup?: () => void;
  onFinalized: (entry: RecordingEntry) => void;
  onWarning: (message: string) => void;
}

export function useRecordingSession({
  sourceType,
  label,
  stream,
  enableTranscript,
  recognitionLang,
  secondaryStream,
  extraCleanup,
  onFinalized,
  onWarning,
}: UseRecordingSessionOptions) {
  const [status, setStatus] = useState<SessionStatus>("recording");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [interimText, setInterimText] = useState("");

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const secondaryRecorderRef = useRef<MediaRecorder | null>(null);
  const secondaryChunksRef = useRef<Blob[]>([]);
  // Actual start time is stamped when the mount effect below runs.
  const startTimeRef = useRef<number>(0);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  /** Pending restart of live transcription after Chrome ended a session. */
  const recognitionRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptSegmentsRef = useRef<TranscriptSegment[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalizedRef = useRef(false);
  const stoppingRef = useRef(false);
  const shouldRestartRecognitionRef = useRef(false);
  // MediaRecorder.stop() and SpeechRecognition.stop() both resolve
  // asynchronously with no guaranteed order. Finalizing as soon as the
  // recorder stops can race ahead of recognition still delivering the
  // final words the user just said — those would be silently dropped from
  // what's saved even though they displayed correctly live. Wait for both
  // (and the secondary recorder, if any) before finalizing.
  const recorderStoppedRef = useRef(false);
  const recognitionEndedRef = useRef(false);
  const secondaryRecorderStoppedRef = useRef(false);

  const finalize = useCallback(() => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;

    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const hasVideo = stream.getVideoTracks().length > 0;
    const mimeType =
      mediaRecorderRef.current?.mimeType || (hasVideo ? "video/webm" : "audio/webm");
    const audioBlob = new Blob(chunksRef.current, { type: mimeType });
    const durationSeconds = Math.max(
      1,
      Math.round((Date.now() - startTimeRef.current) / 1000),
    );

    const secondaryMimeType = secondaryRecorderRef.current?.mimeType || "audio/webm";
    const secondaryAudioBlob =
      secondaryStream && secondaryChunksRef.current.length > 0
        ? new Blob(secondaryChunksRef.current, { type: secondaryMimeType })
        : null;

    const entry: RecordingEntry = {
      id: generateId(),
      label,
      sourceType,
      createdAt: startTimeRef.current,
      durationSeconds,
      audioBlob,
      audioMimeType: mimeType,
      hasVideo,
      transcriptSegments: enableTranscript ? transcriptSegmentsRef.current : null,
      transcriptEditedManually: false,
      secondaryAudioBlob,
      secondaryAudioMimeType: secondaryAudioBlob ? secondaryMimeType : null,
    };

    setStatus("stopped");
    onFinalized(entry);
  }, [label, sourceType, enableTranscript, secondaryStream, onFinalized, stream]);

  // Only finalize once a real stop was requested AND every recorder/
  // recognizer that was actually running has actually finished — never on
  // the phantom stop() React Strict Mode's dev-only cleanup pass triggers.
  const tryFinalize = useCallback(() => {
    if (!stoppingRef.current) return;
    if (!recorderStoppedRef.current) return;
    if (!recognitionEndedRef.current) return;
    if (!secondaryRecorderStoppedRef.current) return;
    finalize();
  }, [finalize]);

  const stop = useCallback(() => {
    if (stoppingRef.current || finalizedRef.current) return;
    stoppingRef.current = true;
    shouldRestartRecognitionRef.current = false;
    setStatus("stopping");

    if (recognitionRestartTimerRef.current !== null) {
      clearTimeout(recognitionRestartTimerRef.current);
      recognitionRestartTimerRef.current = null;
    }
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      recorderStoppedRef.current = true;
    }

    const secondaryRecorder = secondaryRecorderRef.current;
    if (secondaryRecorder && secondaryRecorder.state !== "inactive") {
      secondaryRecorder.stop();
    } else {
      secondaryRecorderStoppedRef.current = true;
    }

    stream.getTracks().forEach((track) => track.stop());
    extraCleanup?.();

    // Safety net: some browsers/edge cases may not reliably fire
    // recognition.onend after stop() — don't hang forever waiting for it.
    setTimeout(() => {
      recorderStoppedRef.current = true;
      recognitionEndedRef.current = true;
      secondaryRecorderStoppedRef.current = true;
      tryFinalize();
    }, 2000);

    tryFinalize();
  }, [stream, extraCleanup, tryFinalize]);

  useEffect(() => {
    startTimeRef.current = Date.now();
    // Discard any data from a superseded recorder instance (relevant when
    // React Strict Mode's dev-only mount→cleanup→mount runs this twice).
    chunksRef.current = [];
    secondaryChunksRef.current = [];
    recorderStoppedRef.current = false;
    secondaryRecorderStoppedRef.current = !secondaryStream;
    // Nothing to wait for from recognition unless it actually starts below.
    recognitionEndedRef.current = !enableTranscript;

    const mimeType = pickSupportedMimeType(stream.getVideoTracks().length > 0);
    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined,
    );
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      // Guard against a belated event from a recorder instance that's
      // already been superseded (React Strict Mode's dev-only double
      // mount): only the current recorder is allowed to append chunks,
      // otherwise a stray fragment from the old encoding session would
      // corrupt the new one's WebM container.
      if (mediaRecorderRef.current !== recorder) return;
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      // Guard against a belated event from a superseded recorder instance
      // (Strict Mode's dev-only double mount) — see the ondataavailable
      // guard above for why this matters.
      if (mediaRecorderRef.current !== recorder) return;
      recorderStoppedRef.current = true;
      tryFinalize();
    };
    recorder.onerror = () => {
      onWarning("The recorder ran into an error and the session was stopped.");
      stop();
    };
    recorder.start(1000);

    let secondaryRecorder: MediaRecorder | null = null;
    if (secondaryStream) {
      const secondaryMimeType = pickSupportedMimeType();
      secondaryRecorder = new MediaRecorder(
        secondaryStream,
        secondaryMimeType ? { mimeType: secondaryMimeType } : undefined,
      );
      secondaryRecorderRef.current = secondaryRecorder;

      const currentSecondaryRecorder = secondaryRecorder;
      secondaryRecorder.ondataavailable = (event) => {
        if (secondaryRecorderRef.current !== currentSecondaryRecorder) return;
        if (event.data.size > 0) secondaryChunksRef.current.push(event.data);
      };
      secondaryRecorder.onstop = () => {
        if (secondaryRecorderRef.current !== currentSecondaryRecorder) return;
        secondaryRecorderStoppedRef.current = true;
        tryFinalize();
      };
      secondaryRecorder.start(1000);
    }

    timerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 500);

    const audioTrack = stream.getAudioTracks()[0];
    const handleTrackEnded = () => stop();
    audioTrack?.addEventListener("ended", handleTrackEnded);

    if (enableTranscript) {
      const SpeechRecognitionCtor = getSpeechRecognitionConstructor();
      if (SpeechRecognitionCtor) {
        // Chrome ends a SpeechRecognition session on its own after a stretch
        // of silence (and periodically regardless). Keeping live transcription
        // alive across a long pause therefore means restarting it — but
        // calling start() synchronously from onend throws InvalidStateError,
        // because the old session hasn't finished tearing down yet. So each
        // restart gets a fresh instance on a short delay, and a start() that
        // still fails is retried with backoff rather than silently giving up
        // (which used to kill the transcript for the rest of the recording).
        let startFailures = 0;

        const launchRecognition = () => {
          if (!shouldRestartRecognitionRef.current) return;

          const recognition = new SpeechRecognitionCtor();
          recognition.continuous = true;
          recognition.interimResults = true;
          recognition.lang = recognitionLang;

          recognition.onresult = (event: SpeechRecognitionEvent) => {
            let interim = "";
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const result = event.results[i];
              const text = result[0]?.transcript ?? "";
              if (result.isFinal) {
                const time = (Date.now() - startTimeRef.current) / 1000;
                const trimmed = text.trim();
                if (trimmed.length > 0) {
                  transcriptSegmentsRef.current = [
                    ...transcriptSegmentsRef.current,
                    { time, text: trimmed, source: "mic" },
                  ];
                  setTranscriptSegments(transcriptSegmentsRef.current);
                }
              } else {
                interim += text;
              }
            }
            setInterimText(interim);
          };

          recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
            // "no-speech" is the normal outcome of a pause, and "aborted"
            // happens on restart — neither is fatal, onend restarts us.
            if (event.error === "no-speech" || event.error === "aborted") return;
            if (event.error === "not-allowed" || event.error === "service-not-allowed") {
              shouldRestartRecognitionRef.current = false;
              onWarning(
                "Microphone permission for live transcription was denied. Recording will continue as audio-only.",
              );
              return;
            }
          };

          recognition.onend = () => {
            // Same stale-instance guard as ondataavailable/onstop above.
            if (recognitionRef.current !== recognition) return;
            if (shouldRestartRecognitionRef.current) {
              // Don't restart from inside onend — the session is still
              // tearing down and start() would throw. A fresh instance on
              // the next tick is what survives long pauses.
              recognitionRestartTimerRef.current = setTimeout(launchRecognition, 250);
            } else {
              // Recognition has genuinely finished (real stop, or it died on
              // its own) — nothing more to wait for before finalizing.
              recognitionEndedRef.current = true;
              tryFinalize();
            }
          };

          try {
            recognition.start();
            recognitionRef.current = recognition;
            startFailures = 0;
          } catch {
            startFailures += 1;
            if (startFailures <= 5) {
              recognitionRestartTimerRef.current = setTimeout(
                launchRecognition,
                250 * startFailures,
              );
            } else {
              shouldRestartRecognitionRef.current = false;
              onWarning(
                "Live transcription stopped and couldn't be restarted. The rest of this recording will be audio-only — you can still transcribe it afterwards.",
              );
              recognitionEndedRef.current = true;
              tryFinalize();
            }
          }
        };

        shouldRestartRecognitionRef.current = true;
        launchRecognition();
      } else {
        onWarning(
          "Live transcription isn't supported in this browser. This recording will be audio-only.",
        );
        recognitionEndedRef.current = true;
      }
    }

    return () => {
      audioTrack?.removeEventListener("ended", handleTrackEnded);
      shouldRestartRecognitionRef.current = false;
      if (timerRef.current !== null) clearInterval(timerRef.current);
      if (recognitionRestartTimerRef.current !== null) {
        clearTimeout(recognitionRestartTimerRef.current);
        recognitionRestartTimerRef.current = null;
      }
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      if (secondaryRecorderRef.current && secondaryRecorderRef.current.state !== "inactive") {
        secondaryRecorderRef.current.stop();
      }
      // Deliberately NOT stopping `stream`'s tracks here: the stream is a
      // real hardware capture owned by the caller (acquired once via
      // getDisplayMedia/getUserMedia), not a resource this effect created.
      // Stopping it here would make the effect non-reentrant — breaking
      // under React Strict Mode's dev-only mount→cleanup→mount, since a
      // stopped hardware track can't be restarted. `stop()` above is the
      // only place that should ever stop the stream's tracks.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, elapsedSeconds, transcriptSegments, interimText, stop };
}
