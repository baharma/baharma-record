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

**Desktop Chrome only.** `getDisplayMedia` (tab/window audio capture) and the Web Speech API
(live transcription) aren't reliably supported on mobile browsers or in Firefox/Safari — the
app doesn't polyfill either. `lib/browserSupport.ts` centralizes the feature-detection
(`isMobileUserAgent`, `isDisplayMediaSupported`, `isSpeechRecognitionSupported`,
`isUserMediaSupported`, `isVideoRecordingSupported`); `BrowserWarningBanner` reads it to show
an inline warning rather than blocking the app outright, since microphone-only recording can
still work in a degraded browser.

### Client-only boundary

Every browser-only API (`MediaRecorder`, `getDisplayMedia`, `IndexedDB`, `SpeechRecognition`,
Web Workers) is unreachable during SSR/static generation. The app enforces this with one
choke point: `app/page.tsx` (a Server Component) renders `AppClientLoader`, a `"use client"`
component that `next/dynamic`s the real `AppClient` with `ssr: false`. `next/dynamic({ssr:
false})` must be called from a Client Component — calling it directly from a Server
Component throws — hence the two-file split instead of one dynamic import in `page.tsx`.

### Recording pipeline

`lib/mediaAcquisition.ts` wraps `getDisplayMedia`/`getUserMedia` acquisition. On macOS, once
one screen/window share is active, the OS-level capture backend can lock up and reject a
*second* concurrent `getDisplayMedia()` call with `NotReadableError` even though nothing else
is actually using the source — `acquireTabAudioStream` special-cases that error with a
macOS-specific message (pick a specific Window/Tab instead of Entire Screen, or toggle Chrome's
Screen Recording permission) rather than the generic "device already in use" wording, since the
generic message is misleading for this case and doesn't point at the actual workaround.

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
`RecordingEntry.secondaryAudioBlob` in `lib/types.ts`). Live transcription of the mic side is
unaffected by which stream is being recorded — `SpeechRecognition` never consumes the
`MediaStream` at all, it always listens to the physical default microphone. (The tab side can
also get a live transcript now, but only through mechanisms entirely separate from
`SpeechRecognition` — either Deepgram or the local Whisper worker; see "Live tab
transcription" below.)

`SpeechRecognition`/`SpeechRecognitionEvent`/etc. aren't part of TypeScript's `dom` lib, so
`useRecordingSession.ts` wouldn't typecheck against the real Web Speech API without them.
`types/speech-recognition.d.ts` declares them globally and is picked up automatically via
tsconfig's `**/*.ts` include — extend that file (not a local cast) for another property.

### Transcription pipeline

`lib/transcription/whisper.worker.ts` runs Whisper (`@huggingface/transformers`) in a Web
Worker so the model download/inference never blocks the UI thread. It's loaded via `new
Worker(new URL("../lib/transcription/whisper.worker.ts", import.meta.url), { type: "module"
})` from `hooks/useTranscriber.ts` — the pattern the Turbopack production build breaks (see
Commands). Models load at `dtype: "fp32"`, not a quantized dtype — quantized/fp16 exports
currently hit a graph-optimizer bug in the onnxruntime-web dev build transformers.js depends
on; fp32 avoids that code path at the cost of a larger one-time download (see
`WHISPER_MODELS`' comment in `lib/transcription/types.ts` for the exact errors and how to
verify if that's still true when upgrading the dependency).

The model is the **user's choice** (`WHISPER_MODELS`, picked in `TranscriptPanel`, remembered
in `localStorage`): "tiny" (~150MB) is markedly worse on non-English, on sung vocals, and on
code-switched speech (a smaller model has less capacity to place a foreign-language word
against a strong single-language decoding prior, and falls back to the nearest in-language
word it knows instead); "base" (~290MB) and "small" (~970MB) each roughly double the previous
tier's download and runtime for a further step up in accuracy — a real trade on hour-long
recordings, not a default to tune. The worker caches one pipeline **per model id**, so
switching back and forth doesn't re-download.

Recordings here can run over an hour, which is what drives two decisions that otherwise look
arbitrary:
- `lib/audioDecode.ts` decodes *into* a 16kHz `OfflineAudioContext`. `decodeAudioData` resamples
  to the context's rate, so samples never expand to the file's native rate first — measured on
  10min/48kHz/stereo, 220MB → 73MB (3x), i.e. ~1.3GB → ~440MB over an hour — and it removes the
  separate `OfflineAudioContext` resample pass and its own full-size buffer. `downmixToMono`
  always returns a standalone copy, never a view onto the `AudioBuffer`, because
  `useTranscriber` transfers that array's `ArrayBuffer` to the worker.
- The worker walks the clip in `INITIAL_WINDOW_SECONDS` windows instead of handing it over
  whole, purely so progress can be reported (`transcribe-progress` → the label in
  `TranscriptPanel`). An hour-long recording is otherwise one opaque call, leaving the UI
  unable to distinguish a long run from a hung one. Windows stay far wider than
  `chunk_length_s` so the model still does its own 30s chunking and stride overlap inside each.

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
- `lib/transcription/hallucination.ts` screens the *non-speech* failure mode: over background
  music or room tone Whisper doesn't stay quiet, it emits stock filler ("you", "Thank you.",
  "Terima kasih."), a sound annotation ("[Music]", "♪"), or letter soup — all of which read as
  dialogue nobody spoke. The trap is that the stock phrases are also real things people say,
  so phrase matching alone never drops anything: a stock phrase is removed only when
  *isolated*, i.e. no substantive speech within `ISOLATION_WINDOW_SECONDS`. Annotations,
  punctuation-only lines, and letter soup are dropped unconditionally (real speech is never
  only those). Verified `no_speech` and token scores are both absent from transformers.js
  4.2.0's ASR pipeline, which returns text and timestamps only — so this screening is the only
  place the failure can be caught.
- `lib/transcription/coverage.ts` + the worker's **gap sweep** recover audio the model skipped.
  Whisper routinely stops generating before its input runs out (music and singing worst of all),
  and because transformers.js splits long audio into 30s chunks generated *independently*, that
  early stop happens per chunk — scattering holes through a long recording, not just truncating
  the end. Each pass reports the timespans it actually produced output for (`SliceResult.intervals`,
  from chunk timestamps); `findFirstGap` then compares those against the clip and each hole gets
  its own dedicated `CONTINUATION_WINDOW_SECONDS` pass, budgeted by `continuationPassBudget`
  (scaled to clip length — a fixed cap that suits a 25s voice note covers only minutes of an
  hour-long recording). Two deliberate asymmetries: only
  *produced* spans count as covered for the initial pass (a span the model was merely *handed*
  proves nothing — stopping early inside it is the whole failure being recovered from), while a
  continuation window is marked covered even when it yields nothing (it just had its dedicated
  try; retrying would loop forever on audio the model can't transcribe, and marking it is what
  guarantees termination). A recovery pass's text is **discarded entirely** when it comes back
  all non-speech (`isAllNonSpeech`) — recovery exists to re-attempt audio the model gave up on,
  but on an instrumental stretch giving up was the *correct* answer, and pressing it to try
  again only invents dialogue. Without that gate the sweep actively manufactures the
  hallucinations the screening above exists to remove.
- The gap sweep's audible scan (`findNextAudibleSample`) and the reported `speechSeconds`
  (`totalAudibleSeconds`) deliberately use `speechRegions.ts`'s **absolute** floor, not its
  noise-floor-relative threshold — that relative threshold is derived from the clip's own
  quietest windows, so on loud material it misclassifies real audio as silence (measured:
  uniform music yields *zero* regions, and a loud clip with a quieter tail drops the tail
  entirely).

`TranscriptSegment.source` (`"mic" | "tab"`) tags which side a segment came from whenever a
recording can have both: `"mic"` segments come from live `SpeechRecognition` results on
"mixed" sessions; `"tab"` segments have three possible origins — live Deepgram transcription,
live *local* Whisper transcription (both during a "tab"/"mixed" session, see below), or after
the fact from "Transcribe Tab Audio" running Whisper/cloud batch transcription over
`secondaryAudioBlob`. Any source of `"tab"` text merges into the existing segments by
replacing only previously-tagged `"tab"` segments, never touching `"mic"` ones, rather than
overwriting the whole transcript.

### Cloud transcription & Settings

Two independent, opt-in cloud integrations sit alongside the local Whisper pipeline above —
both are pure client→provider calls (this app has no backend to proxy through), with API
keys stored via `lib/localStorage.ts`'s guarded read/write wrappers under provider-specific
keys defined in `lib/transcription/cloudProviders.ts` and `deepgramLive.ts`. Those same
storage keys are read/written from three places — `NewSourceModal`'s and `TranscriptPanel`'s
inline controls, and the centralized `SettingsModal` — so a key entered in any one shows up
pre-filled in the others; `SettingsModal` is purely a convenience UI over the same state, not
a separate source of truth, and skipping it to configure inline still works.

- **Live tab transcription (Deepgram).** `lib/transcription/deepgramLive.ts` streams audio
  over a `wss://api.deepgram.com/v1/listen` WebSocket, the one vendor-proprietary protocol in
  the app (contrast the OpenAI-compatible shape below) — real-time streaming ASR doesn't have
  a shared shape the way batch transcription does. It's one of the two ways tab audio can get
  a transcript *live* (the other being the local path in "Live tab transcription" below),
  since `SpeechRecognition` can never listen to anything but the physical
  microphone (see the recording pipeline notes above). `useRecordingSession.ts` feeds it the
  isolated tab-only signal — `secondaryStream` for "mixed" sessions, `stream` itself for
  "tab" sessions (there is no secondary stream to isolate from) — never the mic-mixed track.
  Browser WebSockets can't set custom headers, so the API key travels in the
  `Sec-WebSocket-Protocol` list instead, per Deepgram's documented browser workaround.
- **Cloud batch transcription.** An alternative *engine* for "Transcribe Audio"/"Transcribe
  Tab Audio", chosen per run (`TranscribeEngineRequest`) alongside the existing local-model
  picker in `TranscriptPanel`. OpenAI, Groq, and "custom" all speak the same OpenAI-style
  multipart `POST {baseUrl}/audio/transcriptions` shape, handled by one function in
  `lib/transcription/cloudTranscribe.ts`; Hugging Face's Inference API has an entirely
  different shape (JSON body with base64 audio, model id in the URL path) and gets its own
  code path there. Unlike the local path, no decode/silence-check/hallucination-screening
  runs before a cloud request — a hosted API has its own signal handling, and re-decoding a
  possibly hour-long recording just to inspect it first would defeat the point of offloading
  the work.

### Live tab transcription (local, on-device)

The no-API-key alternative to Deepgram for the same job: a live transcript of the isolated tab
signal, running the app's own Whisper worker instead of a hosted service. Picked in
`NewSourceModal`'s three-way control (off / Deepgram / on-device), which is deliberately
*exclusive* — both live paths tag their output `source: "tab"` on one timeline, so running
both would just duplicate text. `PendingSession.localLiveTab` carries it into
`useRecordingSession.ts`, which wires it exactly like the Deepgram session (own
`localLiveEndedRef` gate in `tryFinalize`, same stale-instance guards) and feeds it the same
isolated tab stream.

Whisper is not a streaming model, so `lib/transcription/localLive.ts` fakes the effect: it
taps raw 16kHz PCM off the stream via Web Audio (not `MediaRecorder` — no container to decode),
cuts it into windows, and transcribes each one. Consequences worth knowing before changing any
of it:

- **Windows are cut by `lib/transcription/liveVad.ts`, not on a fixed timer.** Its threshold is
  an adaptive noise floor, *not* `speechRegions.ts`'s absolute one: tab audio routinely carries
  a music bed that never drops below an absolute floor, so an absolute threshold finds no
  pauses at all and every window ends up cut by the `MAX_WINDOW_SECONDS` cap — mid-word, which
  is exactly the input Whisper handles worst (measured on a talking-head video with background
  music: every single cut was the cap). The floor also can't exceed a fraction of the recent
  peak (`PEAK_TO_FLOOR_RATIO`), or capture starting mid-sentence seeds it at *speech* level and
  the detector stays deaf until the first pause.
- **Segments are stamped with when their audio was captured** (`VadWindow.startSeconds`),
  never with arrival time the way the mic/Deepgram paths do. Local inference lands seconds
  after the fact — plus a first-window wait for the model to load — so arrival stamps put
  everything minutes late on the timeline.
- **Sustained sound is rejected before the model runs**, on `VadWindow.dynamicRange` (ratio of
  the window's loud frames to its quiet ones, against `MIN_SPEECH_DYNAMIC_RANGE`). This is the
  live path's most important guard and the only one that can work at all here: fed music or
  room tone, Whisper doesn't emit something visibly broken, it invents *fluent, plausible
  dialogue*, which no text-level screen can tell from a real transcript. The measure is a
  percentile ratio, deliberately not "how far frames dip below the median" — speech over a loud
  music bed never dips far below its own median (the bed holds the floor up) and the dip
  measure scored it identically to pure music, i.e. it silently dropped real speech. See the
  measured table on that constant before retuning it, and note the guard only catches
  *sustained* sound; music with real dynamics still reaches the model.
- **The worker's `"transcribe-window"` branch skips the whole-clip machinery** (speech-region
  splitting, gap sweep) since those need a complete recording to reason about — but it still
  runs the two *per-line* screens, `isDegenerateRepetition` and `isNonSpeechArtifact`. Skipping
  those was a real bug: without them the degenerate loop Whisper falls into on audio it can't
  place goes straight to the transcript. The stock-phrase filter runs too, but on a different
  rule than batch: it can't check whether a phrase is *isolated* among neighbours (there is no
  "later" yet), so it uses the window's own duration instead — several seconds of audio
  yielding nothing but "Terima kasih" is filler, while a genuine one arrives in a window barely
  longer than the phrase takes to say (`STOCK_PHRASE_ISOLATION_SECONDS`).
- **`useLiveTranscriber.ts` owns a second worker instance**, not the batch one: a batch
  `"transcribe"` call is one uninterrupted await chain that can run for minutes, and live
  windows can't queue behind it. Costs memory, not bandwidth (transformers.js caches weights in
  the browser Cache API). No queue is needed inside it — `localLive.ts` never sends window N+1
  before N resolves, so the "one ONNX session, no concurrent calls" rule holds by construction.
- **The live path tries WebGPU first and falls back to wasm**; batch stays on wasm
  deliberately (no deadline, and its long runs are likeliest to hit a GPU backend's rough
  edges). This matters because the wasm backend is pinned to one thread, which is what makes
  model size a real constraint live: `LIVE_WHISPER_MODELS` therefore offers only tiny/base
  (never "small"), and the picker tells the user which backend they actually got, since that's
  what decides whether "base" can keep pace.

Even at its best this stays below the batch pass: every window is transcribed with no
knowledge of the sentence before it. It's the trade for getting text during the meeting rather
than after it.

### Data model & storage

`lib/types.ts` defines `RecordingEntry` (the IndexedDB record) and `PendingSession` (a live,
not-yet-saved recording). `hooks/useRecordingsStore.ts` wraps `lib/db.ts` (a thin `idb`
wrapper) and is the only place that talks to IndexedDB directly. `lib/exportImport.ts`
(JSZip) and `lib/transcriptFormat.ts` both read/write `RecordingEntry`/`TranscriptSegment`
shapes — the exported `transcript.txt` and the in-app "Copy Transcript" button share
`lib/transcriptFormat.ts`'s single formatter so the two outputs can't drift apart.

`RecordingEntry.hasVideo` is derived once at recording time from
`stream.getVideoTracks().length > 0` (`useRecordingSession.ts`) and stored on the entry —
`audioBlob` holds the video track too when true, it isn't a separate blob. Records saved
before this field existed read as `undefined` at runtime despite the `boolean` type, so every
read goes through `Boolean(entry.hasVideo)` rather than a direct truthy check. Export mirrors
this: `lib/exportImport.ts` names the media file inside the zip `video.<ext>` vs `audio.<ext>`
based on the same flag (recorded as `has_video` in `meta.json`), and import reads that name
back to reconstruct `hasVideo` rather than sniffing the file itself.
