<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Baharma Record

100% client-side Next.js 16 (App Router) + TypeScript + Tailwind 4 app: records audio/video from multiple browser sources (tabs, screen, mic) simultaneously, with live and batch transcription (local Whisper worker, Deepgram, OpenAI-compatible cloud APIs). No backend, no API routes, no server state — recordings/transcripts/settings live entirely in the browser's IndexedDB. **Desktop Chrome only** (relies on `getDisplayMedia` + Web Speech API).

Deep-dive docs: [CLAUDE.md](./CLAUDE.md) (architecture, pipelines, measured rationale behind non-obvious code) and [README.md](./README.md) (feature behavior). Read CLAUDE.md before touching the recording or transcription pipelines.

## Commands

```bash
npm run dev        # Turbopack dev server on localhost:3000
npm run build      # next build --webpack — NEVER remove the flag (see below)
npm start          # serve the production build
npm run lint       # eslint
npx tsc --noEmit   # typecheck (no script defined; no test suite exists)
```

**`build` must stay pinned to `--webpack`.** Turbopack (as of Next.js 16.3) mis-bundles the `new Worker(new URL(...))` transcription-worker pattern in production — copies raw un-transpiled `.ts` as a static asset. `next dev` (Turbopack) is unaffected. `next.config.ts` also sets `output: "export"`, so build output additionally lands in `./out` as a static site.

## Layout & layer rules

- `app/` — one Server Component page + layout/globals. `components/` — all `"use client"` UI. `hooks/` — session/store/transcriber logic. `lib/` — pure-ish helpers. `lib/transcription/` — Whisper worker + guards. `types/` — ambient declarations. Path alias `@/*` → repo root.
- **Client-only boundary:** `app/page.tsx` (Server) renders `AppClientLoader`, a `"use client"` wrapper that `next/dynamic`s `AppClient` with `ssr: false` (calling `ssr: false` from a Server Component throws). Keep this two-file split; never import browser-only APIs above it.
- **IndexedDB access only via `hooks/useRecordingsStore.ts`** → `lib/db.ts` (thin `idb` wrapper). Data model in `lib/types.ts` (`RecordingEntry`, `PendingSession`).
- **Transcript text output** (Copy Transcript button, exported `transcript.txt`) must share `lib/transcriptFormat.ts` — the single formatter.
- **API keys** (Deepgram, OpenAI/Groq/custom, HF) go through `lib/localStorage.ts` guarded wrappers; keys defined in `lib/transcription/cloudProviders.ts` / `deepgramLive.ts`. `SettingsModal` is a convenience UI over the same state, not a separate source of truth — three places (both modals + Settings) read/write the same keys.
- **Browser feature detection** is centralized in `lib/browserSupport.ts`; `BrowserWarningBanner` consumes it.

## Gotchas that already bit once — don't undo

- **React Strict Mode traps in `hooks/useRecordingSession.ts`** (see its inline comments): effect cleanup must never stop hardware tracks (only the exposed `stop()` may), and every recorder/recognition callback guards "is this still the current instance". `SpeechRecognition` restarts must create a fresh instance on a delay — `.start()` from `onend` throws `InvalidStateError`. Finalization waits for all stopped gates (`tryFinalize`), since `MediaRecorder.stop()`/`SpeechRecognition.stop()` finish asynchronously.
- **Web Speech API types** aren't in TS's `dom` lib — extend `types/speech-recognition.d.ts`, don't cast locally.
- **`RecordingEntry.hasVideo`** is `undefined` on pre-existing records despite the `boolean` type — always read via `Boolean(entry.hasVideo)`.
- **Whisper runs at `dtype: "fp32"`** — quantized/fp16 hits an onnxruntime-web bug (see `WHISPER_MODELS` comment in `lib/transcription/types.ts` before upgrading the dependency). Batch path is wasm-only; live path tries WebGPU first.
- **Hallucination/coverage guards are load-bearing**: speech-region splitting (`speechRegions.ts`), repetition + non-speech screening (`repetition.ts`, `hallucination.ts`), and the gap sweep (`coverage.ts`) each fix a measured Whisper failure transformers.js doesn't expose heuristics for. The live path additionally gates windows on adaptive VAD (`liveVad.ts`) — its thresholds are noise-floor-relative on purpose (tab audio has music beds); don't swap in absolute ones.
- **Concurrent inference on one ONNX session isn't safe** — transcribe regions/windows sequentially, never `Promise.all`.
- **macOS second `getDisplayMedia`** rejects with `NotReadableError`; `lib/mediaAcquisition.ts` special-cases the message. Don't fold it back into the generic wording.
- Recordings can exceed an hour: audio is decoded straight into a 16kHz `OfflineAudioContext` (`lib/audioDecode.ts`) and the worker reports progress per window — don't "simplify" these without re-reading CLAUDE.md.
- Leave-page-mid-recording is guarded by history sentinel + `beforeunload` + a synchronous `pagehide` snapshot (fixed per-session `entryId` overwrites rather than duplicates). See CLAUDE.md before refactoring session lifecycle.
