"use client";

import { useEffect, useState } from "react";
import type { RecordingEntry } from "@/lib/types";

export interface StorageEstimateState {
  usage: number;
  quota: number;
  supported: boolean;
}

/** Bytes actually held by a recording's blobs. */
function recordingBytes(recording: RecordingEntry): number {
  return recording.audioBlob.size + (recording.secondaryAudioBlob?.size ?? 0);
}

/**
 * Storage usage shown to the user, measured from the recordings themselves
 * rather than from `navigator.storage.estimate()`'s `usage`. Chromium's
 * reported usage lags far behind actual writes and deletes — measured: after
 * deleting a 5MB recording, `usage` was unchanged 5.7s later even on a fresh
 * call, so a deletion appeared to free nothing. Summing blob sizes reflects a
 * delete the moment the store's state updates. `quota` has no such lag and is
 * still read from the Storage API.
 */
export function useStorageEstimate(recordings: RecordingEntry[]): StorageEstimateState {
  const [quotaState, setQuotaState] = useState({ quota: 0, supported: false });

  useEffect(() => {
    let cancelled = false;

    async function loadQuota() {
      if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
        return;
      }
      try {
        const estimate = await navigator.storage.estimate();
        if (!cancelled) {
          setQuotaState({ quota: estimate.quota ?? 0, supported: true });
        }
      } catch {
        // ignore — estimate stays unsupported
      }
    }

    loadQuota();
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    usage: recordings.reduce((total, recording) => total + recordingBytes(recording), 0),
    quota: quotaState.quota,
    supported: quotaState.supported,
  };
}
