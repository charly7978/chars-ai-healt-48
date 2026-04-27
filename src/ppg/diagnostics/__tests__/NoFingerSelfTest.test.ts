import { describe, expect, it } from "vitest";
import { NoFingerSelfTest } from "../NoFingerSelfTest";
import type { FingerOpticalEvidence } from "../../roi/FingerOpticalROI";
import type { PublishedPPGMeasurement } from "../../publication/PPGPublicationGate";

function makeRoi(overrides: Partial<FingerOpticalEvidence>): FingerOpticalEvidence {
  return {
    roi: { x: 0, y: 0, width: 10, height: 10 },
    meanRgb: { r: 0, g: 0, b: 0 },
    medianRgb: { r: 0, g: 0, b: 0 },
    p5Rgb: { r: 0, g: 0, b: 0 },
    p95Rgb: { r: 0, g: 0, b: 0 },
    linearMean: { r: 0.05, g: 0.05, b: 0.05 },
    opticalDensity: { r: 0, g: 0, b: 0 },
    highSaturation: { r: 0, g: 0, b: 0 },
    lowSaturation: { r: 0, g: 0, b: 0 },
    redSaturationRatio: 0,
    greenSaturationRatio: 0,
    blueSaturationRatio: 0,
    clippedPixelRatio: 0,
    usablePixelRatio: { r: 0, g: 0, b: 0 },
    usablePixelRatioMax: 0,
    spatialVariance: 0,
    uniformityScore: 0,
    textureScore: 0,
    dcStability: 0,
    dcTrend: 0,
    luminanceDelta: 0,
    centroidDrift: 0,
    motionArtifactScore: 0,
    coverageScore: 0.1,
    illuminationScore: 0,
    contactScore: 0,
    redDominance: 0.02,
    greenPulseAvailability: 0,
    pressureRisk: 0,
    motionRisk: 0,
    reason: ["INSUFFICIENT_VALID_PIXELS"],
    accepted: false,
    tiles: [],
    usableTileCount: 0,
    tileCount: 49,
    roiStabilityScore: 0,
    perfusionScore: 0,
    saturationScore: 0,
    motionScore: 0,
    opticalContactScore: 0,
    channelUsable: { r: false, g: false, b: false },
    contactState: "absent",
    pressureState: "weak_contact",
    userGuidance: "",
    ...overrides,
  };
}

function makePublished(canPublish: boolean): PublishedPPGMeasurement {
  return {
    state: canPublish ? "PPG_VALID" : "CAMERA_READY_NO_PPG",
    canPublishVitals: canPublish,
    canVibrateBeat: false,
    bpm: canPublish ? 72 : null,
    bpmConfidence: canPublish ? 0.8 : 0,
    oxygen: { spo2: null, confidence: 0, canPublish: false, method: "NONE", reasons: [], calibrationBadge: "uncalibrated" },
    waveformSource: canPublish ? "REAL_PPG" : "NONE",
    beatMarkers: [],
    withheldBeatMarkers: [],
    irregularityFlag: false,
    estimatorBreakdown: { peakBpm: null, medianIbiBpm: null, fftBpm: null, autocorrBpm: null, agreementBpm: 0 },
    quality: {} as never,
    evidence: {} as never,
    message: "",
    goodWindowStreak: 0,
    lastValidTimestamp: null,
    rejectedBeatCandidates: 0,
    lastValidBpm: null,
    staleSinceMs: 0,
    staleBadge: "never",
  };
}

describe("NoFingerSelfTest", () => {
  it("classifies an empty scene as no-finger and counts a correct block", () => {
    const test = new NoFingerSelfTest();
    test.observe({
      t: 0,
      roi: makeRoi({}),
      published: makePublished(false),
    });
    const r = test.report();
    expect(r.noFingerSamples).toBe(1);
    expect(r.correctBlocks).toBe(1);
    expect(r.falsePositives).toBe(0);
  });

  it("flags a false positive when gate publishes vitals on a no-finger scene", () => {
    const test = new NoFingerSelfTest();
    test.observe({
      t: 1,
      roi: makeRoi({}),
      published: makePublished(true),
    });
    const r = test.report();
    expect(r.falsePositives).toBe(1);
    expect(r.lastViolationReason).not.toBeNull();
  });

  it("classifies a finger-likely scene correctly and never marks a violation", () => {
    const test = new NoFingerSelfTest();
    test.observe({
      t: 2,
      roi: makeRoi({
        contactState: "stable",
        redDominance: 0.35,
        linearMean: { r: 0.55, g: 0.18, b: 0.12 },
        coverageScore: 0.85,
        reason: [],
      }),
      published: makePublished(true),
    });
    const r = test.report();
    expect(r.fingerLikelySamples).toBe(1);
    expect(r.falsePositives).toBe(0);
  });
});
