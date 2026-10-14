/** Synthetic test music: kick on every beat (accented downbeats), hats on 8ths, quiet→loud sections. */
export function synthTrack(opts: { bpm: number; seconds: number; sr?: number; offset?: number; loudFrom?: number }) {
  const sr = opts.sr ?? 44100;
  const n = Math.round(opts.seconds * sr);
  const x = new Float32Array(n);
  const period = 60 / opts.bpm;
  const offset = opts.offset ?? 0.5;
  const beats: number[] = [];
  let k = 0;
  // deterministic noise
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let t = offset; t < opts.seconds - 0.05; t += period, k++) {
    beats.push(t);
    const loud = opts.loudFrom !== undefined && t >= opts.loudFrom ? 1 : 0.35;
    const acc = k % 4 === 0 ? 1 : 0.6;
    const s = Math.round(t * sr);
    for (let i = 0; i < sr * 0.15 && s + i < n; i++) {
      const f = 55 + 90 * Math.exp(-i / (sr * 0.02));
      x[s + i] += loud * acc * 0.8 * Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / (sr * 0.06));
    }
    for (const h of [0, period / 2]) {
      const hs = Math.round((t + h) * sr);
      for (let i = 0; i < sr * 0.03 && hs + i < n; i++) x[hs + i] += loud * 0.15 * rnd() * Math.exp(-i / (sr * 0.006));
    }
  }
  return { samples: x, sampleRate: sr, beats };
}
