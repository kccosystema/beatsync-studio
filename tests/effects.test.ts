import { describe, expect, it } from "vitest";
import { blackFadeAt, blackFadeExpr, clipFx, hueAt, hueExpr, sourceSpan, sourceTimeAt, timeMap } from "@/lib/engine/effects";
import { planRender } from "@/lib/export/plan";
import { generateTimeline } from "@/lib/engine/generate";
import { setEffect } from "@/lib/timeline/ops";
import type { EffectType, TimelineClip } from "@/lib/types";
import { fakeAnalysis, fakeMedia, settings } from "./fixtures";

const evalF = (expr: string, T: number) =>
  new Function("gte", "exp", "min", "max", "T", `return (${expr});`)((a: number, b: number) => (a >= b ? 1 : 0), Math.exp, Math.min, Math.max, T);

const base: TimelineClip = {
  id: "clip-x", mediaId: "m0", srcIn: 2_000_000, start: 10_000_000, end: 14_000_000,
  transitionIn: { type: "cut", duration: 0 }, pulses: [0, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000], effects: [],
};
const withFx = (type: EffectType, intensity = 0.8): TimelineClip => ({ ...base, effects: [{ type, intensity }] });
const video = { kind: "video" as const, duration: 20_000_000 };

describe("new look effects: preview == export", () => {
  for (const tau of [0, 0.05, 0.3, 1.7, 3.9, 4]) {
    it(`hue + black fade agree at τ=${tau}`, () => {
      const f = clipFx({ ...base, effects: [{ type: "hue", intensity: 0.6 }, { type: "blackFade", intensity: 0.7 }] });
      expect(evalF(hueExpr(f, "T"), tau)).toBeCloseTo(hueAt(f, tau), 6);
      expect(evalF(blackFadeExpr(f, "T"), tau)).toBeCloseTo(blackFadeAt(f, tau), 6);
    });
  }
  it("black fade is black at both clip edges and clear in the middle", () => {
    const f = clipFx(withFx("blackFade"));
    expect(blackFadeAt(f, 0)).toBe(1);
    expect(blackFadeAt(f, 4)).toBe(1);
    expect(blackFadeAt(f, 2)).toBe(0);
  });
});

describe("time effects (time map)", () => {
  it("normal clips play 1:1 from the in-point", () => {
    const m = timeMap(base, video);
    expect(sourceTimeAt(m, 0)).toBeCloseTo(2);
    expect(sourceTimeAt(m, 1.5)).toBeCloseTo(3.5);
  });
  it("slow-mo and speed change the rate and footage consumed", () => {
    const slow = timeMap(withFx("slowMo", 1), video);
    const fast = timeMap(withFx("speed", 1), video);
    expect(sourceTimeAt(slow, 4)).toBeCloseTo(2 + 4 * 0.25);
    expect(sourceTimeAt(fast, 4)).toBeCloseTo(2 + 4 * 3);
    expect(sourceSpan(fast, 4)).toBeCloseTo(12);
  });
  it("boomerang goes forward then back to the start", () => {
    const m = timeMap(withFx("boomerang"), video);
    expect(sourceTimeAt(m, 2)).toBeCloseTo(4);
    expect(sourceTimeAt(m, 3)).toBeCloseTo(3);
    expect(sourceTimeAt(m, 3.99)).toBeCloseTo(2.01);
  });
  it("jump cut skips forward on every beat", () => {
    const m = timeMap(withFx("jumpCut", 0.5), video);
    const before = sourceTimeAt(m, 0.499), after = sourceTimeAt(m, 0.5);
    expect(after - before).toBeGreaterThan(0.4); // skip = beat * (0.5 + a) = 0.5s
    for (let i = 1; i < m.length; i++) expect(m[i].rate).toBe(1);
  });
  it("fast cut jumps around the clip deterministically, staying inside the media", () => {
    const a = timeMap(withFx("fastCut", 0.8), video);
    const b = timeMap(withFx("fastCut", 0.8), video);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(8); // quarter... half-beat cuts in a 4 s clip
    for (let t = 0; t < 4; t += 0.05) {
      const s = sourceTimeAt(a, t);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(20);
    }
  });
  it("photos ignore time effects", () => {
    expect(timeMap(withFx("speed"), { kind: "image", duration: 0 })).toHaveLength(1);
  });
});

describe("effect exclusivity", () => {
  it("only one time effect and one layout effect per clip", () => {
    const tl = { clips: [base], duration: 4e6, fadeIn: 0, fadeOut: 0 };
    let t = setEffect(tl, 0, "slowMo", 0.5);
    t = setEffect(t, 0, "boomerang", 1);
    t = setEffect(t, 0, "split", 0.6);
    t = setEffect(t, 0, "prism", 0.6);
    t = setEffect(t, 0, "rgb", 0.6);
    expect(t.clips[0].effects.map((e) => e.type).sort()).toEqual(["boomerang", "prism", "rgb"]);
  });
});

describe("export plan with every new effect", () => {
  const analysis = fakeAnalysis({ seconds: 90, dropAt: 30 });
  const media = fakeMedia(5, 20);
  const { timeline } = generateTimeline({ analysis, media, settings: settings({ transitionFrequency: 70, seed: 9 }) });
  const types: EffectType[] = ["slowMo", "speed", "boomerang", "jumpCut", "fastCut", "rgb", "hue", "blackFade", "split", "prism"];
  expect(timeline.clips.length).toBeGreaterThanOrEqual(10);
  const tl = { ...timeline, clips: timeline.clips.map((c, i) => ({ ...c, effects: [{ type: types[i % types.length], intensity: 0.8 }] })) };
  for (const fps of [24, 60] as const) {
    it(`${fps} fps: sub-inputs add up to exactly each piece's frames`, () => {
      const plan = planRender({ timeline: tl, media, aspect: "16:9", export: { resolution: 720, fps } });
      expect(plan.pieces.reduce((a, p) => a + p.frameCount, 0)).toBe(plan.totalFrames);
      for (const p of plan.pieces) for (const sd of p.sides) {
        expect(sd.inputs.reduce((a, i) => a + i.frames, 0)).toBe(p.frameCount);
        for (const i of sd.inputs) expect(i.srcStart).toBeGreaterThanOrEqual(0);
      }
      const all = plan.pieces.map((p) => p.filter).join("\n");
      expect(all).toContain("reverse"); // boomerang
      expect(all).toContain("hstack=inputs=3"); // split
      expect(all).toContain("vstack"); // prism
      expect(all).toContain("hue=h=");
      expect(all).toContain("rgbashift");
      expect(plan.clips.some((c) => c.remapped)).toBe(true);
    });
  }
});

describe("project-level effect switches", () => {
  const analysis = fakeAnalysis();
  const media = fakeMedia(6, 20);
  const used = (disabledEffects: EffectType[]) =>
    new Set(generateTimeline({ analysis, media, settings: settings({ preset: "edm", effectIntensity: 100, disabledEffects }) }).timeline.clips.flatMap((c) => c.effects.map((e) => e.type)));

  it("the auto-editor never uses a switched-off effect", () => {
    const all = used([]);
    expect(all.has("flash")).toBe(true);
    expect(all.has("zoomPulse")).toBe(true);
    const off: EffectType[] = ["flash", "zoomPulse", "rgb", "strobe"];
    const some = used(off);
    for (const t of off) expect(some.has(t)).toBe(false);
    expect(some.size).toBeGreaterThan(0);
  });

  it("all off gives a clean edit with no effects at all", () => {
    expect(used(["zoomIn", "zoomOut", "zoomPulse", "shake", "flash", "strobe", "blackFade", "rgb", "hue", "split", "prism", "distort", "mono", "slowMo", "speed", "boomerang", "jumpCut", "fastCut"]).size).toBe(0);
  });

  it("switching an effect off strips it from an edited timeline", async () => {
    const { stripEffects } = await import("@/lib/timeline/ops");
    const { timeline } = generateTimeline({ analysis, media, settings: settings({ preset: "edm" }) });
    const t = stripEffects(timeline, ["flash"]);
    expect(t.clips.some((c) => c.effects.some((e) => e.type === "flash"))).toBe(false);
    expect(t.clips.length).toBe(timeline.clips.length);
    expect(stripEffects(t, ["flash"])).toBe(t); // no-op returns same object (no extra undo step)
  });
});

describe("framing (manual reposition)", () => {
  it("preview rect matches the export's scale+crop maths", async () => {
    const { framedRect } = await import("@/lib/engine/effects");
    // 16:9 source into a 9:16 frame
    const srcW = 1920, srcH = 1080, outW = 1080, outH = 1920;
    for (const fr of [{ x: -1, y: 0, scale: 1 }, { x: 0, y: 0, scale: 1 }, { x: 1, y: 0, scale: 1 }, { x: 0.3, y: -0.6, scale: 2 }]) {
      const r = framedRect(srcW, srcH, outW, outH, fr);
      // FFmpeg: scale to cover(outW*scale, outH*scale) → crop outW×outH at (iw-ow)/2*(1+x)
      const k = Math.max((outW * fr.scale) / srcW, (outH * fr.scale) / srcH);
      const iw = srcW * k, ih = srcH * k;
      const cx = ((iw - outW) / 2) * (1 + fr.x), cy = ((ih - outH) / 2) * (1 + fr.y);
      expect(r.x).toBeCloseTo(cx / k, 6);
      expect(r.y).toBeCloseTo(cy / k, 6);
      expect(r.w).toBeCloseTo(outW / k, 6);
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(srcW + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(srcH + 1e-6);
    }
    expect(framedRect(srcW, srcH, outW, outH, { x: -1, y: 0, scale: 1 }).x).toBe(0); // left edge
  });

  it("setFraming clamps, rounds and clears back to centred", async () => {
    const { setFraming } = await import("@/lib/timeline/ops");
    const tl = { clips: [base], duration: 4e6, fadeIn: 0, fadeOut: 0 };
    const t = setFraming(tl, 0, { x: -3, y: 0.12345, scale: 9 });
    expect(t.clips[0].framing).toEqual({ x: -1, y: 0.123, scale: 3 });
    expect(setFraming(t, 0, null).clips[0].framing).toBeUndefined();
    expect(setFraming(t, 0, { x: 0, y: 0, scale: 1 }).clips[0].framing).toBeUndefined();
  });

  it("export crop uses the clip's framing", () => {
    const analysis = fakeAnalysis({ seconds: 20 });
    const media = fakeMedia(3, 20);
    const { timeline } = generateTimeline({ analysis, media, settings: settings({ seed: 2 }) });
    const tl = { ...timeline, clips: timeline.clips.map((c, i) => (i === 1 ? { ...c, framing: { x: -0.75, y: 0.5, scale: 1.5 } } : c)) };
    const plan = planRender({ timeline: tl, media, aspect: "9:16", export: { resolution: 720, fps: 30 } });
    const body = plan.pieces.find((p) => p.kind === "body" && p.sides[0].clipIndex === 1)!;
    expect(body.filter).toContain("(1+(-0.75))");
    expect(body.filter).toContain("(1+(0.5))");
  });
});
