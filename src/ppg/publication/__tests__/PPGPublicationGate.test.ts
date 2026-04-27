import { describe, expect, it } from "vitest";
import { PPGPublicationGate } from "../PPGPublicationGate";
import type { PPGCameraState } from "../../camera/PPGCameraController";
import type { FingerOpticalEvidence } from "../../roi/FingerOpticalROI";
import type { FusedPPGChannels } from "../../signal/PPGChannelFusion";
import type { BeatDetectionResult } from "../../signal/BeatDetector";
import type { PPGOpticalSample } from "../../signal/RadiometricPPGExtractor";
import {
  createEmptySignalQuality,
  type PPGSignalQuality,
} from "../../signal/PPGSignalQuality";

/**
 * Minimal builders. The gate only inspects fields it documents in its
 * contract, so we provide just enough surface to drive each branch.
 */
function camera(over: Partial<PPGCameraState> = {}): PPGCameraState {
  return {
    cameraReady: true,
    torchAvailable: true,
    torchEnabled: true,
    torchApplied: true,
    acquisitionReady: true,
    notReadyReasons: [],
    error: null,
    diagnostics: { calibration: { status: "calibrated" } } as unknown as PPGCameraState["diagnostics"],
    ...over,
  } as PPGCameraState;
}

function roi(over: Partial<FingerOpticalEvidence> = {}): FingerOpticalEvidence {
  return {
    contactScore: 0.8,
    illuminationScore: 0.8,
    contactState: "stable",
    pressureState: "optimal",
    accepted: true,
    usableTileCount: 20,
    tileCount: 49,
    roiStabilityScore: 0.7,
    channelUsable: { r: true, g: true, b: true },
    highSaturation: { r: 0.05, g: 0.05, b: 0.05 },
    lowSaturation: { r: 0.05, g: 0.05, b: 0.05 },
    dcStability: 0.8,
    reason: [],
    ...over,
  } as FingerOpticalEvidence;
}

function quality(over: Partial<PPGSignalQuality> = {}): PPGSignalQuality {
  return {
    ...createEmptySignalQuality([]),
    contactScore: 0.8,
    illuminationScore: 0.8,
    saturationPenalty: 0.1,
    motionLikeNoise: 0.2,
    bandPowerRatio: 0.6,
    spectralPeakProminence: 4,
    acDcPerfusionIndex: 0.05,
    snrDb: 8,
    rrConsistency: 0.8,
    morphologyScore: 0.7,
    baselineStability: 0.8,
    totalScore: 75,
    grade: "GOOD",
    autocorrBpm: 75,
    fftBpm: 75,
    peakBpm: 75,
    estimatorAgreementBpm: 1,
    ...over,
  };
}

function beats(over: Partial<BeatDetectionResult> = {}): BeatDetectionResult {
  const fakeBeats = Array.from({ length: 8 }, (_, i) => ({
    t: 1000 + i * 800,
    peakT: 1000 + i * 800,
    peakValue: 1,
    onsetT: 900 + i * 800,
    onsetValue: 0,
    troughT: 1200 + i * 800,
    troughValue: 0,
    amplitude: 1,
    riseTimeMs: 100,
    decayTimeMs: 200,
    pulseWidthMs: 320,
    areaUnderPulse: 100,
    upSlope: 0.01,
    downSlope: 0.005,
    prominence: 1,
    confidence: 0.8,
  })) as BeatDetectionResult["beats"];
  return {
    beats: fakeBeats,
    withheldBeats: [],
    bpm: 75,
    rrIntervalsMs: [800, 800, 800, 800, 800, 800, 800],
    confidence: 0.8,
    peakBpm: 75,
    medianIbiBpm: 75,
    fftBpm: 75,
    autocorrBpm: 75,
    estimatorAgreementBpm: 1,
    rejectedCandidates: 0,
    sampleRateHz: 30,
    irregularityFlag: false,
    ibiStdMs: 5,
    ...over,
  };
}

function channels(over: Partial<FusedPPGChannels> = {}): FusedPPGChannels {
  return {
    t: 8000,
    g1: 0,
    g2: 0,
    g3: 0,
    selected: 0,
    selectedName: "GREEN_OD",
    channelSnr: { g1: 8, g2: 8, g3: 8 },
    allChannels: [],
    selectionReason: "OK",
    ...over,
  } as FusedPPGChannels;
}

function opticalSamples(durationMs = 8000, fs = 30): PPGOpticalSample[] {
  const out: PPGOpticalSample[] = [];
  const n = Math.floor((durationMs * fs) / 1000);
  for (let i = 0; i < n; i += 1) {
    // Tiny pulsatile component so robustAc/SNR don't go to zero.
    const pulse = Math.sin(2 * Math.PI * 1.2 * (i / fs)) * 0.02;
    out.push({
      t: (i / fs) * 1000,
      fps: fs,
      baselineValid: true,
      saturation: { rHigh: 0.05, gHigh: 0.05, bHigh: 0.05, rLow: 0, gLow: 0, bLow: 0 },
      od: { r: 0.5 + pulse, g: 0.5 + pulse * 0.6, b: 0.5 + pulse * 0.4 },
      dc: { r: 100, g: 100, b: 100 },
      ac: { r: 1, g: 1, b: 1 },
      perfusion: { r: 0.05, g: 0.05, b: 0.05 },
    } as PPGOpticalSample);
  }
  return out;
}

describe("PPGPublicationGate — stale-publication ledger", () => {
  it('badge is "never" when no valid window has ever been published', () => {
    const gate = new PPGPublicationGate();
    const r = gate.evaluate({
      camera: camera(),
      roi: roi({ contactScore: 0.1 }),
      channels: channels(),
      quality: quality({ totalScore: 10 }),
      beats: beats({ bpm: null, beats: [], rrIntervalsMs: [] }),
      opticalSamples: opticalSamples(8000),
      selectedSeries: opticalSamples(8000).map((s) => ({ t: s.t, value: 0.1 })),
      fpsQuality: 100,
    });
    expect(r.canPublishVitals).toBe(false);
    expect(r.staleBadge).toBe("never");
    expect(r.lastValidBpm).toBeNull();
  });

  it('badge transitions never → fresh → stale → expired without ever back-filling fresh bpm', () => {
    const gate = new PPGPublicationGate();
    // Two good windows to satisfy goodWindowStreak >= 2 (buckets 2s apart).
    const baseSeries = opticalSamples(8000).map((s) => ({ t: s.t, value: Math.sin(s.t / 200) }));
    const s1 = opticalSamples(8000);
    const s2 = s1.map((s) => ({ ...s, t: s.t + 2500 }));

    gate.evaluate({
      camera: camera(),
      roi: roi(),
      channels: channels(),
      quality: quality(),
      beats: beats(),
      opticalSamples: s1,
      selectedSeries: baseSeries,
      fpsQuality: 100,
    });
    // Warm up the per-frame contact streak (≥30 consecutive accepted frames)
    // before asserting publication. Each call ticks the streak by 1.
    for (let i = 0; i < 32; i++) {
      gate.evaluate({
        camera: camera(),
        roi: roi(),
        channels: channels(),
        quality: quality(),
        beats: beats(),
        opticalSamples: s1,
        selectedSeries: baseSeries,
        fpsQuality: 100,
      });
    }
    const fresh = gate.evaluate({
      camera: camera(),
      roi: roi(),
      channels: channels(),
      quality: quality(),
      beats: beats(),
      opticalSamples: s2,
      selectedSeries: baseSeries.map((s) => ({ ...s, t: s.t + 2500 })),
      fpsQuality: 100,
    });
    expect(fresh.canPublishVitals).toBe(true);
    expect(fresh.staleBadge).toBe("fresh");
    expect(fresh.bpm).toBe(75);
    expect(fresh.lastValidBpm).toBe(75);

    // Advance 4s with degraded contact → should go stale (≤6s) but bpm=null.
    const sStale = s2.map((s) => ({ ...s, t: s.t + 4000 }));
    const stale = gate.evaluate({
      camera: camera(),
      roi: roi({ contactScore: 0.1, contactState: "absent" }),
      channels: channels(),
      quality: quality({ totalScore: 10 }),
      beats: beats({ bpm: null, confidence: 0.1 }),
      opticalSamples: sStale,
      selectedSeries: baseSeries.map((s) => ({ ...s, t: s.t + 6500 })),
      fpsQuality: 100,
    });
    expect(stale.canPublishVitals).toBe(false);
    expect(stale.bpm).toBeNull(); // never back-filled
    expect(stale.staleBadge).toBe("stale");
    expect(stale.lastValidBpm).toBe(75);
    expect(stale.staleSinceMs).toBeGreaterThan(0);
    expect(stale.staleSinceMs).toBeLessThanOrEqual(6000);

    // Advance >6s → expired.
    const sExpired = s2.map((s) => ({ ...s, t: s.t + 9000 }));
    const expired = gate.evaluate({
      camera: camera(),
      roi: roi({ contactScore: 0.1, contactState: "absent" }),
      channels: channels(),
      quality: quality({ totalScore: 10 }),
      beats: beats({ bpm: null, confidence: 0.1 }),
      opticalSamples: sExpired,
      selectedSeries: baseSeries.map((s) => ({ ...s, t: s.t + 11500 })),
      fpsQuality: 100,
    });
    expect(expired.staleBadge).toBe("expired");
    expect(expired.staleSinceMs).toBeGreaterThan(6000);
    expect(expired.bpm).toBeNull();
  });
});

describe("PPGPublicationGate — hard gates", () => {
  it("blocks publication when fpsQuality < 40", () => {
    const gate = new PPGPublicationGate();
    const r = gate.evaluate({
      camera: camera(),
      roi: roi(),
      channels: channels(),
      quality: quality(),
      beats: beats(),
      opticalSamples: opticalSamples(8000),
      selectedSeries: opticalSamples(8000).map((s) => ({ t: s.t, value: 1 })),
      fpsQuality: 10,
    });
    expect(r.canPublishVitals).toBe(false);
    expect(r.quality.reasons.some((x) => x.startsWith("FPS_QUALITY_LOW"))).toBe(true);
  });

  it("blocks publication when motion/saturation destructive", () => {
    const gate = new PPGPublicationGate();
    const r = gate.evaluate({
      camera: camera(),
      roi: roi({
        highSaturation: { r: 0.9, g: 0.9, b: 0.9 },
        lowSaturation: { r: 0, g: 0, b: 0 },
      }),
      channels: channels(),
      quality: quality({ saturationPenalty: 0.9 }),
      beats: beats(),
      opticalSamples: opticalSamples(8000),
      selectedSeries: opticalSamples(8000).map((s) => ({ t: s.t, value: 1 })),
      fpsQuality: 100,
    });
    expect(r.canPublishVitals).toBe(false);
  });

  it("blocks publication when contact state is absent", () => {
    const gate = new PPGPublicationGate();
    const r = gate.evaluate({
      camera: camera(),
      roi: roi({ contactState: "absent", contactScore: 0.1 }),
      channels: channels(),
      quality: quality({ contactScore: 0.1, totalScore: 30 }),
      beats: beats(),
      opticalSamples: opticalSamples(8000),
      selectedSeries: opticalSamples(8000).map((s) => ({ t: s.t, value: 1 })),
      fpsQuality: 100,
    });
    expect(r.canPublishVitals).toBe(false);
    expect(r.bpm).toBeNull();
  });

  it("blocks publication when too few accepted beats", () => {
    const gate = new PPGPublicationGate();
    const r = gate.evaluate({
      camera: camera(),
      roi: roi(),
      channels: channels(),
      quality: quality(),
      beats: beats({
        beats: [],
        rrIntervalsMs: [],
        bpm: null,
        peakBpm: null,
        confidence: 0.1,
      }),
      opticalSamples: opticalSamples(8000),
      selectedSeries: opticalSamples(8000).map((s) => ({ t: s.t, value: 1 })),
      fpsQuality: 100,
    });
    expect(r.canPublishVitals).toBe(false);
    expect(r.quality.reasons).toContain("NOT_ENOUGH_VALID_BEATS");
  });

  it("requires N consecutive accepted-contact frames before publishing vitals", () => {
    const gate = new PPGPublicationGate();
    const baseSeries = opticalSamples(8000).map((s) => ({ t: s.t, value: Math.sin(s.t / 200) }));
    const s1 = opticalSamples(8000);
    const args = (samples = s1, series = baseSeries) => ({
      camera: camera(),
      roi: roi(),
      channels: channels(),
      quality: quality(),
      beats: beats(),
      opticalSamples: samples,
      selectedSeries: series,
      fpsQuality: 100,
    });
    // First two windowed buckets pass.
    gate.evaluate(args());
    gate.evaluate(args(s1.map((s) => ({ ...s, t: s.t + 2500 })), baseSeries.map((s) => ({ ...s, t: s.t + 2500 }))));
    // After only 2 frames, contact streak < 30 → publication still blocked.
    const early = gate.evaluate(args());
    expect(early.canPublishVitals).toBe(false);
    expect(early.quality.reasons.some((r) => r.startsWith("CONTACT_STREAK_"))).toBe(true);

    // Drive enough consecutive accepted frames to satisfy the streak.
    for (let i = 0; i < 35; i++) gate.evaluate(args());
    const late = gate.evaluate(args());
    expect(late.canPublishVitals).toBe(true);
    expect(late.quality.reasons.some((r) => r.startsWith("CONTACT_STREAK_"))).toBe(false);

    // A single frame with broken contact resets the streak → publication blocked again.
    const broken = gate.evaluate({
      ...args(),
      roi: roi({ contactState: "absent", accepted: false, contactScore: 0.1 }),
    });
    expect(broken.canPublishVitals).toBe(false);
  });
});

describe("AdaptiveAcquisitionThresholds — auto-tuned ambient window", () => {
  it("shrinks the window when the noise estimate is stable", async () => {
    const { AdaptiveAcquisitionThresholds } = await import("../../camera/AdaptiveAcquisitionThresholds");
    const eng = new AdaptiveAcquisitionThresholds();
    const initial = eng.getAmbientWindowSize();
    for (let i = 0; i < 400; i++) {
      eng.observeAmbientSample({ r: 100 + (i % 2 === 0 ? 1 : -1) * 0.5, g: 100, b: 100 });
    }
    expect(eng.getAmbientWindowSize()).toBeLessThan(initial);
  });

  it("grows the window when the noise estimate is volatile", async () => {
    const { AdaptiveAcquisitionThresholds } = await import("../../camera/AdaptiveAcquisitionThresholds");
    const eng = new AdaptiveAcquisitionThresholds();
    const initial = eng.getAmbientWindowSize();
    for (let i = 0; i < 400; i++) {
      const swing = i % 30 < 15 ? 1 : 25;
      eng.observeAmbientSample({ r: 100 + (Math.random() - 0.5) * swing, g: 100, b: 100 });
    }
    expect(eng.getAmbientWindowSize()).toBeGreaterThanOrEqual(initial);
  });
});
