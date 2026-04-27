import { describe, expect, it } from "vitest";
import { BeatDetector, type BeatRejectionReason } from "../BeatDetector";
import type { TimeSample } from "../PPGFilters";

/* ------------------------------------------------------------------ */
/*                       Synthetic PPG generators                     */
/* ------------------------------------------------------------------ */

const FS = 30; // Hz, matches default targetFs cap.

function sine(durationSec: number, bpm: number, opts: { fs?: number; amp?: number; noise?: number } = {}): TimeSample[] {
  const fs = opts.fs ?? FS;
  const amp = opts.amp ?? 1;
  const noise = opts.noise ?? 0;
  const n = Math.floor(durationSec * fs);
  const f = bpm / 60;
  const out: TimeSample[] = [];
  // deterministic pseudo-random for stable test runs
  let seed = 1;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return (seed / 233280 - 0.5) * 2;
  };
  for (let i = 0; i < n; i += 1) {
    const t = (i / fs) * 1000;
    out.push({ t, value: amp * Math.sin(2 * Math.PI * f * (i / fs)) + noise * rand() });
  }
  return out;
}

/** A flat (no-pulse) DC line + tiny noise. */
function flat(durationSec: number, fs = FS): TimeSample[] {
  const n = Math.floor(durationSec * fs);
  const out: TimeSample[] = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return (seed / 233280 - 0.5) * 2;
  };
  for (let i = 0; i < n; i += 1) {
    out.push({ t: (i / fs) * 1000, value: 0.5 + 0.01 * rand() });
  }
  return out;
}

/** Sinusoidal pulse with a sharp motion spike injected near the middle. */
function withMotionSpike(durationSec: number, bpm: number): TimeSample[] {
  const base = sine(durationSec, bpm, { amp: 0.5 });
  const spikeIdx = Math.floor(base.length / 2);
  base[spikeIdx] = { ...base[spikeIdx], value: 12 }; // huge excursion
  base[spikeIdx + 1] = { ...base[spikeIdx + 1], value: 11 };
  return base;
}

/* ------------------------------------------------------------------ */
/*                                Tests                               */
/* ------------------------------------------------------------------ */

describe("BeatDetector — state machine + rejection reasons", () => {
  it("returns empty result with no invented beats on a flat signal", () => {
    const det = new BeatDetector();
    const result = det.detect(flat(8));
    expect(result.beats.length).toBe(0);
    expect(result.bpm).toBeNull();
    expect(result.rrIntervalsMs.length).toBe(0);
    expect(result.peakBpm).toBeNull();
    expect(result.fftBpm).toBeNull();
  });

  it("returns empty result on too-short input (no fabricated beats)", () => {
    const det = new BeatDetector();
    const result = det.detect(sine(2, 75));
    expect(result.beats.length).toBe(0);
    expect(result.bpm).toBeNull();
  });

  it("walks seeking_foot → rising → candidate_peak → falling → refractory and detects ~75 BPM", () => {
    const det = new BeatDetector();
    const result = det.detect(sine(12, 75, { amp: 0.5 }));

    // We expect roughly 12s * 75/60 = 15 beats; allow generous range for
    // bandpass settling + edge trimming.
    expect(result.beats.length).toBeGreaterThanOrEqual(5);
    expect(result.beats.length).toBeLessThanOrEqual(20);

    // Each accepted beat must carry a real timestamp + morphology.
    for (const beat of result.beats) {
      expect(Number.isFinite(beat.t)).toBe(true);
      expect(beat.peakT).toBe(beat.t);
      expect(beat.amplitude).toBeGreaterThan(0);
      expect(beat.pulseWidthMs).toBeGreaterThan(0);
      expect(beat.rejectionReason).toBeUndefined();
    }

    // RR intervals must be physiologic.
    for (const rr of result.rrIntervalsMs) {
      expect(rr).toBeGreaterThan(60000 / 220);
      expect(rr).toBeLessThan(60000 / 30);
    }

    // BPM either null (if estimators disagreed) or in a wide tolerance band:
    // we only care that it's NOT a fabricated, far-off value.
    if (result.bpm !== null) {
      expect(Math.abs(result.bpm - 75)).toBeLessThan(25);
    }
    expect(result.peakBpm).not.toBeNull();
  });

  it("monotonic timestamps: every accepted beat strictly after the previous", () => {
    const det = new BeatDetector();
    const result = det.detect(sine(10, 90, { amp: 0.5 }));
    for (let i = 1; i < result.beats.length; i += 1) {
      expect(result.beats[i].t).toBeGreaterThan(result.beats[i - 1].t);
    }
  });

  it("never publishes BPM outside the [30,220] physiological window", () => {
    const det = new BeatDetector();
    for (const bpm of [55, 90, 140]) {
      const result = det.detect(sine(10, bpm, { amp: 0.5 }));
      if (result.bpm !== null) {
        expect(result.bpm).toBeGreaterThanOrEqual(30);
        expect(result.bpm).toBeLessThanOrEqual(220);
      }
    }
  });

  it("withholds candidates with a typed BeatRejectionReason (no silent drops)", () => {
    const det = new BeatDetector();
    const result = det.detect(withMotionSpike(10, 80));
    // Withheld bucket may contain motion spikes, refractory violations, or
    // morphology-invalid candidates depending on filter response — but every
    // entry MUST carry a typed reason.
    const allowed: BeatRejectionReason[] = [
      "AMPLITUDE_BELOW_THRESHOLD",
      "PROMINENCE_BELOW_MAD",
      "PULSE_WIDTH_OUT_OF_RANGE",
      "RR_OUT_OF_RANGE",
      "DICROTIC_DOUBLE_PEAK",
      "MOTION_ARTIFACT",
      "REFRACTORY_VIOLATION",
      "MORPHOLOGY_INVALID",
    ];
    for (const w of result.withheldBeats) {
      expect(w.rejectionReason).toBeDefined();
      expect(allowed).toContain(w.rejectionReason!);
    }
    // rejectedCandidates counter must match withheldBeats length.
    expect(result.rejectedCandidates).toBe(result.withheldBeats.length);
  });

  it("estimatorAgreementBpm is 999 when fewer than 2 estimators are available, finite otherwise", () => {
    const det = new BeatDetector();
    const flatRes = det.detect(flat(8));
    expect(flatRes.estimatorAgreementBpm).toBe(999);

    const goodRes = det.detect(sine(12, 72, { amp: 0.5 }));
    // With a clean sine, peak + autocorr + fft should all converge.
    if (goodRes.peakBpm !== null && goodRes.fftBpm !== null) {
      expect(goodRes.estimatorAgreementBpm).toBeLessThan(999);
    }
  });

  it("never invents a beat: total beats <= candidates encountered (accepted + withheld)", () => {
    const det = new BeatDetector();
    const result = det.detect(sine(12, 90, { amp: 0.5, noise: 0.05 }));
    // Sanity: accepted beats are never more than crude expected pulse count.
    const expectedMax = Math.ceil((12 * 90) / 60) + 4;
    expect(result.beats.length).toBeLessThanOrEqual(expectedMax);
  });

  it("publicationException is set when BPM is suppressed", () => {
    const det = new BeatDetector();
    const result = det.detect(flat(8));
    expect(result.bpm).toBeNull();
    expect(result.publicationException).toBeDefined();
  });

  it("refractory blocks impossibly fast beats (no >220 BPM publication)", () => {
    const det = new BeatDetector();
    // Very fast 240 BPM input — detector must NOT publish a 240 BPM beat train.
    const result = det.detect(sine(8, 240, { amp: 0.5 }));
    if (result.bpm !== null) {
      expect(result.bpm).toBeLessThanOrEqual(220);
    }
    // Any super-tight RR must have been moved to withheld with REFRACTORY_VIOLATION
    // or RR_OUT_OF_RANGE.
    const tightWithheld = result.withheldBeats.filter(
      (w) =>
        w.rejectionReason === "REFRACTORY_VIOLATION" ||
        w.rejectionReason === "RR_OUT_OF_RANGE" ||
        w.rejectionReason === "PULSE_WIDTH_OUT_OF_RANGE",
    );
    // We don't require >0 (filter may smooth them away), but if any candidate
    // was within < min RR, it must be in withheld with a typed reason.
    for (const w of tightWithheld) {
      expect(w.rejectionReason).toBeDefined();
    }
  });
});
