"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { generateId } from "@/lib/id";
import type {
  InferenceDevice,
  ModelFileProgress,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/transcription/types";

interface PendingWindowRequest {
  resolve: (result: { text: string }) => void;
  reject: (error: Error) => void;
}

/**
 * Owns a *second*, dedicated Whisper Web Worker for live, on-device
 * transcription of short windows during a recording — separate from
 * useTranscriber.ts's worker, which handles the full after-the-fact batch
 * pipeline. They can't share one worker: the batch worker's "transcribe"
 * handler is one long uninterrupted await chain (can run minutes on an
 * hour-long clip), so a live window sent to that same worker would queue
 * behind whatever batch job is already running. The cost of a second
 * instance is memory, not bandwidth — transformers.js caches downloaded
 * model weights via the browser Cache API, so this doesn't re-download
 * "tiny", it just holds a second small in-memory pipeline.
 *
 * Lazily created on first use (so the model is never downloaded/loaded
 * unless a local-live session actually starts one), then kept for the rest
 * of the app session — same lifetime as useTranscriber.ts's own worker.
 * Live callers never send window N+1 before window N resolves (see
 * lib/transcription/localLive.ts's single-flight queue), so this worker
 * never needs its own request queue: the "one shared ONNX session can't
 * take concurrent calls" constraint is satisfied by construction.
 */
export function useLiveTranscriber() {
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState<ModelFileProgress | null>(null);
  /** Which backend the live pipeline actually got — null until the first load resolves. */
  const [device, setDevice] = useState<InferenceDevice | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const pendingRequestsRef = useRef<Map<string, PendingWindowRequest>>(new Map());

  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      const worker = new Worker(
        new URL("../lib/transcription/whisper.worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;

        if (message.type === "status") {
          setIsModelLoading(message.phase === "loading-model");
          if (message.phase === "transcribing") setLoadProgress(null);
          return;
        }
        if (message.type === "progress") {
          setLoadProgress(message.progress);
          return;
        }
        if (message.type === "live-device") {
          setDevice(message.device);
          return;
        }
        // "result" / "transcribe-progress" belong to the batch "transcribe"
        // request type, which this worker instance never receives.
        if (message.type !== "window-result" && message.type !== "error") return;

        const pending = pendingRequestsRef.current.get(message.requestId);
        if (!pending) return;
        pendingRequestsRef.current.delete(message.requestId);

        if (message.type === "window-result") {
          pending.resolve({ text: message.text });
        } else {
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

  const transcribeWindow = useCallback(
    (samples: Float32Array, language: string, modelId: string): Promise<{ text: string }> => {
      const worker = getWorker();
      const requestId = generateId();
      return new Promise<{ text: string }>((resolve, reject) => {
        pendingRequestsRef.current.set(requestId, { resolve, reject });
        const request: WorkerRequest = {
          type: "transcribe-window",
          requestId,
          audio: samples,
          language,
          modelId,
        };
        worker.postMessage(request, [samples.buffer]);
      });
    },
    [getWorker],
  );

  return { transcribeWindow, isModelLoading, loadProgress, device };
}

export type LiveTranscriber = ReturnType<typeof useLiveTranscriber>;
