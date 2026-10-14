import { describe, expect, it } from "vitest";
import { generateTimeline } from "@/lib/engine/generate";
import { planRender } from "@/lib/export/plan";
import { clipFx, flashAt, flashExpr, shakeAt, shakeExpr, zoomAt, zoomExpr } from "@/lib/engine/effects";
import { frameAt } from "@/lib/time";
import type { TimelineClip } from "@/lib/types";
import { fakeAnalysis, fakeMedia, settings } from "./fixtures";

/** Evaluate an FFmpeg expression with the same semantics in JS. */
function evalFfmpeg(expr: string, vars: Record<string, number>): number {
  const helpers = { gte: (a: number, b: number) => (a >= b ? 1 : 0), exp: Math.exp, sin: Math.sin, cos: Math.cos, min: Math.min, max: Math.max, PI: Math.PI };
  const names = [...Object.keys(helpers), ...Object.keys(vars)];
  return new Function(...names, `return (${expr});`)(...Object.values(helpers), ...Object.values(vars));
}

const clip: TimelineClip = {
  id: "c", mediaId: "m", srcIn: 0, start: 2_000_000, end: 6_000_000, transitionIn: { type: "cut", duration: 0 },
  pulses: [0, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000],
  effects: [{ type: "zoomIn", intensity: 0.7 }, { type: "zoomPulse", intensity: 0.8 }, { type: "shake", intensity: 0.6 }, { type: "flash", intensity: 0.9 }, { type: "strobe", intensity: 0.5 }],
};

describe("effects: preview curves == export expressions", () => {
  const f = clipFx(clip);
  for (const tau of [-0.2, 0, 0.01, 0.37, 0.5, 1.234, 2.0, 3.99]) {
    it(`agree at τ=${tau}`, () => {
      expect(evalFfmpeg(zoomExpr(f, "T"), { T: tau })).toBeCloseTo(zoomAt(f, tau), 6);
      expect(evalFfmpeg(flashExpr(f, "T"), { T: tau })).toBeCloseTo(flashAt(f, tau), 6);
      const s = shakeExpr(f, "T"), j = shakeAt(f, tau);
      expect(evalFfmpeg(s.dx, { T: tau })).toBeCloseTo(j.dx, 6);
      expect(evalFfmpeg(s.dy, { T: tau })).toBeCloseTo(j.dy, 6);
    });
  }
  it("shake never exceeds the zoom margin (no black borders)", () => {
    for (let tau = 0; tau < 4; tau += 0.01) {
      const z = zoomAt(f, tau), s = shakeAt(f, tau);
      expect(Math.abs(s.dx)).toBeLessThanOrEqual((z - 1) / 2 + 1e-9);
      expect(Math.abs(s.dy)).toBeLessThanOrEqual((z - 1) / 2 + 1e-9);
    }
  });
});

describe("export planning", () => {
  const analysis = fakeAnalysis({ bpm: 128, seconds: 47.3 });
  const media = fakeMedia();
  for (const fps of [24, 30, 60] as const) {
    it(`${fps} fps: pieces tile the output frame-exactly with no drift`, () => {
      const { timeline } = generateTimeline({ analysis, media, settings: settings({ transitionFrequency: 80, preset: "cinematic" }) });
      const plan = planRender({ timeline, media, aspect: "16:9", export: { resolution: 720, fps } });
      expect(plan.totalFrames).toBe(frameAt(analysis.duration, fps));
      expect(plan.width).toBe(1280);
      // pieces tile [0, totalFrames) with no gaps/overlaps
      let f = 0;
      for (const p of plan.pieces) {
        expect(p.frameStart).toBe(f);
        expect(p.frameCount).toBeGreaterThan(0);
        f += p.frameCount;
      }
      expect(f).toBe(plan.totalFrames);
      // clip spans tile too, and every cut lands within half a frame of its timeline time
      let g = 0;
      plan.clips.forEach((c, i) => {
        expect(c.frameStart).toBe(g);
        g += c.frameCount;
        expect(Math.abs(c.frameStart / fps - timeline.clips[i].start / 1e6)).toBeLessThanOrEqual(0.5 / fps + 1e-9);
      });
      expect(g).toBe(plan.totalFrames);
      // transition pieces are centred on their cut; hard cuts sit exactly between two bodies
      const transitions = plan.pieces.filter((p) => p.kind === "transition");
      expect(transitions.length).toBeGreaterThan(0);
      for (const p of transitions) {
        const k = p.sides[1].clipIndex;
        expect(p.sides[0].clipIndex).toBe(k - 1);
        expect(p.frameStart).toBe(plan.cutFrames[k] - Math.floor(plan.transitionFrames[k] / 2));
        expect(p.frameCount).toBe(plan.transitionFrames[k]);
        expect(p.filter).toContain("xfade=transition=");
      }
      // every clip keeps at least one body frame
      expect(plan.pieces.filter((p) => p.kind === "body").length).toBe(timeline.clips.length);
    });
  }

  it("clamps transitions that would swallow a clip", () => {
    const { timeline } = generateTimeline({ analysis, media, settings: settings() });
    const tl = { ...timeline, clips: timeline.clips.map((c, i) => (i > 0 ? { ...c, transitionIn: { type: "fade" as const, duration: 10_000_000 } } : c)) };
    const plan = planRender({ timeline: tl, media, aspect: "16:9", export: { resolution: 720, fps: 30 } });
    for (const p of plan.pieces) expect(p.frameCount).toBeGreaterThan(0);
    expect(plan.pieces.reduce((a, p) => a + p.frameCount, 0)).toBe(plan.totalFrames);
  });

  it("applies the timeline fades in absolute time", () => {
    const { timeline } = generateTimeline({ analysis, media, settings: settings({ preset: "cinematic" }) });
    const plan = planRender({ timeline, media, aspect: "16:9", export: { resolution: 720, fps: 30 } });
    expect(plan.pieces[0].filter).toContain("brightness='-(");
    const mid = plan.pieces[Math.floor(plan.pieces.length / 2)];
    expect(mid.filter).toContain("max(0,1-"); // expression present but evaluates to 0 mid-song
  });

  it("output sizes per aspect", () => {
    const { timeline } = generateTimeline({ analysis, media, settings: settings() });
    const s = (aspect: any, resolution: any) => { const p = planRender({ timeline, media, aspect, export: { resolution, fps: 30 } }); return `${p.width}x${p.height}`; };
    expect(s("16:9", 1080)).toBe("1920x1080");
    expect(s("9:16", 1080)).toBe("1080x1920");
    expect(s("1:1", 720)).toBe("720x720");
    expect(s("9:16", 720)).toBe("720x1280");
  });

  it("pads the start when a transition handle precedes the source", () => {
    const { timeline } = generateTimeline({ analysis, media, settings: settings() });
    const tl = { ...timeline, clips: timeline.clips.map((c, i) => (i === 2 ? { ...c, srcIn: 0, transitionIn: { type: "fade" as const, duration: 400_000 } } : c)) };
    const mediaV = media.map((m) => ({ ...m, kind: "video" as const, duration: 20e6 }));
    const plan = planRender({ timeline: tl, media: mediaV, aspect: "16:9", export: { resolution: 720, fps: 30 } });
    const t = plan.pieces.find((p) => p.kind === "transition" && p.sides[1].clipIndex === 2)!;
    expect(t.sides[1].inputs[0].padStart).toBe(6);
    expect(t.filter).toContain("tpad=start=6");
  });
});
