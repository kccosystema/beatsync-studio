/**
 * Small, dependency-free DSP toolkit used by the analysis worker and tests.
 * Everything operates on mono Float32 PCM.
 */

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export interface OnsetFeatures {
  /** Full-band log spectral flux (half-wave rectified), one value per hop. */
  flux: Float32Array;
  /** Low-band (< ~150 Hz) spectral flux — kick drums, used for downbeats. */
  lowFlux: Float32Array;
  /** Frame rate of the envelopes in Hz. */
  frameRate: number;
  hop: number;
  /**
   * Seconds to ADD to `frame / frameRate` to get the true onset time. An STFT
   * frame "sees" an attack before its start time, so envelopes lead the audio.
   */
  latency: number;
  /** 12-bin pitch-class energy per frame (frame-major, 12 values each). */
  chroma: Float32Array;
}

/** Spectral-flux onset envelopes via STFT (Hann window). */
export function onsetEnvelope(
  x: Float32Array,
  sampleRate: number,
  frameSize = 2048,
  hop = 512,
): OnsetFeatures {
  const nFrames = Math.max(1, Math.floor((x.length - frameSize) / hop) + 1);
  const bins = frameSize / 2;
  const win = new Float32Array(frameSize);
  for (let i = 0; i < frameSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frameSize);
  const lowBin = Math.max(2, Math.round((150 * frameSize) / sampleRate));
  // Hann coherent gain is 0.5, so a full-scale sinusoid peaks at frameSize/4.
  const norm = 4 / frameSize;
  const re = new Float32Array(frameSize);
  const im = new Float32Array(frameSize);
  let prev = new Float32Array(bins);
  let cur = new Float32Array(bins);
  const flux = new Float32Array(nFrames);
  const lowFlux = new Float32Array(nFrames);
  // Pitch class for each bin between ~55 Hz and 5 kHz (-1 = ignored).
  const pcOf = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = (k * sampleRate) / frameSize;
    if (f < 55 || f > 5000) continue;
    pcOf[k] = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
  }
  const chroma = new Float32Array(nFrames * 12);
  for (let f = 0; f < nFrames; f++) {
    const off = f * hop;
    for (let i = 0; i < frameSize; i++) {
      re[i] = (x[off + i] ?? 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let s = 0, sl = 0;
    for (let k = 1; k < bins; k++) {
      const lin = norm * Math.hypot(re[k], im[k]);
      const mag = Math.log1p(100 * lin);
      cur[k] = mag;
      const pc = pcOf[k];
      if (pc >= 0) chroma[f * 12 + pc] += lin * lin;
      const d = mag - prev[k];
      if (d > 0) {
        s += d;
        if (k <= lowBin) sl += d;
      }
    }
    flux[f] = f === 0 ? 0 : s;
    lowFlux[f] = f === 0 ? 0 : sl;
    const t = prev; prev = cur; cur = t;
  }
  return { flux, lowFlux, frameRate: sampleRate / hop, hop, latency: (frameSize * 0.75) / sampleRate, chroma };
}

/**
 * Loudness envelope: RMS over a centred `window` (samples), one value per
 * `hop` samples, in dB. A window of a few hundred ms tracks perceived
 * loudness instead of individual drum hits.
 */
export function rmsDb(x: Float32Array, hop: number, window = hop): Float32Array {
  const n = Math.max(1, Math.ceil(x.length / hop));
  // prefix sum of squares for O(1) windows
  const pre = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) pre[i + 1] = pre[i] + x[i] * x[i];
  const out = new Float32Array(n);
  const half = Math.floor(window / 2);
  for (let f = 0; f < n; f++) {
    const c = f * hop + Math.floor(hop / 2);
    const a = Math.max(0, c - half), b = Math.min(x.length, c + half);
    const rms = Math.sqrt((pre[b] - pre[a]) / Math.max(1, b - a));
    out[f] = 20 * Math.log10(rms + 1e-9);
  }
  return out;
}

/** Max-abs peaks for waveform display. */
export function waveformPeaks(x: Float32Array, sampleRate: number, perSecond: number): number[] {
  const bucket = Math.max(1, Math.round(sampleRate / perSecond));
  const n = Math.ceil(x.length / bucket);
  const out = new Array<number>(n);
  let globalMax = 1e-9;
  for (let b = 0; b < n; b++) {
    let m = 0;
    const end = Math.min(x.length, (b + 1) * bucket);
    for (let i = b * bucket; i < end; i++) {
      const v = x[i] < 0 ? -x[i] : x[i];
      if (v > m) m = v;
    }
    out[b] = m;
    if (m > globalMax) globalMax = m;
  }
  for (let b = 0; b < n; b++) out[b] = Math.round((out[b] / globalMax) * 1000) / 1000;
  return out;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const a = Array.from(values).sort((x, y) => x - y);
  if (!a.length) return 0;
  const idx = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[idx];
}

export function movingAverage(x: ArrayLike<number>, radius: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  let s = 0, c = 0;
  // sliding window [i-radius, i+radius]
  for (let i = 0; i < Math.min(n, radius); i++) { s += x[i]; c++; }
  for (let i = 0; i < n; i++) {
    const add = i + radius;
    if (add < n) { s += x[add]; c++; }
    const rem = i - radius - 1;
    if (rem >= 0) { s -= x[rem]; c--; }
    out[i] = s / c;
  }
  return out;
}

export function meanStd(x: ArrayLike<number>): { mean: number; std: number } {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  const mean = s / Math.max(1, x.length);
  let v = 0;
  for (let i = 0; i < x.length; i++) v += (x[i] - mean) ** 2;
  return { mean, std: Math.sqrt(v / Math.max(1, x.length)) };
}
