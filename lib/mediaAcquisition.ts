import { isDisplayMediaSupported } from "./browserSupport";

/**
 * Captures a tab/window/screen via getDisplayMedia and returns a MediaStream
 * with audio (always) and, when `includeVideo` is set, the video track too.
 * Video is otherwise stopped immediately after acquisition — this also
 * releases the "you are sharing your screen" indicator as soon as possible
 * for anything that doesn't need the video.
 */
export async function acquireTabAudioStream(
  options: { includeVideo?: boolean } = {},
): Promise<MediaStream> {
  if (!isDisplayMediaSupported()) {
    throw new Error(
      "Tab/window audio capture is not supported in this browser. Please use desktop Chrome or another Chromium-based browser.",
    );
  }

  const displayStream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true,
    // Chrome-specific hints (silently ignored elsewhere): keep the "share
    // system/tab audio" checkbox available by default, don't offer this
    // app's own tab as a shareable source, and let the user switch between
    // tab/window/screen in the native dialog without re-prompting.
    systemAudio: "include",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  } as DisplayMediaStreamOptions);

  if (!options.includeVideo) {
    displayStream.getVideoTracks().forEach((track) => track.stop());
  }

  const audioTracks = displayStream.getAudioTracks();
  if (audioTracks.length === 0) {
    displayStream.getTracks().forEach((track) => track.stop());
    throw new Error(
      'No audio was shared. In the browser dialog, choose a Chrome tab and make sure "Share tab audio" (or "Share audio") is checked.',
    );
  }

  return options.includeVideo ? displayStream : new MediaStream(audioTracks);
}

export async function acquireMicrophoneStream(
  options: { includeVideo?: boolean } = {},
): Promise<MediaStream> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    throw new Error("Microphone capture is not supported in this browser.");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: Boolean(options.includeVideo),
  });
}

export function friendlyErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
        return "Permission was denied. Please allow access and try again.";
      case "NotFoundError":
        return "No matching device was found.";
      case "NotReadableError":
        return "The selected device is already in use by another application.";
      case "AbortError":
        return "The request was cancelled.";
      default:
        break;
    }
  }
  if (error instanceof Error) return error.message;
  return "An unknown error occurred.";
}
