"use client";

import { useEffect, useRef, useState } from "react";
import type { TranscriberStatus } from "@/hooks/useTranscriber";
import { downloadBlob, exportRecordingToZip } from "@/lib/exportImport";
import { formatDateTime, formatDuration, sanitizeFileName } from "@/lib/mediaFormat";
import type { TranscribeEngineRequest } from "@/lib/transcription/cloudProviders";
import type { ModelFileProgress, TranscribeProgress } from "@/lib/transcription/types";
import { sourceTypeLabel, type RecordingEntry, type TranscriptSegment } from "@/lib/types";
import { TranscriptPanel } from "./TranscriptPanel";

interface Props {
  recording: RecordingEntry;
  onClose: () => void;
  onDelete: (id: string) => Promise<void>;
  onUpdate: (id: string, patch: Partial<RecordingEntry>) => Promise<void>;
  onError: (message: string) => void;
  onAutoTranscribe: (recording: RecordingEntry, language: string, request: TranscribeEngineRequest) => void;
  isTranscribing: boolean;
  transcriberBusyElsewhere: boolean;
  transcriberStatus: TranscriberStatus;
  transcriberProgress: ModelFileProgress | null;
  transcriberTranscribeProgress: TranscribeProgress | null;
}

export function RecordingDetailModal({
  recording,
  onClose,
  onDelete,
  onUpdate,
  onError,
  onAutoTranscribe,
  isTranscribing,
  transcriberBusyElsewhere,
  transcriberStatus,
  transcriberProgress,
  transcriberTranscribeProgress,
}: Props) {
  // Rendered with key={recording.id} by the caller, so this instance is
  // always fresh for a given recording — no need to reset state on prop change.
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const setMediaRef = (el: HTMLMediaElement | null) => {
    mediaRef.current = el;
  };
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(recording.label);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  // Single-level undo for transcript changes: captured right before an
  // auto-transcribe or manual save overwrites the current transcript, so a
  // bad result (wrong language, garbled audio) can be rolled back. Cleared
  // on unmount/switching recordings — not persisted, and only one step deep.
  const [previousTranscript, setPreviousTranscript] = useState<{
    segments: RecordingEntry["transcriptSegments"];
    editedManually: boolean;
  } | null>(null);

  useEffect(() => {
    // Create (and later revoke) the object URL here rather than in a
    // useState lazy initializer: React Strict Mode's dev-only mount→
    // cleanup→mount would otherwise revoke the one-and-only URL in the
    // phantom cleanup pass and never recreate it, leaving audio playback
    // permanently broken. Recreating it on each effect run is safe (it's
    // cheap, in-memory, and this only ever runs once outside of Strict Mode).
    const url = URL.createObjectURL(recording.audioBlob);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [recording.audioBlob]);

  function handleSeek(time: number) {
    if (mediaRef.current) {
      mediaRef.current.currentTime = time;
      mediaRef.current.play().catch(() => {});
    }
  }

  async function saveLabel() {
    const trimmed = labelDraft.trim();
    if (!trimmed || trimmed === recording.label) {
      setEditingLabel(false);
      setLabelDraft(recording.label);
      return;
    }
    setBusy(true);
    try {
      await onUpdate(recording.id, { label: trimmed });
      setEditingLabel(false);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to update label.");
    } finally {
      setBusy(false);
    }
  }

  function snapshotTranscriptForUndo() {
    setPreviousTranscript({
      segments: recording.transcriptSegments,
      editedManually: recording.transcriptEditedManually,
    });
  }

  async function saveTranscript(segments: TranscriptSegment[]) {
    snapshotTranscriptForUndo();
    try {
      await onUpdate(recording.id, {
        transcriptSegments: segments.length > 0 ? segments : null,
        transcriptEditedManually: true,
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to save transcript.");
    }
  }

  function handleAutoTranscribeClick(language: string, request: TranscribeEngineRequest) {
    snapshotTranscriptForUndo();
    onAutoTranscribe(recording, language, request);
  }

  async function removeTabLines() {
    const remaining = (recording.transcriptSegments ?? []).filter(
      (segment) => segment.source !== "tab",
    );
    snapshotTranscriptForUndo();
    try {
      await onUpdate(recording.id, {
        transcriptSegments: remaining.length > 0 ? remaining : null,
        transcriptEditedManually: false,
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to remove the tab lines.");
    }
  }

  async function undoTranscript() {
    if (!previousTranscript) return;
    try {
      await onUpdate(recording.id, {
        transcriptSegments: previousTranscript.segments,
        transcriptEditedManually: previousTranscript.editedManually,
      });
      setPreviousTranscript(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to undo the transcript change.");
    }
  }

  async function handleExport() {
    setBusy(true);
    try {
      const blob = await exportRecordingToZip(recording);
      downloadBlob(blob, `${sanitizeFileName(recording.label)}.zip`);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to export recording.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await onDelete(recording.id);
      onClose();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to delete recording.");
      setBusy(false);
    }
  }

  const hasTranscript = Boolean(
    recording.transcriptSegments && recording.transcriptSegments.length > 0,
  );
  const hasVideo = Boolean(recording.hasVideo);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 p-4 dark:border-zinc-800">
          <div className="min-w-0 flex-1">
            {editingLabel ? (
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={labelDraft}
                  onChange={(event) => setLabelDraft(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && saveLabel()}
                  className="flex-1 rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-lg font-semibold dark:border-zinc-700"
                />
                <button
                  onClick={saveLabel}
                  disabled={busy}
                  className="rounded-md bg-zinc-900 px-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setEditingLabel(false);
                    setLabelDraft(recording.label);
                  }}
                  className="px-2 text-sm"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                className="truncate text-left text-lg font-semibold decoration-dotted hover:underline"
                onClick={() => setEditingLabel(true)}
                title="Click to rename"
              >
                {recording.label}
              </button>
            )}
            <p className="mt-1 text-xs text-zinc-500">
              {formatDateTime(recording.createdAt)} · {formatDuration(recording.durationSeconds)}{" "}
              · {sourceTypeLabel(recording.sourceType)}
              {hasVideo ? " · Video" : ""} ·{" "}
              {hasTranscript ? "Has transcript" : "Audio only"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="px-1 text-xl leading-none text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="border-b border-zinc-200 p-4 dark:border-zinc-800">
          {audioUrl &&
            (hasVideo ? (
              <video
                ref={setMediaRef}
                src={audioUrl}
                controls
                className="max-h-[40vh] w-full rounded-md bg-black"
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              />
            ) : (
              <audio
                ref={setMediaRef}
                src={audioUrl}
                controls
                className="w-full"
                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
              />
            ))}
        </div>

        {/* A flex column, not a plain block: the panel inside sizes itself
            with flex-1, because height:100% doesn't resolve against a parent
            whose own height comes from flex layout rather than an explicit
            value — which silently let the transcript grow past the modal. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
          <TranscriptPanel
            recording={recording}
            currentTime={currentTime}
            onSeek={handleSeek}
            onSaveTranscript={saveTranscript}
            onAutoTranscribe={handleAutoTranscribeClick}
            isTranscribing={isTranscribing}
            transcriberBusyElsewhere={transcriberBusyElsewhere}
            transcriberStatus={transcriberStatus}
            transcriberProgress={transcriberProgress}
            transcriberTranscribeProgress={transcriberTranscribeProgress}
            hasPreviousTranscript={previousTranscript !== null}
            onUndoTranscript={undoTranscript}
            onRemoveTabLines={removeTabLines}
          />
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-zinc-200 p-4 dark:border-zinc-800">
          <button
            onClick={handleExport}
            disabled={busy}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Export Recording
          </button>
          {confirmingDelete ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-zinc-500">Delete this recording?</span>
              <button
                onClick={handleDelete}
                disabled={busy}
                className="rounded-md bg-red-600 px-3 py-1.5 text-white disabled:opacity-50"
              >
                Yes, delete
              </button>
              <button
                onClick={() => setConfirmingDelete(false)}
                className="rounded-md border border-zinc-300 px-3 py-1.5 dark:border-zinc-700"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:hover:bg-red-950/30"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
