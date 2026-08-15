const CANDIDATE_AUDIO_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

const CANDIDATE_VIDEO_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];

export function pickSupportedMimeType(preferVideo = false): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = preferVideo ? CANDIDATE_VIDEO_MIME_TYPES : CANDIDATE_AUDIO_MIME_TYPES;
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

export function extensionForMimeType(mimeType: string): string {
  const type = mimeType.toLowerCase();
  const isVideo = type.startsWith("video/");
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mp4")) return isVideo ? "mp4" : "m4a";
  if (type.includes("wav")) return "wav";
  return "webm";
}

export function mimeTypeForExtension(
  extension: string,
  kind: "audio" | "video" = "audio",
): string {
  switch (extension.toLowerCase()) {
    case "ogg":
      return `${kind}/ogg`;
    case "m4a":
      return "audio/mp4";
    case "mp4":
      return `${kind}/mp4`;
    case "wav":
      return "audio/wav";
    default:
      return `${kind}/webm`;
  }
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(secs)}`;
  }
  return `${minutes}:${pad(secs)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function sanitizeFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : "recording";
}
