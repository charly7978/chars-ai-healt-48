/**
 * Multi-source signal extraction and ranking for PPG.
 * Generates multiple candidate signals and selects the best by SQI.
 */

import { RingBuffer } from './RingBuffer';

export type SourceType =
  | 'RED_NORM'
  | 'GREEN_NORM'
  | 'BLUE_NORM'
  | 'RG_WEIGHTED'
  | 'RED_ABSORBANCE'
  | 'GREEN_ABSORBANCE'
  | 'BLUE_ABSORBANCE'
  | 'TEMPORAL_DIFF'
  | 'COMBINED';

export interface SourceCandidate {
  type: SourceType;
  value: number;
  sqi: number;
  acDc: number;
  perfusionIndex: number;
  driftPenalty: number;
  clipPenalty: number;
}

export interface RankerOutput {
  activeSource: SourceType;
  activeValue: number;
  activeSQI: number;
  candidates: SourceCandidate[];
}

const BUFFER_SIZE = 90; // ~3s at 30fps
const MIN_SWITCH_FRAMES = 15; // hysteresis
const SQI_ADVANTAGE_THRESHOLD = 0.12; // must beat current by this margin

export class SignalSourceRanker {
  private buffers: Map<SourceType, RingBuffer> = new Map();
  private dcBuffers: Map<SourceType, RingBuffer> = new Map();
  private currentSource: SourceType = 'RED_NORM';
  private sourceStableFrames = 0;
  private framesSinceSwitch = 0;

  constructor() {
    const types: SourceType[] = ['RED_NORM', 'GREEN_NORM', 'RG_WEIGHTED', 'RED_ABSORBANCE', 'GREEN_ABSORBANCE', 'TEMPORAL_DIFF', 'COMBINED'];
    for (const t of types) {
      this.buffers.set(t, new RingBuffer(BUFFER_SIZE));
      this.dcBuffers.set(t, new RingBuffer(BUFFER_SIZE));
    }
  }

  /**
   * Push a new frame's ROI-averaged values and get ranked output.
   */
  rank(
    avgR: number, avgG: number, avgB: number,
    prevR: number, prevG: number,
    clipHighRatio: number, clipLowRatio: number
  ): RankerOutput {
    this.framesSinceSwitch++;

    // DC baselines (slow EMA)
    const alpha = 0.05;
    const dcR = this.ema('RED_NORM', avgR, alpha);
    const dcG = this.ema('GREEN_NORM', avgG, alpha);

    // Generate candidate values
    const eps = 1e-6;
    const candidates: { type: SourceType; value: number }[] = [
      { type: 'RED_NORM', value: avgR / (dcR + eps) },
      { type: 'GREEN_NORM', value: avgG / (dcG + eps) },
      { type: 'RG_WEIGHTED', value: (0.6 * avgR + 0.4 * avgG) / (0.6 * dcR + 0.4 * dcG + eps) },
      { type: 'RED_ABSORBANCE', value: -Math.log((avgR + eps) / (dcR + eps)) },
      { type: 'GREEN_ABSORBANCE', value: -Math.log((avgG + eps) / (dcG + eps)) },
      { type: 'TEMPORAL_DIFF', value: avgR - prevR + 0.5 * (avgG - prevG) },
      { type: 'COMBINED', value: 0.5 * (-Math.log((avgR + eps) / (dcR + eps))) + 0.5 * (avgR / (dcR + eps)) }
    ];

    // Push into buffers
    for (const c of candidates) {
      this.buffers.get(c.type)!.push(c.value);
    }

    // Score each candidate
    const clipPenalty = Math.min(1, (clipHighRatio + clipLowRatio) * 3);
    const scored: SourceCandidate[] = candidates.map(c => {
      const buf = this.buffers.get(c.type)!;
      const stats = buf.stats();
      const ac = stats.max - stats.min;
      const dc = Math.abs(stats.mean) + eps;
      const acDc = ac / dc;
      const perfusionIndex = acDc * 100;

      // Drift penalty: how much mean shifted over last 30 samples
      let driftPenalty = 0;
      if (buf.length >= 30) {
        const arr = buf.toArray(30);
        const firstHalf = arr.slice(0, 15).reduce((a, b) => a + b, 0) / 15;
        const secondHalf = arr.slice(15).reduce((a, b) => a + b, 0) / 15;
        driftPenalty = Math.min(1, Math.abs(secondHalf - firstHalf) / (dc + eps) * 5);
      }

      // Periodicity via zero-crossing rate in detrended signal
      let periodicityScore = 0;
      if (buf.length >= 30) {
        const arr = buf.toArray(30);
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        let crossings = 0;
        for (let i = 1; i < arr.length; i++) {
          if ((arr[i] - mean) * (arr[i - 1] - mean) < 0) crossings++;
        }
        // Cardiac band ~0.8-3Hz at 30fps => expect 1.6-6 crossings per 30 samples
        const crossRate = crossings;
        periodicityScore = (crossRate >= 2 && crossRate <= 10) ? Math.min(1, crossRate / 5) : 0.2;
      }

      // SQI composite
      const sqi = Math.max(0, Math.min(1,
        0.3 * Math.min(1, acDc * 20) +
        0.25 * periodicityScore +
        0.15 * (1 - driftPenalty) +
        0.15 * (1 - clipPenalty) +
        0.15 * Math.min(1, buf.length / BUFFER_SIZE)
      ));

      return {
        type: c.type,
        value: c.value,
        sqi,
        acDc,
        perfusionIndex,
        driftPenalty,
        clipPenalty
      };
    });

    // Winner-take-all with hysteresis
    scored.sort((a, b) => b.sqi - a.sqi);
    const best = scored[0];
    const currentCandidate = scored.find(s => s.type === this.currentSource) || best;

    if (
      best.type !== this.currentSource &&
      best.sqi > currentCandidate.sqi + SQI_ADVANTAGE_THRESHOLD &&
      this.framesSinceSwitch >= MIN_SWITCH_FRAMES
    ) {
      console.log(`📊 Source switch: ${this.currentSource} → ${best.type} (SQI ${best.sqi.toFixed(2)} vs ${currentCandidate.sqi.toFixed(2)})`);
      this.currentSource = best.type;
      this.framesSinceSwitch = 0;
    }

    const active = scored.find(s => s.type === this.currentSource) || best;

    return {
      activeSource: this.currentSource,
      activeValue: active.value,
      activeSQI: active.sqi,
      candidates: scored
    };
  }

  private ema(type: SourceType, value: number, alpha: number): number {
    const dcBuf = this.dcBuffers.get(type)!;
    const prev = dcBuf.length > 0 ? dcBuf.last() : value;
    const smoothed = prev * (1 - alpha) + value * alpha;
    dcBuf.push(smoothed);
    return smoothed;
  }

  getActiveSource(): SourceType { return this.currentSource; }

  reset(): void {
    this.buffers.forEach(b => b.clear());
    this.dcBuffers.forEach(b => b.clear());
    this.currentSource = 'RED_NORM';
    this.sourceStableFrames = 0;
    this.framesSinceSwitch = 0;
  }
}
