export interface FingerOpticalEvidence {
  roi: { x: number; y: number; width: number; height: number };
  meanRgb: { r: number; g: number; b: number };
  medianRgb: { r: number; g: number; b: number };
  p5Rgb: { r: number; g: number; b: number };
  p95Rgb: { r: number; g: number; b: number };
  highSaturation: { r: number; g: number; b: number };
  lowSaturation: { r: number; g: number; b: number };
  spatialVariance: number;
  dcStability: number;
  coverageScore: number;
  illuminationScore: number;
  contactScore: number;
  reason: string[];
}

type Channel = "r" | "g" | "b";

const CHANNELS: Channel[] = ["r", "g", "b"];

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

export class FingerOpticalROI {
  private previousLuma: number | null = null;
  private dcStability = 1;

  reset(): void {
    this.previousLuma = null;
    this.dcStability = 1;
  }

  analyze(imageData: ImageData): FingerOpticalEvidence {
    const { width, height, data } = imageData;
    const roiWidth = Math.max(1, Math.floor(width * 0.6));
    const roiHeight = Math.max(1, Math.floor(height * 0.6));
    const x0 = Math.max(0, Math.floor((width - roiWidth) / 2));
    const y0 = Math.max(0, Math.floor((height - roiHeight) / 2));
    const step = Math.max(1, Math.floor(Math.sqrt((roiWidth * roiHeight) / 7000)));

    const values: Record<Channel, number[]> = { r: [], g: [], b: [] };
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumLuma = 0;
    let sumLumaSq = 0;
    let count = 0;
    const high = { r: 0, g: 0, b: 0 };
    const low = { r: 0, g: 0, b: 0 };

    for (let y = y0; y < y0 + roiHeight; y += step) {
      for (let x = x0; x < x0 + roiWidth; x += step) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

        values.r.push(r);
        values.g.push(g);
        values.b.push(b);
        sumR += r;
        sumG += g;
        sumB += b;
        sumLuma += luma;
        sumLumaSq += luma * luma;
        count += 1;

        if (r >= 250) high.r += 1;
        if (g >= 250) high.g += 1;
        if (b >= 250) high.b += 1;
        if (r <= 5) low.r += 1;
        if (g <= 5) low.g += 1;
        if (b <= 5) low.b += 1;
      }
    }

    for (const ch of CHANNELS) values[ch].sort((a, b) => a - b);

    const meanRgb = {
      r: count ? sumR / count : 0,
      g: count ? sumG / count : 0,
      b: count ? sumB / count : 0,
    };
    const medianRgb = {
      r: percentile(values.r, 0.5),
      g: percentile(values.g, 0.5),
      b: percentile(values.b, 0.5),
    };
    const p5Rgb = {
      r: percentile(values.r, 0.05),
      g: percentile(values.g, 0.05),
      b: percentile(values.b, 0.05),
    };
    const p95Rgb = {
      r: percentile(values.r, 0.95),
      g: percentile(values.g, 0.95),
      b: percentile(values.b, 0.95),
    };

    const highSaturation = {
      r: count ? high.r / count : 0,
      g: count ? high.g / count : 0,
      b: count ? high.b / count : 0,
    };
    const lowSaturation = {
      r: count ? low.r / count : 0,
      g: count ? low.g / count : 0,
      b: count ? low.b / count : 0,
    };

    const meanLuma = count ? sumLuma / count : 0;
    const spatialVariance = count
      ? Math.max(0, sumLumaSq / count - meanLuma * meanLuma) / (255 * 255)
      : 0;

    if (this.previousLuma !== null) {
      const relChange = Math.abs(meanLuma - this.previousLuma) / Math.max(20, this.previousLuma);
      const instant = clamp01(1 - relChange * 5);
      this.dcStability = this.dcStability * 0.85 + instant * 0.15;
    }
    this.previousLuma = meanLuma;

    const redRatio = meanRgb.r / Math.max(1, meanRgb.r + meanRgb.g + meanRgb.b);
    const rgRatio = meanRgb.r / Math.max(1, meanRgb.g);
    const rbRatio = meanRgb.r / Math.max(1, meanRgb.b);
    const brightnessScore = trapezoid(meanLuma, 22, 45, 225, 252);
    const redScore = 0.5 * trapezoid(redRatio, 0.28, 0.33, 0.62, 0.72) +
      0.25 * trapezoid(rgRatio, 0.75, 0.95, 3.6, 5.5) +
      0.25 * trapezoid(rbRatio, 0.9, 1.15, 8.0, 12.0);
    const uniformityScore = clamp01(1 - spatialVariance * 18);
    const highClip = Math.max(highSaturation.r, highSaturation.g, highSaturation.b);
    const lowClip = Math.max(lowSaturation.r, lowSaturation.g, lowSaturation.b);
    const saturationScore = clamp01(1 - highClip * 2.2 - lowClip * 1.8);

    const coverageScore = clamp01(
      brightnessScore * 0.34 +
        redScore * 0.30 +
        uniformityScore * 0.18 +
        saturationScore * 0.18,
    );
    const illuminationScore = clamp01(brightnessScore * 0.65 + saturationScore * 0.35);
    const contactScore = clamp01(
      coverageScore * 0.45 +
        illuminationScore * 0.20 +
        this.dcStability * 0.20 +
        redScore * 0.15,
    );

    const reason: string[] = [];
    if (coverageScore < 0.45) reason.push("ROI_COVERAGE_LOW");
    if (illuminationScore < 0.45) reason.push("ILLUMINATION_INVALID");
    if (highClip > 0.25) reason.push("HIGH_SATURATION");
    if (lowClip > 0.30) reason.push("LOW_SATURATION");
    if (this.dcStability < 0.55) reason.push("DC_UNSTABLE");
    if (redScore < 0.35) reason.push("CHROMA_NOT_FINGER_LIKE");

    return {
      roi: { x: x0, y: y0, width: roiWidth, height: roiHeight },
      meanRgb,
      medianRgb,
      p5Rgb,
      p95Rgb,
      highSaturation,
      lowSaturation,
      spatialVariance,
      dcStability: this.dcStability,
      coverageScore,
      illuminationScore,
      contactScore,
      reason,
    };
  }
}
