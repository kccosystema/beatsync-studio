/* Classic worker: runs Essentia.js (WASM) RhythmExtractor2013 off the main thread.
 * The UMD WASM build assigns to `exports`, so provide one before loading. */
self.exports = {};
let essentia = null;

async function init() {
  if (essentia) return essentia;
  importScripts("/workers/essentia-wasm.umd.js", "/workers/essentia.js-core.umd.js");
  const Module = self.exports.EssentiaWASM;
  if (!Module) throw new Error("Essentia WASM module did not load");
  if (!Module.calledRun) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Essentia WASM init timed out")), 30000);
      const prev = Module.onRuntimeInitialized;
      Module.onRuntimeInitialized = () => { clearTimeout(t); if (prev) prev(); resolve(); };
    });
  }
  essentia = new self.Essentia(Module);
  return essentia;
}

self.onmessage = async (e) => {
  const { samples, method } = e.data;
  try {
    const ess = await init();
    self.postMessage({ type: "status", version: ess.version });
    const vec = ess.arrayToVector(samples);
    const r = ess.RhythmExtractor2013(vec, 208, method || "multifeature", 40);
    const ticks = Array.from(ess.vectorToArray(r.ticks));
    if (vec.delete) vec.delete();
    self.postMessage({ type: "result", bpm: r.bpm, beats: ticks, confidence: r.confidence });
  } catch (err) {
    self.postMessage({ type: "error", error: String((err && err.message) || err) });
  }
};
