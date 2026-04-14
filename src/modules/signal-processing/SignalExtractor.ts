/**
 * SignalExtractor - Multi-source PPG signal extraction with quality metrics
 * Generates multiple signal candidates, ranks them by quality, applies DSP
 * Uses tile-based spatial weighting and temporal resampling
 */

import { RingBuffer } from './RingBuffer';
import { TileStats } from './FingerContactDetector';

export type SignalSource =
  | 'RED_AVG'
  | 'GREEN_AVG'
  | 'BLUE_AVG'
  | 'RED_ABSORBANCE'
  | 'GREEN_ABSORBANCE'
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

const DEFAULT_CONFIG: SignalExtractorConfig = {
  bufferSize: 180, // ~6 seconds at 30fps
  bandPassLow: 0.8, // Hz (~48 BPM)
  bandPassHigh: 3.0, // Hz (~180 BPM)
  sampleRate: 30,
  detrendAlpha: 0.05
};

export class SignalExtractor {
  private config: SignalExtractorConfig;
  
  // Buffers for each signal source
  private buffers: Map<SignalSource, RingBuffer> = new Map();
  private dcBuffers: Map<SignalSource, RingBuffer> = new Map();
  
  // Current active source
  private activeSource: SignalSource = 'RED_AVG';
  private sourceStableFrames = 0;
  private framesSinceSwitch = 0;
  private readonly MIN_SWITCH_FRAMES = 20;
  private readonly SQI_ADVANTAGE = 0.15;

  // Filter state
  private lastFilteredValue = 0;
  private detrendState = 0;

  constructor(config?: Partial<SignalExtractorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeBuffers();
  }

  /**
   * Initialize ring buffers for all sources
   */
  private initializeBuffers(): void {
    const sources: SignalSource[] = [
      'RED_AVG', 'GREEN_AVG', 'BLUE_AVG',
      'RED_ABSORBANCE', 'GREEN_ABSORBANCE',
      'RG_RATIO', 'RGB_WEIGHTED', 'TEMPORAL_DIFF'
    ];

    for (const source of sources) {
      this.buffers.set(source, new RingBuffer(this.config.bufferSize));
      this.dcBuffers.set(source, new RingBuffer(this.config.bufferSize));
    }
  }

  /**
   * Extract signal from frame data
   */
  extract(
    imageData: ImageData,
    mask: Uint8Array,
    tileStats: TileStats[],
    prevFrameRgb?: { r: number; g: number; b: number }
  ): ExtractedSignal {
    const { data, width, height } = imageData;

    // Calculate tile weights based on quality
    const tileWeights = this.calculateTileWeights(tileStats, mask, width, height);

    // Extract spatially weighted RGB averages
    const rgb = this.extractWeightedRGB(data, mask, tileWeights, width, height);

    // Generate all signal candidates
    const candidates = this.generateCandidates(rgb, prevFrameRgb);

    // Score and rank candidates
    const scoredCandidates = this.scoreCandidates(candidates);

    // Select best source with hysteresis
    this.selectActiveSource(scoredCandidates);

    // Get active candidate
    const active = scoredCandidates.find(c => c.source === this.activeSource) || scoredCandidates[0];

    // Apply filtering
    const filtered = this.applyFiltering(active);

    return {
      rawValue: active.rawValue,
      filteredValue: filtered,
      quality: active.quality,
      activeSource: this.activeSource,
      perfusionIndex: active.perfusionIndex,
      snr: active.snr,
      rgbRaw: rgb,
      tileWeights,
      candidates: scoredCandidates
    };
  }

  /**
   * Calculate tile weights based on quality metrics
   */
  private calculateTileWeights(
    tileStats: TileStats[],
    mask: Uint8Array,
    imageWidth: number,
    imageHeight: number
  ): number[] {
    const weights: number[] = [];
    const gridCols = Math.ceil(Math.sqrt(tileStats.length));
    const gridRows = Math.ceil(tileStats.length / gridCols);

    for (let i = 0; i < tileStats.length; i++) {
      const tile = tileStats[i];
      
      if (!tile.isValid || tile.quality === 0) {
        weights.push(0);
        continue;
      }

      // Base weight from tile quality
      let weight = tile.quality;

      // Penalize saturated tiles
      if (tile.isSaturated) weight *= 0.3;

      // Penalize dark tiles
      if (tile.isTooDark) weight *= 0.2;

      // Centrality bonus (tiles near center get higher weight)
      const row = Math.floor(i / gridCols);
      const col = i % gridCols;
      const cx = gridCols / 2;
      const cy = gridRows / 2;
      const dist = Math.sqrt((col - cx) ** 2 + (row - cy) ** 2);
      const maxDist = Math.sqrt(cx * cx + cy * cy);
      const centrality = 1 - (dist / maxDist);
      weight *= (0.7 + centrality * 0.3);

      weights.push(Math.max(0, weight));
    }

    // Normalize weights
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      for (let i = 0; i < weights.length; i++) {
        weights[i] /= sum;
      }
    }

    return weights;
  }

  /**
   * Extract spatially weighted RGB averages
   */
  private extractWeightedRGB(
    data: Uint8ClampedArray,
    mask: Uint8Array,
    tileWeights: number[],
    imageWidth: number,
    imageHeight: number
  ): { r: number; g: number; b: number } {
    const roiW = Math.sqrt(mask.length);
    const roiH = roiW;
    const gridCols = Math.ceil(Math.sqrt(tileWeights.length));
    const gridRows = Math.ceil(tileWeights.length / gridCols);
    const tileW = roiW / gridCols;
    const tileH = roiH / gridRows;

    let sumR = 0, sumG = 0, sumB = 0, totalWeight = 0;

    for (let i = 0; i < tileWeights.length; i++) {
      const weight = tileWeights[i];
      if (weight === 0) continue;

      const tile = tileStatsToTileStats(tileWeights, i); // Placeholder
      const row = Math.floor(i / gridCols);
      const col = i % gridCols;
      const tx0 = Math.floor(col * tileW);
      const ty0 = Math.floor(row * tileH);
      const tx1 = Math.min(Math.floor((col + 1) * tileW), roiW);
      const ty1 = Math.min(Math.floor((row + 1) * tileH), roiH);

      // Sample pixels in this tile
      let tileSumR = 0, tileSumG = 0, tileSumB = 0, tileCount = 0;
      for (let y = ty0; y < ty1; y += 2) {
        for (let x = tx0; x < tx1; x += 2) {
          const pi = (y * imageWidth + x) * 4;
          tileSumR += data[pi];
          tileSumG += data[pi + 1];
          tileSumB += data[pi + 2];
          tileCount++;
        }
      }

      if (tileCount > 0) {
        sumR += (tileSumR / tileCount) * weight;
        sumG += (tileSumG / tileCount) * weight;
        sumB += (tileSumB / tileCount) * weight;
        totalWeight += weight;
      }
    }

    if (totalWeight === 0) {
      return { r: 0, g: 0, b: 0 };
    }

    return {
      r: sumR / totalWeight,
      g: sumG / totalWeight,
      b: sumB / totalWeight
    };
  }

  /**
   * Generate all signal candidates from RGB
   */
  private generateCandidates(
    rgb: { r: number; g: number; b: number },
    prevFrameRgb?: { r: number; g: number; b: number }
  ): SignalCandidate[] {
    const eps = 1e-6;
    const total = rgb.r + rgb.g + rgb.b + eps;

    // Get DC baselines (slow EMA)
    const dcR = this.updateDC('RED_AVG', rgb.r);
    const dcG = this.updateDC('GREEN_AVG', rgb.g);
    const dcB = this.updateDC('BLUE_AVG', rgb.b);

    const candidates: SignalCandidate[] = [
      {
        source: 'RED_AVG',
        rawValue: rgb.r,
        normalizedValue: rgb.r / (dcR + eps),
        acComponent: 0,
        dcComponent: dcR,
        perfusionIndex: 0,
        snr: 0,
        periodicity: 0,
        stability: 0,
        quality: 0
      },
      {
        source: 'GREEN_AVG',
        rawValue: rgb.g,
        normalizedValue: rgb.g / (dcG + eps),
        acComponent: 0,
        dcComponent: dcG,
        perfusionIndex: 0,
        snr: 0,
        periodicity: 0,
        stability: 0,
        quality: 0
      },
      {
        source: 'BLUE_AVG',
        rawValue: rgb.b,
        normalizedValue: rgb.b / (dcB + eps),
        acComponent: 0,
        dcComponent: dcB,
        perfusionIndex: 0,
        snr: 0,
        periodicity: 0,
        stability: 0,
        quality: 0
      },
      {
        source: 'RED_ABSORBANCE',
        rawValue: rgb.r,
        normalizedValue: -Math.log((rgb.r + eps) / (dcR + eps)),
        acComponent: 0,
        dcComponent: dcR,
        perfusionIndex: 0,
        snr: 0,
        periodicity: 0,
        stability: 0,
        quality: 0
      },
      {
        source: 'GREEN_ABSORBANCE',
        rawValue: rgb.g,
        normalizedValue: -Math.log((rgb.g + eps) / (dcG + eps)),
        acComponent: 0,
        dcComponent: dcG,
        perfusionIndex: 0,
        snr: 0,
        periodicity: 0,
        stability: 0,
        quality: 0
      },
      {
        source: 'RG_RATIO',
        rawValue: rgb.r / (rgb.g + eps),
        normalizedValue: (rgb.r / (rgb.g + eps)) / ((dcR / (dcG + eps)) + eps),
        acComponent: 0,
        dcComponent: dcR / (dcG + eps),
        perfusionIndex: 0,
        snr: 0,
        periodicity: 0,
        stability: 0,
        quality: 0
      },
      {
        source: 'RGB_WEIGHTED',
        rawValue: 0.6 * rgb.r + 0.3 * rgb.g + 0.1 * rgb.b,
        normalizedValue: (0.6 * rgb.r + 0.3 * rgb.g + 0.1 * rgb.b) / (0.6 * dcR + 0.3 * dcG + 0.1 * dcB + eps),
        acComponent: 0,
        dcComponent: 0.6 * dcR + 0.3 * dcG + 0.1 * dcB,
        perfusionIndex: 0,
        snr: 0,
        periodicity: 0,
        stability: 0,
        quality: 0
      }
    ];

    // Temporal diff if previous frame available
    if (prevFrameRgb) {
      candidates.push({
        source: 'TEMPORAL_DIFF',
        rawValue: rgb.r - prevFrameRgb.r + 0.5 * (rgb.g - prevFrameRgb.g),
        normalizedValue: (rgb.r - prevFrameRgb.r + 0.5 * (rgb.g - prevFrameRgb.g)),
        acComponent: 0,
        dcComponent: 0,
        perfusionIndex: 0,
        snr: 0,
        periodicity: 0,
        stability: 0,
        quality: 0
      });
    }

    return candidates;
  }

  /**
   * Update DC baseline with EMA
   */
  private updateDC(source: SignalSource, value: number): number {
    const dcBuf = this.dcBuffers.get(source)!;
    const prev = dcBuf.length > 0 ? dcBuf.last() : value;
    const smoothed = prev * (1 - this.config.detrendAlpha) + value * this.config.detrendAlpha;
    dcBuf.push(smoothed);
    return smoothed;
  }

  /**
   * Score all candidates based on quality metrics
   */
  private scoreCandidates(candidates: SignalCandidate[]): SignalCandidate[] {
    const scored: SignalCandidate[] = [];

    for (const candidate of candidates) {
      // Push to buffer
      const buf = this.buffers.get(candidate.source)!;
      buf.push(candidate.normalizedValue);

      // Calculate AC/DC
      const stats = buf.stats();
      const ac = stats.max - stats.min;
      const dc = Math.abs(stats.mean) + 1e-6;
      const acDc = ac / dc;
      const perfusionIndex = acDc * 100;

      // Calculate SNR (signal power vs noise power)
      const signalPower = stats.variance;
      const noisePower = this.estimateNoise(buf);
      const snr = signalPower / (noisePower + 1e-6);

      // Periodicity via zero-crossing rate
      const periodicity = this.calculatePeriodicity(buf);

      // Stability via drift
      const stability = this.calculateStability(buf);

      // Composite quality score
      const quality = this.calculateQuality(acDc, snr, periodicity, stability, buf.length);

      scored.push({
        ...candidate,
        acComponent: ac,
        dcComponent: dc,
        perfusionIndex,
        snr,
        periodicity,
        stability,
        quality
      });
    }

    return scored;
  }

  /**
   * Estimate noise from buffer
   */
  private estimateNoise(buf: RingBuffer): number {
    if (buf.length < 10) return 1;

    const arr = buf.toArray();
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    
    // High-frequency noise estimation (difference between consecutive samples)
    let noiseSum = 0;
    for (let i = 1; i < arr.length; i++) {
      noiseSum += (arr[i] - arr[i - 1]) ** 2;
    }
    
    return noiseSum / (arr.length - 1);
  }

  /**
   * Calculate periodicity score
   */
  private calculatePeriodicity(buf: RingBuffer): number {
    if (buf.length < 30) return 0;

    const arr = buf.toArray(30);
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    
    // Zero-crossing rate
    let crossings = 0;
    for (let i = 1; i < arr.length; i++) {
      if ((arr[i] - mean) * (arr[i - 1] - mean) < 0) crossings++;
    }

    // Cardiac band at 30fps: 0.8-3 Hz => 0.8-3 crossings per second
    // For 30 samples (~1 sec): expect 0.8-3 crossings
    const crossRate = crossings;
    
    return (crossRate >= 0.8 && crossRate <= 4) ? Math.min(1, crossRate / 2) : 0.3;
  }

  /**
   * Calculate stability score
   */
  private calculateStability(buf: RingBuffer): number {
    if (buf.length < 30) return 0.5;

    const arr = buf.toArray(30);
    const firstHalf = arr.slice(0, 15).reduce((a, b) => a + b, 0) / 15;
    const secondHalf = arr.slice(15).reduce((a, b) => a + b, 0) / 15;
    
    const drift = Math.abs(secondHalf - firstHalf);
    const mean = Math.abs(firstHalf + secondHalf) / 2 + 1e-6;
    
    return Math.max(0, 1 - (drift / mean) * 5);
  }

  /**
   * Calculate composite quality score
   */
  private calculateQuality(
    acDc: number,
    snr: number,
    periodicity: number,
    stability: number,
    bufferFill: number
  ): number {
    const weights = {
      acDc: 0.3,
      snr: 0.25,
      periodicity: 0.25,
      stability: 0.15,
      fill: 0.05
    };

    const acDcScore = Math.min(1, acDc * 30);
    const snrScore = Math.min(1, Math.log10(snr + 1) / 2);
    const fillScore = bufferFill / this.config.bufferSize;

    return (
      acDcScore * weights.acDc +
      snrScore * weights.snr +
      periodicity * weights.periodicity +
      stability * weights.stability +
      fillScore * weights.fill
    );
  }

  /**
   * Select active source with hysteresis
   */
  private selectActiveSource(scoredCandidates: SignalCandidate[]): void {
    this.framesSinceSwitch++;

    scoredCandidates.sort((a, b) => b.quality - a.quality);
    const best = scoredCandidates[0];
    const current = scoredCandidates.find(c => c.source === this.activeSource) || best;

    if (
      best.source !== this.activeSource &&
      best.quality > current.quality + this.SQI_ADVANTAGE &&
      this.framesSinceSwitch >= this.MIN_SWITCH_FRAMES
    ) {
      this.activeSource = best.source;
      this.framesSinceSwitch = 0;
      this.lastFilteredValue = 0; // Reset filter state on switch
    }
  }

  /**
   * Apply filtering to active signal
   */
  private applyFiltering(candidate: SignalCandidate): number {
    // Detrending (baseline removal)
    const detrended = candidate.normalizedValue - this.detrendState;
    this.detrendState = this.detrendState * (1 - this.config.detrendAlpha) + candidate.normalizedValue * this.config.detrendAlpha;

    // Simple exponential smoothing (light filter)
    const alpha = 0.3;
    this.lastFilteredValue = this.lastFilteredValue * (1 - alpha) + detrended * alpha;

    return this.lastFilteredValue;
  }

  /**
   * Get active source
   */
  getActiveSource(): SignalSource {
    return this.activeSource;
  }

  /**
   * Reset extractor state
   */
  reset(): void {
    this.buffers.forEach(b => b.clear());
    this.dcBuffers.forEach(b => b.clear());
    this.activeSource = 'RED_AVG';
    this.sourceStableFrames = 0;
    this.framesSinceSwitch = 0;
    this.lastFilteredValue = 0;
    this.detrendState = 0;
  }
}

// Helper function placeholder
function tileStatsToTileStats(weights: number[], index: number): any {
  return { isValid: true, quality: weights[index] || 0 };
}
