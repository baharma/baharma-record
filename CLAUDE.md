# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev      # Turbopack dev server (localhost:3000)
npm run build    # next build --webpack — NOT the default Turbopack build, see below
npm start        # serve the production build (after npm run build)
npm run lint     # eslint
npx tsc --noEmit # typecheck (no separate script defined)
```

There is no test suite/framework in this repo (no `test` script, no test runner installed).

**`build` must stay pinned to `--webpack`.** Turbopack (as of Next.js 16.3) doesn't bundle
the `new Worker(new URL(...))` pattern used for the transcription worker correctly in
production — it copies the raw, un-transpiled `.ts` source as a static asset instead of
compiling it, which fails at runtime. `next dev` uses Turbopack and is unaffected (only the
production bundling path is broken). `next.config.ts` also sets `output: "export"`, so
`npm run build` produces a static site in `./out` in addition to the standard
`.next` server build.

## Architecture

This is a 100% client-side app — Next.js only serves static files; there is no backend, no
API routes, and no server-held state. Everything (recordings, transcripts, settings) lives
in the browser's IndexedDB, scoped per-browser/per-device.

### Client-only boundary

Every browser-only API (`MediaRecorder`, `getDisplayMedia`, `IndexedDB`, `SpeechRecognition`,
Web Workers) is unreachable during SSR/static generation. The app enforces this with one
choke point: `app/page.tsx` (a Server Component) renders `AppClientLoader`, a `"use client"`
component that `next/dynamic`s the real `AppClient` with `ssr: false`. `next/dynamic({ssr:
false})` must be called from a Client Component — calling it directly from a Server
Component throws — hence the two-file split instead of one dynamic import in `page.tsx`.

### Recording pipeline

`hooks/useRecordingSession.ts` owns one live recording session end-to-end: it drives up to
two parallel `MediaRecorder`s (see "mixed" sessions below) and, for mic-enabled sessions, a
`SpeechRecognition` instance, and only calls `onFinalized` once every recorder/recognizer
that was actually running has genuinely stopped (`tryFinalize`'s `recorderStoppedRef` /
`secondaryRecorderStoppedRef` / `recognitionEndedRef` gate). This exists because
`MediaRecorder.stop()` and `SpeechRecognition.stop()` resolve asynchronously with no
guaranteed order — finalizing as soon as the recorder stops used to race ahead of
recognition still delivering the last words spoken, silently dropping them from what got
saved.

Two React Strict Mode dev-mode traps drive most of this hook's structure, and both bit in
production-shaped ways before being fixed — don't undo either without re-reading the inline
comments:
- The mount effect's cleanup must never stop `stream`'s (or `secondaryStream`'s) hardware
  tracks — only the exposed `stop()` callback may, because Strict Mode's dev-only
  mount→cleanup→mount would otherwise kill a real hardware track that can't be restarted,
  breaking the second mount.
- Every recorder/recognition callback (`ondataavailable`, `onstop`, `onend`) guards with an
  "is this still the current instance" check (`mediaRecorderRef.current !== recorder`, etc.)
  so a belated event from a phantom Strict-Mode instance can't corrupt or prematurely
  finalize the real one. `SpeechRecognition` restarts (Chrome ends sessions on its own after
  a pause) go through the same discipline: never call `.start()` synchronously from `onend`
  (throws `InvalidStateError` — the old session is still tearing down); restart a fresh
  instance on a short delay instead, with backoff on repeated failure.

**"Mixed" (Tab + Mic Simultaneously) sessions** record two streams from one hook instance:
the Web Audio–mixed track (both sources summed via `AudioContext`/
`MediaStreamAudioDestinationNode`) is the one saved as the recording's `audioBlob`; the raw,
unmixed tab-only stream is recorded in parallel into `secondaryAudioBlob`, existing purely so
the tab side can later be transcribed without mic speech tangled into the same audio (see
`RecordingEntry.secondaryAudioBlob` in `lib/types.ts`). Live transcription is unaffected by
which stream is being recorded — `SpeechRecognition` never consumes the `MediaStream` at all,
it always listens to the physical default microphone.

### Transcription pipeline

`lib/transcription/whisper.worker.ts` runs Whisper (`@huggingface/transformers`) in a Web
Worker so the model download/inference never blocks the UI thread. It's loaded via `new
Worker(new URL("../lib/transcription/whisper.worker.ts", import.meta.url), { type: "module"
})` from `hooks/useTranscriber.ts` — the pattern the Turbopack production build breaks (see
Commands). The model loads at `dtype: "fp32"`, not a quantized dtype — quantized/fp16 exports
currently hit a graph-optimizer bug in the onnxruntime-web dev build transformers.js depends
on; fp32 avoids that code path at the cost of a larger one-time download (see
`WHISPER_MODEL_ID`'s comment in `lib/transcription/types.ts` for the exact errors and how to
verify if that's still true when upgrading the dependency).

Several non-obvious safeguards sit between "decode the audio" and "hand segments back to the
UI", because transformers.js exposes none of Whisper's own anti-hallucination heuristics
(`no_speech_threshold`, `compression_ratio_threshold`, `logprob_threshold`):
- `lib/audioDecode.ts` measures peak/RMS level; silent audio is rejected before the model
  ever runs (`SILENCE_PEAK_THRESHOLD`), and quiet-but-audible audio is gain-normalized
  (`normalizeForSpeech`) — weak signal is a major driver of hallucination.
- `lib/transcription/speechRegions.ts` does energy-based speech-region detection. If speech
  covers under `CONTINUOUS_SPEECH_RATIO` (70%) of the clip, each region is transcribed
  *separately and sequentially* (never `Promise.all` — concurrent calls into one shared ONNX
  session aren't safe) with timestamps offset back onto the real timeline. This exists
  because silence-heavy audio fed whole to Whisper doesn't just get skipped — it can collapse
  the entire clip into one bogus segment with a nonsense timespan, which is what makes a
  transcript appear to jump from one timestamp to a much later one. Continuous speech is left
  on the original single-pass path unchanged.
- `lib/transcription/repetition.ts` screens for Whisper's other hallucination failure mode —
  a handful of words looping for the whole segment — as a belt-and-braces filter after
  generation-time `no_repeat_ngram_size`/`repetition_penalty`.

`TranscriptSegment.source` (`"mic" | "tab"`) only appears on segments from a "mixed"
recording. The mic side comes from live `SpeechRecognition` results; the tab side is filled
in on demand by "Transcribe Tab Audio", which transcribes `secondaryAudioBlob` and merges the
result into the existing segments (replacing only previously-tagged `"tab"` segments, never
touching `"mic"` ones) rather than overwriting the whole transcript.

### Data model & storage

`lib/types.ts` defines `RecordingEntry` (the IndexedDB record) and `PendingSession` (a live,
not-yet-saved recording). `hooks/useRecordingsStore.ts` wraps `lib/db.ts` (a thin `idb`
wrapper) and is the only place that talks to IndexedDB directly. `lib/exportImport.ts`
(JSZip) and `lib/transcriptFormat.ts` both read/write `RecordingEntry`/`TranscriptSegment`
shapes — the exported `transcript.txt` and the in-app "Copy Transcript" button share
`lib/transcriptFormat.ts`'s single formatter so the two outputs can't drift apart.
