"use client";

import {
  isDisplayMediaSupported,
  isMobileUserAgent,
  isSpeechRecognitionSupported,
} from "@/lib/browserSupport";

export function BrowserWarningBanner() {
  const mobile = isMobileUserAgent();
  const displaySupported = isDisplayMediaSupported();
  const speechSupported = isSpeechRecognitionSupported();

  if (!mobile && displaySupported && speechSupported) return null;

  return (
    <div className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      <p className="font-medium">
        This app works best in desktop Chrome (or another Chromium-based browser).
      </p>
      {mobile && (
        <p>
          You appear to be on a mobile device — tab/window audio capture generally isn&apos;t
          available on mobile browsers. Please switch to desktop Chrome for the full experience.
        </p>
      )}
      {!displaySupported && (
        <p>
          Tab/window audio capture isn&apos;t supported in this browser. Microphone recording may
          still work.
        </p>
      )}
      {!speechSupported && (
        <p>
          Live transcription (Web Speech API) isn&apos;t supported in this browser. Microphone
          recordings will be audio-only, but you can add a transcript manually.
        </p>
      )}
    </div>
  );
}
