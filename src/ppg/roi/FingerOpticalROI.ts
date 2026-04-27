import { clamp, srgbToLinear, trimmedMean } from "../signal/PPGFilters";

export interface FingerOpticalEvidence {
  roi: { x: number; y: number; width: number; height: number };
  meanRgb: { r: number; g: number; b: number };
  medianRgb: { r: number; g: number; b: number };
  p5Rgb: { r: number; g: number; b: number };
  p95Rgb: { r: number; g: number; b: number };
  linearMean: { r: number; g: number; b: number };
  opticalDensity: { r: number; g: number; b: number };
  highSaturation: { r: number; g: number; b: number };
  lowSaturation: { r: number; g: number; b: number };
  spatialVariance: number;
  dcStability: number;
  dcTrend: number;
  coverageScore: number;
  illuminationScore: number;
  contactScore: number;
  redDominance: number;
  greenPulseAvailability: number;
  pressureRisk: number;
  motionRisk: number;
  reason: string[];
  accepted: boolean;
}

type Channel = "r" | "g" | "b";

const CHANNELS: Channel[] = ["r", "g", "b"];
const EPS = 1e-6;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function trapezoid(value: number, low0: number, low1: number, high1: number, high0: number): number {
  if (!Number.isFinite(value) || value <= low0 || value >= high0) return 0;
  if (value >= low1 && value <= high1) return 1;
  if (value < low1) return (value - low0) / Math.max(1e-6, low1 - low0);
  return (high0 - value) / Math.max(1e-6, high0 - high1);
}

/** Calculate optical density from linear intensity and baseline */
function calculateOpticalDensity(linear: number, baseline: number): number {
  return -Math.log((linear + EPS) / (baseline + EPS));
}

export class FingerOpticalROI {
  private previousLuma: number | null = null;
  private dcStability = 1;
  private lumaHistory: number[] = [];
  private readonly lumaHistorySize = 10;
  private frameCount = 0;

  // Adaptive baseline for optical density (percentile-based, not mean)
  private baselineLinear: { r: number; g: number; b: number } | null = null;
  private baselineAlpha = 0.02; // Slow adaptation

  reset(): void {
    this.previousLuma = null;
    this.dcStability = 1;
    this.lumaHistory = [];
    this.frameCount = 0;
    this.baselineLinear = null;
  }

  analyze(imageData: ImageData): FingerOpticalEvidence {
    this.frameCount++;
    const { width, height, data } = imageData;

    // Full frame analysis - ROI reduction handled by sampler
    const roi = { x: 0, y: 0, width, height };

    // Target ~8000 samples for performance
    const targetSamples = 8000;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / targetSamples)));

    // Collect valid (non-saturated) pixel values
    const rawValues: Record<Channel, number[]> = { r: [], g: [], b: [] };
    const linearValues: Record<Channel, number[]> = { r: [], g: [], b: [] };

    let sumLuma = 0;
    let sumLumaSq = 0;
    let validCount = 0;

    // Saturation tracking
    const highSat = { r: 0, g: 0, b: 0 };
    const lowSat = { r: 0, g: 0, b: 0 };

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // Saturation mask: reject pixels near 0 or 255
        const isSaturated = r >= 252 || g >= 252 || b >= 252;
        const isDark = r <= 3 && g <= 3 && b <= 3;

        if (r >= 252) highSat.r++;
        if (g >= 252) highSat.g++;
        if (b >= 252) highSat.b++;
        if (r <= 3) lowSat.r++;
        if (g <= 3) lowSat.g++;
        if (b <= 3) lowSat.b++;

        // Only include non-saturated pixels
        if (!isSaturated && !isDark) {
          rawValues.r.push(r);
          rawValues.g.push(g);
          rawValues.b.push(b);

          const lr = srgbToLinear(r);
          const lg = srgbToLinear(g);
          const lb = srgbToLinear(b);
          linearValues.r.push(lr);
          linearValues.g.push(lg);
          linearValues.b.push(lb);

          // Perceptual luma for spatial analysis
          const luma = 0.299 * r + 0.587 * g + 0.114 * b;
          sumLuma += luma;
          sumLumaSq += luma * luma;
          validCount++;
        }
      }
    }

    const totalChecked = Math.ceil(width / step) * Math.ceil(height / step);

    // Sort for percentile calculations
    for (const ch of CHANNELS) rawValues[ch].sort((a, b) => a - b);
    for (const ch of CHANNELS) linearValues[ch].sort((a, b) => a - b);

    // Raw RGB statistics
    const meanRgb = {
      r: validCount ? rawValues.r.reduce((a, b) => a + b, 0) / validCount : 0,
      g: validCount ? rawValues.g.reduce((a, b) => a + b, 0) / validCount : 0,
      b: validCount ? rawValues.b.reduce((a, b) => a + b, 0) / validCount : 0,
    };
    const medianRgb = {
      r: percentile(rawValues.r, 0.5),
      g: percentile(rawValues.g, 0.5),
      b: percentile(rawValues.b, 0.5),
    };
    const p5Rgb = {
      r: percentile(rawValues.r, 0.05),
      g: percentile(rawValues.g, 0.05),
      b: percentile(rawValues.b, 0.05),
    };
    const p95Rgb = {
      r: percentile(rawValues.r, 0.95),
      g: percentile(rawValues.g, 0.95),
      b: percentile(rawValues.b, 0.95),
    };

    // Linear intensity (using trimmed mean for robustness)
    const linearMean = {
      r: trimmedMean(linearValues.r, 0.1),
      g: trimmedMean(linearValues.g, 0.1),
      b: trimmedMean(linearValues.b, 0.1),
    };

    // Update adaptive baseline (slow, percentile-based)
    if (!this.baselineLinear) {
      this.baselineLinear = { ...linearMean };
    } else {
      const alpha = this.baselineAlpha;
      this.baselineLinear = {
        r: this.baselineLinear.r * (1 - alpha) + linearMean.r * alpha,
        g: this.baselineLinear.g * (1 - alpha) + linearMean.g * alpha,
        b: this.baselineLinear.b * (1 - alpha) + linearMean.b * alpha,
      };
    }

    // Calculate optical density
    const opticalDensity = {
      r: calculateOpticalDensity(linearMean.r, this.baselineLinear.r),
      g: calculateOpticalDensity(linearMean.g, this.baselineLinear.g),
      b: calculateOpticalDensity(linearMean.b, this.baselineLinear.b),
    };

    // Saturation ratios
    const highSaturation = {
      r: highSat.r / Math.max(1, totalChecked),
      g: highSat.g / Math.max(1, totalChecked),
      b: highSat.b / Math.max(1, totalChecked),
    };
    const lowSaturation = {
      r: lowSat.r / Math.max(1, totalChecked),
      g: lowSat.g / Math.max(1, totalChecked),
      b: lowSat.b / Math.max(1, totalChecked),
    };

    // Spatial variance (uniformity check)
    const meanLuma = validCount ? sumLuma / validCount : 0;
    const spatialVariance = validCount
      ? Math.max(0, sumLumaSq / validCount - meanLuma * meanLuma) / (255 * 255)
      : 0;

    // DC stability tracking
    this.lumaHistory.push(meanLuma);
    if (this.lumaHistory.length > this.lumaHistorySize) {
      this.lumaHistory.shift();
    }

    // Calculate DC trend (simple linear regression on last N samples)
    let dcTrend = 0;
    if (this.lumaHistory.length >= 5) {
      const n = this.lumaHistory.length;
      const sumY = this.lumaHistory.reduce((a, b) => a + b, 0);
      const sumX = (n * (n - 1)) / 2;
      const sumXY = this.lumaHistory.reduce((sum, y, x) => sum + x * y, 0);
      const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
      const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
      dcTrend = slope; // luma units per frame
    }

    // Update DC stability
    if (this.previousLuma !== null) {
      const relChange = Math.abs(meanLuma - this.previousLuma) / Math.max(20, this.previousLuma);
      const instant = clamp01(1 - relChange * 8); // More aggressive than before
      this.dcStability = this.dcStability * 0.88 + instant * 0.12;
    }
    this.previousLuma = meanLuma;

    // Motion risk from DC oscillation
    const motionRisk = clamp01(Math.abs(dcTrend) / 10);

    // Chromatic analysis
    const redRatio = meanRgb.r / Math.max(1, meanRgb.r + meanRgb.g + meanRgb.b);
    const rgRatio = meanRgb.r / Math.max(1, meanRgb.g);
    const rbRatio = meanRgb.r / Math.max(1, meanRgb.b);

    // Red dominance (finger-like under flash)
    const redDominance = clamp01((redRatio - 0.3) / 0.4);

    // Green pulse availability (green channel quality for PPG)
    const greenRange = p95Rgb.g - p5Rgb.g;
    const greenPulseAvailability = clamp01(greenRange / 60);

    // Brightness and illumination
    const brightnessScore = trapezoid(meanLuma, 30, 60, 200, 245);
    const highClip = Math.max(highSaturation.r, highSaturation.g, highSaturation.b);
    const lowClip = Math.max(lowSaturation.r, lowSaturation.g, lowSaturation.b);
    const saturationScore = clamp01(1 - highClip * 3 - lowClip * 2);

    // Illumination score (brightness + saturation check)
    const illuminationScore = clamp01(brightnessScore * 0.7 + saturationScore * 0.3);

    // Coverage score (valid pixels vs expected)
    const coverageRatio = validCount / Math.max(1, totalChecked);
    const uniformityScore = clamp01(1 - spatialVariance * 25);
    const coverageScore = clamp01(coverageRatio * uniformityScore);

    // Contact score (composite of factors that indicate finger contact)
    const contactScore = clamp01(
      coverageScore * 0.35 +
      illuminationScore * 0.25 +
      this.dcStability * 0.25 +
      redDominance * 0.15,
    );

    // Pressure risk (excessive saturation or compression indicators)
    const extremeSat = highClip > 0.15 || lowClip > 0.2;
    const lowVariance = spatialVariance < 0.001 && meanLuma > 200;
    const pressureRisk = clamp01((extremeSat ? 0.6 : 0) + (lowVariance ? 0.4 : 0));

    // Build rejection reasons
    const reason: string[] = [];

    // Hard rejection criteria
    if (coverageScore < 0.3) reason.push("COVERAGE_TOO_LOW");
    if (illuminationScore < 0.25) reason.push("ILLUMINATION_INVALID");
    if (highClip > 0.2) reason.push("HIGH_SATURATION_DESTRUCTIVE");
    if (lowClip > 0.25) reason.push("LOW_SATURATION_BLOCKED");
    if (this.dcStability < 0.35) reason.push("DC_UNSTABLE_MOTION");
    if (motionRisk > 0.5) reason.push("MOTION_DETECTED");
    if (pressureRisk > 0.6) reason.push("PRESSURE_RISK");
    if (redDominance < 0.15) reason.push("NOT_FINGER_LIKE");
    if (validCount < 100) reason.push("INSUFFICIENT_VALID_PIXELS");

    // Soft warnings
    if (coverageScore < 0.5) reason.push("COVERAGE_LOW");
    if (greenPulseAvailability < 0.3) reason.push("GREEN_PULSE_WEAK");

    // Acceptance criteria
    const accepted =
      contactScore >= 0.45 &&
      coverageScore >= 0.3 &&
      illuminationScore >= 0.3 &&
      highClip < 0.15 &&
      lowClip < 0.2 &&
      this.dcStability >= 0.4 &&
      motionRisk < 0.5 &&
      pressureRisk < 0.5;

    return {
      roi,
      meanRgb,
      medianRgb,
      p5Rgb,
      p95Rgb,
      linearMean,
      opticalDensity,
      highSaturation,
      lowSaturation,
      spatialVariance,
      dcStability: this.dcStability,
      dcTrend,
      coverageScore,
      illuminationScore,
      contactScore,
      redDominance,
      greenPulseAvailability,
      pressureRisk,
      motionRisk,
      reason,
      accepted,
    };
  }
}
