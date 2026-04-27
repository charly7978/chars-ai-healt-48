import type { PPGCameraState } from "../camera/PPGCameraController";
import type { FingerOpticalEvidence } from "../roi/FingerOpticalROI";
import type { BeatDetectionResult } from "../signal/BeatDetector";
import type { FusedPPGChannels } from "../signal/PPGChannelFusion";
import type { PPGOpticalSample } from "../signal/RadiometricPPGExtractor";
import {
  createEmptySignalQuality,
  type PPGSignalQuality,
} from "../signal/PPGSignalQuality";
import { durationMs, type TimeSample } from "../signal/PPGFilters";
import {
  estimateCameraSpO2,
  type PublishedOxygenMeasurement,
} from "../signal/PPGOxygenEstimator";

export type PublicationState =
  | "CAMERA_STARTING"
  | "CAMERA_READY_NO_PPG"
  | "ACQUIRING_BASELINE"
  | "PPG_WEAK"
  | "PPG_VALIDATING"
  | "PPG_VALID"
  | "PPG_LOST"
  | "ERROR";

export interface PublishedPPGMeasurement {
  state: PublicationState;
  canPublishVitals: boolean;
  canVibrateBeat: boolean;
  bpm: number | null;
  bpmConfidence: number;
  oxygen: PublishedOxygenMeasurement;
  // Note: numeric waveform was previously serialized here for the monitor,
  // but the monitor renders directly from `channels` (see FullScreenCardiacMonitor.mainTrace).
  // We keep `waveformSource` as the contract — the array itself was dead work.
  waveformSource: "REAL_PPG" | "RAW_DEBUG_ONLY" | "NONE";
  beatMarkers: Array<{
    t: number;
    confidence: number;
    onsetT?: number | null;
    troughT?: number | null;
  }>;
  withheldBeatMarkers: Array<{ t: number; reason: string }>;
  irregularityFlag: boolean;
  estimatorBreakdown: {
    peakBpm: number | null;
    medianIbiBpm: number | null;
    fftBpm: number | null;
    autocorrBpm: number | null;
    agreementBpm: number;
    publicationException?: string;
  };
  quality: PPGSignalQuality;
  evidence: {
    camera: PPGCameraState;
    roi: FingerOpticalEvidence;
    channels: FusedPPGChannels;
  };
  message: string;
  goodWindowStreak: number;
  lastValidTimestamp: number | null;
  rejectedBeatCandidates: number;
  /**
   * Stale-publication contract:
   *   - `bpm` above is ALWAYS the freshly validated value (or null if the
   *     current window does not pass the gate). It is NEVER backfilled.
   *   - `lastValidBpm` mirrors the last gate-approved BPM. UI may display
   *     it dimmed when `staleBadge !== "fresh"`.
   *   - `staleSinceMs` = (now − lastValidTimestamp). 0 when fresh, growing
   *     while we wait for the next valid window.
   *   - `staleBadge` discrete state for the UI:
   *       "fresh"   → current window valid
   *       "stale"   → 0 < staleSinceMs ≤ 6000
   *       "expired" → staleSinceMs > 6000  (do not trust)
   *       "never"   → no valid window has ever been published in this session
   */
  lastValidBpm: number | null;
  staleSinceMs: number;
  staleBadge: "fresh" | "stale" | "expired" | "never";
}

const NO_SIGNAL_MESSAGE = "SIN SENAL PPG VERIFICABLE";

export function createEmptyPublishedPPGMeasurement(
  camera: PPGCameraState,
): PublishedPPGMeasurement {
  return {
    state: camera.error ? "ERROR" : camera.cameraReady ? "CAMERA_READY_NO_PPG" : "CAMERA_STARTING",
    canPublishVitals: false,
    canVibrateBeat: false,
    bpm: null,
    bpmConfidence: 0,
    oxygen: {
      spo2: null,
      confidence: 0,
      canPublish: false,
      method: "NONE",
      reasons: ["NO_PPG_PUBLICATION"],
      calibrationBadge: camera.diagnostics?.calibration.status ?? "uncalibrated",
    },
    waveformSource: "NONE",
    beatMarkers: [],
    withheldBeatMarkers: [],
    irregularityFlag: false,
    estimatorBreakdown: {
      peakBpm: null,
      medianIbiBpm: null,
      fftBpm: null,
      autocorrBpm: null,
      agreementBpm: 999,
    },
    quality: createEmptySignalQuality(),
    evidence: {
      camera,
      roi: {
        roi: { x: 0, y: 0, width: 0, height: 0 },
        meanRgb: { r: 0, g: 0, b: 0 },
        medianRgb: { r: 0, g: 0, b: 0 },
        p5Rgb: { r: 0, g: 0, b: 0 },
        p95Rgb: { r: 0, g: 0, b: 0 },
        linearMean: { r: 0, g: 0, b: 0 },
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
        coverageScore: 0,
        illuminationScore: 0,
        contactScore: 0,
        redDominance: 0,
        greenPulseAvailability: 0,
        pressureRisk: 0,
        motionRisk: 0,
        reason: ["INSUFFICIENT_VALID_PIXELS"],
        accepted: false,
        tiles: [],
        usableTileCount: 0,
        tileCount: 25,
        roiStabilityScore: 0,
        perfusionScore: 0,
        saturationScore: 0,
        motionScore: 0,
        opticalContactScore: 0,
        channelUsable: { r: false, g: false, b: false },
        contactState: "absent",
        pressureState: "weak_contact",
        userGuidance: "Cubrí la cámara con el dedo.",
      },
      channels: {
        t: 0,
        g1: 0,
        g2: 0,
        g3: 0,
        selected: 0,
        selectedName: "GREEN_OD",
        channelSnr: { g1: -60, g2: -60, g3: -60 },
        allChannels: [],
        selectionReason: "NO_CHANNELS",
      },
    },
    message: NO_SIGNAL_MESSAGE,
    goodWindowStreak: 0,
    lastValidTimestamp: null,
    rejectedBeatCandidates: 0,
    lastValidBpm: null,
    staleSinceMs: 0,
    staleBadge: "never",
  };
}

export class PPGPublicationGate {
  private goodWindowStreak = 0;
  private lastWindowBucket = -1;
  private wasValid = false;
  private lastValidBpm: number | null = null;
  private lastValidAtMs: number | null = null;

  reset(): void {
    this.goodWindowStreak = 0;
    this.lastWindowBucket = -1;
    this.wasValid = false;
    this.lastValidBpm = null;
    this.lastValidAtMs = null;
  }

  evaluate(params: {
    camera: PPGCameraState;
    roi: FingerOpticalEvidence;
    channels: FusedPPGChannels;
    quality: PPGSignalQuality;
    beats: BeatDetectionResult;
    opticalSamples: PPGOpticalSample[];
    selectedSeries: TimeSample[];
    /** 0..100 — sampler cadence quality (rVFC jitter / dropped frames). */
    fpsQuality?: number;
  }): PublishedPPGMeasurement {
    const {
      camera,
      roi,
      channels,
      quality,
      beats,
      opticalSamples,
      selectedSeries,
      fpsQuality = 100,
    } = params;
    const reasons = new Set<string>(quality.reasons);
    const bufferMs = opticalSamples.length >= 2 ? opticalSamples[opticalSamples.length - 1].t - opticalSamples[0].t : 0;
    const selectedDurationMs = durationMs(selectedSeries);
    const validBeats = beats.beats.filter((beat) => beat.confidence >= 0.55);
    const bradycardiaWindowAllowed =
      beats.bpm !== null && beats.bpm < 45 && bufferMs >= 14000 && validBeats.length >= 4;
    const enoughBeats = validBeats.length >= 5 || bradycardiaWindowAllowed;
    const torchCondition = !camera.torchAvailable || camera.torchEnabled;
    const saturationOk = quality.saturationPenalty <= 0.55;
    const perfusionOk = quality.acDcPerfusionIndex >= 0.02;
    // Multi-estimator agreement (informative, not a hard binary lock)
    const estimatorAgreementBpm = beats.estimatorAgreementBpm ?? 999;
    const estimatorsAvailable =
      Number(beats.fftBpm !== null) +
      Number(beats.autocorrBpm !== null) +
      Number(beats.bpm !== null);
    // Require at least 2 estimators agreeing within 8 BPM, OR a single
    // very-high-confidence temporal detection with strong band power.
    const twoEstimatorsAgree = estimatorsAvailable >= 2 && estimatorAgreementBpm <= 8;
    const strongTemporalAlone =
      beats.bpm !== null &&
      beats.confidence >= 0.7 &&
      quality.bandPowerRatio >= 0.45 &&
      quality.rrConsistency >= 0.6;
    const agreementOk = twoEstimatorsAgree || strongTemporalAlone;

    // Sampler cadence quality must be high enough that the temporal axis is
    // physically meaningful. Below 40 we don't trust BPM at all.
    const fpsQualityOk = fpsQuality >= 40;
    // Tile-based hard gate: BPM/SpO2 require enough usable optical real estate.
    const tileGateOk = roi.usableTileCount >= 6 && roi.roiStabilityScore >= 0.4;
    // Contact state veto for any heart-rate publication.
    const contactStateOk =
      roi.contactState === "stable" || roi.contactState === "partial";

    const coreQualityPass =
      quality.totalScore >= 60 &&
      quality.bandPowerRatio >= 0.30 &&
      agreementOk &&
      roi.contactScore >= 0.45 &&
      saturationOk &&
      perfusionOk &&
      quality.rrConsistency >= 0.4 &&
      beats.confidence >= 0.45 &&
      fpsQualityOk &&
      tileGateOk &&
      contactStateOk;

    if (!camera.cameraReady) reasons.add("CAMERA_NOT_READY");
    if (!torchCondition) reasons.add("TORCH_NOT_ENABLED");
    if (bufferMs < 6000 || selectedDurationMs < 6000) reasons.add("BUFFER_LT_6S");
    if (bufferMs < 10000) reasons.add("BUFFER_LT_10S_PREFERRED");
    if (!enoughBeats) reasons.add("NOT_ENOUGH_VALID_BEATS");
    if (!agreementOk) reasons.add(`ESTIMATOR_AGREEMENT_${estimatorAgreementBpm.toFixed(1)}_BPM`);
    if (estimatorsAvailable < 2 && !strongTemporalAlone) reasons.add("INSUFFICIENT_ESTIMATORS");
    if (!saturationOk) reasons.add("SATURATION_DESTRUCTIVE");
    if (!perfusionOk) reasons.add("PERFUSION_BELOW_THRESHOLD");
    if (quality.rrConsistency < 0.4) reasons.add("RR_CHAOTIC_OR_INSUFFICIENT");
    if (!fpsQualityOk) reasons.add(`FPS_QUALITY_LOW_${fpsQuality.toFixed(0)}`);
    if (!tileGateOk) reasons.add(`TILE_GATE_FAIL_${roi.usableTileCount}/${roi.tileCount}`);
    if (!contactStateOk) reasons.add(`CONTACT_STATE_${roi.contactState.toUpperCase()}`);

    const now = opticalSamples[opticalSamples.length - 1]?.t ?? channels.t;
    const windowBucket = Math.floor(now / 2000);
    if (windowBucket !== this.lastWindowBucket) {
      this.lastWindowBucket = windowBucket;
      if (coreQualityPass && bufferMs >= 4000) {
        this.goodWindowStreak += 1;
      } else {
        this.goodWindowStreak = 0;
      }
    }

    let state: PublicationState = "CAMERA_READY_NO_PPG";
    if (camera.error) {
      state = "ERROR";
    } else if (!camera.cameraReady) {
      state = "CAMERA_STARTING";
    } else if (bufferMs < 1200 || roi.contactScore < 0.25) {
      state = "CAMERA_READY_NO_PPG";
    } else if (bufferMs < 6000) {
      state = "ACQUIRING_BASELINE";
    } else if (quality.totalScore < 35) {
      state = this.wasValid ? "PPG_LOST" : "PPG_WEAK";
    } else if (coreQualityPass && this.goodWindowStreak >= 2 && enoughBeats) {
      state = "PPG_VALID";
    } else {
      state = this.wasValid ? "PPG_LOST" : "PPG_VALIDATING";
    }

    const canPublishVitals =
      state === "PPG_VALID" &&
      camera.cameraReady &&
      torchCondition &&
      bufferMs >= 6000 &&
      selectedDurationMs >= 6000 &&
      enoughBeats &&
      coreQualityPass &&
      this.goodWindowStreak >= 2 &&
      beats.bpm !== null;

    // Quality dropped — wasValid transition handled below; nothing else to clear
    // because publication is recomputed every window from `canPublishVitals`.

    this.wasValid = canPublishVitals;

    const lastBeat = beats.beats[beats.beats.length - 1];
    const canVibrateBeat =
      canPublishVitals &&
      state === "PPG_VALID" &&
      Boolean(lastBeat) &&
      lastBeat.confidence >= 0.75 &&
      quality.totalScore >= 70 &&
      !lastBeat.rejectionReason;

    // Check if selectedSeries contains real data (not all zeros)
    const hasRealData = selectedSeries.some((s) => Math.abs(s.value) > 0.001);

    const waveformSource: PublishedPPGMeasurement["waveformSource"] = canPublishVitals
      ? "REAL_PPG"
      : hasRealData && selectedSeries.length >= 3
        ? "RAW_DEBUG_ONLY"
        : "NONE";

    // SpO2 needs BOTH red AND green to be optically valid (Ratio-of-Ratios).
    // If red is saturated under flash but green is fine, we still publish BPM
    // (handled above) but block SpO2 explicitly so the user is not misled.
    const spo2ChannelsOk = roi.channelUsable.r && roi.channelUsable.g;
    const oxygen = estimateCameraSpO2({
      samples: opticalSamples,
      quality,
      canPublishVitals: canPublishVitals && spo2ChannelsOk,
      calibrationBadge: camera.diagnostics?.calibration.status ?? "uncalibrated",
    });
    if (!spo2ChannelsOk) {
      oxygen.canPublish = false;
      if (!oxygen.reasons.includes("CHANNEL_RED_OR_GREEN_UNUSABLE")) {
        oxygen.reasons = [...oxygen.reasons, "CHANNEL_RED_OR_GREEN_UNUSABLE"];
      }
    }

    const nowMs = opticalSamples[opticalSamples.length - 1]?.t ?? channels.t;
    let lastValidTimestamp: number | null = null;
    if (canPublishVitals && beats.bpm !== null) {
      lastValidTimestamp = nowMs;
      this.lastValidBpm = Math.round(beats.bpm);
      this.lastValidAtMs = nowMs;
    }

    // Stale-publication ledger. NEVER substitutes the fresh `bpm` value —
    // only exposes "what was the last valid number and how old is it" so
    // the UI can render a dimmed "stale 3.2s" badge instead of a number
    // that looks fresh.
    let staleSinceMs = 0;
    let staleBadge: PublishedPPGMeasurement["staleBadge"] = "never";
    if (this.lastValidAtMs !== null) {
      if (canPublishVitals) {
        staleBadge = "fresh";
        staleSinceMs = 0;
      } else {
        staleSinceMs = Math.max(0, nowMs - this.lastValidAtMs);
        staleBadge = staleSinceMs <= 6000 ? "stale" : "expired";
      }
    }

    return {
      state,
      canPublishVitals,
      canVibrateBeat,
      bpm: canPublishVitals && beats.bpm !== null ? Math.round(beats.bpm) : null,
      bpmConfidence: canPublishVitals ? beats.confidence : 0,
      oxygen,
      waveformSource,
      beatMarkers: canPublishVitals
        ? beats.beats.slice(-16).map((beat) => ({
            t: beat.t,
            confidence: beat.confidence,
            onsetT: beat.onsetT,
            troughT: beat.troughT,
          }))
        : [],
      withheldBeatMarkers: beats.withheldBeats
        .slice(-12)
        .map((beat) => ({ t: beat.t, reason: beat.rejectionReason ?? "UNKNOWN" })),
      irregularityFlag: beats.irregularityFlag,
      estimatorBreakdown: {
        peakBpm: beats.peakBpm,
        medianIbiBpm: beats.medianIbiBpm,
        fftBpm: beats.fftBpm,
        autocorrBpm: beats.autocorrBpm,
        agreementBpm: beats.estimatorAgreementBpm,
        publicationException: beats.publicationException,
      },
      quality: {
        ...quality,
        reasons: [...new Set([...quality.reasons, ...reasons, ...oxygen.reasons])],
      },
      evidence: { camera, roi, channels },
      message: canPublishVitals ? "PPG VALIDADA" : NO_SIGNAL_MESSAGE,
      goodWindowStreak: this.goodWindowStreak,
      lastValidTimestamp,
      rejectedBeatCandidates: beats.rejectedCandidates,
      lastValidBpm: this.lastValidBpm,
      staleSinceMs,
      staleBadge,
    };
  }
}
