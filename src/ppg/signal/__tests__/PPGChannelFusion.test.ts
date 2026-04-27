import { describe, expect, it } from "vitest";
import { PPGChannelFusion, type ChannelMetrics } from "../PPGChannelFusion";
import type {
  ChannelMask,
  PPGOpticalSample,
} from "../RadiometricPPGExtractor";

/* ------------------------------------------------------------------ */
/*  Synthetic optical-sample factory                                  */
/*                                                                    */
/*  Goal: drive PPGChannelFusion through realistic windows      */
/*  while CONTROLLING which channels are usable per frame, so we can  */
/*  unit-test the ≥60 % channelMask rule without touching the camera. */
/* ------------------------------------------------------------------ */

interface BuildOpts {
  /** Window length in seconds. */
  durationSec: number;
  /** Sampling rate in frames-per-second. */
  fps: number;
  /** Synthetic pulse frequency in Hz (cardiac). */
  pulseHz: number;
  /**
   * (frameIndex, totalFrames) → ChannelMask. Lets the test paint exactly
   * which fraction of the window each channel is "usable".
   */
  maskAt: (i: number, n: number) => ChannelMask;
}

function buildSamples(opts: BuildOpts): PPGOpticalSample[] {
  const { durationSec, fps, pulseHz, maskAt } = opts;
  const n = Math.floor(durationSec * fps);
  const out: PPGOpticalSample[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i / fps) * 1000;
    // Small AC oscillation around a stable DC. Magnitudes are
    // physiologically plausible for OD (log-domain).
    const ac = 0.02 * Math.sin(2 * Math.PI * pulseHz * (i / fps));
    const dc = 100;
    const mask = maskAt(i, n);
    out.push({
      t,
      fps,
      baselineValid: true,
      raw: { r: 180, g: 120, b: 60 },
      linear: { r: 0.45, g: 0.20, b: 0.05 },
      dcStats: {
        r: { median: dc, trimmedMean: dc, p5: dc - 2, p95: dc + 2 },
        g: { median: dc, trimmedMean: dc, p5: dc - 2, p95: dc + 2 },
        b: { median: dc, trimmedMean: dc, p5: dc - 2, p95: dc + 2 },
      },
      dc: { r: dc, g: dc, b: dc },
      baseline: { r: dc, g: dc, b: dc },
      od: { r: 0.5 + ac * 0.7, g: 0.6 + ac, b: 0.4 + ac * 0.4 },
      ac: { r: ac, g: ac, b: ac * 0.5 },
      acRobust: { r: ac, g: ac, b: ac * 0.5 },
      perfusion: { r: 0.05, g: 0.05, b: 0.04 },
      saturation: { rHigh: 0.04, gHigh: 0.04, bHigh: 0.04, rLow: 0, gLow: 0, bLow: 0 },
      channelMask: mask,
      rejection: [],
    } as unknown as PPGOpticalSample);
  }
  return out;
}

/**
 * Drive the engine sample-by-sample. The engine is stateful (windowed
 * history) so we must feed it the entire stream like the real pipeline.
 */
function runEngine(samples: PPGOpticalSample[]) {
  const engine = new PPGChannelFusion();
  let last;
  for (const s of samples) last = engine.push(s);
  if (!last) throw new Error("engine produced no output");
  return { engine, fused: last };
}

describe("PPGChannelFusion — channelMask ≥60 % gating", () => {
  it("DROPS the red channel when it is masked-out in >40 % of frames", () => {
    // Red usable in only 30 % of frames → must NOT appear in allChannels.
    // Green is usable in 100 % → must be present.
    const samples = buildSamples({
      durationSec: 8,
      fps: 30,
      pulseHz: 1.2,
      maskAt: (i, n) => ({
        r: i / n < 0.3,            // 30 % usable → BELOW 60 % threshold
        g: true,                   // 100 % usable
        b: false,                  // never usable
      }),
    });
    const { fused } = runEngine(samples);

    const names = fused.allChannels.map((c: ChannelMetrics) => c.name);
    expect(names).toContain("GREEN_OD");
    expect(names).not.toContain("RED_OD");
    // Multi-channel methods that need green should still survive.
    // RG_RATIO_OD requires BOTH r and g over the threshold → must be dropped.
    expect(names).not.toContain("RG_RATIO_OD");
    expect(names).not.toContain("BLUE_OD");
  });

  it("KEEPS the red channel exactly at 60 % usable ratio (boundary)", () => {
    // Engine evaluates the recent window (~10 s). Build a 10s stream where
    // red is usable in the LAST 60 % of frames so the recent-window
    // fraction is ≥0.6.
    const samples = buildSamples({
      durationSec: 10,
      fps: 30,
      pulseHz: 1.2,
      maskAt: (i, n) => ({
        r: i / n >= 0.4,           // last 60 % → ratio = 0.6 exactly
        g: true,
        b: false,
      }),
    });
    const { fused } = runEngine(samples);
    const names = fused.allChannels.map((c: ChannelMetrics) => c.name);
    expect(names).toContain("RED_OD");
    expect(names).toContain("GREEN_OD");
    expect(names).toContain("RG_RATIO_OD");
  });

  it("falls back to GREEN_OD with NO_VALID_CHANNELS_FALLBACK_GREEN when nothing passes", () => {
    // All channels masked-out → fallback green channel + audit-friendly reason.
    const samples = buildSamples({
      durationSec: 8,
      fps: 30,
      pulseHz: 1.2,
      maskAt: () => ({ r: false, g: false, b: false }),
    });
    const { fused } = runEngine(samples);
    expect(fused.allChannels.length).toBe(0);
    expect(fused.selectedName).toBe("GREEN_OD");
    expect(fused.selectionReason).toBe("NO_VALID_CHANNELS_FALLBACK_GREEN");
  });

  it("does NOT publish multi-channel CHROM/POS when green is masked-out", () => {
    // Green below threshold ⇒ every multi-channel method that depends on
    // green (CHROM, POS, PCA_1, RG_RATIO_OD) must be excluded.
    const samples = buildSamples({
      durationSec: 10,
      fps: 30,
      pulseHz: 1.2,
      maskAt: (i, n) => ({
        r: true,
        g: i / n < 0.5,            // 50 % usable → BELOW 60 % threshold
        b: false,
      }),
    });
    const { fused } = runEngine(samples);
    const names = fused.allChannels.map((c: ChannelMetrics) => c.name);
    expect(names).toContain("RED_OD");
    expect(names).not.toContain("GREEN_OD");
    expect(names).not.toContain("CHROM");
    expect(names).not.toContain("POS");
    expect(names).not.toContain("RG_RATIO_OD");
  });
});

describe("PPGChannelFusion — selection regression", () => {
  it("selectedName is one of allChannels (no ghost selections)", () => {
    const samples = buildSamples({
      durationSec: 10,
      fps: 30,
      pulseHz: 1.2,
      maskAt: () => ({ r: true, g: true, b: false }),
    });
    const { fused } = runEngine(samples);
    if (fused.allChannels.length > 0) {
      const names = fused.allChannels.map((c: ChannelMetrics) => c.name);
      expect(names).toContain(fused.selectedName);
    }
  });

  it("hysteresis: selection does NOT flap when scores are within 0.05", () => {
    // Run the engine through two near-identical windows. Once a winner is
    // chosen, it must be sticky (anti-flicker) on the next nearly-identical
    // call, so consecutive selections are equal.
    const a = buildSamples({
      durationSec: 10, fps: 30, pulseHz: 1.2,
      maskAt: () => ({ r: true, g: true, b: false }),
    });
    const engine = new PPGChannelFusion();
    let firstName = "";
    let lastName = "";
    for (let i = 0; i < a.length; i += 1) {
      const f = engine.push(a[i]);
      if (i === a.length - 1) firstName = f.selectedName;
    }
    // Push 30 more nearly-identical frames; the winner must NOT flip.
    const b = buildSamples({
      durationSec: 1, fps: 30, pulseHz: 1.2,
      maskAt: () => ({ r: true, g: true, b: false }),
    }).map((s, i) => ({ ...s, t: a[a.length - 1].t + (i + 1) * (1000 / 30) }));
    for (const s of b) {
      const f = engine.push(s);
      lastName = f.selectedName;
    }
    expect(lastName).toBe(firstName);
  });

  it("selectionReason is non-empty and mentions the winner channel name", () => {
    const samples = buildSamples({
      durationSec: 10, fps: 30, pulseHz: 1.2,
      maskAt: () => ({ r: true, g: true, b: false }),
    });
    const { fused } = runEngine(samples);
    expect(fused.selectionReason.length).toBeGreaterThan(0);
    expect(fused.selectionReason).toContain(fused.selectedName);
  });
});
