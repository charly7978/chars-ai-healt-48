import type { PPGCameraState } from "../camera/PPGCameraController";
import type { FingerOpticalEvidence } from "../roi/FingerOpticalROI";
import type { BeatDetectionResult } from "../signal/BeatDetector";
import type { FusedPPGChannels } from "../signal/PPGChannelFusion";
import type { PPGOpticalSample } from "../signal/RadiometricPPGExtractor";
import {
  createEmptySignalQuality,
  type PPGSignalQuality,
} from "../signal/PPGSignalQuality";
import { durationMs, preprocessPPG, type TimeSample } from "../signal/PPGFilters";

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
  waveform: number[];
  waveformSource: "REAL_PPG" | "RAW_DEBUG_ONLY" | "NONE";
  beatMarkers: Array<{ t: number; confidence: number }>;
  quality: PPGSignalQuality;
  evidence: {
    camera: PPGCameraState;
    roi: FingerOpticalEvidence;
    channels: FusedPPGChannels;
  };
  message: string;
}

const NO_SIGNAL_MESSAGE = "SIN SEÑAL PPG VERIFICABLE";

function waveformFromSeries(series: TimeSample[], maxPoints = 520): number[] {
  if (series.length < 3) return [];
  const processed = preprocessPPG(series, 0.5, 4.0, 30);
  const tail = processed.slice(-maxPoints);
  return tail.map((sample) => sample.value);
}

export function createEmptyPublishedPPGMeasurement(
  camera: PPGCameraState,
): PublishedPPGMeasurement {
  return {
    state: camera.error ? "ERROR" : camera.cameraReady ? "CAMERA_READY_NO_PPG" : "CAMERA_STARTING",
    canPublishVitals: false,
    canVibrateBeat: false,
    bpm: null,
    bpmConfidence: 0,
    waveform: [],
    waveformSource: "NONE",
    beatMarkers: [],
    quality: createEmptySignalQuality(),
    evidence: {
      camera,
      roi: {
        roi: { x: 0, y: 0, width: 0, height: 0 },
        meanRgb: { r: 0, g: 0, b: 0 },
        medianRgb: { r: 0, g: 0, b: 0 },
        p5Rgb: { r: 0, g: 0, b: 0 },
        p95Rgb: { r: 0, g: 0, b: 0 },
        highSaturation: { r: 0, g: 0, b: 0 },
        lowSaturation: { r: 0, g: 0, b: 0 },
        spatialVariance: 0,
        dcStability: 0,
        coverageScore: 0,
        illuminationScore: 0,
        contactScore: 0,
        reason: ["NO_ROI"],
      },
      channels: {
        t: 0,
        g1: 0,
        g2: 0,
        g3: 0,
        selected: 0,
        selectedName: "G1_GREEN_OD",
        channelSnr: { g1: -60, g2: -60, g3: -60 },
      },
    },
    message: NO_SIGNAL_MESSAGE,
  };
}

export class PPGPublicationGate {
  private goodWindowStreak = 0;
  private lastWindowBucket = -1;
  private wasValid = false;

  reset(): void {
    this.goodWindowStreak = 0;
    this.lastWindowBucket = -1;
    this.wasValid = false;
  }

  evaluate(params: {
    camera: PPGCameraState;
    roi: FingerOpticalEvidence;
    channels: FusedPPGChannels;
    quality: PPGSignalQuality;
    beats: BeatDetectionResult;
    opticalSamples: PPGOpticalSample[];
    selectedSeries: TimeSample[];
  }): PublishedPPGMeasurement {
    const {
      camera,
      roi,
      channels,
      quality,
      beats,
      opticalSamples,
      selectedSeries,
    } = params;
    const reasons = new Set<string>(quality.reasons);
    const bufferMs = opticalSamples.length >= 2 ? opticalSamples[opticalSamples.length - 1].t - opticalSamples[0].t : 0;
    const selectedDurationMs = durationMs(selectedSeries);
    const validBeats = beats.beats.filter((beat) => beat.confidence >= 0.65);
    const bradycardiaWindowAllowed =
      beats.bpm !== null && beats.bpm < 45 && bufferMs >= 14000 && validBeats.length >= 4;
    const enoughBeats = validBeats.length >= 6 || bradycardiaWindowAllowed;
    const torchCondition = !camera.torchAvailable || camera.torchEnabled;
    const saturationOk = quality.saturationPenalty <= 0.45;
    const perfusionOk = quality.acDcPerfusionIndex >= 0.03;
    const agreementOk = quality.estimatorAgreementBpm <= 5;
    const estimatorsOk =
      quality.fftBpm !== null && quality.autocorrBpm !== null && quality.peakBpm !== null;
    const coreQualityPass =
      quality.totalScore >= 70 &&
      quality.bandPowerRatio >= 0.35 &&
      agreementOk &&
      estimatorsOk &&
      roi.contactScore >= 0.55 &&
      saturationOk &&
      perfusionOk &&
      quality.rrConsistency >= 0.45 &&
      beats.confidence >= 0.55;

    if (!camera.cameraReady) reasons.add("CAMERA_NOT_READY");
    if (!torchCondition) reasons.add("TORCH_NOT_ENABLED");
    if (bufferMs < 8000 || selectedDurationMs < 8000) reasons.add("BUFFER_LT_8S");
    if (!enoughBeats) reasons.add("NOT_ENOUGH_VALID_BEATS");
    if (!agreementOk) reasons.add("ESTIMATOR_AGREEMENT_GT_5_BPM");
    if (!estimatorsOk) reasons.add("MISSING_REQUIRED_ESTIMATOR");
    if (!saturationOk) reasons.add("SATURATION_DESTRUCTIVE");
    if (!perfusionOk) reasons.add("PERFUSION_BELOW_THRESHOLD");
    if (quality.rrConsistency < 0.45) reasons.add("RR_CHAOTIC_OR_INSUFFICIENT");

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
    } else if (bufferMs < 1200 || roi.contactScore < 0.30) {
      state = "CAMERA_READY_NO_PPG";
    } else if (bufferMs < 8000) {
      state = "ACQUIRING_BASELINE";
    } else if (quality.totalScore < 45) {
      state = this.wasValid ? "PPG_LOST" : "PPG_WEAK";
    } else if (coreQualityPass && this.goodWindowStreak >= 3 && enoughBeats) {
      state = "PPG_VALID";
    } else {
      state = this.wasValid ? "PPG_LOST" : "PPG_VALIDATING";
    }

    const canPublishVitals =
      state === "PPG_VALID" &&
      camera.cameraReady &&
      torchCondition &&
      bufferMs >= 8000 &&
      selectedDurationMs >= 8000 &&
      enoughBeats &&
      coreQualityPass &&
      this.goodWindowStreak >= 3 &&
      beats.bpm !== null;

    this.wasValid = canPublishVitals;

    const lastBeat = beats.beats[beats.beats.length - 1];
    const canVibrateBeat =
      canPublishVitals &&
      Boolean(lastBeat) &&
      lastBeat.confidence >= 0.75 &&
      quality.totalScore >= 70;

    const waveformSource: PublishedPPGMeasurement["waveformSource"] = canPublishVitals
      ? "REAL_PPG"
      : selectedSeries.length >= 3
        ? "RAW_DEBUG_ONLY"
        : "NONE";

    return {
      state,
      canPublishVitals,
      canVibrateBeat,
      bpm: canPublishVitals && beats.bpm !== null ? Math.round(beats.bpm) : null,
      bpmConfidence: canPublishVitals ? beats.confidence : 0,
      waveform: waveformSource === "NONE" ? [] : waveformFromSeries(selectedSeries),
      waveformSource,
      beatMarkers: canPublishVitals
        ? beats.beats.slice(-16).map((beat) => ({ t: beat.t, confidence: beat.confidence }))
        : [],
      quality: {
        ...quality,
        reasons: [...new Set([...quality.reasons, ...reasons])],
      },
      evidence: { camera, roi, channels },
      message: canPublishVitals ? "PPG VALIDADA" : NO_SIGNAL_MESSAGE,
    };
  }
}
