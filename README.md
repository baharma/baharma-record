# Baharma Record

Record audio from multiple browser tabs and your microphone at the same time,
build up a replayable local library with text transcripts where available,
and export/import recordings as `.zip` files — all with **no backend, no
server, no API keys, and no database**. Everything is stored in your
browser's IndexedDB.

> ⚠️ **This app only works properly in desktop Chrome** (or another
> Chromium-based desktop browser like Edge or Brave). It relies on
> `getDisplayMedia` (tab/window audio capture) and the Web Speech API (live
> transcription), neither of which is reliably supported on mobile browsers
> or in Firefox/Safari.

## Setup & run

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000) in **desktop
Chrome**.

For a production build:

```bash
npm run build
npm start
```

Since the app has no server-side logic, it also works as a fully static
site:

```bash
npm run build   # output is written to ./out (output: "export" in next.config.ts)
```

You can serve the `out/` folder with any static file server.

> **Note:** `npm run build` runs `next build --webpack` rather than the
> Turbopack production build. Turbopack (as of Next.js 16.3) doesn't bundle
> the `new Worker(new URL(...))` pattern used for the speech-to-text worker
> correctly in production builds — it copies the raw, un-transpiled
> TypeScript source as a static asset instead of compiling it, which fails
> at runtime. Webpack handles it correctly. `next dev` still uses Turbopack
> (works fine there — only the production bundling path is affected).

## How it works

- **Recording**: each source (a browser tab/window/screen, or your
  microphone) runs its own independent `MediaRecorder` session. You can
  record multiple sources at once — e.g. a Discord tab and your microphone
  simultaneously.
- **Transcripts**: the Web Speech API can only listen to your device's
  active microphone — it cannot read audio from a `MediaStream` captured via
  `getDisplayMedia`. So:
  - **Microphone recordings** get a live transcript automatically as you
    record, via the Web Speech API. Before starting, pick the language
    you'll be speaking from the dropdown (defaults to your browser's
    locale) — the Web Speech API needs an explicit language and silently
    produces wrong/garbled text if it doesn't match what's actually spoken,
    so don't rely on the default if your browser's locale doesn't match
    your recording's language.
    - Chrome ends a speech-recognition session by itself after a stretch of
      silence, so the app restarts it to keep a long pause from killing the
      transcript for the rest of the recording. The restart has to happen on
      a fresh instance a tick later: calling `start()` straight from `onend`
      throws `InvalidStateError` because the previous session is still
      tearing down. A failed start is retried with backoff, and only after
      several failures does it give up — with a visible warning rather than
      silently going dead.
  - **Tab/window recordings** are audio-only while recording. From the
    recording's detail view, you can either click **"Transcribe Audio"** to
    generate a transcript automatically (see below), or add/edit one
    manually.
  - Use "Tab + Mic Simultaneously" to mix tab audio and your microphone into
    a **single** recording (via the Web Audio API — both streams are summed
    into one track before `MediaRecorder` sees them) with a live transcript,
    for e.g. a meeting you're listening to through speakers while talking
    into your mic. It's one file/library entry, not two. The tab audio is
    *also* recorded in parallel as a separate, isolated (not mixed) track
    purely so its content can be transcribed later without your mic voice
    tangled in — see "Transcribe Tab Audio" below.
  - **Transcribe Tab Audio**: for a "Tab + Mic Simultaneously" recording,
    once the mic side has been captured live, a **"Transcribe Tab Audio"**
    button lets you fill in the other side too — it runs Whisper on the
    isolated tab-only audio (not the mixed track, so mic speech doesn't
    interfere) and merges the result into the same transcript, sorted by
    time, each line labeled **MIC** or **TAB** so you can tell them apart.
    The isolated tab audio is kept (not discarded) so you can re-run this
    with a different language later if the result isn't right — each run
    replaces only the TAB-labeled lines, leaving the mic side untouched.
    A "Remove Tab Lines" button deletes them all again if the result is
    useless, keeping the live MIC transcript intact.
  - **Which path is most accurate?** The live MIC transcript (Chrome's Web
    Speech API, server-backed) is markedly more accurate than the offline
    Whisper pass. The Web Speech API cannot be pointed at tab audio — it
    only ever listens to the default microphone, and no browser API can
    change that. So the most accurate setup for a call is to **listen
    through speakers rather than headphones**: your mic then physically
    hears the other side too, and the single live transcript covers the
    whole conversation. "Transcribe Tab Audio" exists for headphone users,
    and is a quality trade-off, not an upgrade.
- **Automatic transcription ("Transcribe Audio")**: for any recording
  without a transcript (tab/window recordings, or mic recordings where live
  transcription wasn't available), pick the spoken language from the
  dropdown and click "Transcribe Audio" to run
  [Whisper](https://github.com/openai/whisper) entirely in your browser via
  [Transformers.js](https://huggingface.co/docs/transformers.js) — audio
  never leaves your device. It runs in a Web Worker so the UI stays
  responsive. The first use downloads the model (~150MB, multilingual) from
  Hugging Face's CDN and caches it in the browser for offline reuse after
  that; every transcription after the first is fast and needs no network
  access. Only one recording can be transcribed at a time.
  - The language dropdown defaults to your browser's locale, but always
    picks a concrete language — never "auto-detect". Transformers.js doesn't
    reliably auto-detect the spoken language when none is given; it silently
    falls back to English, which is why non-English audio would otherwise
    come back transcribed as (garbled) English. Pick the language actually
    spoken in the recording before transcribing.
  - Accuracy depends heavily on audio quality and how many people are
    talking at once. A solo, clear microphone recording transcribes well;
    a multi-speaker voice-chat tab recording (Discord, a group call) with
    background game/notification sounds is much harder for the compact
    "tiny" model used here and can come out significantly less accurate.
    Swap `WHISPER_MODEL_ID` in `lib/transcription/types.ts` for a larger
    model (e.g. `"Xenova/whisper-base"`) for better accuracy on that kind
    of audio, at the cost of a bigger one-time download.
  - **Silence splitting.** Long pauses don't just get skipped by Whisper —
    they corrupt the whole result. Measured on a generated 80s clip with
    speech at 5s/40s/70s: the chunked pipeline returned a *single* segment
    stamped `[0 → 73]` whose text mashed the first two sentences together
    and dropped the third entirely. That is what makes a transcript appear
    to jump from, say, `0:07` straight to `0:33`. So before transcribing,
    the audio is scanned for speech regions
    (`lib/transcription/speechRegions.ts`); if speech covers less than 70%
    of the recording, each region is transcribed separately (one at a time —
    concurrent inference on a single ONNX session isn't safe) and its
    timestamps offset back onto the real timeline. Continuous speech is
    detected as such and takes the original single-pass path unchanged.
    A recording that is one burst of speech followed by a long quiet tail
    counts too: it gets trimmed to the speech rather than handing the model
    all that silence.
  - **Why a transcript can end before the recording does.** Whisper only
    emits lines where it hears speech, so a transcript legitimately stops
    early when the source went quiet — which is indistinguishable, from the
    outside, from the app losing content. To remove the guesswork, when the
    audible portion is more than 5s shorter than the clip the success
    message says so outright ("Only 22s of the 39s had audible sound, so the
    transcript ends earlier"). The opposite case — sound right through the
    clip but the model stopping early anyway, which is what music and singing
    tend to do — is called out separately, since it means the model lost the
    thread rather than running out of audio.
  - **Hallucination guards.** Given silence or near-silence, Whisper does
    not return nothing — it invents text, classically one word repeated for
    pages ("yang yang yang yang …"). The Whisper heuristics that normally
    suppress this (`no_speech_threshold`, `compression_ratio_threshold`,
    `logprob_threshold`) are *not* exposed by transformers.js, so the app
    adds its own: audio is level-checked before transcribing and rejected
    up front if silent (with a message pointing at the likely cause), quiet
    audio is gain-normalized first, generation runs with
    `no_repeat_ngram_size`/`repetition_penalty`, and any segment that still
    comes out degenerate is dropped (`lib/transcription/repetition.ts`).
- **Re-transcribe & Undo**: an auto-generated transcript isn't final — the
  "Transcribe Audio" (or "Transcribe Tab Audio") button stays available
  after a transcript exists, relabeled "Re-transcribe...", so you can pick
  a different language and try again if the first result was wrong. Right
  after a transcribe or manual-edit action, an "Undo" button appears to
  revert to whatever the transcript was immediately before that change —
  one level deep, cleared once used or once you make another change.
- **Copy Transcript**: once a recording has a transcript (live, auto-
  generated, or manual), a "Copy Transcript" button copies the full text to
  your clipboard — as readable lines carrying the same context the on-screen
  badges show, e.g. `[0:04] [Mic] halo halo oktavinus`. Consecutive lines
  from the same side are joined into one utterance so it reads as a
  conversation rather than a column of fragments. The copied text and the
  exported `transcript.txt` share one formatter
  (`lib/transcriptFormat.ts`), so they can't drift apart.
- **Storage**: recordings (audio blobs, metadata, transcripts) are stored in
  IndexedDB via the `idb` library, entirely inside your browser. Nothing is
  ever sent to a server. Data does **not** sync across browsers or devices —
  use Export/Import to move your library.
- **Export/Import**: recordings are bundled into `.zip` files (via `JSZip`)
  containing the audio file, `meta.json`, and `transcript.txt`. Export a
  single recording or your entire library, and import `.zip` files back in
  on any device using this app.

## Tech stack

- Next.js (App Router) + TypeScript
- Tailwind CSS
- `idb` for IndexedDB access
- `JSZip` for export/import
- `MediaRecorder`, `getDisplayMedia`, `getUserMedia`, and the Web Speech API
  (`SpeechRecognition`) — all client-side browser APIs, no server involved
- `@huggingface/transformers` (Transformers.js) running a quantization-free
  Whisper model in a Web Worker via WebAssembly, for on-demand automatic
  transcription — also entirely client-side, no server or API key involved
