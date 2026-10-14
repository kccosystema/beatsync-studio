import { it } from "vitest";
import { onsetEnvelope, meanStd } from "@/lib/audio/dsp";
import { beatEnvelope } from "@/lib/audio/analyze";
import { synthTrack } from "./synth";
it("dbg", () => {
  const { samples, sampleRate } = synthTrack({ bpm: 90, seconds: 30, offset: 0.25 });
  const o = onsetEnvelope(samples, sampleRate);
  for (const [name, env] of [["flux", o.flux], ["low", o.lowFlux], ["comb", beatEnvelope(o.flux, o.lowFlux)]] as const) {
    const n = env.length; const { mean } = meanStd(env);
    const ac = (lag: number) => { let s = 0; for (let i = 0; i + lag < n; i++) s += (env[i]-mean)*(env[i+lag]-mean); return s/(n-lag); };
    console.log(name, "180:", ac(29).toFixed(2), "90:", ac(57).toFixed(2), "45:", ac(115).toFixed(2));
  }
  // peak magnitudes
  let mx=0, mxl=0; for (let i=0;i<o.flux.length;i++){mx=Math.max(mx,o.flux[i]);mxl=Math.max(mxl,o.lowFlux[i]);}
  console.log("max flux", mx, "max low", mxl);
});
