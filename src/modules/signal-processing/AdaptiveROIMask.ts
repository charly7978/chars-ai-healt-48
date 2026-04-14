/**
 * Adaptive ROI mask with explicit saturation/clipping exclusion.
 * Builds a per-frame valid pixel mask, intersects with previous mask for stability.
 */

export interface ROIMaskResult {
  /** Number of valid (non-clipped, non-saturated) pixels */
  validPixels: number;
  /** Total pixels in ROI area */
  totalPixels: number;
  /** Coverage ratio 0-1 */
  coverage: number;
  /** Aggregated RGB from valid pixels only */
  avgR: number;
  avgG: number;
  avgB: number;
  /** Raw (unfiltered) RGB from valid pixels */
  rawR: number;
  rawG: number;
  rawB: number;
  /** Clipping ratios */
  clipHighRatio: number;
  clipLowRatio: number;
  /** Mask stability vs previous frame (0=totally different, 1=identical) */
  maskStability: number;
  /** Fine ROI bounds */
  roiBounds: { x: number; y: number; w: number; h: number };
}

const CLIP_LOW = 10;
const CLIP_HIGH = 245;
const MIN_VALID_INTENSITY = 15;

export class AdaptiveROIMask {
  private prevMask: Uint8Array | null = null;
  private prevWidth = 0;
  private prevHeight = 0;

  /**
   * Process imageData, returning valid-pixel-only aggregates.
   * coarseROIFactor: fraction of image to use as coarse ROI (centered).
   */
  process(imageData: ImageData, coarseROIFactor = 0.75): ROIMaskResult {
    const { width, height, data } = imageData;
    const cx = width >> 1, cy = height >> 1;
    const halfW = Math.floor(width * coarseROIFactor * 0.5);
    const halfH = Math.floor(height * coarseROIFactor * 0.5);
    const x0 = Math.max(0, cx - halfW);
    const y0 = Math.max(0, cy - halfH);
    const x1 = Math.min(width, cx + halfW);
    const y1 = Math.min(height, cy + halfH);
    const roiW = x1 - x0;
    const roiH = y1 - y0;
    const totalPixels = roiW * roiH;

    // Current mask (1 = valid, 0 = clipped/invalid)
    const mask = new Uint8Array(totalPixels);

    let validCount = 0;
    let sumR = 0, sumG = 0, sumB = 0;
    let clipHighCount = 0, clipLowCount = 0;

    // Build mask and aggregate
    let mi = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const pi = (y * width + x) * 4;
        const r = data[pi];
        const g = data[pi + 1];
        const b = data[pi + 2];
        const intensity = r + g + b;

        const isClipHigh = r >= CLIP_HIGH || g >= CLIP_HIGH || b >= CLIP_HIGH;
        const isClipLow = r <= CLIP_LOW && g <= CLIP_LOW && b <= CLIP_LOW;
        const isTooFaint = intensity < MIN_VALID_INTENSITY * 3;

        if (isClipHigh) clipHighCount++;
        if (isClipLow) clipLowCount++;

        if (!isClipHigh && !isClipLow && !isTooFaint) {
          mask[mi] = 1;
          validCount++;
          sumR += r;
          sumG += g;
          sumB += b;
        }
        mi++;
      }
    }

    // Mask stability vs previous frame
    let maskStability = 1.0;
    if (this.prevMask && this.prevMask.length === totalPixels) {
      let same = 0;
      for (let i = 0; i < totalPixels; i++) {
        if (mask[i] === this.prevMask[i]) same++;
      }
      maskStability = same / totalPixels;
    }

    this.prevMask = mask;
    this.prevWidth = roiW;
    this.prevHeight = roiH;

    const inv = validCount > 0 ? 1 / validCount : 0;
    return {
      validPixels: validCount,
      totalPixels,
      coverage: validCount / Math.max(1, totalPixels),
      avgR: sumR * inv,
      avgG: sumG * inv,
      avgB: sumB * inv,
      rawR: sumR * inv,
      rawG: sumG * inv,
      rawB: sumB * inv,
      clipHighRatio: clipHighCount / Math.max(1, totalPixels),
      clipLowRatio: clipLowCount / Math.max(1, totalPixels),
      maskStability,
      roiBounds: { x: x0, y: y0, w: roiW, h: roiH }
    };
  }

  reset(): void {
    this.prevMask = null;
  }
}
