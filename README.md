# BeatSync Studio

A browser-based automatic music-video editor. Drop in a song and a pile of clips/photos, pick a style, click **Generate Video** — the app detects the beats and energy of the song, builds an edit whose cuts, transitions and effects follow the music, previews it in sync, and renders a real MP4 with FFmpeg on your machine.

Everything runs locally: no accounts, no cloud services, no paid APIs.

## Quick start

Requirements: **Node.js 20+** and **FFmpeg** with `libx264` and `aac` on your `PATH`.

```bash
brew install ffmpeg        # macOS (Linux: apt install ffmpeg)
npm install
npm run dev                # http://localhost:3000
```

Production mode: `npm run build && npm start`.

Want something to try it with? `npm run samples` generates a royalty-free 64-second test song (quiet intro → build → drop → breakdown → drop), six video clips and two photos in `./samples`.

If FFmpeg lives elsewhere, set `FFMPEG_PATH` / `FFPROBE_PATH`. The export dialog checks the render worker and tells you if FFmpeg is missing.

## Using it

1. **Add a song** (MP3, WAV, M4A, AAC — anything your browser can decode). It's analysed in the background: BPM, beats, downbeats, energy, transients and energy sections appear in the media panel and on the timeline.
   **Song section:** *Trim song / find chorus* (music card or the timeline toolbar) picks the part of the song the video is cut to. Drag handles on the full-song waveform (snaps to bars), or take a suggestion: **Likely chorus** (a loud stretch that repeats elsewhere, found by chroma self-similarity across bars), **Best 15/30/60 seconds**, or any detected energy section. Audition the selection, set music fade-in/out, and the edit is rebuilt from that section. Preview and export both play exactly that range.
2. **Add clips and photos** (MP4, MOV, WebM, JPEG, PNG, WebP — up to 60). Drag files anywhere onto the window. Drag thumbnails to reorder.
3. The edit generates automatically once both are present. Change the **style preset**, **intensity**, **transition frequency**, **effect intensity**, **clip length**, **sync offset**, **half/double-time grid**, **clip order** or **seed** and it regenerates. **Regenerate Edit** rolls a new seed; the same seed + settings always yields the same edit.
4. **Fine-tune on the timeline:** click a clip to edit it, drag a clip to reorder (cuts re-snap to beats), drag a clip edge to move a cut (snaps to beats; hold **Alt** for free trimming), slip the source in-point, change the transition, toggle effects, duplicate or delete. Undo/redo covers everything.
   **Effects** (per clip, from the Effects tab or the clip panel):
   - *Motion:* Slow Zoom In/Out, Zoom Pulse, Camera Shake
   - *Look:* Flash, Strobe, Black Fade, RGB Split, Hue Cycle, Split Screen, Prism, Distortion, Mono
   - *Time* (one per clip): Slow-Mo, Speed Up, Boomerang, Jump Cut, Fast Cut — these remap which source frame plays when; the export renders them exactly, the preview approximates reverse playback by seeking. Time-remapped clips contribute silence when "Keep original clip audio" is on.
   `npm run fx-sheet` renders every effect on the sample footage into `effects-sheet.jpg`.
5. **Export:** 720p or 1080p, 24/30/60 fps, in 16:9, 9:16 or 1:1, with optional original clip audio mixed under the song.
6. **Save** stores the whole project — including the media files — in the browser (IndexedDB). **Projects** reopens or deletes saved projects.

Keyboard: `Space` play/pause · `←/→` previous/next beat · `Home` start · `⌘Z / ⇧⌘Z` undo/redo · `⌘S` save · `⌘D` duplicate clip · `Delete` remove clip · `Esc` deselect/close.

## How it works

```
 song ──► decode (WebAudio) ──► Essentia.js worker ──► beats/BPM ─┐
                              └► analysis worker: onsets, energy, downbeats, sections ─► BeatAnalysis
 clips ─► probe + thumbnails + motion score ─────────────────────────────────────────► MediaItem[]
                                         │
            editing engine (deterministic, seeded) ──► Timeline (edit decision list, integer µs)
                                         │
          ┌──────────────────────────────┼──────────────────────────────┐
     timeline UI                 canvas preview                   export planner
  (roll / slip / move)   (audio = master clock, same          (frame-exact pieces →
                          effect curves as export)              FFmpeg on local Node worker)
```

| Module | Path |
| --- | --- |
| Data model (all times in integer microseconds) | `src/lib/types.ts`, `src/lib/time.ts` |
| Audio analysis engine + beat detection | `src/lib/audio/` (`dsp.ts`, `beatTracker.ts`, `analyze.ts`, workers in `analysis.worker.ts` and `public/workers/essentia.worker.js`) |
| Media manager | `src/lib/media/import.ts` |
| Automatic editing engine + presets | `src/lib/engine/generate.ts`, `presets.ts` |
| Effects engine (shared by preview + export) | `src/lib/engine/effects.ts`, `transitions.ts` |
| Timeline editor operations | `src/lib/timeline/ops.ts` |
| Preview renderer | `src/lib/preview/compositor.ts` |
| Export engine | `src/lib/export/plan.ts` (planner), `src/server/render.ts` (FFmpeg worker), `src/app/api/*` |
| Project persistence | `src/lib/persist/db.ts` |
| State | `src/store/studio.ts` (Zustand) |
| UI | `src/components/` |

### Audio analysis
- **Beats/BPM:** Essentia.js `RhythmExtractor2013` (multifeature; degara for tracks > 7 min) in a Web Worker. If Essentia can't load, a built-in tracker takes over: spectral-flux onset envelope with low-band emphasis → tempo by autocorrelation with a tempo prior → dynamic-programming beat tracking (Ellis 2007).
- **Downbeats:** the bar phase whose beats carry the most kick-band onset energy. Marked *estimated (low confidence)* when no phase clearly wins — the grid still works, the UI just says so.
- **Energy / transients / sections:** loudness envelope (400 ms RMS), peak-picked onsets, and novelty-based segmentation on bar lines. Sections are labelled by **energy behaviour** (intro, low, mid, build, drop, breakdown, outro) — the app does not pretend to know which part is the verse or chorus.

### The editing engine
Walks the beat grid choosing clip lengths of 1/2/4/8/16 beats from the preset's rules for the current energy class, biased by intensity; snaps longer clips to bar lines; forces a cut on every section change; accelerates cutting through build-ups; hits drops with a hard cut + flash/zoom-pulse/shake. Media is assigned sequentially or shuffled (shuffle prefers high-motion clips for high-energy sections), with source in-points leaving room for transition handles. Every random decision comes from one seeded PRNG.

### Preview ↔ export parity
Effects are defined once as functions of clip-local time (`effects.ts`). The preview evaluates them in JS on a Canvas 2D compositor; the export compiles the *same* definitions into FFmpeg expressions (`zoompan`, `eq`, `rgbashift`, `noise`, `xfade`). A unit test evaluates both and asserts they match.

### Export
The timeline is cut into frame-exact **pieces** (clip bodies + transition windows) that tile the output. Each piece is rendered straight from the source media with its effects and an exact frame count, in parallel; transition pieces blend both neighbouring clips with `xfade`. Pieces are joined with the concat demuxer (stream copy, no re-encode) and muxed with the song trimmed to exactly `frames / fps`. Progress is the real count of frames FFmpeg has encoded; cancel kills the FFmpeg processes.

On an Apple-silicon laptop the 64-second sample renders in ~13 s at 720p30, ~22 s at 1080p30 and ~32 s at 1080p60.

## Tests

```bash
npm test          # unit: beat detection on synthetic tracks, timeline generation, clip boundaries,
                  #       export frame maths, preview/export effect parity (53 tests)
npm run test:e2e  # end-to-end: synthetic song + clips → analysis → edit → real FFmpeg renders (720p24/30,
                  #   1080p60 9:16), verifies codecs, size, exact frame count, A/V duration, that every hard
                  #   cut is detected within one frame of its beat, and that cancel works
npm run lint && npm run typecheck
```

## Limitations & notes
- **Browser codec support** decides what can be imported: HEVC `.mov` files from iPhones won't play in Chrome/Firefox on every OS. Unsupported files are rejected with a message instead of failing later.
- **Preview** uses Canvas 2D at ~960 px. Heavy effects (RGB split) are approximations of the FFmpeg filters; timing, zooms, shake, flashes and transitions match the export.
- **Downbeat and section detection** are heuristic; the app reports confidence rather than inventing labels. Use **Sync offset**, **half/double-time** and beat-snapped trimming to correct the grid.
- **Uploads for export** are copied to `.beatsync-data/` next to the app (the local render worker's cache; entries unused for 14 days are removed). Exports are kept for 3 hours.
- Max 60 media items per project (a 32-clip import + edit + export was tested in the browser).
- **Licensing:** Essentia.js is AGPL-3.0. That's fine for local/personal use; distributing this app publicly means complying with the AGPL (or swapping in the built-in tracker, which is already wired as the fallback).
