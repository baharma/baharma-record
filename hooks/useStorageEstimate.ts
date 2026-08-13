"use client";

import { useEffect, useState } from "react";

export interface StorageEstimateState {
  usage: number;
  quota: number;
  supported: boolean;
}

export function useStorageEstimate(refreshKey: number): StorageEstimateState {
  const [state, setState] = useState<StorageEstimateState>({
    usage: 0,
    quota: 0,
    supported: false,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
        return;
      }
      try {
        const estimate = await navigator.storage.estimate();
        if (!cancelled) {
          setState({
            usage: estimate.usage ?? 0,
            quota: estimate.quota ?? 0,
            supported: true,
          });
        }
      } catch {
        // ignore — estimate stays unsupported
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return state;
}
