"use client";

import { useCallback, useState } from "react";
import { useRecordingsStore } from "@/hooks/useRecordingsStore";
import { useToasts } from "@/hooks/useToasts";
import { useTranscriber } from "@/hooks/useTranscriber";
import { downloadBlob, exportRecordingsToZip, importZipFile } from "@/lib/exportImport";
import { cloudProvider, type TranscribeEngineRequest } from "@/lib/transcription/cloudProviders";
import { transcribeWithCloudProvider } from "@/lib/transcription/cloudTranscribe";
import type { PendingSession, RecordingEntry, TranscriptSegment } from "@/lib/types";
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
    async (recording: RecordingEntry, language: string, request: TranscribeEngineRequest) => {
      if (transcribingId) return;
      setTranscribingId(recording.id);
      try {
        // "mixed" recordings with a secondaryAudioBlob: this is (re-)filling
        // in the tab side of a combined transcript (the mic side already
        // came from live Web Speech) — transcribe the isolated tab-only
        // audio, tag those segments, and merge them into the existing
        // transcript sorted by time, replacing any previous tab segments
        // (so re-running with a different language works as a clean redo,
        // not an accumulation). The secondary audio is kept (not cleared)
        // so this can be retried again later.
        const isTabMerge = recording.sourceType === "mixed" && Boolean(recording.secondaryAudioBlob);
        const audioToTranscribe = isTabMerge ? recording.secondaryAudioBlob! : recording.audioBlob;

        const { segments: rawSegments, speechSeconds, audioSeconds } =
          request.engine === "local"
            ? await transcriber.transcribe(audioToTranscribe, language, request.modelId)
            : await transcribeWithCloudProvider(audioToTranscribe, language, request.config);
        const newSegments: TranscriptSegment[] = isTabMerge
          ? rawSegments.map((segment) => ({ ...segment, source: "tab" as const }))
          : rawSegments;

        const finalSegments = isTabMerge
          ? [
              ...(recording.transcriptSegments ?? []).filter((segment) => segment.source !== "tab"),
              ...newSegments,
            ].sort((a, b) => a.time - b.time)
          : newSegments;

        await store.updateRecording(recording.id, {
          transcriptSegments: finalSegments.length > 0 ? finalSegments : null,
          transcriptEditedManually: false,
        });

        const lastSegmentTime = newSegments.length
          ? newSegments[newSegments.length - 1].time
          : 0;
        const unaccountedSeconds = audioSeconds - lastSegmentTime;

        if (newSegments.length === 0) {
          push("info", `No speech was detected in "${recording.label}".`);
        } else if (request.engine === "cloud") {
          // The stopped-early/quiet-tail heuristics below exist specifically
          // to compensate for the local model's known coverage gaps (see
          // whisper.worker.ts's gap sweep) — a hosted API doesn't share that
          // failure mode and this path can't measure real speechSeconds, so
          // just confirm the result instead of reusing those numbers.
          push(
            "success",
            `Transcribed "${recording.label}" via ${cloudProvider(request.config.provider).label}.`,
          );
        } else if (unaccountedSeconds > 8 && audioSeconds - speechSeconds < 5) {
          // There was sound right through the clip, yet the model stopped
          // early — it lost the thread rather than running out of audio.
          // Music and singing trigger this far more than speech does.
          push(
            "info",
            `Transcribed "${recording.label}", but the model stopped around ` +
              `${Math.round(lastSegmentTime)}s of ${Math.round(audioSeconds)}s even though there ` +
              `was sound throughout. Music and singing often defeat the offline model — the live ` +
              `mic transcript is more reliable, or try a larger model.`,
          );
        } else if (audioSeconds - speechSeconds >= 5) {
          // Explain up front why a transcript can end well before the
          // recording does — usually the source simply went quiet.
          push(
            "success",
            `Transcribed "${recording.label}". Only ${Math.round(speechSeconds)}s of the ` +
              `${Math.round(audioSeconds)}s had audible sound, so the transcript ends earlier.`,
          );
        } else {
          push("success", `Transcribed "${recording.label}".`);
        }
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
      <StorageEstimateBar recordings={store.recordings} />

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
          transcriberTranscribeProgress={transcriber.transcribeProgress}
        />
      )}

      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </main>
  );
}
