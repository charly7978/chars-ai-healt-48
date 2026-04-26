/**
 * FingerContactDetector - contact PPG finger detection from real camera frames.
 * Uses a centered coarse ROI, tile connectivity, clipping rejection and temporal
 * hysteresis. It returns ROI-relative mask pixels plus absolute ROI bounds so
 * downstream extraction samples the correct part of the frame.
 */

export type ContactState =
  | 'NO_CONTACT'
  | 'PARTIAL_CONTACT'
  | 'ACQUIRING_CONTACT'
  | 'STABLE_CONTACT'
  | 'SATURATED_CONTACT'
  | 'EXCESSIVE_PRESSURE'
  | 'MOTION_CORRUPTED';

export interface TileStats {
  avgR: number;
  avgG: number;
  avgB: number;
  intensity: number;
  redRatio: number;
  rgRatio: number;
  rbRatio: number;
  chromaSpread: number;
  intensityStd: number;
  saturatedRatio: number;
  darkRatio: number;
  sampleCount: number;
  isSaturated: boolean;
  isTooDark: boolean;
  isValid: boolean;
  quality: number;
}

export interface ContactAnalysis {
  state: ContactState;
  coverage: number;
  centrality: number;
  clipHighRatio: number;
  clipLowRatio: number;
  uniformity: number;
  maskStability: number;
  motionScore: number;
  pressureScore: number;
  validPixels: number;
  totalPixels: number;
  confidence: number;
  guidanceMessage: string;
  tileStats: TileStats[];
  mask: Uint8Array;
  roiBounds: { x: number; y: number; width: number; height: number };
}

export interface FingerContactDetectorConfig {
  tileSize: number;
  gridRows: number;
  gridCols: number;
  minCoverage: number;
  minRedForFinger: number;
  stableEntryFrames: number;
  unstableExitFrames: number;
  motionThreshold: number;
  pressureThreshold: number;
  roiScale: number;
}

const DEFAULT_CONFIG: FingerContactDetectorConfig = {
  tileSize: 16,
  gridRows: 10,
  gridCols: 10,
  minCoverage: 0.18,
  minRedForFinger: 42,
  stableEntryFrames: 8,
  unstableExitFrames: 12,
  motionThreshold: 0.34,
  pressureThreshold: 0.72,
  roiScale: 0.78
};

const CLIP_HIGH = 252;
const CLIP_LOW = 8;

export class FingerContactDetector {
  private config: FingerContactDetectorConfig;
  private contactState: ContactState = 'NO_CONTACT';
  private consecutiveGoodFrames = 0;
  private consecutiveBadFrames = 0;
  private prevMask: Uint8Array | null = null;
  private prevTileStats: TileStats[] = [];
  private frameCount = 0;

  private adaptiveMinCoverage = DEFAULT_CONFIG.minCoverage;
  private adaptiveMinRed = DEFAULT_CONFIG.minRedForFinger;

  constructor(config?: Partial<FingerContactDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.adaptiveMinCoverage = this.config.minCoverage;
    this.adaptiveMinRed = this.config.minRedForFinger;
  }

  analyze(imageData: ImageData): ContactAnalysis {
    this.frameCount++;

    const { width, height, data } = imageData;
    const cx = width >> 1;
    const cy = height >> 1;
    const cropSize = Math.floor(Math.min(width, height) * this.config.roiScale);
    const x0 = Math.max(0, Math.floor(cx - cropSize / 2));
    const y0 = Math.max(0, Math.floor(cy - cropSize / 2));
    const x1 = Math.min(width, x0 + cropSize);
    const y1 = Math.min(height, y0 + cropSize);
    const roiW = x1 - x0;
    const roiH = y1 - y0;

    const tileStats = this.analyzeTiles(data, width, x0, y0, roiW, roiH);
    this.keepLargestConnectedComponent(tileStats);

    const mask = this.buildContactMask(tileStats, roiW, roiH);
    const validPixels = mask.reduce((sum, v) => sum + v, 0);
    const totalPixels = Math.max(1, roiW * roiH);
    const coverage = validPixels / totalPixels;
    const centrality = this.calculateCentrality(mask, roiW, roiH);
    const { clipHigh, clipLow } = this.calculateClipping(tileStats);
    const uniformity = this.calculateUniformity(tileStats);
    const maskStability = this.calculateMaskStability(mask, totalPixels);
    const motionScore = this.calculateMotionScore(tileStats);
    const pressureScore = this.calculatePressureScore(tileStats, uniformity, clipHigh);

    const fingerPresent = this.isFingerPresent(
      tileStats,
      coverage,
      centrality,
      clipHigh,
      clipLow,
      maskStability
    );

    this.updateContactState(fingerPresent, pressureScore, motionScore, clipHigh, coverage);
    this.adaptThresholds(tileStats, coverage);

    this.prevMask = mask;
    this.prevTileStats = tileStats.map(t => ({ ...t }));

    return {
      state: this.contactState,
      coverage,
      centrality,
      clipHighRatio: clipHigh,
      clipLowRatio: clipLow,
      uniformity,
      maskStability,
      motionScore,
      pressureScore,
      validPixels,
      totalPixels,
      confidence: this.calculateConfidence(fingerPresent, coverage, centrality, maskStability),
      guidanceMessage: this.getGuidanceMessage(),
      tileStats,
      mask,
      roiBounds: { x: x0, y: y0, width: roiW, height: roiH }
    };
  }

  private analyzeTiles(
    data: Uint8ClampedArray,
    imageWidth: number,
    x0: number,
    y0: number,
    roiW: number,
    roiH: number
  ): TileStats[] {
    const stats: TileStats[] = [];
    const tileW = Math.ceil(roiW / this.config.gridCols);
    const tileH = Math.ceil(roiH / this.config.gridRows);

    for (let row = 0; row < this.config.gridRows; row++) {
      for (let col = 0; col < this.config.gridCols; col++) {
        const tx = x0 + col * tileW;
        const ty = y0 + row * tileH;
        const tw = Math.min(tileW, x0 + roiW - tx);
        const th = Math.min(tileH, y0 + roiH - ty);

        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let sumLum = 0;
        let sumLumSq = 0;
        let saturatedCount = 0;
        let darkCount = 0;
        let count = 0;

        for (let y = ty; y < ty + th; y += 2) {
          for (let x = tx; x < tx + tw; x += 2) {
            const pi = (y * imageWidth + x) * 4;
            const r = data[pi];
            const g = data[pi + 1];
            const b = data[pi + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;

            sumR += r;
            sumG += g;
            sumB += b;
            sumLum += lum;
            sumLumSq += lum * lum;
            count++;

            if (r >= CLIP_HIGH || g >= CLIP_HIGH || b >= CLIP_HIGH) saturatedCount++;
            if ((r <= CLIP_LOW && g <= CLIP_LOW && b <= CLIP_LOW) || r + g + b < 36) darkCount++;
          }
        }

        if (count === 0) {
          stats.push(this.emptyTile());
          continue;
        }

        const avgR = sumR / count;
        const avgG = sumG / count;
        const avgB = sumB / count;
        const intensity = avgR + avgG + avgB;
        const total = intensity + 1e-6;
        const redRatio = avgR / total;
        const rgRatio = avgR / (avgG + 1);
        const rbRatio = avgR / (avgB + 1);
        const meanLum = sumLum / count;
        const intensityStd = Math.sqrt(Math.max(0, sumLumSq / count - meanLum * meanLum));
        const saturatedRatio = saturatedCount / count;
        const darkRatio = darkCount / count;
        const chromaSpread = (Math.max(avgR, avgG, avgB) - Math.min(avgR, avgG, avgB)) / 255;

        const brightnessScore = this.trapezoid(avgR, 34, 58, 225, 248);
        const redRatioScore = this.trapezoid(redRatio, 0.30, 0.34, 0.58, 0.66);
        const rgScore = this.trapezoid(rgRatio, 0.82, 1.02, 3.2, 4.8);
        const rbScore = this.trapezoid(rbRatio, 1.05, 1.22, 6.0, 9.0);
        const clipScore = Math.max(0, 1 - saturatedRatio * 2.3 - darkRatio * 2.0);
        const textureScore = this.trapezoid(intensityStd, 0.4, 1.8, 38, 70);
        const chromaScore = this.trapezoid(chromaSpread, 0.02, 0.06, 0.55, 0.80);

        const quality = Math.max(0, Math.min(1,
          0.28 * brightnessScore +
          0.20 * redRatioScore +
          0.18 * rgScore +
          0.12 * rbScore +
          0.12 * clipScore +
          0.06 * textureScore +
          0.04 * chromaScore
        ));

        const isSaturated = saturatedRatio > 0.42;
        const isTooDark = darkRatio > 0.45 || intensity < 42;
        const isValid = quality >= 0.46 && saturatedRatio < 0.58 && darkRatio < 0.50;

        stats.push({
          avgR,
          avgG,
          avgB,
          intensity,
          redRatio,
          rgRatio,
          rbRatio,
          chromaSpread,
          intensityStd,
          saturatedRatio,
          darkRatio,
          sampleCount: count,
          isSaturated,
          isTooDark,
          isValid,
          quality
        });
      }
    }

    return stats;
  }

  private emptyTile(): TileStats {
    return {
      avgR: 0,
      avgG: 0,
      avgB: 0,
      intensity: 0,
      redRatio: 0,
      rgRatio: 0,
      rbRatio: 0,
      chromaSpread: 0,
      intensityStd: 0,
      saturatedRatio: 0,
      darkRatio: 1,
      sampleCount: 0,
      isSaturated: false,
      isTooDark: true,
      isValid: false,
      quality: 0
    };
  }

  private keepLargestConnectedComponent(tileStats: TileStats[]): void {
    const rows = this.config.gridRows;
    const cols = this.config.gridCols;
    const visited = new Uint8Array(tileStats.length);
    let bestComponent: number[] = [];

    for (let i = 0; i < tileStats.length; i++) {
      if (visited[i] || !tileStats[i].isValid) continue;

      const stack = [i];
      const component: number[] = [];
      visited[i] = 1;

      while (stack.length) {
        const idx = stack.pop()!;
        component.push(idx);
        const row = Math.floor(idx / cols);
        const col = idx % cols;
        const neighbors = [
          row > 0 ? idx - cols : -1,
          row < rows - 1 ? idx + cols : -1,
          col > 0 ? idx - 1 : -1,
          col < cols - 1 ? idx + 1 : -1
        ];

        for (const n of neighbors) {
          if (n >= 0 && !visited[n] && tileStats[n].isValid) {
            visited[n] = 1;
            stack.push(n);
          }
        }
      }

      if (component.length > bestComponent.length) {
        bestComponent = component;
      }
    }

    const keep = new Set(bestComponent);
    for (let i = 0; i < tileStats.length; i++) {
      if (!keep.has(i)) {
        tileStats[i].isValid = false;
        tileStats[i].quality *= 0.35;
      }
    }
  }

  private buildContactMask(tileStats: TileStats[], roiW: number, roiH: number): Uint8Array {
    const tileW = Math.ceil(roiW / this.config.gridCols);
    const tileH = Math.ceil(roiH / this.config.gridRows);
    const mask = new Uint8Array(roiW * roiH);

    for (let row = 0; row < this.config.gridRows; row++) {
      for (let col = 0; col < this.config.gridCols; col++) {
        const idx = row * this.config.gridCols + col;
        const tile = tileStats[idx];
        if (!tile?.isValid) continue;

        const tx0 = col * tileW;
        const ty0 = row * tileH;
        const tw = Math.min(tileW, roiW - tx0);
        const th = Math.min(tileH, roiH - ty0);

        for (let y = ty0; y < ty0 + th; y++) {
          const offset = y * roiW;
          for (let x = tx0; x < tx0 + tw; x++) {
            mask[offset + x] = 1;
          }
        }
      }
    }

    return mask;
  }

  private calculateCentrality(mask: Uint8Array, width: number, height: number): number {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    const cx = width / 2;
    const cy = height / 2;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (mask[y * width + x]) {
          sumX += x;
          sumY += y;
          count++;
        }
      }
    }

    if (count === 0) return 0;

    const meanX = sumX / count;
    const meanY = sumY / count;
    const dist = Math.sqrt((meanX - cx) ** 2 + (meanY - cy) ** 2);
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    return Math.max(0, 1 - dist / (maxDist + 1e-6));
  }

  private calculateClipping(tileStats: TileStats[]): { clipHigh: number; clipLow: number } {
    let high = 0;
    let low = 0;
    let count = 0;

    for (const tile of tileStats) {
      if (tile.sampleCount <= 0) continue;
      high += tile.saturatedRatio * tile.sampleCount;
      low += tile.darkRatio * tile.sampleCount;
      count += tile.sampleCount;
    }

    return {
      clipHigh: high / Math.max(1, count),
      clipLow: low / Math.max(1, count)
    };
  }

  private calculateUniformity(tileStats: TileStats[]): number {
    const validTiles = tileStats.filter(t => t.isValid);
    if (validTiles.length < 4) return 0;

    const intensities = validTiles.map(t => t.intensity / 3);
    const mean = intensities.reduce((a, b) => a + b, 0) / intensities.length;
    const variance = intensities.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intensities.length;
    const cv = Math.sqrt(variance) / (mean + 1e-6);

    return Math.max(0, Math.min(1, 1 - cv * 2.2));
  }

  private calculateMaskStability(mask: Uint8Array, totalPixels: number): number {
    if (!this.prevMask || this.prevMask.length !== mask.length) return 1.0;

    let same = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === this.prevMask[i]) same++;
    }

    return same / totalPixels;
  }

  private calculateMotionScore(tileStats: TileStats[]): number {
    if (this.prevTileStats.length !== tileStats.length) return 0;

    let diff = 0;
    let weighted = 0;
    for (let i = 0; i < tileStats.length; i++) {
      const weight = Math.max(tileStats[i].quality, this.prevTileStats[i].quality);
      if (weight <= 0) continue;
      const denom = Math.max(32, (tileStats[i].intensity + this.prevTileStats[i].intensity) / 2);
      diff += Math.abs(tileStats[i].intensity - this.prevTileStats[i].intensity) / denom * weight;
      weighted += weight;
    }

    return Math.max(0, Math.min(1, weighted > 0 ? diff / weighted : 0));
  }

  private calculatePressureScore(tileStats: TileStats[], uniformity: number, clipHigh: number): number {
    const validTiles = tileStats.filter(t => t.isValid || t.quality > 0.3);
    const avgChannel = validTiles.length
      ? validTiles.reduce((sum, t) => sum + t.intensity / 3, 0) / validTiles.length
      : 0;

    let score = 0;
    score += uniformity > 0.88 ? 0.28 : uniformity > 0.74 ? 0.14 : 0;
    score += clipHigh > 0.28 ? 0.38 : clipHigh > 0.12 ? 0.18 : 0;
    score += avgChannel > 232 ? 0.28 : avgChannel > 210 ? 0.14 : 0;

    return Math.min(1, score);
  }

  private isFingerPresent(
    tileStats: TileStats[],
    coverage: number,
    centrality: number,
    clipHigh: number,
    clipLow: number,
    maskStability: number
  ): boolean {
    if (coverage < this.adaptiveMinCoverage) return false;
    if (centrality < 0.42 && coverage < 0.45) return false;

    const validTiles = tileStats.filter(t => t.isValid);
    if (validTiles.length < Math.max(6, tileStats.length * 0.12)) return false;

    const avgRed = validTiles.reduce((sum, t) => sum + t.avgR * t.quality, 0) /
      Math.max(1e-6, validTiles.reduce((sum, t) => sum + t.quality, 0));
    if (avgRed < this.adaptiveMinRed) return false;

    const avgRedRatio = validTiles.reduce((sum, t) => sum + t.redRatio, 0) / validTiles.length;
    const avgRg = validTiles.reduce((sum, t) => sum + t.rgRatio, 0) / validTiles.length;
    if (avgRedRatio < 0.30 || avgRg < 0.82) return false;

    if (clipHigh > 0.62 || clipLow > 0.42) return false;
    if (this.frameCount > 12 && maskStability < 0.28) return false;

    return true;
  }

  private updateContactState(
    fingerPresent: boolean,
    pressureScore: number,
    motionScore: number,
    clipHigh: number,
    coverage: number
  ): void {
    if (fingerPresent) {
      this.consecutiveGoodFrames++;
      this.consecutiveBadFrames = 0;
    } else {
      this.consecutiveBadFrames++;
      this.consecutiveGoodFrames = 0;
    }

    if (motionScore > this.config.motionThreshold && this.contactState === 'STABLE_CONTACT') {
      this.contactState = 'MOTION_CORRUPTED';
      this.consecutiveGoodFrames = 0;
      return;
    }

    if (pressureScore > this.config.pressureThreshold) {
      this.contactState = 'EXCESSIVE_PRESSURE';
      return;
    }

    if (clipHigh > 0.38) {
      this.contactState = 'SATURATED_CONTACT';
      return;
    }

    if (!fingerPresent) {
      if (this.consecutiveBadFrames >= this.config.unstableExitFrames) {
        this.contactState = 'NO_CONTACT';
      } else if (this.contactState !== 'NO_CONTACT') {
        this.contactState = coverage > 0.10 ? 'PARTIAL_CONTACT' : 'ACQUIRING_CONTACT';
      }
      return;
    }

    if (this.consecutiveGoodFrames >= this.config.stableEntryFrames) {
      this.contactState = 'STABLE_CONTACT';
    } else if (this.consecutiveGoodFrames >= 3) {
      this.contactState = 'ACQUIRING_CONTACT';
    } else {
      this.contactState = 'PARTIAL_CONTACT';
    }
  }

  private adaptThresholds(tileStats: TileStats[], coverage: number): void {
    if (this.frameCount < 30 || this.contactState !== 'STABLE_CONTACT') return;

    const validTiles = tileStats.filter(t => t.isValid);
    if (validTiles.length === 0) return;

    const weightSum = validTiles.reduce((sum, t) => sum + t.quality, 0);
    const avgRed = validTiles.reduce((sum, t) => sum + t.avgR * t.quality, 0) / Math.max(1e-6, weightSum);

    this.adaptiveMinRed = this.clamp(this.adaptiveMinRed * 0.98 + avgRed * 0.02 * 0.72, 34, 95);
    this.adaptiveMinCoverage = this.clamp(
      this.adaptiveMinCoverage * 0.985 + coverage * 0.015 * 0.72,
      0.14,
      0.34
    );
  }

  private calculateConfidence(
    fingerPresent: boolean,
    coverage: number,
    centrality: number,
    maskStability: number
  ): number {
    if (!fingerPresent) return 0;

    let confidence = 0.45 * Math.min(1, coverage / 0.62) +
      0.25 * centrality +
      0.30 * maskStability;

    if (this.contactState === 'STABLE_CONTACT') confidence += 0.12;
    return this.clamp(confidence, 0, 1);
  }

  private getGuidanceMessage(): string {
    switch (this.contactState) {
      case 'NO_CONTACT':
        return 'Coloque el dedo sobre la camara';
      case 'PARTIAL_CONTACT':
        return 'Cubra completamente camara y flash';
      case 'ACQUIRING_CONTACT':
        return 'Adquiriendo contacto';
      case 'STABLE_CONTACT':
        return 'Senal estable';
      case 'SATURATED_CONTACT':
        return 'Saturacion: reduzca presion o cambie posicion';
      case 'EXCESSIVE_PRESSURE':
        return 'Reduzca presion';
      case 'MOTION_CORRUPTED':
        return 'Mantenga el dedo quieto';
      default:
        return 'Procesando';
    }
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

  reset(): void {
    this.contactState = 'NO_CONTACT';
    this.consecutiveGoodFrames = 0;
    this.consecutiveBadFrames = 0;
    this.prevMask = null;
    this.prevTileStats = [];
    this.frameCount = 0;
    this.adaptiveMinCoverage = this.config.minCoverage;
    this.adaptiveMinRed = this.config.minRedForFinger;
  }

  getState(): ContactState {
    return this.contactState;
  }
}
