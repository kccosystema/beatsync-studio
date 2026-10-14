/**
 * Main-thread orchestration of audio analysis.
 * Decoding uses the browser's native decoder (async, off the JS thread); all
 * signal processing runs in Web Workers.
 */
import type { BeatAnalysis } from "../types";
import type { ExternalBeats } from "./analyze";

export const ANALYSIS_SR = 44100;

export interface AnalysisProgress {
  progress: number;
  stage: string;
}

export async function decodeToMono(file: Blob): Promise<{ samples: Float32Array; duration: number; sampleRate: number }> {
  const data = await file.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } catch {
    throw new Error("This browser can't decode that audio file. Try MP3, WAV or M4A.");
  } finally {
    ctx.close();
  }
  const length = Math.ceil(decoded.duration * ANALYSIS_SR);
  const off = new OfflineAudioContext(1, length, ANALYSIS_SR);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return { samples: rendered.getChannelData(0).slice(), duration: decoded.duration, sampleRate: decoded.sampleRate };
}

function runEssentia(samples: Float32Array, timeoutMs: number): Promise<ExternalBeats | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker("/workers/essentia.worker.js");
    } catch {
      return resolve(null);
    }
    const done = (v: ExternalBeats | null) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(v);
    };
    const timer = setTimeout(() => {
      console.warn("[analysis] Essentia timed out; using built-in tracker");
      done(null);
    }, timeoutMs);
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "result") done({ bpm: m.bpm, beats: m.beats, confidence: m.confidence });
      else if (m.type === "error") {
        console.warn("[analysis] Essentia failed:", m.error);
        done(null);
      }
    };
    worker.onerror = (e) => {
      console.warn("[analysis] Essentia worker error:", e.message);
      done(null);
    };
    // Long tracks: Essentia's multifeature method is accurate but slow; degara is ~4x faster.
    const method = samples.length / ANALYSIS_SR > 420 ? "degara" : "multifeature";
    const copy = samples.slice();
    worker.postMessage({ samples: copy, method }, [copy.buffer]);
  });
}

function runAnalysis(
  samples: Float32Array,
  external: ExternalBeats | null,
  onProgress: (p: AnalysisProgress) => void,
): Promise<BeatAnalysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "progress") onProgress({ progress: m.progress, stage: m.stage });
      else if (m.type === "result") {
        worker.terminate();
        resolve(m.analysis);
      } else if (m.type === "error") {
        worker.terminate();
        reject(new Error(m.error));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Analysis worker crashed"));
    };
    worker.postMessage({ samples, sampleRate: ANALYSIS_SR, external }, [samples.buffer]);
  });
}

export async function analyzeFile(
  file: Blob,
  onProgress: (p: AnalysisProgress) => void,
): Promise<{ analysis: BeatAnalysis; sampleRate: number }> {
  onProgress({ progress: 0.02, stage: "Decoding audio" });
  const { samples, sampleRate } = await decodeToMono(file);
  onProgress({ progress: 0.1, stage: "Detecting beats (Essentia.js)" });
  const essentia = await runEssentia(samples, 180_000);
  const analysis = await runAnalysis(samples, essentia, (p) =>
    onProgress({ progress: 0.4 + p.progress * 0.6, stage: essentia ? p.stage : `${p.stage} (built-in tracker)` }),
  );
  return { analysis, sampleRate };
}
