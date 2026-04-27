import type { FingerOpticalEvidence } from "../roi/FingerOpticalROI";
import type { PPGOpticalSample } from "./RadiometricPPGExtractor";
import type { FusedPPGChannels } from "./PPGChannelFusion";
import type { BeatDetectionResult } from "./BeatDetector";
import {
  autocorrBpm,
  clamp,
  durationMs,
  mean,
  median,
  preprocessPPGRobust,
  spectralMetrics,
  type TimeSample,
} from "./PPGFilters";

export interface PPGSignalQuality {
  contactScore: number;
  illuminationScore: number;
  saturationPenalty: number;
  motionLikeNoise: number;
  bandPowerRatio: number;
  dominantFrequencyHz: number;
  dominantFrequencyBpm: number;
  spectralPeakProminence: number;
  /** Ratio of 2nd harmonic power to fundamental (healthy PPG: 0.15-0.35) */
  harmonic2Ratio: number;
  /** Consistency of harmonic structure: 1 = perfect, 0 = none */
  harmonicConsistency: number;
  autocorrBpm: number | null;
  fftBpm: number | null;
  peakBpm: number | null;
  estimatorAgreementBpm: number;
  acDcPerfusionIndex: number;
  snrDb: number;
  rrConsistency: number;
  morphologyScore: number;
  baselineStability: number;
  totalScore: number;
  grade: "NO_SIGNAL" | "WEAK" | "FAIR" | "GOOD" | "EXCELLENT";
  reasons: string[];
}

export function createEmptySignalQuality(reasons: string[] = ["NO_REAL_PPG_WINDOW"]): PPGSignalQuality {
  return {
    contactScore: 0,
    illuminationScore: 0,
    saturationPenalty: 1,
    motionLikeNoise: 1,
    bandPowerRatio: 0,
    dominantFrequencyHz: 0,
    dominantFrequencyBpm: 0,
    spectralPeakProminence: 0,
    harmonic2Ratio: 0,
    harmonicConsistency: 0,
    autocorrBpm: null,
    fftBpm: null,
    peakBpm: null,
    estimatorAgreementBpm: 999,
    acDcPerfusionIndex: 0,
    snrDb: -60,
    rrConsistency: 0,
    morphologyScore: 0,
    baselineStability: 0,
    totalScore: 0,
    grade: "NO_SIGNAL",
    reasons,
  };
}

function grade(totalScore: number): PPGSignalQuality["grade"] {
  if (totalScore < 25) return "NO_SIGNAL";
  if (totalScore < 45) return "WEAK";
  if (totalScore < 65) return "FAIR";
  if (totalScore < 82) return "GOOD";
  return "EXCELLENT";
}

function scoreAgreement(estimates: number[]): number {
  if (estimates.length < 2) return 999;
  return Math.max(...estimates) - Math.min(...estimates);
}

function rrConsistency(rrIntervalsMs: number[]): number {
  if (rrIntervalsMs.length < 3) return 0;
  const rrMedian = median(rrIntervalsMs);
  const deviations = rrIntervalsMs.map((rr) => Math.abs(rr - rrMedian));
  return clamp(1 - median(deviations) / Math.max(1, rrMedian), 0, 1);
}

export class PPGSignalQualityAnalyzer {
  evaluate(params: {
    selectedSeries: TimeSample[];
    opticalSamples: PPGOpticalSample[];
    roi: FingerOpticalEvidence;
    channels: FusedPPGChannels;
    beats: BeatDetectionResult;
  }): PPGSignalQuality {
    const { selectedSeries, opticalSamples, roi, beats } = params;
    const reasons = new Set<string>(roi.reason);

    if (selectedSeries.length < 60 || durationMs(selectedSeries) < 4000) {
      return createEmptySignalQuality(["INSUFFICIENT_REAL_BUFFER", ...reasons]);
    }

    // Derive target Fs from optical samples, limit to reasonable range
    const avgFps = mean(opticalSamples.map((s) => s.fps));
    const targetFs = clamp(avgFps, 15, 60);

    const preprocessResult = preprocessPPGRobust(selectedSeries, 0.5, 4.0, targetFs);
    if (!preprocessResult.valid) {
      return createEmptySignalQuality(["RESAMPLE_FAILED", ...reasons]);
    }
    const signal = preprocessResult.samples;

    const spectral = spectralMetrics(signal, 0.5, 4.0);
    const autocorr = autocorrBpm(signal);
    const fftBpm =
      spectral.bandPowerRatio >= 0.35 && spectral.spectralPeakProminence >= 2
        ? spectral.dominantFrequencyBpm
        : null;
    const peakBpm = beats.bpm && beats.confidence >= 0.35 ? beats.bpm : null;
    const estimates = [fftBpm, autocorr.bpm, peakBpm].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    const estimatorAgreementBpm = scoreAgreement(estimates);
    const saturationPenalty = clamp(
      Math.max(
        roi.highSaturation.r,
        roi.highSaturation.g,
        roi.highSaturation.b,
        roi.lowSaturation.r,
        roi.lowSaturation.g,
        roi.lowSaturation.b,
      ) * 2.2,
      0,
      1,
    );
    const perfusionValues = opticalSamples.flatMap((sample) => [
      sample.perfusion.r,
      sample.perfusion.g,
      sample.perfusion.b,
    ]);
    const acDcPerfusionIndex = mean(perfusionValues);

    // Calculate baseline stability from optical samples
    const baselineValidRatio = opticalSamples.filter((s) => s.baselineValid).length / opticalSamples.length;
    const baselineStability = baselineValidRatio * roi.dcStability;
    const rrScore = rrConsistency(beats.rrIntervalsMs);
    const morphologyScore =
      beats.beats.length > 0
        ? mean(beats.beats.slice(-8).map((beat) => beat.confidence))
        : 0;
    const motionLikeNoise = clamp(
      (1 - spectral.bandPowerRatio) * 0.65 + (1 - roi.dcStability) * 0.35,
      0,
      1,
    );

    if (roi.contactScore < 0.55) reasons.add("CONTACT_SCORE_LOW");
    if (roi.illuminationScore < 0.50) reasons.add("ILLUMINATION_SCORE_LOW");
    if (saturationPenalty > 0.45) reasons.add("SATURATION_DESTRUCTIVE");
    if (spectral.bandPowerRatio < 0.35) reasons.add("LOW_BAND_POWER_RATIO");
    if (spectral.spectralPeakProminence < 2) reasons.add("SPECTRAL_PEAK_WEAK");
    if (autocorr.bpm === null) reasons.add("AUTOCORR_NO_STABLE_PERIOD");
    if (peakBpm === null) reasons.add("PEAK_ESTIMATOR_UNAVAILABLE");
    if (estimatorAgreementBpm > 5) reasons.add("ESTIMATORS_DISAGREE");
    if (acDcPerfusionIndex < 0.03) reasons.add("PERFUSION_TOO_LOW");
    if (rrScore < 0.55 && beats.rrIntervalsMs.length >= 3) reasons.add("RR_INCONSISTENT");
    if (spectral.harmonicConsistency < 0.3) reasons.add("LOW_HARMONIC_CONSISTENCY");

    const contactPart = roi.contactScore * 16;
    const illuminationPart = roi.illuminationScore * 10;
    const saturationPart = (1 - saturationPenalty) * 10;
    const bandPart = clamp(spectral.bandPowerRatio / 0.75, 0, 1) * 16;
    const prominencePart = clamp(Math.log10(spectral.spectralPeakProminence + 1) / 1.1, 0, 1) * 12;
    const agreementPart =
      estimatorAgreementBpm <= 5 ? 14 : estimatorAgreementBpm <= 10 ? 7 : 0;
    const perfusionPart = clamp(acDcPerfusionIndex / 0.4, 0, 1) * 8;
    const snrPart = clamp((spectral.snrDb + 6) / 20, 0, 1) * 8;
    const rrPart = rrScore * 4;
    const morphologyPart = morphologyScore * 2;

    let totalScore =
      contactPart +
      illuminationPart +
      saturationPart +
      bandPart +
      prominencePart +
      agreementPart +
      perfusionPart +
      snrPart +
      rrPart +
      morphologyPart;

    if (roi.contactScore < 0.35) totalScore = Math.min(totalScore, 30);
    if (spectral.bandPowerRatio < 0.25) totalScore = Math.min(totalScore, 45);
    if (estimates.length < 2) totalScore = Math.min(totalScore, 58);
    if (saturationPenalty > 0.60) totalScore = Math.min(totalScore, 38);
    if (motionLikeNoise > 0.75) totalScore = Math.min(totalScore, 55);

    totalScore = clamp(totalScore, 0, 100);

    return {
      contactScore: roi.contactScore,
      illuminationScore: roi.illuminationScore,
      saturationPenalty,
      motionLikeNoise,
      bandPowerRatio: spectral.bandPowerRatio,
      dominantFrequencyHz: spectral.dominantFrequencyHz,
      dominantFrequencyBpm: spectral.dominantFrequencyBpm,
      spectralPeakProminence: spectral.spectralPeakProminence,
      harmonic2Ratio: spectral.harmonic2Ratio,
      harmonicConsistency: spectral.harmonicConsistency,
      autocorrBpm: autocorr.bpm,
      fftBpm,
      peakBpm,
      estimatorAgreementBpm,
      acDcPerfusionIndex,
      snrDb: spectral.snrDb,
      rrConsistency: rrScore,
      morphologyScore,
      baselineStability,
      totalScore,
      grade: grade(totalScore),
      reasons: [...reasons],
    };
  }
}
