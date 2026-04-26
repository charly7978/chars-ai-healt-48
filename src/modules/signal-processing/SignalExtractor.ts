/**
 * SignalExtractor - multi-source PPG extraction from the detected ROI.
 *
 * The extractor uses only real camera pixels inside the contact mask, rejects
 * clipped samples at pixel level, builds several optical signal candidates and
 * ranks them by spectral concentration, perfusion amplitude and stability.
 */

import { RingBuffer } from './RingBuffer';
import { TileStats } from './FingerContactDetector';

export type SignalSource =
  | 'RED_AVG'
  | 'GREEN_AVG'
  | 'BLUE_AVG'
  | 'RED_ABSORBANCE'
  | 'GREEN_ABSORBANCE'
  | 'BLUE_ABSORBANCE'
  | 'RG_RATIO'
  | 'RGB_WEIGHTED'
  | 'TEMPORAL_DIFF';

export interface SignalCandidate {
  source: SignalSource;
  rawValue: number;
  normalizedValue: number;
  acComponent: number;
  dcComponent: number;
  perfusionIndex: number;
  snr: number;
  periodicity: number;
  stability: number;
  quality: number;
}

export interface ExtractedSignal {
  rawValue: number;
  filteredValue: number;
  quality: number;
  activeSource: SignalSource;
  perfusionIndex: number;
  snr: number;
  rgbRaw: { r: number; g: number; b: number };
  tileWeights: number[];
  candidates: SignalCandidate[];
}

export interface SignalExtractorConfig {
  bufferSize: number;
  bandPassLow: number;
  bandPassHigh: number;
  sampleRate: number;
  detrendAlpha: number;
}

export interface RoiBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_CONFIG: SignalExtractorConfig = {
  bufferSize: 210,
  bandPassLow: 0.72,
  bandPassHigh: 3.4,
  sampleRate: 30,
  detrendAlpha: 0.025
};

const PIXEL_CLIP_HIGH = 252;
const PIXEL_CLIP_LOW = 8;

export class SignalExtractor {
  private config: SignalExtractorConfig;
  private buffers: Map<SignalSource, RingBuffer> = new Map();
  private dcBuffers: Map<SignalSource, RingBuffer> = new Map();
  private detrendStates: Map<SignalSource, number> = new Map();
  private lowPassStates: Map<SignalSource, number> = new Map();

  private activeSource: SignalSource = 'RGB_WEIGHTED';
  private framesSinceSwitch = 0;
  private readonly MIN_SWITCH_FRAMES = 24;
  private readonly SQI_ADVANTAGE = 0.12;

  constructor(config?: Partial<SignalExtractorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeBuffers();
  }

  private initializeBuffers(): void {
    const sources = this.sources();
    for (const source of sources) {
      this.buffers.set(source, new RingBuffer(this.config.bufferSize));
      this.dcBuffers.set(source, new RingBuffer(this.config.bufferSize));
    }
  }

  extract(
    imageData: ImageData,
    mask: Uint8Array,
    tileStats: TileStats[],
    roiBounds: RoiBounds,
    prevFrameRgb?: { r: number; g: number; b: number }
  ): ExtractedSignal {
    const { data, width, height } = imageData;
    const tileWeights = this.calculateTileWeights(tileStats);
    const rgb = this.extractWeightedRGB(data, mask, tileWeights, width, height, roiBounds);
    const candidates = this.generateCandidates(rgb, prevFrameRgb);
    const scoredCandidates = this.scoreCandidates(candidates);

    this.selectActiveSource(scoredCandidates);

    const active = scoredCandidates.find(c => c.source === this.activeSource) || scoredCandidates[0];
    const filtered = active ? this.applyFiltering(active) : 0;

    return {
      rawValue: active?.rawValue ?? 0,
      filteredValue: filtered,
      quality: active?.quality ?? 0,
      activeSource: active?.source ?? this.activeSource,
      perfusionIndex: active?.perfusionIndex ?? 0,
      snr: active?.snr ?? 0,
      rgbRaw: rgb,
      tileWeights,
      candidates: scoredCandidates
    };
  }

  private calculateTileWeights(tileStats: TileStats[]): number[] {
    const weights: number[] = [];
    const gridCols = Math.max(1, Math.round(Math.sqrt(tileStats.length)));
    const gridRows = Math.max(1, Math.ceil(tileStats.length / gridCols));

    for (let i = 0; i < tileStats.length; i++) {
      const tile = tileStats[i];
      if (!tile?.isValid || tile.quality <= 0) {
        weights.push(0);
        continue;
      }

      const row = Math.floor(i / gridCols);
      const col = i % gridCols;
      const cx = (gridCols - 1) / 2;
      const cy = (gridRows - 1) / 2;
      const maxDist = Math.sqrt(cx * cx + cy * cy) + 1e-6;
      const dist = Math.sqrt((col - cx) ** 2 + (row - cy) ** 2);
      const centrality = 1 - dist / maxDist;
      const clipFactor = Math.max(0, 1 - tile.saturatedRatio * 2.1 - tile.darkRatio * 1.8);
      const textureFactor = this.trapezoid(tile.intensityStd, 0.3, 1.5, 42, 72);

      const weight = tile.quality *
        (0.72 + 0.28 * centrality) *
        (0.82 + 0.18 * textureFactor) *
        clipFactor;

      weights.push(Math.max(0, weight));
    }

    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    }

    return weights;
  }

  private extractWeightedRGB(
    data: Uint8ClampedArray,
    mask: Uint8Array,
    tileWeights: number[],
    imageWidth: number,
    imageHeight: number,
    roiBounds: RoiBounds
  ): { r: number; g: number; b: number } {
    const roiW = Math.max(0, Math.floor(roiBounds.width));
    const roiH = Math.max(0, Math.floor(roiBounds.height));
    if (roiW <= 0 || roiH <= 0 || mask.length !== roiW * roiH) {
      return { r: 0, g: 0, b: 0 };
    }

    const gridCols = Math.max(1, Math.round(Math.sqrt(tileWeights.length)));
    const gridRows = Math.max(1, Math.ceil(tileWeights.length / gridCols));

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let totalWeight = 0;

    for (let y = 0; y < roiH; y++) {
      const gy = roiBounds.y + y;
      if (gy < 0 || gy >= imageHeight) continue;

      for (let x = 0; x < roiW; x++) {
        const mi = y * roiW + x;
        if (mask[mi] === 0) continue;

        const gx = roiBounds.x + x;
        if (gx < 0 || gx >= imageWidth) continue;

        const col = Math.min(gridCols - 1, Math.floor((x / roiW) * gridCols));
        const row = Math.min(gridRows - 1, Math.floor((y / roiH) * gridRows));
        const tileWeight = tileWeights[row * gridCols + col] || 0;
        if (tileWeight <= 0) continue;

        const pi = (gy * imageWidth + gx) * 4;
        const r = data[pi];
        const g = data[pi + 1];
        const b = data[pi + 2];

        if (r >= PIXEL_CLIP_HIGH || g >= PIXEL_CLIP_HIGH || b >= PIXEL_CLIP_HIGH) continue;
        if ((r <= PIXEL_CLIP_LOW && g <= PIXEL_CLIP_LOW && b <= PIXEL_CLIP_LOW) || r + g + b < 36) continue;

        sumR += r * tileWeight;
        sumG += g * tileWeight;
        sumB += b * tileWeight;
        totalWeight += tileWeight;
      }
    }

    if (totalWeight <= 0) return { r: 0, g: 0, b: 0 };

    return {
      r: sumR / totalWeight,
      g: sumG / totalWeight,
      b: sumB / totalWeight
    };
  }

  private generateCandidates(
    rgb: { r: number; g: number; b: number },
    prevFrameRgb?: { r: number; g: number; b: number }
  ): SignalCandidate[] {
    const eps = 1e-6;
    const dcR = this.updateDC('RED_AVG', rgb.r);
    const dcG = this.updateDC('GREEN_AVG', rgb.g);
    const dcB = this.updateDC('BLUE_AVG', rgb.b);

    const redNorm = rgb.r / (dcR + eps);
    const greenNorm = rgb.g / (dcG + eps);
    const blueNorm = rgb.b / (dcB + eps);
    const redAbs = -Math.log(this.clamp(redNorm, eps, 4));
    const greenAbs = -Math.log(this.clamp(greenNorm, eps, 4));
    const blueAbs = -Math.log(this.clamp(blueNorm, eps, 4));
    const rgChrom = Math.log(this.clamp(redNorm / (greenNorm + eps), 0.1, 10));
    const fusedAbsorbance = 0.50 * redAbs + 0.35 * greenAbs + 0.15 * blueAbs;
    const fusedRaw = 0.50 * rgb.r + 0.35 * rgb.g + 0.15 * rgb.b;
    const fusedDc = 0.50 * dcR + 0.35 * dcG + 0.15 * dcB;

    const candidates: SignalCandidate[] = [
      this.emptyCandidate('RED_AVG', rgb.r, redNorm, dcR),
      this.emptyCandidate('GREEN_AVG', rgb.g, greenNorm, dcG),
      this.emptyCandidate('BLUE_AVG', rgb.b, blueNorm, dcB),
      this.emptyCandidate('RED_ABSORBANCE', rgb.r, redAbs, dcR),
      this.emptyCandidate('GREEN_ABSORBANCE', rgb.g, greenAbs, dcG),
      this.emptyCandidate('BLUE_ABSORBANCE', rgb.b, blueAbs, dcB),
      this.emptyCandidate('RG_RATIO', rgb.r / (rgb.g + eps), rgChrom, dcR / (dcG + eps)),
      this.emptyCandidate('RGB_WEIGHTED', fusedRaw, fusedAbsorbance, fusedDc)
    ];

    if (prevFrameRgb) {
      const diff = (rgb.r - prevFrameRgb.r) / (dcR + eps) +
        0.55 * (rgb.g - prevFrameRgb.g) / (dcG + eps) +
        0.20 * (rgb.b - prevFrameRgb.b) / (dcB + eps);

      candidates.push(this.emptyCandidate('TEMPORAL_DIFF', diff, diff, 1));
    }

    return candidates;
  }

  private emptyCandidate(
    source: SignalSource,
    rawValue: number,
    normalizedValue: number,
    dcComponent: number
  ): SignalCandidate {
    return {
      source,
      rawValue,
      normalizedValue: Number.isFinite(normalizedValue) ? normalizedValue : 0,
      acComponent: 0,
      dcComponent,
      perfusionIndex: 0,
      snr: 0,
      periodicity: 0,
      stability: 0,
      quality: 0
    };
  }

  private updateDC(source: SignalSource, value: number): number {
    const dcBuf = this.dcBuffers.get(source)!;
    const prev = dcBuf.length > 0 ? dcBuf.last() : value;
    if (prev <= 1 && value > 1) {
      dcBuf.push(value);
      return value;
    }
    const alpha = value <= 0 ? 0.005 : this.config.detrendAlpha;
    const smoothed = prev * (1 - alpha) + value * alpha;
    dcBuf.push(smoothed);
    return smoothed;
  }

  private scoreCandidates(candidates: SignalCandidate[]): SignalCandidate[] {
    const scored: SignalCandidate[] = [];

    for (const candidate of candidates) {
      const buf = this.buffers.get(candidate.source)!;
      buf.push(candidate.normalizedValue);

      const ac = this.robustRange(buf);
      const spectral = this.calculateSpectralMetrics(buf);
      const stability = this.calculateStability(buf, ac);
      const quality = this.calculateQuality(ac, spectral.snr, spectral.periodicity, stability, buf.length);

      scored.push({
        ...candidate,
        acComponent: ac,
        perfusionIndex: ac * 100,
        snr: spectral.snr,
        periodicity: spectral.periodicity,
        stability,
        quality
      });
    }

    scored.sort((a, b) => b.quality - a.quality);
    return scored;
  }

  private robustRange(buf: RingBuffer): number {
    if (buf.length < 6) return 0;

    const arr = buf.toArray(Math.min(buf.length, 120)).filter(Number.isFinite);
    if (arr.length < 6) return 0;

    arr.sort((a, b) => a - b);
    const lo = arr[Math.floor((arr.length - 1) * 0.05)];
    const hi = arr[Math.floor((arr.length - 1) * 0.95)];
    return Math.max(0, hi - lo);
  }

  private calculateSpectralMetrics(buf: RingBuffer): { snr: number; periodicity: number } {
    const n = Math.min(buf.length, 150);
    if (n < 48) return { snr: 0, periodicity: 0 };

    const arr = buf.toArray(n);
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    const fs = this.config.sampleRate;
    const minK = Math.max(1, Math.floor(0.45 * n / fs));
    const maxK = Math.min(Math.floor(4.5 * n / fs), Math.floor(n / 2));

    let totalPower = 0;
    let cardiacPower = 0;
    let peakPower = 0;
    let bins = 0;

    for (let k = minK; k <= maxK; k++) {
      const hz = k * fs / n;
      let re = 0;
      let im = 0;

      for (let i = 0; i < n; i++) {
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / Math.max(1, n - 1));
        const v = (arr[i] - mean) * window;
        const phase = 2 * Math.PI * k * i / n;
        re += v * Math.cos(phase);
        im -= v * Math.sin(phase);
      }

      const power = re * re + im * im;
      totalPower += power;
      bins++;

      if (hz >= this.config.bandPassLow && hz <= this.config.bandPassHigh) {
        cardiacPower += power;
        if (power > peakPower) peakPower = power;
      }
    }

    const residualPower = Math.max(1e-12, totalPower - peakPower);
    const snr = peakPower / (residualPower / Math.max(1, bins - 1));
    const bandRatio = cardiacPower / Math.max(1e-12, totalPower);
    const concentration = peakPower / Math.max(1e-12, cardiacPower);
    const periodicity = this.clamp(0.65 * bandRatio + 0.35 * Math.min(1, concentration * 3), 0, 1);

    return { snr, periodicity };
  }

  private calculateStability(buf: RingBuffer, ac: number): number {
    if (buf.length < 36) return 0.55;

    const arr = buf.toArray(Math.min(buf.length, 72));
    const split = Math.floor(arr.length / 2);
    const first = arr.slice(0, split).reduce((a, b) => a + b, 0) / Math.max(1, split);
    const second = arr.slice(split).reduce((a, b) => a + b, 0) / Math.max(1, arr.length - split);
    const drift = Math.abs(second - first);

    return this.clamp(1 - drift / Math.max(1e-5, ac * 3.2), 0, 1);
  }

  private calculateQuality(
    ac: number,
    snr: number,
    periodicity: number,
    stability: number,
    bufferFill: number
  ): number {
    const perfusionScore = this.trapezoid(ac, 0.0008, 0.004, 0.075, 0.16);
    const snrScore = this.clamp(Math.log10(snr + 1) / 1.35, 0, 1);
    const fillScore = Math.min(1, bufferFill / 90);

    let quality =
      0.34 * snrScore +
      0.26 * periodicity +
      0.24 * perfusionScore +
      0.11 * stability +
      0.05 * fillScore;

    if (ac > 0.20) quality *= 0.45;
    return this.clamp(quality, 0, 1);
  }

  private selectActiveSource(scoredCandidates: SignalCandidate[]): void {
    this.framesSinceSwitch++;
    if (scoredCandidates.length === 0) return;

    const best = scoredCandidates[0];
    const current = scoredCandidates.find(c => c.source === this.activeSource) || best;

    if (
      best.source !== this.activeSource &&
      best.quality > current.quality + this.SQI_ADVANTAGE &&
      this.framesSinceSwitch >= this.MIN_SWITCH_FRAMES
    ) {
      this.activeSource = best.source;
      this.framesSinceSwitch = 0;
    }
  }

  private applyFiltering(candidate: SignalCandidate): number {
    const source = candidate.source;
    const value = candidate.normalizedValue;
    const previousTrend = this.detrendStates.get(source) ?? value;
    const trend = previousTrend * (1 - this.config.detrendAlpha) + value * this.config.detrendAlpha;
    this.detrendStates.set(source, trend);

    const detrended = value - trend;
    const previousLowPass = this.lowPassStates.get(source) ?? detrended;
    const lowPass = previousLowPass * 0.66 + detrended * 0.34;
    this.lowPassStates.set(source, lowPass);

    return lowPass;
  }

  getActiveSource(): SignalSource {
    return this.activeSource;
  }

  reset(): void {
    this.buffers.forEach(b => b.clear());
    this.dcBuffers.forEach(b => b.clear());
    this.detrendStates.clear();
    this.lowPassStates.clear();
    this.activeSource = 'RGB_WEIGHTED';
    this.framesSinceSwitch = 0;
  }

  private sources(): SignalSource[] {
    return [
      'RED_AVG',
      'GREEN_AVG',
      'BLUE_AVG',
      'RED_ABSORBANCE',
      'GREEN_ABSORBANCE',
      'BLUE_ABSORBANCE',
      'RG_RATIO',
      'RGB_WEIGHTED',
      'TEMPORAL_DIFF'
    ];
  }

  private trapezoid(value: number, low0: number, low1: number, high1: number, high0: number): number {
    if (!Number.isFinite(value) || value <= low0 || value >= high0) return 0;
    if (value >= low1 && value <= high1) return 1;
    if (value < low1) return (value - low0) / Math.max(1e-6, low1 - low0);
    return (high0 - value) / Math.max(1e-6, high0 - high1);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }
}
