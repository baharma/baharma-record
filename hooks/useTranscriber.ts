"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { decodeAudioTo16kMono } from "@/lib/audioDecode";
import { generateId } from "@/lib/id";
import type { ModelFileProgress, WorkerRequest, WorkerResponse } from "@/lib/transcription/types";
import type { TranscriptSegment } from "@/lib/types";

export type TranscriberStatus =
  | "idle"
  | "decoding"
  | "loading-model"
  | "transcribing"
  | "error";

interface PendingRequest {
  resolve: (segments: TranscriptSegment[]) => void;
  reject: (error: Error) => void;
}

export function useTranscriber() {
  const [status, setStatus] = useState<TranscriberStatus>("idle");
  const [progress, setProgress] = useState<ModelFileProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());

  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      const worker = new Worker(
        new URL("../lib/transcription/whisper.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;

        if (message.type === "status") {
          setStatus(message.phase);
          if (message.phase === "transcribing") setProgress(null);
          return;
        }
        if (message.type === "progress") {
          setProgress(message.progress);
          return;
        }

        const pending = pendingRequestsRef.current.get(message.requestId);
        if (!pending) return;
        pendingRequestsRef.current.delete(message.requestId);

        if (message.type === "result") {
          setStatus("idle");
          setProgress(null);
          pending.resolve(message.segments);
        } else if (message.type === "error") {
          setStatus("error");
          setProgress(null);
          setError(message.message);
          pending.reject(new Error(message.message));
        }
      };
      workerRef.current = worker;
    }
    return workerRef.current;
  }, []);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const transcribe = useCallback(
    async (audioBlob: Blob, language: string): Promise<TranscriptSegment[]> => {
      setError(null);
      setStatus("decoding");

      const audio = await decodeAudioTo16kMono(audioBlob);

      const worker = getWorker();
      const requestId = generateId();

      return new Promise<TranscriptSegment[]>((resolve, reject) => {
        pendingRequestsRef.current.set(requestId, { resolve, reject });
        const request: WorkerRequest = { type: "transcribe", requestId, audio, language };
        worker.postMessage(request, [audio.buffer]);
      });
    },
    [getWorker],
  );

  return { transcribe, status, progress, error };
}

export type Transcriber = ReturnType<typeof useTranscriber>;
