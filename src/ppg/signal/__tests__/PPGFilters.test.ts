import { describe, expect, it } from "vitest";
import {
  bandpassZeroPhase,
  preprocessPPGRobust,
  resampleUniform,
  spectralMetrics,
  validateWindow,
  type TimeSample,
} from "../PPGFilters";

const FS = 30;

function sine(durationSec: number, hz: number, amp = 1, fs = FS): TimeSample[] {
  const n = Math.floor(durationSec * fs);
  const out: TimeSample[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ t: (i / fs) * 1000, value: amp * Math.sin(2 * Math.PI * hz * (i / fs)) });
  }
  return out;
}

function noise(durationSec: number, amp = 1, fs = FS): TimeSample[] {
  let seed = 12345;
  const r = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return (seed / 233280 - 0.5) * 2;
  };
  const n = Math.floor(durationSec * fs);
  const out: TimeSample[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ t: (i / fs) * 1000, value: amp * r() });
  }
  return out;
}

describe("PPGFilters — windowing & sampling", () => {
  it("validateWindow rejects insufficient samples", () => {
    expect(validateWindow(sine(0.1, 1)).valid).toBe(false);
  });

  it("validateWindow rejects extreme jitter", () => {
    const s: TimeSample[] = [];
    for (let i = 0; i < 30; i += 1) {
      // Random gaps 5–500 ms
      s.push({ t: i === 0 ? 0 : s[i - 1].t + (i % 2 === 0 ? 5 : 400), value: 0 });
    }
    const v = validateWindow(s);
    expect(v.valid).toBe(false);
    expect(["EXTREME_JITTER", "LARGE_GAPS"]).toContain(v.reason);
  });

  it("resampleUniform produces uniform spacing at target Fs", () => {
    const r = resampleUniform(sine(5, 1.2), 30);
    expect(r.valid).toBe(true);
    const dts: number[] = [];
    for (let i = 1; i < r.samples.length; i += 1) dts.push(r.samples[i].t - r.samples[i - 1].t);
    const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
    expect(Math.abs(avg - 1000 / 30)).toBeLessThan(0.5);
  });
});

describe("PPGFilters — bandpassZeroPhase", () => {
  it("preserves a 1.2 Hz pulse and rejects pure white noise", () => {
    const pulse = sine(8, 1.2, 1);
    const filteredPulse = bandpassZeroPhase(pulse, 0.5, 4.0, FS);
    const ampPulse = Math.max(...filteredPulse.map((s) => Math.abs(s.value)));
    expect(ampPulse).toBeGreaterThan(0.3);

    const onlyNoise = noise(8, 1);
    const filteredNoise = bandpassZeroPhase(onlyNoise, 0.5, 4.0, FS);
    // Bandpass + Hampel should attenuate broadband noise substantially
    const rms = Math.sqrt(
      filteredNoise.reduce((a, s) => a + s.value * s.value, 0) / filteredNoise.length,
    );
    expect(rms).toBeLessThan(0.6);
  });

  it("zero-phase: peak of input sine aligns with peak of filtered sine (within 1 sample)", () => {
    const pulse = sine(8, 1.2, 1);
    const filtered = bandpassZeroPhase(pulse, 0.5, 4.0, FS);

    // Find first positive peak in input (after 1s settle)
    const startIdx = FS;
    let inPeakIdx = startIdx;
    for (let i = startIdx + 1; i < pulse.length - 1; i += 1) {
      if (pulse[i].value > pulse[i - 1].value && pulse[i].value > pulse[i + 1].value) {
        inPeakIdx = i;
        break;
      }
    }
    let outPeakIdx = startIdx;
    for (let i = startIdx + 1; i < filtered.length - 1; i += 1) {
      if (filtered[i].value > filtered[i - 1].value && filtered[i].value > filtered[i + 1].value) {
        outPeakIdx = i;
        break;
      }
    }
    expect(Math.abs(outPeakIdx - inPeakIdx)).toBeLessThanOrEqual(1);
  });

  it("falls back gracefully on out-of-range fs (no NaN)", () => {
    const pulse = sine(4, 1.2, 1);
    const filtered = bandpassZeroPhase(pulse, 0.5, 4.0, 5); // fs < 2*high
    for (const s of filtered) expect(Number.isFinite(s.value)).toBe(true);
  });
});

describe("PPGFilters — preprocessPPGRobust", () => {
  it("rejects too-short input with INSUFFICIENT_SAMPLES", () => {
    const r = preprocessPPGRobust(sine(0.1, 1.2));
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("INSUFFICIENT_SAMPLES");
  });

  it("succeeds on clean pulse and surfaces the dominant frequency in spectralMetrics", () => {
    const r = preprocessPPGRobust(sine(8, 1.25), 0.5, 4.0, 30);
    expect(r.valid).toBe(true);
    const m = spectralMetrics(r.samples, 0.5, 4.0);
    expect(m.dominantFrequencyHz).toBeGreaterThan(0.8);
    expect(m.dominantFrequencyHz).toBeLessThan(2.0);
    expect(m.bandPowerRatio).toBeGreaterThan(0.3);
  });

  it("rejects a saturated (clipped) input — band power collapses", () => {
    const sat: TimeSample[] = sine(8, 1.2, 1).map((s) => ({
      t: s.t,
      value: 1, // hard rail at 1
    }));
    const r = preprocessPPGRobust(sat);
    expect(r.valid).toBe(true); // resample is fine
    const m = spectralMetrics(r.samples, 0.5, 4.0);
    // No oscillation → no band power
    expect(m.bandPowerRatio).toBeLessThan(0.2);
  });

  it("attenuates a motion spike (no spectral peak hijack)", () => {
    const base = sine(10, 1.2, 0.5);
    const mid = Math.floor(base.length / 2);
    base[mid] = { ...base[mid], value: 20 };
    base[mid + 1] = { ...base[mid + 1], value: 18 };
    const r = preprocessPPGRobust(base);
    expect(r.valid).toBe(true);
    // Hampel + bandpass should keep dynamic range bounded
    const max = Math.max(...r.samples.map((s) => Math.abs(s.value)));
    expect(max).toBeLessThan(8);
  });
});
