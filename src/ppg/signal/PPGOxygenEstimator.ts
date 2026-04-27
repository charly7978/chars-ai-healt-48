import { clamp, mad, median } from "./PPGFilters";
import type { PPGOpticalSample } from "./RadiometricPPGExtractor";
import type { PPGSignalQuality } from "./PPGSignalQuality";

export interface PublishedOxygenMeasurement {
  spo2: number | null;
  confidence: number;
  canPublish: boolean;
  method: "CAMERA_RGB_RATIO_OF_RATIOS" | "NONE";
  reasons: string[];
}

function percentile(values: number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function robustAc(values: number[]): number {
  return Math.max(0, percentile(values, 0.95) - percentile(values, 0.05));
}

function robustNoise(values: number[]): number {
  return 1.4826 * mad(values) || 1e-6;
}

export function estimateCameraSpO2(params: {
  samples: PPGOpticalSample[];
  quality: PPGSignalQuality;
  canPublishVitals: boolean;
}): PublishedOxygenMeasurement {
  const { samples, quality, canPublishVitals } = params;
  const reasons: string[] = [];

  if (!canPublishVitals) reasons.push("PPG_NOT_VALIDATED");
  if (samples.length < 180) reasons.push("OXYGEN_BUFFER_SHORT");
  if (quality.totalScore < 75) reasons.push("SQI_BELOW_OXYGEN_THRESHOLD");
  if (quality.estimatorAgreementBpm > 5) reasons.push("BPM_ESTIMATORS_NOT_LOCKED");

  const last = samples[samples.length - 1];
  if (!last) {
    return {
      spo2: null,
      confidence: 0,
      canPublish: false,
      method: "NONE",
      reasons: ["NO_OPTICAL_SAMPLES"],
    };
  }

  const highSat = Math.max(last.saturation.rHigh, last.saturation.gHigh, last.saturation.bHigh);
  if (highSat > 0.12) reasons.push("OXYGEN_CHANNEL_SATURATION");

  const recent = samples.slice(-360);
  const odR = recent.map((sample) => sample.od.r);
  const odG = recent.map((sample) => sample.od.g);
  const odB = recent.map((sample) => sample.od.b);
  const dcR = median(recent.map((sample) => sample.dc.r));
  const dcG = median(recent.map((sample) => sample.dc.g));
  const dcB = median(recent.map((sample) => sample.dc.b));
  const acR = robustAc(odR);
  const acG = robustAc(odG);
  const acB = robustAc(odB);
  const noiseR = robustNoise(odR);
  const noiseG = robustNoise(odG);
  const noiseB = robustNoise(odB);
  const snrR = acR / noiseR;
  const snrG = acG / noiseG;
  const snrB = acB / noiseB;

  if (acR < 0.0005 || acG < 0.0005) reasons.push("OXYGEN_AC_TOO_LOW");
  if (snrR < 1.2 || snrG < 1.2) reasons.push("OXYGEN_CHANNEL_SNR_LOW");
  if (dcR <= 0 || dcG <= 0 || dcB <= 0) reasons.push("OXYGEN_DC_INVALID");

  const blueUsable = acB >= 0.00035 && snrB >= 0.9 && last.saturation.bHigh < 0.08;
  const denominator = blueUsable ? acB / Math.max(1e-6, dcB) : acG / Math.max(1e-6, dcG);
  const numerator = acR / Math.max(1e-6, dcR);
  const ratio = numerator / Math.max(1e-6, denominator);

  if (!Number.isFinite(ratio) || ratio <= 0) reasons.push("OXYGEN_RATIO_INVALID");

  const rawSpo2 = blueUsable ? 110 - 25 * ratio : 112 - 31 * ratio;
  const spo2 = Math.round(clamp(rawSpo2, 70, 100));
  const physiological = spo2 >= 70 && spo2 <= 100;
  if (!physiological) reasons.push("OXYGEN_OUT_OF_RANGE");

  const channelScore = clamp((Math.min(snrR, snrG, blueUsable ? snrB : snrG) - 0.9) / 3.2, 0, 1);
  const perfusionScore = clamp(quality.acDcPerfusionIndex / 0.6, 0, 1);
  const confidence = clamp(
    quality.totalScore / 100 * 0.45 +
      channelScore * 0.30 +
      perfusionScore * 0.15 +
      (blueUsable ? 0.10 : 0.04),
    0,
    1,
  );
  if (confidence < 0.72) reasons.push("OXYGEN_CONFIDENCE_LOW");

  const canPublish =
    canPublishVitals &&
    reasons.length === 0 &&
    confidence >= 0.72 &&
    physiological;

  return {
    spo2: canPublish ? spo2 : null,
    confidence: canPublish ? confidence : 0,
    canPublish,
    method: canPublish ? "CAMERA_RGB_RATIO_OF_RATIOS" : "NONE",
    reasons,
  };
}
