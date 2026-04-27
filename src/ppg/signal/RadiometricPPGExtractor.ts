import type { RealFrame } from "../camera/FrameSampler";
import { FingerOpticalROI, type FingerOpticalEvidence } from "../roi/FingerOpticalROI";
import { clamp, mean, median, srgbToLinear, std, trimmedMean } from "./PPGFilters";

/**
 * Closed enum of all reasons the extractor can refuse to emit a sample.
 * Keeping this typed prevents silent drift between extractor → publication
 * gate → UI guidance layers.
 */
export type ExtractorRejectionReason =
  | "NO_IMAGE_DATA"
  | "ACQUISITION_GATE_COVERAGE"
  | "ACQUISITION_GATE_LUMA"
  | "ACQUISITION_GATE_RED_DOMINANCE"
  | "ACQUISITION_GATE_GLOBAL_SATURATION"
  | "INSUFFICIENT_VALID_PIXELS"
  | "ROI_NOT_ACCEPTED"
  | "ALL_CHANNELS_SATURATED";

/**
 * Per-channel availability mask. True means the channel is physically usable
 * for PPG extraction (not clipped, not too dark).
 */
export interface ChannelMask {
  r: boolean;
  g: boolean;
  b: boolean;
}

/**
 * Robust DC statistics per channel — produced fresh every frame from the
 * unsaturated pixel pool. Consumers should prefer `median` for the optical
 * baseline and use `trimmedMean` only when a smoothed estimator is required.
 */
export interface DCStatsRgb {
  median: { r: number; g: number; b: number };
  trimmedMean: { r: number; g: number; b: number };
  p5: { r: number; g: number; b: number };
  p95: { r: number; g: number; b: number };
}

export interface PPGOpticalSample {
  t: number;
  dt: number;
  fps: number;
  /** Trimmed-mean RGB intensity from the unsaturated pool (legacy field). */
  raw: { r: number; g: number; b: number };
  /** Linear (γ-removed) intensity used for OD math. */
  linear: { r: number; g: number; b: number };
  /** Slow-adapting baseline used as DC reference for OD. */
  baseline: { r: number; g: number; b: number };
  /** Optical density per channel:  -ln((I + ε) / (DC_ref + ε)). */
  od: { r: number; g: number; b: number };
  /** AC component on linear intensity (instantaneous, sample − baseline). */
  ac: { r: number; g: number; b: number };
  /** Robust AC: linear − rolling-median trend (less sensitive to outliers). */
  acRobust: { r: number; g: number; b: number };
  /** Same as `baseline`; kept as alias for explicit AC/DC math. */
  dc: { r: number; g: number; b: number };
  /** Full robust DC statistics (median / trimmedMean / p5 / p95). */
  dcStats: DCStatsRgb;
  /** Perfusion index per channel: |AC| / DC * 100 (clamped 0..100). */
  perfusion: { r: number; g: number; b: number };
  /** AC/DC ratio per channel (0..1, undivided perfusion). */
  acdc: { r: number; g: number; b: number };
  /** Per-channel saturation snapshot from the ROI evidence. */
  saturation: {
    rHigh: number;
    gHigh: number;
    bHigh: number;
    rLow: number;
    gLow: number;
    bLow: number;
  };
  /** Channels usable as PPG sources for downstream fusion. */
  channelMask: ChannelMask;
  roiEvidence: FingerOpticalEvidence;
  baselineValid: boolean;
}

type Rgb = { r: number; g: number; b: number };

/** ε used inside log() to bound the optical density at very low intensities. */
const OD_EPSILON = 1e-4;

/** Robust standard deviation scale factor for MAD → σ. */
const MAD_SCALE = 1.4826;

export interface ExtractorRejection {
  evidence: FingerOpticalEvidence;
  reason: ExtractorRejectionReason;
  detail: string;
}

export class RadiometricPPGExtractor {
  private roiAnalyzer = new FingerOpticalROI();
  private samples: PPGOpticalSample[] = [];
  private lastTimestamp = 0;

  // Baseline history for robust DC (using median over a stable window).
  private baselineHistory: Rgb[] = [];
  private readonly baselineHistorySize = 45; // seconds
  private readonly targetBufferSeconds = 30;

  // EMA fallback baseline for startup
  private emaBaseline: Rgb | null = null;

  // Diagnostics — even when a frame is rejected, downstream UI can show why.
  private lastEvidence: FingerOpticalEvidence | null = null;
  private lastRejection: ExtractorRejection | null = null;

  constructor(private readonly maxSeconds = 45) {}

  reset(): void {
    this.roiAnalyzer.reset();
    this.samples = [];
    this.lastTimestamp = 0;
    this.baselineHistory = [];
    this.emaBaseline = null;
    this.lastEvidence = null;
    this.lastRejection = null;
  }

  getLastEvidence(): FingerOpticalEvidence | null {
    return this.lastEvidence;
  }

  /** Returns the structured rejection from the last failed `processFrame`. */
  getLastRejection(): ExtractorRejection | null {
    return this.lastRejection;
  }

  /** Convenience accessor: legacy callers expecting a string. */
  getLastRejectionMessage(): string | null {
    return this.lastRejection
      ? `${this.lastRejection.reason}: ${this.lastRejection.detail}`
      : null;
  }

  /**
   * Robust slow baseline computed across the recent history (median over a
   * stable window). Returns null while the window is too short or unstable.
   */
  private calculateRobustBaseline(): Rgb | null {
    if (this.baselineHistory.length < 10) return null;
    const recent = this.baselineHistory.slice(-10);
    const rValues = recent.map((v) => v.r).sort((a, b) => a - b);
    const gValues = recent.map((v) => v.g).sort((a, b) => a - b);
    const bValues = recent.map((v) => v.b).sort((a, b) => a - b);

    // IQR-based stability check — reject if any channel jitter > 30% of range.
    const iqr = (s: number[]) =>
      s[Math.floor(s.length * 0.75)] - s[Math.floor(s.length * 0.25)];
    const instabilityThreshold = 0.3;
    if (
      iqr(rValues) > instabilityThreshold ||
      iqr(gValues) > instabilityThreshold ||
      iqr(bValues) > instabilityThreshold
    ) {
      return null;
    }

    const med = (arr: number[]) => arr[Math.floor(arr.length / 2)];
    return { r: med(rValues), g: med(gValues), b: med(bValues) };
  }

  private hasSaturationInBaseline(): boolean {
    if (this.baselineHistory.length < 10) return false;
    const recent = this.baselineHistory.slice(-10);
    const hasZero = recent.some((v) => v.r < 0.01 || v.g < 0.01 || v.b < 0.01);
    const hasOne = recent.some((v) => v.r > 0.99 || v.g > 0.99 || v.b > 0.99);
    return hasZero || hasOne;
  }

  getSamples(seconds = this.maxSeconds): PPGOpticalSample[] {
    if (this.samples.length === 0) return [];
    const cutoff = this.samples[this.samples.length - 1].t - seconds * 1000;
    return this.samples.filter((sample) => sample.t >= cutoff);
  }

  private reject(
    evidence: FingerOpticalEvidence | null,
    reason: ExtractorRejectionReason,
    detail: string,
  ): null {
    this.lastRejection = evidence
      ? { evidence, reason, detail }
      : ({ reason, detail } as unknown as ExtractorRejection);
    return null;
  }

  processFrame(frame: RealFrame): PPGOpticalSample | null {
    if (!frame.imageData || frame.imageWidth <= 0 || frame.imageHeight <= 0) {
      return this.reject(null, "NO_IMAGE_DATA", "frame has no ImageData payload");
    }

    const evidence = this.roiAnalyzer.analyze(frame.imageData);
    this.lastEvidence = evidence;

    // ── ACQUISITION GATE ────────────────────────────────────────────────
    // Cheap physical-sanity gate. The strict medical-grade gating happens
    // downstream in PPGPublicationGate — here we just refuse to inject
    // junk frames into the sample buffer.
    const meanLuma =
      0.299 * evidence.meanRgb.r +
      0.587 * evidence.meanRgb.g +
      0.114 * evidence.meanRgb.b;

    if (evidence.coverageScore < 0.20) {
      return this.reject(
        evidence,
        "ACQUISITION_GATE_COVERAGE",
        `coverage=${evidence.coverageScore.toFixed(2)} (<0.20)`,
      );
    }
    if (meanLuma < 25) {
      return this.reject(
        evidence,
        "ACQUISITION_GATE_LUMA",
        `meanLuma=${meanLuma.toFixed(0)} (<25)`,
      );
    }
    if (evidence.redDominance < 0.05) {
      return this.reject(
        evidence,
        "ACQUISITION_GATE_RED_DOMINANCE",
        `red=${evidence.redDominance.toFixed(2)} (<0.05)`,
      );
    }
    const maxHigh = Math.max(
      evidence.highSaturation.r,
      evidence.highSaturation.g,
      evidence.highSaturation.b,
    );
    const maxLow = Math.max(
      evidence.lowSaturation.r,
      evidence.lowSaturation.g,
      evidence.lowSaturation.b,
    );
    // Only refuse on GLOBAL saturation — single-channel clip is fine because
    // the channel mask below will simply mark that channel unusable.
    if (maxHigh > 0.55 || maxLow > 0.55) {
      return this.reject(
        evidence,
        "ACQUISITION_GATE_GLOBAL_SATURATION",
        `highMax=${maxHigh.toFixed(2)} lowMax=${maxLow.toFixed(2)}`,
      );
    }
    if (!evidence.accepted) {
      return this.reject(
        evidence,
        "ROI_NOT_ACCEPTED",
        `state=${evidence.contactState} pressure=${evidence.pressureState} score=${evidence.contactScore.toFixed(2)} tiles=${evidence.usableTileCount}/${evidence.tileCount} reasons=${evidence.reason.join("+") || "NONE"}`,
      );
    }

    // ── PIXEL POOL (per-channel, independently masked) ──────────────────
    const { data, width } = frame.imageData;
    const roi = evidence.roi;
    const step = Math.max(1, Math.floor(Math.sqrt((roi.width * roi.height) / 9000)));
    const rawValues: Record<keyof Rgb, number[]> = { r: [], g: [], b: [] };
    const linearValues: Record<keyof Rgb, number[]> = { r: [], g: [], b: [] };

    // Per-channel saturation thresholds — a clipped red pixel still
    // contributes a valid green sample, so we mask independently.
    const HIGH = 252;
    const LOW = 3;

    for (let y = roi.y; y < roi.y + roi.height; y += step) {
      const rowBase = y * width * 4;
      for (let x = roi.x; x < roi.x + roi.width; x += step) {
        const idx = rowBase + x * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        if (r < HIGH && r > LOW) {
          rawValues.r.push(r);
          linearValues.r.push(srgbToLinear(r));
        }
        if (g < HIGH && g > LOW) {
          rawValues.g.push(g);
          linearValues.g.push(srgbToLinear(g));
        }
        if (b < HIGH && b > LOW) {
          rawValues.b.push(b);
          linearValues.b.push(srgbToLinear(b));
        }
      }
    }

    // Need at least one channel with enough pixels to be useful.
    const minPixels = 32;
    const channelsWithPool = {
      r: linearValues.r.length >= minPixels,
      g: linearValues.g.length >= minPixels,
      b: linearValues.b.length >= minPixels,
    };
    if (!channelsWithPool.r && !channelsWithPool.g && !channelsWithPool.b) {
      return this.reject(
        evidence,
        "INSUFFICIENT_VALID_PIXELS",
        `r=${linearValues.r.length} g=${linearValues.g.length} b=${linearValues.b.length}`,
      );
    }

    // ── DC STATS (robust, multi-estimator, per channel) ─────────────────
    const safeStat = (arr: number[], fn: (a: number[]) => number, fb = 0) =>
      arr.length >= minPixels ? fn(arr) : fb;
    const safeP = (arr: number[], p: number) => {
      if (arr.length < minPixels) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1);
      return sorted[idx];
    };
    const dcStats: DCStatsRgb = {
      median: {
        r: safeStat(linearValues.r, median),
        g: safeStat(linearValues.g, median),
        b: safeStat(linearValues.b, median),
      },
      trimmedMean: {
        r: safeStat(linearValues.r, (a) => trimmedMean(a, 0.1)),
        g: safeStat(linearValues.g, (a) => trimmedMean(a, 0.1)),
        b: safeStat(linearValues.b, (a) => trimmedMean(a, 0.1)),
      },
      p5: {
        r: safeP(linearValues.r, 0.05),
        g: safeP(linearValues.g, 0.05),
        b: safeP(linearValues.b, 0.05),
      },
      p95: {
        r: safeP(linearValues.r, 0.95),
        g: safeP(linearValues.g, 0.95),
        b: safeP(linearValues.b, 0.95),
      },
    };

    // Trimmed mean is what we feed into the slow baseline tracker — it is
    // more stable than the median for low-N pools but still rejects outliers.
    const linear: Rgb = { ...dcStats.trimmedMean };
    const raw: Rgb = {
      r: safeStat(rawValues.r, (a) => trimmedMean(a, 0.1)),
      g: safeStat(rawValues.g, (a) => trimmedMean(a, 0.1)),
      b: safeStat(rawValues.b, (a) => trimmedMean(a, 0.1)),
    };

    // ── TIMING ──────────────────────────────────────────────────────────
    const dt =
      this.lastTimestamp > 0
        ? frame.timestampMs - this.lastTimestamp
        : 1000 / Math.max(1, frame.measuredFps);
    this.lastTimestamp = frame.timestampMs;

    // ── BASELINE TRACKING ───────────────────────────────────────────────
    this.baselineHistory.push({ ...linear });
    if (this.baselineHistory.length > this.baselineHistorySize * 30) {
      this.baselineHistory.shift();
    }
    const baseline = this.calculateRobustBaseline();
    const baselineValid = baseline !== null && !this.hasSaturationInBaseline();
    let dc: Rgb;
    if (baselineValid && baseline) {
      dc = baseline;
      this.emaBaseline = { ...baseline };
    } else if (this.emaBaseline) {
      const alpha = 0.02;
      this.emaBaseline = {
        r: this.emaBaseline.r * (1 - alpha) + linear.r * alpha,
        g: this.emaBaseline.g * (1 - alpha) + linear.g * alpha,
        b: this.emaBaseline.b * (1 - alpha) + linear.b * alpha,
      };
      dc = this.emaBaseline;
    } else {
      this.emaBaseline = { ...linear };
      dc = { ...linear };
    }

    // ── AC / OD / PERFUSION ─────────────────────────────────────────────
    // Instantaneous AC (sample − slow baseline)
    const ac: Rgb = {
      r: linear.r - dc.r,
      g: linear.g - dc.g,
      b: linear.b - dc.b,
    };
    // Robust AC using a short rolling MEDIAN trend over recent samples.
    // This is what perfusionIndex / channel-quality should consume because
    // it is invariant to single-frame outliers.
    const acRobust = this.computeRobustAc(linear);

    // Optical density with documented epsilon. ε bounds I/DC away from 0.
    const od: Rgb = {
      r: -Math.log((linear.r + OD_EPSILON) / (dc.r + OD_EPSILON)),
      g: -Math.log((linear.g + OD_EPSILON) / (dc.g + OD_EPSILON)),
      b: -Math.log((linear.b + OD_EPSILON) / (dc.b + OD_EPSILON)),
    };

    // Perfusion index per channel — uses ROBUST AC.
    const acdc: Rgb = {
      r: Math.abs(acRobust.r) / Math.max(OD_EPSILON, dc.r),
      g: Math.abs(acRobust.g) / Math.max(OD_EPSILON, dc.g),
      b: Math.abs(acRobust.b) / Math.max(OD_EPSILON, dc.b),
    };
    const perfusion: Rgb = {
      r: clamp(acdc.r * 100, 0, 100),
      g: clamp(acdc.g * 100, 0, 100),
      b: clamp(acdc.b * 100, 0, 100),
    };

    // ── CHANNEL MASK (per-channel usability for fusion) ─────────────────
    const channelMask: ChannelMask = {
      r:
        channelsWithPool.r &&
        evidence.highSaturation.r < 0.25 &&
        evidence.lowSaturation.r < 0.30,
      g:
        channelsWithPool.g &&
        evidence.highSaturation.g < 0.25 &&
        evidence.lowSaturation.g < 0.30,
      b:
        channelsWithPool.b &&
        evidence.highSaturation.b < 0.30 &&
        evidence.lowSaturation.b < 0.30,
    };

    if (!channelMask.r && !channelMask.g && !channelMask.b) {
      return this.reject(
        evidence,
        "ALL_CHANNELS_SATURATED",
        `R sat=${evidence.highSaturation.r.toFixed(2)} G sat=${evidence.highSaturation.g.toFixed(2)} B sat=${evidence.highSaturation.b.toFixed(2)}`,
      );
    }

    this.lastRejection = null;

    const sample: PPGOpticalSample = {
      t: frame.timestampMs,
      dt,
      fps: frame.measuredFps,
      raw,
      linear,
      baseline: dc,
      od,
      ac,
      acRobust,
      dc,
      dcStats,
      perfusion,
      acdc,
      saturation: {
        rHigh: evidence.highSaturation.r,
        gHigh: evidence.highSaturation.g,
        bHigh: evidence.highSaturation.b,
        rLow: evidence.lowSaturation.r,
        gLow: evidence.lowSaturation.g,
        bLow: evidence.lowSaturation.b,
      },
      channelMask,
      roiEvidence: evidence,
      baselineValid,
    };

    this.samples.push(sample);
    const cutoff = sample.t - this.targetBufferSeconds * 1000;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }

    return sample;
  }

  /**
   * Compute AC as the residual against a rolling-median trend over the last
   * ~1 second of samples. This is much more robust to motion spikes than
   * `linear − slow_baseline` and is what perfusion / channel-SNR should use.
   */
  private computeRobustAc(currentLinear: Rgb): Rgb {
    const N = 30; // ~1 s at 30 fps
    if (this.samples.length < 5) {
      // Not enough history yet — fall back to zero AC. The slow-baseline
      // path above will catch it on the next iteration.
      return { r: 0, g: 0, b: 0 };
    }
    const tail = this.samples.slice(-N);
    const robustMed = (pick: (s: PPGOpticalSample) => number, current: number) => {
      const arr = tail.map(pick).concat(current);
      const m = median(arr);
      // MAD scaling kept for diagnostics; not subtracted from AC itself.
      void (MAD_SCALE * std(arr));
      return current - m;
    };
    return {
      r: robustMed((s) => s.linear.r, currentLinear.r),
      g: robustMed((s) => s.linear.g, currentLinear.g),
      b: robustMed((s) => s.linear.b, currentLinear.b),
    };
  }
}

// Re-export for legacy callers that imported the helper directly.
export { mean as _meanInternal };
