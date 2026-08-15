import JSZip from "jszip";
import { generateId } from "./id";
import {
  extensionForMimeType,
  mimeTypeForExtension,
  sanitizeFileName,
} from "./mediaFormat";
import { formatTranscriptText } from "./transcriptFormat";
import type { RecordingEntry, SourceType, TranscriptSegment } from "./types";

interface RecordingMetaJson {
  id: string;
  label: string;
  source_type: SourceType;
  created_at: number;
  duration_seconds: number;
  /** References "video.<ext>" instead of "audio.<ext>" when has_video is true. */
  audio_file: string;
  has_video: boolean;
  has_transcript: boolean;
  transcript_segments: TranscriptSegment[] | null;
  transcript_edited_manually: boolean;
}

function metaFromEntry(entry: RecordingEntry, mediaFile: string): RecordingMetaJson {
  return {
    id: entry.id,
    label: entry.label,
    source_type: entry.sourceType,
    created_at: entry.createdAt,
    duration_seconds: entry.durationSeconds,
    audio_file: mediaFile,
    has_video: Boolean(entry.hasVideo),
    has_transcript: Boolean(entry.transcriptSegments && entry.transcriptSegments.length > 0),
    transcript_segments: entry.transcriptSegments,
    transcript_edited_manually: entry.transcriptEditedManually,
  };
}

function transcriptToText(entry: RecordingEntry): string {
  const text = formatTranscriptText(entry.transcriptSegments, {
    editedManually: entry.transcriptEditedManually,
  });
  return text.length > 0 ? `${text}\n` : "(No transcript available for this recording.)\n";
}

function buildZipForEntry(zip: JSZip, entry: RecordingEntry): string {
  const ext = extensionForMimeType(entry.audioMimeType);
  const mediaFile = `${entry.hasVideo ? "video" : "audio"}.${ext}`;
  zip.file(mediaFile, entry.audioBlob);
  zip.file("meta.json", JSON.stringify(metaFromEntry(entry, mediaFile), null, 2));
  zip.file("transcript.txt", transcriptToText(entry));
  return mediaFile;
}

export async function exportRecordingToZip(entry: RecordingEntry): Promise<Blob> {
  const zip = new JSZip();
  buildZipForEntry(zip, entry);
  return zip.generateAsync({ type: "blob" });
}

export async function exportRecordingsToZip(entries: RecordingEntry[]): Promise<Blob> {
  const zip = new JSZip();
  const usedNames = new Set<string>();
  for (const entry of entries) {
    let folderName = sanitizeFileName(`${entry.label}_${entry.id.slice(0, 8)}`);
    while (usedNames.has(folderName)) {
      folderName = `${folderName}-${generateId().slice(0, 4)}`;
    }
    usedNames.add(folderName);
    const folder = zip.folder(folderName);
    if (folder) buildZipForEntry(folder, entry);
  }
  return zip.generateAsync({ type: "blob" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isRecordingMetaJson(value: unknown): value is RecordingMetaJson {
  if (!value || typeof value !== "object") return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta.id === "string" &&
    typeof meta.label === "string" &&
    (meta.source_type === "tab" || meta.source_type === "mic" || meta.source_type === "mixed") &&
    typeof meta.created_at === "number" &&
    typeof meta.duration_seconds === "number"
  );
}

async function parseRecordingFolder(
  folder: JSZip,
  folderLabel: string,
): Promise<RecordingEntry> {
  const metaFile = folder.file("meta.json");
  if (!metaFile) {
    throw new Error(`"${folderLabel}" is missing meta.json.`);
  }

  let meta: unknown;
  try {
    meta = JSON.parse(await metaFile.async("string"));
  } catch {
    throw new Error(`"${folderLabel}" has a corrupted meta.json.`);
  }

  if (!isRecordingMetaJson(meta)) {
    throw new Error(`"${folderLabel}" has an invalid or unrecognized meta.json.`);
  }

  let audioFile = meta.audio_file ? folder.file(meta.audio_file) : null;
  if (!audioFile) {
    const fallback = folder.filter((path) => /^(?:audio|video)\.[a-z0-9]+$/i.test(path));
    audioFile = fallback[0] ?? null;
  }
  if (!audioFile) {
    throw new Error(`"${folderLabel}" is missing its audio file.`);
  }

  const hasVideo = Boolean(meta.has_video);
  const audioArrayBuffer = await audioFile.async("arraybuffer");
  const extMatch = audioFile.name.match(/\.([a-z0-9]+)$/i);
  const mimeType = mimeTypeForExtension(
    extMatch ? extMatch[1] : "webm",
    hasVideo ? "video" : "audio",
  );
  const audioBlob = new Blob([audioArrayBuffer], { type: mimeType });

  return {
    id: generateId(),
    label: meta.label,
    sourceType: meta.source_type,
    createdAt: meta.created_at,
    durationSeconds: meta.duration_seconds,
    audioBlob,
    audioMimeType: mimeType,
    hasVideo,
    transcriptSegments: meta.transcript_segments ?? null,
    transcriptEditedManually: Boolean(meta.transcript_edited_manually),
    // The secondary (isolated tab-only) audio used to fill in a "mixed"
    // recording's tab-side transcript is a working artifact, not exported —
    // by the time a recording is exported, that transcription pass has
    // either already happened or the user chose not to run it.
    secondaryAudioBlob: null,
    secondaryAudioMimeType: null,
  };
}

export interface ImportResult {
  entries: RecordingEntry[];
  errors: string[];
}

export async function importZipFile(file: File): Promise<ImportResult> {
  const errors: string[] = [];
  const entries: RecordingEntry[] = [];

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    return {
      entries: [],
      errors: [`"${file.name}" is not a valid .zip file or is corrupted.`],
    };
  }

  if (zip.file("meta.json")) {
    try {
      entries.push(await parseRecordingFolder(zip, file.name));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return { entries, errors };
  }

  const subfolderNames = new Set<string>();
  zip.forEach((relativePath) => {
    const slashIndex = relativePath.indexOf("/");
    if (slashIndex > 0) {
      subfolderNames.add(relativePath.slice(0, slashIndex));
    }
  });

  if (subfolderNames.size === 0) {
    return {
      entries: [],
      errors: [
        `"${file.name}" doesn't look like a recording export (no meta.json found).`,
      ],
    };
  }

  for (const folderName of subfolderNames) {
    const folder = zip.folder(folderName);
    if (!folder) continue;
    try {
      entries.push(await parseRecordingFolder(folder, folderName));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (entries.length === 0 && errors.length === 0) {
    errors.push(`"${file.name}" doesn't contain any recognizable recordings.`);
  }

  return { entries, errors };
}
