import type { RealFrame } from "../camera/FrameSampler";
import { FingerOpticalROI, type FingerOpticalEvidence } from "../roi/FingerOpticalROI";

export interface PPGOpticalSample {
  t: number;
  dt: number;
  fps: number;
  raw: { r: number; g: number; b: number };
  linear: { r: number; g: number; b: number };
  baseline: { r: number; g: number; b: number };
  od: { r: number; g: number; b: number };
  ac: { r: number; g: number; b: number };
  dc: { r: number; g: number; b: number };
  perfusion: { r: number; g: number; b: number };
  saturation: {
    rHigh: number;
    gHigh: number;
    bHigh: number;
    rLow: number;
    gLow: number;
    bLow: number;
  };
  roiEvidence: FingerOpticalEvidence;
  baselineValid: boolean;
}

type Rgb = { r: number; g: number; b: number };

const EPS = 1e-6;

export function srgbToLinear(v8: number): number {
  const c = v8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function trimmedMean(values: number[], trim = 0.1): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const cut = Math.floor(finite.length * trim);
  const sliced = finite.slice(cut, Math.max(cut + 1, finite.length - cut));
  return sliced.reduce((sum, value) => sum + value, 0) / sliced.length;
}

export class RadiometricPPGExtractor {
  private roiAnalyzer = new FingerOpticalROI();
  private samples: PPGOpticalSample[] = [];
  private lastTimestamp = 0;

  // Baseline history for robust calculation (using median/percentiles)
  private baselineHistory: Rgb[] = [];
  private readonly baselineHistorySize = 45; // 45 seconds of history
  private readonly targetBufferSeconds = 30;

  constructor(private readonly maxSeconds = 45) {}

  reset(): void {
    this.roiAnalyzer.reset();
    this.samples = [];
    this.lastTimestamp = 0;
    this.baselineHistory = [];
  }

  /**
   * Calculate robust baseline using median over stable window
   * Returns null if window is unstable or saturated
   */
  private calculateRobustBaseline(): Rgb | null {
    if (this.baselineHistory.length < 30) return null; // Need at least 1 second at 30fps

    // Check last window for stability
    const recent = this.baselineHistory.slice(-30);
    const rValues = recent.map((v) => v.r).sort((a, b) => a - b);
    const gValues = recent.map((v) => v.g).sort((a, b) => a - b);
    const bValues = recent.map((v) => v.b).sort((a, b) => a - b);

    // Calculate IQR for stability check
    const rIQR = rValues[Math.floor(rValues.length * 0.75)] - rValues[Math.floor(rValues.length * 0.25)];
    const gIQR = gValues[Math.floor(gValues.length * 0.75)] - gValues[Math.floor(gValues.length * 0.25)];
    const bIQR = bValues[Math.floor(bValues.length * 0.75)] - bValues[Math.floor(bValues.length * 0.25)];

    // Reject if too unstable (IQR > threshold)
    const instabilityThreshold = 0.15; // 15% variation
    if (rIQR > instabilityThreshold || gIQR > instabilityThreshold || bIQR > instabilityThreshold) {
      return null; // Window too unstable
    }

    // Use median as robust baseline
    const median = (arr: number[]) => arr[Math.floor(arr.length / 2)];
    return {
      r: median(rValues),
      g: median(gValues),
      b: median(bValues),
    };
  }

  /**
   * Check if baseline history contains excessive saturation
   */
  private hasSaturationInBaseline(): boolean {
    if (this.baselineHistory.length < 10) return false;
    const recent = this.baselineHistory.slice(-10);
    // Check for values near 0 or 1 (saturated)
    const hasZero = recent.some((v) => v.r < 0.01 || v.g < 0.01 || v.b < 0.01);
    const hasOne = recent.some((v) => v.r > 0.99 || v.g > 0.99 || v.b > 0.99);
    return hasZero || hasOne;
  }

  getSamples(seconds = this.maxSeconds): PPGOpticalSample[] {
    if (this.samples.length === 0) return [];
    const cutoff = this.samples[this.samples.length - 1].t - seconds * 1000;
    return this.samples.filter((sample) => sample.t >= cutoff);
  }

  processFrame(frame: RealFrame): PPGOpticalSample | null {
    if (!frame.imageData || frame.width <= 0 || frame.height <= 0) return null;

    const evidence = this.roiAnalyzer.analyze(frame.imageData);

    // Skip processing if ROI is rejected
    if (!evidence.accepted) {
      return null;
    }

    const { data, width } = frame.imageData;
    const roi = evidence.roi;
    const step = Math.max(1, Math.floor(Math.sqrt((roi.width * roi.height) / 9000)));
    const rawValues: Record<keyof Rgb, number[]> = { r: [], g: [], b: [] };
    const linearValues: Record<keyof Rgb, number[]> = { r: [], g: [], b: [] };

    for (let y = roi.y; y < roi.y + roi.height; y += step) {
      for (let x = roi.x; x < roi.x + roi.width; x += step) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        // Aggressive saturation masking
        if (r >= 252 || g >= 252 || b >= 252) continue;
        if (r <= 3 && g <= 3 && b <= 3) continue;
        if (r + g + b < 24) continue;

        rawValues.r.push(r);
        rawValues.g.push(g);
        rawValues.b.push(b);
        linearValues.r.push(srgbToLinear(r));
        linearValues.g.push(srgbToLinear(g));
        linearValues.b.push(srgbToLinear(b));
      }
    }

    if (linearValues.r.length < 32) return null;

    // Calculate dt from real timestamps
    const dt = this.lastTimestamp > 0 ? frame.timestampMs - this.lastTimestamp : 1000 / frame.measuredFps;
    this.lastTimestamp = frame.timestampMs;

    const raw = {
      r: trimmedMean(rawValues.r),
      g: trimmedMean(rawValues.g),
      b: trimmedMean(rawValues.b),
    };
    const linear = {
      r: trimmedMean(linearValues.r),
      g: trimmedMean(linearValues.g),
      b: trimmedMean(linearValues.b),
    };

    // Add to baseline history
    this.baselineHistory.push({ ...linear });
    if (this.baselineHistory.length > this.baselineHistorySize * 30) { // ~30fps * 45s
      this.baselineHistory.shift();
    }

    // Calculate robust baseline
    const baseline = this.calculateRobustBaseline();
    const baselineValid = baseline !== null && !this.hasSaturationInBaseline();

    // Use robust baseline if valid, otherwise use current linear (AC will be near zero)
    const dc = baseline ?? { ...linear };
    const ac = {
      r: linear.r - dc.r,
      g: linear.g - dc.g,
      b: linear.b - dc.b,
    };
    const od = {
      r: -Math.log((linear.r + EPS) / (dc.r + EPS)),
      g: -Math.log((linear.g + EPS) / (dc.g + EPS)),
      b: -Math.log((linear.b + EPS) / (dc.b + EPS)),
    };
    const perfusion = {
      r: clamp((Math.abs(ac.r) / (dc.r + EPS)) * 100, 0, 100),
      g: clamp((Math.abs(ac.g) / (dc.g + EPS)) * 100, 0, 100),
      b: clamp((Math.abs(ac.b) / (dc.b + EPS)) * 100, 0, 100),
    };

    const sample: PPGOpticalSample = {
      t: frame.timestampMs,
      dt,
      fps: frame.measuredFps,
      raw,
      linear,
      baseline: dc,
      od,
      ac,
      dc,
      perfusion,
      saturation: {
        rHigh: evidence.highSaturation.r,
        gHigh: evidence.highSaturation.g,
        bHigh: evidence.highSaturation.b,
        rLow: evidence.lowSaturation.r,
        gLow: evidence.lowSaturation.g,
        bLow: evidence.lowSaturation.b,
      },
      roiEvidence: evidence,
      baselineValid,
    };

    this.samples.push(sample);
    // Keep 30-45 seconds of buffer
    const cutoff = sample.t - this.targetBufferSeconds * 1000;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }

    return sample;
  }
}
