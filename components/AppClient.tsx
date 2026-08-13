"use client";

import { useCallback, useState } from "react";
import { useRecordingsStore } from "@/hooks/useRecordingsStore";
import { useToasts } from "@/hooks/useToasts";
import { useTranscriber } from "@/hooks/useTranscriber";
import { downloadBlob, exportRecordingsToZip, importZipFile } from "@/lib/exportImport";
import type { PendingSession, RecordingEntry } from "@/lib/types";
import { ActiveSessionCard } from "./ActiveSessionCard";
import { BrowserWarningBanner } from "./BrowserWarningBanner";
import { LibrarySection } from "./LibrarySection";
import { NewSourceModal } from "./NewSourceModal";
import { RecordingDetailModal } from "./RecordingDetailModal";
import { StorageEstimateBar } from "./StorageEstimateBar";
import { ToastStack } from "./ToastStack";
import { Toolbar } from "./Toolbar";

export default function AppClient() {
  const store = useRecordingsStore();
  const { toasts, push, dismiss } = useToasts();
  const transcriber = useTranscriber();
  const [activeSessions, setActiveSessions] = useState<PendingSession[]>([]);
  const [showNewSourceModal, setShowNewSourceModal] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [importing, setImporting] = useState(false);
  const [transcribingId, setTranscribingId] = useState<string | null>(null);

  const handleSessionsCreated = useCallback((sessions: PendingSession[]) => {
    setActiveSessions((prev) => [...prev, ...sessions]);
    setShowNewSourceModal(false);
  }, []);

  const handleSessionRemove = useCallback((id: string) => {
    setActiveSessions((prev) => prev.filter((session) => session.id !== id));
  }, []);

  const handleSessionFinalized = useCallback(
    async (entry: RecordingEntry) => {
      try {
        await store.addRecording(entry);
        setRefreshTick((t) => t + 1);
        push("success", `Saved "${entry.label}" to your library.`);
      } catch (error) {
        push("error", error instanceof Error ? error.message : "Failed to save recording.");
      }
    },
    [store, push],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await store.deleteRecording(id);
      setRefreshTick((t) => t + 1);
      setSelectedId((current) => (current === id ? null : current));
    },
    [store],
  );

  const handleUpdate = useCallback(
    async (id: string, patch: Partial<RecordingEntry>) => {
      await store.updateRecording(id, patch);
    },
    [store],
  );

  const handleAutoTranscribe = useCallback(
    async (recording: RecordingEntry, language: string) => {
      if (transcribingId) return;
      setTranscribingId(recording.id);
      try {
        const segments = await transcriber.transcribe(recording.audioBlob, language);
        await store.updateRecording(recording.id, {
          transcriptSegments: segments.length > 0 ? segments : null,
          transcriptEditedManually: false,
        });
        push(
          segments.length > 0 ? "success" : "info",
          segments.length > 0
            ? `Transcribed "${recording.label}".`
            : `No speech was detected in "${recording.label}".`,
        );
      } catch (error) {
        push(
          "error",
          error instanceof Error ? error.message : "Failed to transcribe this recording.",
        );
      } finally {
        setTranscribingId(null);
      }
    },
    [transcriber, transcribingId, store, push],
  );

  async function handleExportAll() {
    try {
      const blob = await exportRecordingsToZip(store.recordings);
      downloadBlob(blob, `recordings-export-${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (error) {
      push("error", error instanceof Error ? error.message : "Failed to export recordings.");
    }
  }

  async function handleImportFile(file: File) {
    setImporting(true);
    try {
      const { entries, errors } = await importZipFile(file);
      if (entries.length > 0) {
        await store.addRecordings(entries);
        setRefreshTick((t) => t + 1);
        push("success", `Imported ${entries.length} recording${entries.length === 1 ? "" : "s"}.`);
      }
      errors.forEach((message) => push("error", message));
      if (entries.length === 0 && errors.length === 0) {
        push("error", "Nothing to import.");
      }
    } catch (error) {
      push("error", error instanceof Error ? error.message : "Failed to import file.");
    } finally {
      setImporting(false);
    }
  }

  const selected = selectedId
    ? (store.recordings.find((recording) => recording.id === selectedId) ?? null)
    : null;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8">
      <header>
        <h1 className="text-2xl font-semibold">Baharma Record</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Record audio from browser tabs and your microphone, with live transcripts where
          available. Data is stored locally in this browser only — use Export to move it to
          another device.
        </p>
      </header>

      <BrowserWarningBanner />
      <StorageEstimateBar refreshKey={refreshTick} />

      <Toolbar
        onNewSource={() => setShowNewSourceModal(true)}
        onExportAll={handleExportAll}
        onImportFile={handleImportFile}
        exportDisabled={store.recordings.length === 0}
        busy={importing}
      />

      {activeSessions.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Actively Recording ({activeSessions.length})
          </h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {activeSessions.map((session) => (
              <ActiveSessionCard
                key={session.id}
                session={session}
                onFinalized={handleSessionFinalized}
                onRemove={handleSessionRemove}
                onWarning={(message) => push("info", message)}
              />
            ))}
          </div>
        </section>
      )}

      <LibrarySection recordings={store.recordings} loading={store.loading} onSelect={setSelectedId} />

      {showNewSourceModal && (
        <NewSourceModal
          onClose={() => setShowNewSourceModal(false)}
          onSessionsCreated={handleSessionsCreated}
          onError={(message) => push("error", message)}
        />
      )}

      {selected && (
        <RecordingDetailModal
          key={selected.id}
          recording={selected}
          onClose={() => setSelectedId(null)}
          onDelete={handleDelete}
          onUpdate={handleUpdate}
          onError={(message) => push("error", message)}
          onAutoTranscribe={handleAutoTranscribe}
          isTranscribing={transcribingId === selected.id}
          transcriberBusyElsewhere={transcribingId !== null && transcribingId !== selected.id}
          transcriberStatus={transcriber.status}
          transcriberProgress={transcriber.progress}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </main>
  );
}
