import { srgbToLinear, trimmedMean } from "../signal/PPGFilters";

/**
 * High-level finger-contact state derived from the per-tile analysis.
 */
export type FingerContactState =
  | "absent"
  | "searching"
  | "partial"
  | "stable"
  | "overexposed"
  | "underexposed"
  | "motion_rejected";

/**
 * Pressure proxy state. Drives user guidance ("press more / less / hold still").
 * Derived from a multi-metric vote — never from a single signal.
 */
export type FingerPressureState =
  | "weak_contact"      // dedo apoyado muy flojo o levantado
  | "low_pressure"      // contacto presente pero perfusión pobre
  | "optimal"           // dentro del sweet spot fisiológico
  | "high_pressure"     // bloqueando perfusión, AC/DC bajando
  | "excessive_pressure"; // saturación + variabilidad casi cero

/**
 * Reason codes returned in `evidence.reason`. Documented as a closed enum to
 * prevent silent drift between detector and UI/guidance layers.
 */
export type FingerRejectionReason =
  | "COVERAGE_TOO_LOW"
  | "COVERAGE_LOW"
  | "ILLUMINATION_INVALID"
  | "RED_CHANNEL_SATURATED"
  | "GREEN_CHANNEL_SATURATED"
  | "BLUE_CHANNEL_SATURATED"
  | "HIGH_SATURATION_DESTRUCTIVE"
  | "LOW_SATURATION_BLOCKED"
  | "DC_UNSTABLE_MOTION"
  | "MOTION_DETECTED"
  | "PRESSURE_RISK"
  | "EXCESSIVE_PRESSURE"
  | "WEAK_CONTACT"
  | "NOT_FINGER_LIKE"
  | "FLAT_SURFACE_NO_TEXTURE"
  | "INSUFFICIENT_VALID_PIXELS"
  | "INSUFFICIENT_USABLE_TILES"
  | "ROI_UNSTABLE"
  | "CENTROID_DRIFT"
  | "LUMINANCE_JITTER"
  | "GREEN_PULSE_WEAK"
  | "OVEREXPOSED"
  | "UNDEREXPOSED"
  | "MOTION_REJECTED";

export interface TileStat {
  index: number;
  rect: { x: number; y: number; width: number; height: number };
  meanRgb: { r: number; g: number; b: number };
  highClip: number;
  lowClip: number;
  pulsatileCandidateScore: number;
  usable: boolean;
}

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
  // Per-channel saturation aliases (preferred names in spec). Same data
  // as highSaturation.{r,g,b} but exposed flat for downstream readers.
  redSaturationRatio: number;
  greenSaturationRatio: number;
  blueSaturationRatio: number;
  /** Pixels where ALL three channels are simultaneously clipped. */
  clippedPixelRatio: number;
  usablePixelRatio: { r: number; g: number; b: number };
  usablePixelRatioMax: number;
  spatialVariance: number;
  /** Spatial uniformity (1 = perfectly uniform). */
  uniformityScore: number;
  /** Mean |∇L| over green channel — distinguishes finger texture from a flat surface. */
  textureScore: number;
  dcStability: number;
  dcTrend: number;
  /** |luma_t − luma_{t-1}| / 255, capped to [0,1]. */
  luminanceDelta: number;
  /** Pixel distance of usable-tile centroid from frame center, normalised by min(w,h)/2. */
  centroidDrift: number;
  /** Composite motion artifact score (luminanceDelta + centroidDrift + dcTrend). */
  motionArtifactScore: number;
  coverageScore: number;
  illuminationScore: number;
  contactScore: number;
  redDominance: number;
  greenPulseAvailability: number;
  pressureRisk: number;
  motionRisk: number;
  reason: FingerRejectionReason[];
  accepted: boolean;
  tiles: TileStat[];
  usableTileCount: number;
  tileCount: number;
  roiStabilityScore: number;
  perfusionScore: number;
  saturationScore: number;
  motionScore: number;
  opticalContactScore: number;
  channelUsable: { r: boolean; g: boolean; b: boolean };
  contactState: FingerContactState;
  pressureState: FingerPressureState;
  /** Human-readable, actionable hint for the UI. Empty string if no guidance needed. */
  userGuidance: string;
}

const TILE_GRID = 5; // 5×5 tile grid

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

  // Tile usability mask from the previous frame, used to compute roiStabilityScore
  // (intersection-over-union of usable tiles).
  private previousUsableTileMask: boolean[] | null = null;

  // Centroid (in normalised tile coordinates) of usable tiles in the previous
  // frame — used to compute frame-to-frame ROI drift independently of IoU.
  private previousCentroid: { x: number; y: number } | null = null;

  // Smoothed AC/DC ratio on the green channel — used by the pressure model.
  private smoothedGreenAcDc = 0;

  reset(): void {
    this.previousLuma = null;
    this.dcStability = 1;
    this.lumaHistory = [];
    this.frameCount = 0;
    this.baselineLinear = null;
    this.previousUsableTileMask = null;
    this.previousCentroid = null;
    this.smoothedGreenAcDc = 0;
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
    let validCount = 0; // pixels usable in at least one channel (luma stats)

    // Per-channel usable counts (pixels not clipped on that channel)
    const usableCount = { r: 0, g: 0, b: 0 };

    // Saturation tracking
    const highSat = { r: 0, g: 0, b: 0 };
    const lowSat = { r: 0, g: 0, b: 0 };

    // Per-channel saturation thresholds. We keep them tight at the top
    // (the flash easily clips red on dark skin) but allow black-level noise
    // floor on the bottom (sensors rarely return true 0).
    const HIGH = 250;
    const LOW = 4;

    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        const rHigh = r >= HIGH;
        const gHigh = g >= HIGH;
        const bHigh = b >= HIGH;
        const rLow = r <= LOW;
        const gLow = g <= LOW;
        const bLow = b <= LOW;

        if (rHigh) highSat.r++;
        if (gHigh) highSat.g++;
        if (bHigh) highSat.b++;
        if (rLow) lowSat.r++;
        if (gLow) lowSat.g++;
        if (bLow) lowSat.b++;

        const rUsable = !rHigh && !rLow;
        const gUsable = !gHigh && !gLow;
        const bUsable = !bHigh && !bLow;

        // Independent channel masking: a clipped red pixel still contributes
        // green and blue, so the green-channel pulse signal is preserved even
        // when the flash blows out red.
        if (rUsable) {
          rawValues.r.push(r);
          linearValues.r.push(srgbToLinear(r));
          usableCount.r++;
        }
        if (gUsable) {
          rawValues.g.push(g);
          linearValues.g.push(srgbToLinear(g));
          usableCount.g++;
        }
        if (bUsable) {
          rawValues.b.push(b);
          linearValues.b.push(srgbToLinear(b));
          usableCount.b++;
        }

        if (rUsable || gUsable || bUsable) {
          // Luma uses whatever channels survived; missing channels fall back
          // to the per-channel midpoint so we don't artificially darken stats.
          const lr = rUsable ? r : 128;
          const lg = gUsable ? g : 128;
          const lb = bUsable ? b : 128;
          const luma = 0.299 * lr + 0.587 * lg + 0.114 * lb;
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

    // Per-channel raw RGB statistics — each channel uses only its own usable pool
    const meanRgb = {
      r: usableCount.r ? rawValues.r.reduce((a, b) => a + b, 0) / usableCount.r : 0,
      g: usableCount.g ? rawValues.g.reduce((a, b) => a + b, 0) / usableCount.g : 0,
      b: usableCount.b ? rawValues.b.reduce((a, b) => a + b, 0) / usableCount.b : 0,
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

    const usablePixelRatio = {
      r: usableCount.r / Math.max(1, totalChecked),
      g: usableCount.g / Math.max(1, totalChecked),
      b: usableCount.b / Math.max(1, totalChecked),
    };
    const usablePixelRatioMax = Math.max(
      usablePixelRatio.r,
      usablePixelRatio.g,
      usablePixelRatio.b,
    );

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

    // Update DC stability + frame-to-frame luminance delta
    let luminanceDelta = 0;
    if (this.previousLuma !== null) {
      luminanceDelta = clamp01(Math.abs(meanLuma - this.previousLuma) / 255);
      const relChange = Math.abs(meanLuma - this.previousLuma) / Math.max(20, this.previousLuma);
      const instant = clamp01(1 - relChange * 8); // More aggressive than before
      this.dcStability = this.dcStability * 0.88 + instant * 0.12;
    }
    this.previousLuma = meanLuma;

    // Motion risk from DC oscillation (will be augmented later by centroid drift)
    let motionRisk = clamp01(Math.abs(dcTrend) / 10);

    // Chromatic analysis
    const redRatio = meanRgb.r / Math.max(1, meanRgb.r + meanRgb.g + meanRgb.b);

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

    // Coverage uses the BEST channel — if green is fully usable we shouldn't
    // reject the frame just because red is saturated under flash.
    const coverageRatio = usablePixelRatioMax;
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

    // ── Tile grid (TILE_GRID×TILE_GRID) ─────────────────────────────────────
    // Single, sparse pass over each tile. Used to:
    //   - locate the cleanest sub-region (future ROI smoothing)
    //   - compute usableTileCount and roiStabilityScore
    //   - produce a per-tile heatmap for the debug UI
    //   - veto frames where contact is only on a couple of tiles
    const tiles: TileStat[] = [];
    const tileMask: boolean[] = new Array(TILE_GRID * TILE_GRID).fill(false);
    const tileW = Math.max(1, Math.floor(width / TILE_GRID));
    const tileH = Math.max(1, Math.floor(height / TILE_GRID));
    const tileStep = Math.max(1, Math.floor(Math.sqrt((tileW * tileH) / 200))); // ~200 samples/tile
    let perfusionAccum = 0;
    let perfusionCount = 0;

    for (let ty = 0; ty < TILE_GRID; ty++) {
      for (let tx = 0; tx < TILE_GRID; tx++) {
        const x0 = tx * tileW;
        const y0 = ty * tileH;
        const x1 = tx === TILE_GRID - 1 ? width : x0 + tileW;
        const y1 = ty === TILE_GRID - 1 ? height : y0 + tileH;

        let tileR = 0;
        let tileG = 0;
        let tileB = 0;
        let tilePixels = 0;
        let tileHigh = 0;
        let tileLow = 0;
        let tileGmin = 255;
        let tileGmax = 0;

        for (let yy = y0; yy < y1; yy += tileStep) {
          const rowBase = yy * width * 4;
          for (let xx = x0; xx < x1; xx += tileStep) {
            const idx = rowBase + xx * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            tileR += r;
            tileG += g;
            tileB += b;
            tilePixels++;
            const maxCh = r > g ? (r > b ? r : b) : g > b ? g : b;
            const minCh = r < g ? (r < b ? r : b) : g < b ? g : b;
            if (maxCh >= 250) tileHigh++;
            if (minCh <= 4) tileLow++;
            if (g < tileGmin) tileGmin = g;
            if (g > tileGmax) tileGmax = g;
          }
        }

        const tileMean = {
          r: tilePixels ? tileR / tilePixels : 0,
          g: tilePixels ? tileG / tilePixels : 0,
          b: tilePixels ? tileB / tilePixels : 0,
        };
        const tileHighRatio = tilePixels ? tileHigh / tilePixels : 0;
        const tileLowRatio = tilePixels ? tileLow / tilePixels : 0;

        // Pulsatile candidate: prefers tiles with healthy red dominance,
        // moderate brightness, and a non-trivial green dynamic range.
        const tileRedDom = tileMean.r / Math.max(1, tileMean.r + tileMean.g + tileMean.b);
        const tileBright = (tileMean.r + tileMean.g + tileMean.b) / 3;
        const greenSpan = Math.max(0, tileGmax - tileGmin) / 64; // normalised
        const candidate = clamp01(
          (tileRedDom > 0.34 ? 1 : tileRedDom / 0.34) * 0.4 +
            (tileBright > 60 && tileBright < 230 ? 1 : 0) * 0.3 +
            Math.min(1, greenSpan) * 0.3,
        );
        // Adaptive validity: tile must not be saturated/clipped, must be at
        // least moderately bright and pass the candidate threshold.
        const usable =
          tileHighRatio < 0.25 &&
          tileLowRatio < 0.25 &&
          tileBright > 35 &&
          tileBright < 245 &&
          candidate > 0.35;

        const tileIdx = ty * TILE_GRID + tx;
        tileMask[tileIdx] = usable;
        if (usable) {
          perfusionAccum += Math.min(1, greenSpan);
          perfusionCount++;
        }

        tiles.push({
          index: tileIdx,
          rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
          meanRgb: tileMean,
          highClip: tileHighRatio,
          lowClip: tileLowRatio,
          pulsatileCandidateScore: candidate,
          usable,
        });
      }
    }

    let usableTileCount = 0;
    for (const t of tileMask) if (t) usableTileCount++;

    // ROI stability = IoU of the usable-tile masks frame-to-frame.
    let roiStabilityScore = 1;
    if (this.previousUsableTileMask) {
      let intersect = 0;
      let union = 0;
      for (let i = 0; i < tileMask.length; i++) {
        const a = tileMask[i];
        const b = this.previousUsableTileMask[i];
        if (a && b) intersect++;
        if (a || b) union++;
      }
      roiStabilityScore = union === 0 ? 1 : intersect / union;
    }
    this.previousUsableTileMask = tileMask;

    const perfusionScore = perfusionCount > 0 ? clamp01(perfusionAccum / perfusionCount) : 0;
    const motionScore = clamp01(1 - motionRisk);
    const opticalContactScore = clamp01(
      coverageScore * 0.3 +
        illuminationScore * 0.2 +
        this.dcStability * 0.2 +
        redDominance * 0.15 +
        (usableTileCount / (TILE_GRID * TILE_GRID)) * 0.15,
    );

    // Per-channel availability for downstream gates.
    const channelUsable = {
      r: usablePixelRatio.r >= 0.4 && highSaturation.r < 0.2 && lowSaturation.r < 0.25,
      g: usablePixelRatio.g >= 0.4 && highSaturation.g < 0.25 && lowSaturation.g < 0.25,
      b: usablePixelRatio.b >= 0.4 && highSaturation.b < 0.3 && lowSaturation.b < 0.3,
    };

    // High-level contact state (does NOT replace `accepted` — it adds nuance).
    let contactState: FingerContactState;
    if (highClip > 0.35 && meanLuma > 220) contactState = "overexposed";
    else if (meanLuma < 25 || coverageScore < 0.15) contactState = "underexposed";
    else if (redDominance < 0.1 && coverageScore < 0.25) contactState = "absent";
    else if (motionRisk > 0.5 || roiStabilityScore < 0.35) contactState = "motion_rejected";
    else if (
      opticalContactScore >= 0.55 &&
      usableTileCount >= 12 &&
      roiStabilityScore >= 0.6 &&
      this.dcStability >= 0.5
    )
      contactState = "stable";
    else if (opticalContactScore >= 0.35 && usableTileCount >= 6) contactState = "partial";
    else contactState = "searching";

    if (usableTileCount < 6) reason.push("INSUFFICIENT_USABLE_TILES");
    if (roiStabilityScore < 0.4) reason.push("ROI_UNSTABLE");
    if (contactState === "overexposed") reason.push("OVEREXPOSED");
    if (contactState === "underexposed") reason.push("UNDEREXPOSED");
    if (contactState === "motion_rejected") reason.push("MOTION_REJECTED");

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
      usablePixelRatio,
      usablePixelRatioMax,
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
      tiles,
      usableTileCount,
      tileCount: TILE_GRID * TILE_GRID,
      roiStabilityScore,
      perfusionScore,
      saturationScore,
      motionScore,
      opticalContactScore,
      channelUsable,
      contactState,
    };
  }
}
