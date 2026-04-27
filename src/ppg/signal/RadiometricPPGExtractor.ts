import type { RealFrame } from "../camera/FrameSampler";
import { FingerOpticalROI, type FingerOpticalEvidence } from "../roi/FingerOpticalROI";

export interface PPGOpticalSample {
  t: number;
  fps: number;
  raw: { r: number; g: number; b: number };
  linear: { r: number; g: number; b: number };
  od: { r: number; g: number; b: number };
  ac: { r: number; g: number; b: number };
  dc: { r: number; g: number; b: number };
  perfusion: { r: number; g: number; b: number };
  saturation: { rHigh: number; gHigh: number; bHigh: number };
  roiEvidence: FingerOpticalEvidence;
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
  private baseline: Rgb | null = null;
  private samples: PPGOpticalSample[] = [];

  constructor(private readonly maxSeconds = 30) {}

  reset(): void {
    this.roiAnalyzer.reset();
    this.baseline = null;
    this.samples = [];
  }

  getSamples(seconds = this.maxSeconds): PPGOpticalSample[] {
    if (this.samples.length === 0) return [];
    const cutoff = this.samples[this.samples.length - 1].t - seconds * 1000;
    return this.samples.filter((sample) => sample.t >= cutoff);
  }

  processFrame(frame: RealFrame): PPGOpticalSample | null {
    if (!frame.imageData || frame.width <= 0 || frame.height <= 0) return null;

    const evidence = this.roiAnalyzer.analyze(frame.imageData);
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
        if (r >= 250 || g >= 250 || b >= 250) continue;
        if ((r <= 5 && g <= 5 && b <= 5) || r + g + b < 24) continue;

        rawValues.r.push(r);
        rawValues.g.push(g);
        rawValues.b.push(b);
        linearValues.r.push(srgbToLinear(r));
        linearValues.g.push(srgbToLinear(g));
        linearValues.b.push(srgbToLinear(b));
      }
    }

    if (linearValues.r.length < 32) return null;

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

    if (!this.baseline) {
      this.baseline = { ...linear };
    } else {
      const alpha = 0.01;
      this.baseline = {
        r: this.baseline.r * (1 - alpha) + linear.r * alpha,
        g: this.baseline.g * (1 - alpha) + linear.g * alpha,
        b: this.baseline.b * (1 - alpha) + linear.b * alpha,
      };
    }

    const dc = { ...this.baseline };
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
      fps: frame.measuredFps,
      raw,
      linear,
      od,
      ac,
      dc,
      perfusion,
      saturation: {
        rHigh: evidence.highSaturation.r,
        gHigh: evidence.highSaturation.g,
        bHigh: evidence.highSaturation.b,
      },
      roiEvidence: evidence,
    };

    this.samples.push(sample);
    const cutoff = sample.t - this.maxSeconds * 1000;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }

    return sample;
  }
}
