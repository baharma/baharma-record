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
  // Actual start time is stamped when the mount effect below runs.
  const startTimeRef = useRef<number>(0);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const transcriptSegmentsRef = useRef<TranscriptSegment[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalizedRef = useRef(false);
  const stoppingRef = useRef(false);
  const shouldRestartRecognitionRef = useRef(false);

  const finalize = useCallback(() => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;

    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    const mimeType = mediaRecorderRef.current?.mimeType || "audio/webm";
    const audioBlob = new Blob(chunksRef.current, { type: mimeType });
    const durationSeconds = Math.max(
      1,
      Math.round((Date.now() - startTimeRef.current) / 1000),
    );

    const entry: RecordingEntry = {
      id: generateId(),
      label,
      sourceType,
      createdAt: startTimeRef.current,
      durationSeconds,
      audioBlob,
      audioMimeType: mimeType,
      transcriptSegments: enableTranscript ? transcriptSegmentsRef.current : null,
      transcriptEditedManually: false,
    };

    setStatus("stopped");
    onFinalized(entry);
  }, [label, sourceType, enableTranscript, onFinalized]);

  const stop = useCallback(() => {
    if (stoppingRef.current || finalizedRef.current) return;
    stoppingRef.current = true;
    shouldRestartRecognitionRef.current = false;
    setStatus("stopping");

    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      finalize();
    }

    stream.getTracks().forEach((track) => track.stop());
    extraCleanup?.();
  }, [finalize, stream, extraCleanup]);

  useEffect(() => {
    startTimeRef.current = Date.now();
    // Discard any data from a superseded recorder instance (relevant when
    // React Strict Mode's dev-only mount→cleanup→mount runs this twice).
    chunksRef.current = [];

    const mimeType = pickSupportedMimeType();
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
    // Only finalize on a real stop (user action or track-ended), never on
    // the phantom stop() Strict Mode's cleanup issues in development.
    recorder.onstop = () => {
      if (stoppingRef.current) finalize();
    };
    recorder.onerror = () => {
      onWarning("The recorder ran into an error and the session was stopped.");
      stop();
    };
    recorder.start(1000);

    timerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 500);

    const audioTrack = stream.getAudioTracks()[0];
    const handleTrackEnded = () => stop();
    audioTrack?.addEventListener("ended", handleTrackEnded);

    if (enableTranscript) {
      const SpeechRecognitionCtor = getSpeechRecognitionConstructor();
      if (SpeechRecognitionCtor) {
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
                  { time, text: trimmed },
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
          if (shouldRestartRecognitionRef.current) {
            try {
              recognition.start();
            } catch {
              // ignore restart races
            }
          }
        };

        try {
          shouldRestartRecognitionRef.current = true;
          recognition.start();
          recognitionRef.current = recognition;
        } catch {
          onWarning("Couldn't start live transcription for this recording.");
        }
      } else {
        onWarning(
          "Live transcription isn't supported in this browser. This recording will be audio-only.",
        );
      }
    }

    return () => {
      audioTrack?.removeEventListener("ended", handleTrackEnded);
      shouldRestartRecognitionRef.current = false;
      if (timerRef.current !== null) clearInterval(timerRef.current);
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
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
