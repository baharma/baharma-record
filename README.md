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
  - **Tab/window recordings** are audio-only while recording. From the
    recording's detail view, you can either click **"Transcribe Audio"** to
    generate a transcript automatically (see below), or add/edit one
    manually.
  - Use "Tab + Mic Simultaneously" to mix tab audio and your microphone into
    a **single** recording (via the Web Audio API — both streams are summed
    into one track before `MediaRecorder` sees them) with a live transcript,
    for e.g. a meeting you're listening to through speakers while talking
    into your mic. It's one file/library entry, not two.
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
- **Copy Transcript**: once a recording has a transcript (live, auto-
  generated, or manual), a "Copy Transcript" button copies the full text to
  your clipboard.
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
