/**
 * FingerContactDetector - Real finger contact detection with tile-based segmentation
 * Uses color analysis, spatial connectivity, and temporal hysteresis
 * Replaces simple ROI with actual finger tissue detection
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
}

const DEFAULT_CONFIG: FingerContactDetectorConfig = {
  tileSize: 16,
  gridRows: 8,
  gridCols: 8,
  minCoverage: 0.15,
  minRedForFinger: 40,
  stableEntryFrames: 8,
  unstableExitFrames: 12,
  motionThreshold: 0.3,
  pressureThreshold: 0.7
};

export class FingerContactDetector {
  private config: FingerContactDetectorConfig;
  private contactState: ContactState = 'NO_CONTACT';
  private consecutiveGoodFrames = 0;
  private consecutiveBadFrames = 0;
  private prevMask: Uint8Array | null = null;
  private prevTileStats: TileStats[] = [];
  private frameCount = 0;

  // Adaptive thresholds
  private adaptiveMinCoverage = DEFAULT_CONFIG.minCoverage;
  private adaptiveMinRed = DEFAULT_CONFIG.minRedForFinger;

  constructor(config?: Partial<FingerContactDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Analyze frame for finger contact
   */
  analyze(imageData: ImageData): ContactAnalysis {
    this.frameCount++;

    const { width, height, data } = imageData;
    const cx = width >> 1;
    const cy = height >> 1;

    // Define analysis region (center crop)
    const cropSize = Math.min(width, height) * 0.75;
    const x0 = Math.max(0, Math.floor(cx - cropSize / 2));
    const y0 = Math.max(0, Math.floor(cy - cropSize / 2));
    const x1 = Math.min(width, Math.floor(cx + cropSize / 2));
    const y1 = Math.min(height, Math.floor(cy + cropSize / 2));
    const roiW = x1 - x0;
    const roiH = y1 - y0;

    // Tile analysis
    const tileStats = this.analyzeTiles(data, width, x0, y0, roiW, roiH);
    
    // Build binary mask
    const mask = this.buildContactMask(tileStats, roiW, roiH);
    
    // Calculate metrics
    const validPixels = mask.reduce((sum, v) => sum + v, 0);
    const totalPixels = roiW * roiH;
    const coverage = validPixels / totalPixels;

    // Centrality - how close valid region is to center
    const centrality = this.calculateCentrality(mask, roiW, roiH);

    // Clipping ratios
    const { clipHigh, clipLow } = this.calculateClipping(tileStats);

    // Uniformity - spatial variance
    const uniformity = this.calculateUniformity(tileStats);

    // Mask stability vs previous frame
    const maskStability = this.calculateMaskStability(mask, totalPixels);

    // Motion score - tile-level changes
    const motionScore = this.calculateMotionScore(tileStats);

    // Pressure score - based on saturation and uniformity
    const pressureScore = this.calculatePressureScore(tileStats, uniformity, clipHigh);

    // Determine if finger is present
    const fingerPresent = this.isFingerPresent(tileStats, coverage, clipHigh, clipLow, maskStability);

    // Update state machine with hysteresis
    this.updateContactState(fingerPresent, pressureScore, motionScore, clipHigh, coverage);

    // Adaptive threshold adjustment
    this.adaptThresholds(tileStats, coverage);

    const guidanceMessage = this.getGuidanceMessage();

    // Store for next frame
    this.prevMask = mask;
    this.prevTileStats = tileStats;

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
      confidence: this.calculateConfidence(fingerPresent, coverage, maskStability),
      guidanceMessage,
      tileStats,
      mask
    };
  }

  /**
   * Analyze image in tiles
   */
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

        let sumR = 0, sumG = 0, sumB = 0;
        let count = 0;
        let saturatedCount = 0;
        let darkCount = 0;

        // Sample pixels (every 2nd for performance)
        for (let y = ty; y < ty + th; y += 2) {
          for (let x = tx; x < tx + tw; x += 2) {
            const pi = (y * imageWidth + x) * 4;
            const r = data[pi];
            const g = data[pi + 1];
            const b = data[pi + 2];

            sumR += r;
            sumG += g;
            sumB += b;
            count++;

            if (r >= 250 || g >= 250 || b >= 250) saturatedCount++;
            if (r <= 10 && g <= 10 && b <= 10) darkCount++;
          }
        }

        if (count === 0) {
          stats.push({
            avgR: 0, avgG: 0, avgB: 0,
            intensity: 0, redRatio: 0, rgRatio: 0,
            isSaturated: false, isTooDark: true,
            isValid: false, quality: 0
          });
          continue;
        }

        const avgR = sumR / count;
        const avgG = sumG / count;
        const avgB = sumB / count;
        const intensity = avgR + avgG + avgB;
        const total = intensity + 1e-6;
        const redRatio = avgR / total;
        const rgRatio = avgR / (avgG + 1);

        const isSaturated = saturatedCount / count > 0.5;
        const isTooDark = darkCount / count > 0.5 || intensity < 30;

        // Quality score based on finger-like properties
        let quality = 0;
        if (!isSaturated && !isTooDark) {
          // Red dominance (finger transmits red via hemoglobin)
          const redDominance = redRatio >= 0.25 && redRatio <= 0.55 ? 1 : 0;
          // R/G ratio for skin
          const rgValid = rgRatio >= 0.6 && rgRatio <= 4.0 ? 1 : 0;
          // Intensity in reasonable range
          const intensityValid = intensity >= 50 && intensity <= 600 ? 1 : 0;
          
          quality = (redDominance * 0.4 + rgValid * 0.35 + intensityValid * 0.25);
        }

        stats.push({
          avgR, avgG, avgB,
          intensity,
          redRatio,
          rgRatio,
          isSaturated,
          isTooDark,
          isValid: quality > 0.4,
          quality
        });
      }
    }

    return stats;
  }

  /**
   * Build binary contact mask from tile stats
   */
  private buildContactMask(tileStats: TileStats[], roiW: number, roiH: number): Uint8Array {
    const tileW = Math.ceil(roiW / this.config.gridCols);
    const tileH = Math.ceil(roiH / this.config.gridRows);
    const mask = new Uint8Array(roiW * roiH);

    for (let row = 0; row < this.config.gridRows; row++) {
      for (let col = 0; col < this.config.gridCols; col++) {
        const idx = row * this.config.gridCols + col;
        const tile = tileStats[idx];

        if (tile.isValid) {
          // Fill tile region in mask
          const tx0 = col * tileW;
          const ty0 = row * tileH;
          const tw = Math.min(tileW, roiW - tx0);
          const th = Math.min(tileH, roiH - ty0);

          for (let y = ty0; y < ty0 + th; y++) {
            for (let x = tx0; x < tx0 + tw; x++) {
              mask[y * roiW + x] = 1;
            }
          }
        }
      }
    }

    return mask;
  }

  /**
   * Calculate centrality of valid region
   */
  private calculateCentrality(mask: Uint8Array, width: number, height: number): number {
    let sumX = 0, sumY = 0, count = 0;
    const cx = width / 2;
    const cy = height / 2;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (mask[y * width + x]) {
          sumX += Math.abs(x - cx);
          sumY += Math.abs(y - cy);
          count++;
        }
      }
    }

    if (count === 0) return 0;

    const avgDistX = sumX / count;
    const avgDistY = sumY / count;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    const avgDist = Math.sqrt(avgDistX * avgDistX + avgDistY * avgDistY);

    return Math.max(0, 1 - avgDist / maxDist);
  }

  /**
   * Calculate clipping ratios
   */
  private calculateClipping(tileStats: TileStats[]): { clipHigh: number; clipLow: number } {
    let saturated = 0, dark = 0, total = tileStats.length;

    for (const tile of tileStats) {
      if (tile.isSaturated) saturated++;
      if (tile.isTooDark) dark++;
    }

    return {
      clipHigh: saturated / total,
      clipLow: dark / total
    };
  }

  /**
   * Calculate spatial uniformity
   */
  private calculateUniformity(tileStats: TileStats[]): number {
    const validTiles = tileStats.filter(t => t.isValid);
    if (validTiles.length < 4) return 0;

    const intensities = validTiles.map(t => t.intensity);
    const mean = intensities.reduce((a, b) => a + b, 0) / intensities.length;
    const variance = intensities.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intensities.length;
    const cv = Math.sqrt(variance) / (mean + 1e-6);

    // cv near 0 = very uniform (could be excessive pressure)
    // cv > 0.3 = varied (good for pulsatility)
    return Math.max(0, Math.min(1, 1 - cv * 2));
  }

  /**
   * Calculate mask stability vs previous frame
   */
  private calculateMaskStability(mask: Uint8Array, totalPixels: number): number {
    if (!this.prevMask || this.prevMask.length !== mask.length) return 1.0;

    let same = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === this.prevMask[i]) same++;
    }

    return same / totalPixels;
  }

  /**
   * Calculate motion score from tile changes
   */
  private calculateMotionScore(tileStats: TileStats[]): number {
    if (this.prevTileStats.length === 0 || this.prevTileStats.length !== tileStats.length) {
      return 0;
    }

    let totalDiff = 0;
    for (let i = 0; i < tileStats.length; i++) {
      const diff = Math.abs(tileStats[i].intensity - this.prevTileStats[i].intensity);
      totalDiff += diff;
    }

    const avgDiff = totalDiff / tileStats.length;
    return Math.min(1, avgDiff / 50); // Normalize
  }

  /**
   * Calculate pressure score
   */
  private calculatePressureScore(tileStats: TileStats[], uniformity: number, clipHigh: number): number {
    let score = 0;

    // High uniformity suggests blood squeezed out
    score += uniformity > 0.85 ? 0.3 : uniformity > 0.7 ? 0.15 : 0;

    // High saturation
    score += clipHigh > 0.3 ? 0.4 : clipHigh > 0.1 ? 0.2 : 0;

    // High intensity average
    const avgIntensity = tileStats.reduce((sum, t) => sum + t.intensity, 0) / tileStats.length;
    score += avgIntensity > 200 ? 0.3 : avgIntensity > 150 ? 0.15 : 0;

    return Math.min(1, score);
  }

  /**
   * Determine if finger is present
   */
  private isFingerPresent(
    tileStats: TileStats[],
    coverage: number,
    clipHigh: number,
    clipLow: number,
    maskStability: number
  ): boolean {
    // Coverage check
    if (coverage < this.adaptiveMinCoverage) return false;

    // Valid tiles check
    const validTiles = tileStats.filter(t => t.isValid);
    if (validTiles.length < tileStats.length * 0.3) return false;

    // Average red intensity
    const avgRed = validTiles.reduce((sum, t) => sum + t.avgR, 0) / validTiles.length;
    if (avgRed < this.adaptiveMinRed) return false;

    // Red dominance
    const avgRedRatio = validTiles.reduce((sum, t) => sum + t.redRatio, 0) / validTiles.length;
    if (avgRedRatio < 0.25) return false;

    // Clipping rejection
    if (clipHigh > 0.6 || clipLow > 0.5) return false;

    // Mask stability after initial frames
    if (this.frameCount > 10 && maskStability < 0.3) return false;

    return true;
  }

  /**
   * Update contact state machine with hysteresis
   */
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

    // Check for motion corruption
    if (motionScore > this.config.motionThreshold && this.contactState === 'STABLE_CONTACT') {
      this.contactState = 'MOTION_CORRUPTED';
      this.consecutiveGoodFrames = 0;
      return;
    }

    // Check for excessive pressure
    if (pressureScore > this.config.pressureThreshold) {
      this.contactState = 'EXCESSIVE_PRESSURE';
      return;
    }

    // Check for saturation
    if (clipHigh > 0.35) {
      this.contactState = 'SATURATED_CONTACT';
      return;
    }

    // Main state transitions
    if (!fingerPresent) {
      if (this.consecutiveBadFrames >= this.config.unstableExitFrames) {
        this.contactState = 'NO_CONTACT';
      } else if (this.contactState !== 'NO_CONTACT') {
        this.contactState = coverage > 0.1 ? 'PARTIAL_CONTACT' : 'ACQUIRING_CONTACT';
      }
      return;
    }

    // Finger present
    if (this.consecutiveGoodFrames >= this.config.stableEntryFrames) {
      this.contactState = 'STABLE_CONTACT';
    } else if (this.consecutiveGoodFrames >= 3) {
      this.contactState = 'ACQUIRING_CONTACT';
    } else {
      this.contactState = 'PARTIAL_CONTACT';
    }
  }

  /**
   * Adapt thresholds based on recent history
   */
  private adaptThresholds(tileStats: TileStats[], coverage: number): void {
    if (this.frameCount < 30) return;

    const validTiles = tileStats.filter(t => t.isValid);
    if (validTiles.length === 0) return;

    const avgRed = validTiles.reduce((sum, t) => sum + t.avgR, 0) / validTiles.length;

    // Slowly adapt red threshold
    this.adaptiveMinRed = this.adaptiveMinRed * 0.95 + avgRed * 0.05 * 0.8;

    // Adapt coverage threshold based on recent success
    if (this.contactState === 'STABLE_CONTACT') {
      this.adaptiveMinCoverage = this.adaptiveMinCoverage * 0.98 + coverage * 0.02 * 0.9;
    }
  }

  /**
   * Calculate overall confidence
   */
  private calculateConfidence(fingerPresent: boolean, coverage: number, maskStability: number): number {
    if (!fingerPresent) return 0;

    let confidence = coverage * 0.4 + maskStability * 0.6;

    // Boost for stable state
    if (this.contactState === 'STABLE_CONTACT') {
      confidence = Math.min(1, confidence + 0.2);
    }

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Get guidance message for user
   */
  private getGuidanceMessage(): string {
    switch (this.contactState) {
      case 'NO_CONTACT':
        return 'Coloque el dedo sobre la cámara';
      case 'PARTIAL_CONTACT':
        return 'Presione más el dedo';
      case 'ACQUIRING_CONTACT':
        return 'Detectando dedo...';
      case 'STABLE_CONTACT':
        return 'Señal estable';
      case 'SATURATED_CONTACT':
        return 'Demasiada luz - aleje el dedo';
      case 'EXCESSIVE_PRESSURE':
        return 'Reduzca la presión';
      case 'MOTION_CORRUPTED':
        return 'Mantenga el dedo quieto';
      default:
        return '...';
    }
  }

  /**
   * Reset detector state
   */
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

  /**
   * Get current contact state
   */
  getState(): ContactState {
    return this.contactState;
  }
}
