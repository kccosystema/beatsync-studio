/// <reference lib="webworker" />
import { analyzeAudio, type ExternalBeats } from "./analyze";

interface Req {
  samples: Float32Array;
  sampleRate: number;
  external: ExternalBeats | null;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { samples, sampleRate, external } = e.data;
  try {
    const analysis = analyzeAudio(samples, sampleRate, {
      external,
      onProgress: (progress, stage) => self.postMessage({ type: "progress", progress, stage }),
    });
    self.postMessage({ type: "result", analysis });
  } catch (err) {
    self.postMessage({ type: "error", error: err instanceof Error ? err.message : String(err) });
  }
};
