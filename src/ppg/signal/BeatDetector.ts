import {
  autocorrBpm,
  clamp,
  durationMs,
  mad,
  median,
  mean,
  preprocessPPGRobust,
  spectralMetrics,
  type TimeSample,
} from "./PPGFilters";

export interface Beat {
  t: number;
  amplitude: number;
  prominence: number;
  rrMs?: number;
  confidence: number;
  rejectionReason?: string;
  valleyPeakDistance?: number;
  pulseWidth?: number;
  upSlope?: number;
  downSlope?: number;
}

export interface BeatDetectionResult {
  beats: Beat[];
  bpm: number | null;
  rrIntervalsMs: number[];
  confidence: number;
  fftBpm?: number | null;
  autocorrBpm?: number | null;
  estimatorAgreementBpm?: number;
  rejectedCandidates: number;
}

function emptyResult(): BeatDetectionResult {
  return {
    beats: [],
    bpm: null,
    rrIntervalsMs: [],
    confidence: 0,
    rejectedCandidates: 0,
  };
}

export class BeatDetector {
  private readonly minBpm = 30;
  private readonly maxBpm = 220;
  private readonly minRefractoryMs = 300; // Physiologic minimum
  private readonly minDistanceMs = 60000 / this.maxBpm;
  private readonly maxDistanceMs = 60000 / this.minBpm;

  reset(): void {
    // Stateless window detector.
  }

  detect(samples: TimeSample[]): BeatDetectionResult {
    if (samples.length < 40 || durationMs(samples) < 3500) {
      return emptyResult();
    }

    // Derive target Fs from samples, limit to reasonable range
    const avgFps = 1000 / (durationMs(samples) / samples.length);
    const targetFs = clamp(avgFps, 15, 60);

    const preprocessResult = preprocessPPGRobust(samples, 0.5, 4.0, targetFs);
    if (!preprocessResult.valid) {
      return emptyResult();
    }
    const signal = preprocessResult.samples;
    const actualFs = preprocessResult.actualFs;
    if (signal.length < 40) return emptyResult();

    const values = signal.map((sample) => sample.value);
    const med = median(values);
    const scale = 1.4826 * mad(values) || 1;
    const threshold = med + Math.max(0.35, scale * 0.45);
    const candidates: Beat[] = [];
    let rejectedCount = 0;

    for (let i = 2; i < signal.length - 2; i += 1) {
      const prev = values[i - 1];
      const value = values[i];
      const next = values[i + 1];
      if (!(value > prev && value >= next && value > threshold)) continue;

      const left = this.localMinimum(values, Math.max(0, i - 15), i);
      const right = this.localMinimum(values, i + 1, Math.min(values.length, i + 16));
      const prominence = value - Math.max(left, right);
      if (prominence < Math.max(0.35, scale * 0.55)) continue;

      const upSlope = value - values[Math.max(0, i - 2)];
      const downSlope = value - values[Math.min(values.length - 1, i + 2)];
      if (upSlope <= 0 || downSlope < -0.15) {
        rejectedCount++;
        continue;
      }

      // Valley-peak distance
      const valleyPeakDistance = value - left;
      if (valleyPeakDistance < Math.max(0.3, scale * 0.4)) {
        rejectedCount++;
        continue;
      }

      // Pulse width (FWHM approximation)
      const halfHeight = left + (value - left) * 0.5;
      let leftHalf = i;
      while (leftHalf > 0 && values[leftHalf] > halfHeight) leftHalf--;
      let rightHalf = i;
      while (rightHalf < values.length - 1 && values[rightHalf] > halfHeight) rightHalf++;
      const pulseWidth = (rightHalf - leftHalf) / actualFs * 1000; // ms
      if (pulseWidth < 150 || pulseWidth > 600) {
        rejectedCount++;
        continue;
      }

      const previous = candidates[candidates.length - 1];
      if (previous && signal[i].t - previous.t < this.minRefractoryMs) {
        rejectedCount++;
        if (prominence > previous.prominence) {
          candidates[candidates.length - 1] = {
            t: signal[i].t,
            amplitude: value,
            prominence,
            confidence: this.peakConfidence(prominence, scale, upSlope, downSlope),
            valleyPeakDistance,
            pulseWidth,
            upSlope,
            downSlope,
          };
        }
        continue;
      }

      candidates.push({
        t: signal[i].t,
        amplitude: value,
        prominence,
        confidence: this.peakConfidence(prominence, scale, upSlope, downSlope),
        valleyPeakDistance,
        pulseWidth,
        upSlope,
        downSlope,
      });
    }

    const beats: Beat[] = [];
    const rrIntervalsMs: number[] = [];
    for (const beat of candidates) {
      const previous = beats[beats.length - 1];
      if (previous) {
        const rrMs = beat.t - previous.t;
        if (rrMs < this.minDistanceMs || rrMs > this.maxDistanceMs) {
          beat.rejectionReason = "RR_OUT_OF_RANGE";
          rejectedCount++;
          continue;
        }
        beat.rrMs = rrMs;
        rrIntervalsMs.push(rrMs);
      }
      beats.push(beat);
    }

    if (beats.length < 2 || rrIntervalsMs.length === 0) {
      return {
        beats,
        bpm: null,
        rrIntervalsMs,
        confidence: beats.length ? Math.max(...beats.map((beat) => beat.confidence)) * 0.35 : 0,
        rejectedCandidates: rejectedCount,
      };
    }

    const rrMedian = median(rrIntervalsMs);
    const rrDev = median(rrIntervalsMs.map((rr) => Math.abs(rr - rrMedian)));
    const rrConsistency = clamp(1 - rrDev / Math.max(1, rrMedian), 0, 1);
    const meanBeatConfidence =
      beats.reduce((sum, beat) => sum + beat.confidence, 0) / Math.max(1, beats.length);
    const bpm = 60000 / rrMedian;

    if (bpm < this.minBpm || bpm > this.maxBpm) {
      return { beats, bpm: null, rrIntervalsMs, confidence: 0, rejectedCandidates: rejectedCount };
    }

    // Multi-estimator: peaks, FFT, autocorr
    const spectral = spectralMetrics(signal, 0.5, 4.0);
    const fftBpmValue = spectral.bandPowerRatio >= 0.30 ? spectral.dominantFrequencyBpm : null;
    const autocorrResult = autocorrBpm(signal, this.minBpm, this.maxBpm);
    const autocorrBpmValue = autocorrResult.bpm;

    // Calculate estimator agreement
    const estimates = [bpm, fftBpmValue, autocorrBpmValue].filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value),
    );
    let estimatorAgreementBpm = 999;
    if (estimates.length >= 2) {
      estimatorAgreementBpm = Math.max(...estimates) - Math.min(...estimates);
    }

    // Quality-aware confidence: do NOT zero-out the temporal BPM when fewer
    // estimators agree. Downstream gate decides whether to publish.
    let confidenceFactor = 1.0;
    if (estimates.length < 2) confidenceFactor *= 0.5;
    else if (estimatorAgreementBpm > 12) confidenceFactor *= 0.5;
    else if (estimatorAgreementBpm > 6) confidenceFactor *= 0.75;

    if (beats.length < 4) confidenceFactor *= 0.6;
    else if (beats.length < 6 && bpm > 50) confidenceFactor *= 0.85;

    return {
      beats,
      bpm,
      rrIntervalsMs,
      confidence: clamp(meanBeatConfidence * 0.6 + rrConsistency * 0.4, 0, 1),
      fftBpm,
      autocorrBpm,
      estimatorAgreementBpm,
      rejectedCandidates: rejectedCount,
    };
  }

  private localMinimum(values: number[], start: number, end: number): number {
    let min = Number.POSITIVE_INFINITY;
    for (let i = start; i < end; i += 1) {
      min = Math.min(min, values[i]);
    }
    return Number.isFinite(min) ? min : 0;
  }

  private peakConfidence(
    prominence: number,
    scale: number,
    upSlope: number,
    downSlope: number,
  ): number {
    const promScore = clamp(prominence / Math.max(0.8, scale * 1.6), 0, 1);
    const slopeScore = clamp((Math.max(0, upSlope) + Math.max(0, downSlope)) / 1.2, 0, 1);
    return clamp(promScore * 0.7 + slopeScore * 0.3, 0, 1);
  }
}
