"use client";

import { useCallback, useEffect, useState } from "react";
import * as db from "@/lib/db";
import type { RecordingEntry } from "@/lib/types";

export function useRecordingsStore() {
  const [recordings, setRecordings] = useState<RecordingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const all = await db.getAllRecordings();
      setRecordings(all);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load recordings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial load from IndexedDB — the setState calls inside `refresh` all
    // happen after an `await`, but the linter's static analysis can't see that.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  const addRecording = useCallback(
    async (entry: RecordingEntry) => {
      await db.addRecording(entry);
      await refresh();
    },
    [refresh],
  );

  const addRecordings = useCallback(
    async (entries: RecordingEntry[]) => {
      for (const entry of entries) {
        await db.addRecording(entry);
      }
      await refresh();
    },
    [refresh],
  );

  const updateRecording = useCallback(
    async (id: string, patch: Partial<RecordingEntry>) => {
      await db.updateRecording(id, patch);
      await refresh();
    },
    [refresh],
  );

  const deleteRecording = useCallback(
    async (id: string) => {
      await db.deleteRecording(id);
      await refresh();
    },
    [refresh],
  );

  return {
    recordings,
    loading,
    error,
    refresh,
    addRecording,
    addRecordings,
    updateRecording,
    deleteRecording,
  };
}

export type RecordingsStore = ReturnType<typeof useRecordingsStore>;
