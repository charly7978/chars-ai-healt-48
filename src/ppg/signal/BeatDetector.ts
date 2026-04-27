import {
  clamp,
  durationMs,
  mad,
  median,
  preprocessPPG,
  type TimeSample,
} from "./PPGFilters";

export interface BeatDetectionResult {
  beats: Array<{
    t: number;
    amplitude: number;
    prominence: number;
    rrMs?: number;
    confidence: number;
  }>;
  bpm: number | null;
  rrIntervalsMs: number[];
  confidence: number;
}

function emptyResult(): BeatDetectionResult {
  return {
    beats: [],
    bpm: null,
    rrIntervalsMs: [],
    confidence: 0,
  };
}

export class BeatDetector {
  private readonly minBpm = 35;
  private readonly maxBpm = 200;

  reset(): void {
    // Stateless window detector.
  }

  detect(samples: TimeSample[]): BeatDetectionResult {
    if (samples.length < 40 || durationMs(samples) < 3500) {
      return emptyResult();
    }

    const signal = preprocessPPG(samples, 0.5, 4.0, 30);
    if (signal.length < 40) return emptyResult();

    const values = signal.map((sample) => sample.value);
    const med = median(values);
    const scale = 1.4826 * mad(values) || 1;
    const threshold = med + Math.max(0.35, scale * 0.45);
    const minDistanceMs = 60000 / this.maxBpm;
    const maxDistanceMs = 60000 / this.minBpm;
    const candidates: BeatDetectionResult["beats"] = [];

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
      if (upSlope <= 0 || downSlope < -0.15) continue;

      const previous = candidates[candidates.length - 1];
      if (previous && signal[i].t - previous.t < minDistanceMs) {
        if (prominence > previous.prominence) {
          candidates[candidates.length - 1] = {
            t: signal[i].t,
            amplitude: value,
            prominence,
            confidence: this.peakConfidence(prominence, scale, upSlope, downSlope),
          };
        }
        continue;
      }

      candidates.push({
        t: signal[i].t,
        amplitude: value,
        prominence,
        confidence: this.peakConfidence(prominence, scale, upSlope, downSlope),
      });
    }

    const beats: BeatDetectionResult["beats"] = [];
    const rrIntervalsMs: number[] = [];
    for (const beat of candidates) {
      const previous = beats[beats.length - 1];
      if (previous) {
        const rrMs = beat.t - previous.t;
        if (rrMs < minDistanceMs || rrMs > maxDistanceMs) continue;
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
      };
    }

    const rrMedian = median(rrIntervalsMs);
    const rrDev = median(rrIntervalsMs.map((rr) => Math.abs(rr - rrMedian)));
    const rrConsistency = clamp(1 - rrDev / Math.max(1, rrMedian), 0, 1);
    const meanBeatConfidence =
      beats.reduce((sum, beat) => sum + beat.confidence, 0) / Math.max(1, beats.length);
    const bpm = 60000 / rrMedian;

    if (bpm < this.minBpm || bpm > this.maxBpm) {
      return { beats, bpm: null, rrIntervalsMs, confidence: 0 };
    }

    return {
      beats,
      bpm,
      rrIntervalsMs,
      confidence: clamp(meanBeatConfidence * 0.6 + rrConsistency * 0.4, 0, 1),
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
