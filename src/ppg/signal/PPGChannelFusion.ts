import type { PPGOpticalSample } from "./RadiometricPPGExtractor";
import {
  autocorrBpm,
  clamp,
  mean,
  preprocessPPGRobust,
  spectralMetrics,
  std,
  type TimeSample,
} from "./PPGFilters";

export type ChannelName =
  | "GREEN_OD"
  | "RED_OD"
  | "BLUE_OD"
  | "CHROM"
  | "POS"
  | "RG_RATIO_OD"
  | "PCA_1";

export interface ChannelMetrics {
  name: ChannelName;
  /** Raw spectral SNR, in dB. */
  snrDb: number;
  /** Fraction of total spectral power inside the cardiac band. */
  bandPowerRatio: number;
  /** Autocorrelation peak strength (0..1). */
  autocorrPeakStrength: number;
  /** FFT vs autocorr BPM agreement (1 = perfect). */
  fftAgreement: number;
  /** Cross-channel agreement: 1 − |bpm − median(otherBpms)| / 30. */
  channelAgreement: number;
  /** Average per-channel saturation in the window (0..1). */
  avgSaturation: number;
  /** Robust perfusion index (mean of |AC|/DC) on this channel. */
  perfusionIndex: number;
  /** Std of the slow baseline over the window. */
  dcDrift: number;
  /** Stability score (1 = full window had a valid baseline). */
  stabilityScore: number;
  /** Composite final score in [0..1] — higher is better. */
  finalScore: number;
  /** Per-term breakdown for the debug panel. */
  scoreBreakdown: {
    snr: number;
    bpr: number;
    autocorr: number;
    fftAgreement: number;
    perfusion: number;
    saturationPenalty: number;
    driftPenalty: number;
    stability: number;
    channelAgreement: number;
  };
  /** Dominant BPM picked by spectral peak (null if below threshold). */
  fftBpm: number | null;
  /** Dominant BPM picked by autocorrelation. */
  autocorrBpm: number | null;
  series: TimeSample[];
  actualFs: number;
}

export interface FusedPPGChannels {
  t: number;
  g1: number;
  g2: number;
  g3: number;
  selected: number;
  selectedName: ChannelName;
  channelSnr: { g1: number; g2: number; g3: number };
  allChannels: ChannelMetrics[];
  selectionReason: string;
}

// Channel configuration for PPG extraction
const CHANNEL_CONFIG: { name: ChannelName; enabled: boolean; priority: number }[] = [
  { name: "GREEN_OD", enabled: true, priority: 1 },
  { name: "RED_OD", enabled: true, priority: 2 },
  { name: "CHROM", enabled: true, priority: 3 },
  { name: "POS", enabled: true, priority: 4 },
  { name: "RG_RATIO_OD", enabled: true, priority: 5 },
  { name: "PCA_1", enabled: false, priority: 6 }, // Only if sufficient window
  { name: "BLUE_OD", enabled: false, priority: 7 }, // Usually too noisy
];

function latestValue(samples: TimeSample[]): number {
  return samples.length > 0 ? samples[samples.length - 1].value : 0;
}

function normalizeArray(values: number[]): number[] {
  const avg = mean(values);
  const scale = std(values) || 1;
  return values.map((value) => (value - avg) / scale);
}

function covariance3(rows: number[][]): number[][] {
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  if (rows.length === 0) return cov;

  for (const row of rows) {
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        cov[i][j] += row[i] * row[j];
      }
    }
  }
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      cov[i][j] /= rows.length;
    }
  }
  return cov;
}

function firstPrincipalVector(rows: number[][]): number[] {
  const cov = covariance3(rows);
  let v = [0.2, 0.7, 0.1];
  for (let iter = 0; iter < 16; iter += 1) {
    const next = [
      cov[0][0] * v[0] + cov[0][1] * v[1] + cov[0][2] * v[2],
      cov[1][0] * v[0] + cov[1][1] * v[1] + cov[1][2] * v[2],
      cov[2][0] * v[0] + cov[2][1] * v[1] + cov[2][2] * v[2],
    ];
    const norm = Math.sqrt(next[0] ** 2 + next[1] ** 2 + next[2] ** 2) || 1;
    v = [next[0] / norm, next[1] / norm, next[2] / norm];
  }
  return v;
}

// (correlation helper removed — dead code, audit 2026-04-27)

export class PPGChannelFusion {
  private opticalSamples: PPGOpticalSample[] = [];
  private history: FusedPPGChannels[] = [];

  constructor(private readonly maxSeconds = 30) {}

  reset(): void {
    this.opticalSamples = [];
    this.history = [];
  }

  push(sample: PPGOpticalSample): FusedPPGChannels {
    this.opticalSamples.push(sample);
    this.prune(sample.t);

    const recent = this.getRecentOptical(12);

    // HARD REJECT: Don't generate data if insufficient samples
    // This prevents generating false data from noise
    if (recent.length < 8) {
      // Return minimal valid data with zeros to indicate no signal
      const minimal: FusedPPGChannels = {
        t: sample.t,
        g1: 0,
        g2: 0,
        g3: 0,
        selected: 0,
        selectedName: "GREEN_OD",
        channelSnr: { g1: -60, g2: -60, g3: -60 },
        allChannels: [],
        selectionReason: "INSUFFICIENT_SAMPLES",
      };
      this.history.push(minimal);
      this.prune(sample.t);
      return minimal;
    }

    // Calculate all channel metrics
    const allChannels = this.calculateAllChannels(recent);

    // If no valid channels, return minimal data
    if (allChannels.length === 0) {
      const minimal: FusedPPGChannels = {
        t: sample.t,
        g1: 0,
        g2: 0,
        g3: 0,
        selected: 0,
        selectedName: "GREEN_OD",
        channelSnr: { g1: -60, g2: -60, g3: -60 },
        allChannels,
        selectionReason: "NO_VALID_CHANNELS",
      };
      this.history.push(minimal);
      this.prune(sample.t);
      return minimal;
    }

    // Select best channel using robust ranking
    const selection = this.selectBestChannel(allChannels, recent);

    // Legacy G1/G2/G3 for backward compatibility
    const g1 = allChannels.find((c) => c.name === "GREEN_OD")?.series ?? [];
    const g2 = allChannels.find((c) => c.name === "CHROM")?.series ?? [];
    const g3 = allChannels.find((c) => c.name === "PCA_1")?.series ?? [];

    const fused: FusedPPGChannels = {
      t: sample.t,
      g1: latestValue(g1),
      g2: latestValue(g2),
      g3: latestValue(g3),
      selected: latestValue(selection.selected.series),
      selectedName: selection.selected.name,
      channelSnr: {
        g1: allChannels.find((c) => c.name === "GREEN_OD")?.snrDb ?? -60,
        g2: allChannels.find((c) => c.name === "CHROM")?.snrDb ?? -60,
        g3: allChannels.find((c) => c.name === "PCA_1")?.snrDb ?? -60,
      },
      allChannels,
      selectionReason: selection.reason,
    };

    this.history.push(fused);
    this.prune(sample.t);
    return fused;
  }

  private calculateAllChannels(samples: PPGOpticalSample[]): ChannelMetrics[] {
    if (samples.length < 8) return [];

    const channels: ChannelMetrics[] = [];
    const duration = (samples[samples.length - 1].t - samples[0].t) / 1000;

    // Enable PCA only if sufficient window (>8s)
    const enablePCA = duration >= 8;

    for (const config of CHANNEL_CONFIG) {
      if (!config.enabled) continue;
      if (config.name === "PCA_1" && !enablePCA) continue;
      if (config.name === "BLUE_OD") continue; // Skip blue (too noisy)

      const series = this.extractChannel(samples, config.name);
      if (series.length < 8) continue;

      const metrics = this.calculateChannelMetrics(series, samples, config.name);
      channels.push(metrics);
    }

    return channels;
  }

  private extractChannel(samples: PPGOpticalSample[], name: ChannelName): TimeSample[] {
    switch (name) {
      case "GREEN_OD":
        return samples.map((s) => ({ t: s.t, value: s.od.g }));
      case "RED_OD":
        return samples.map((s) => ({ t: s.t, value: s.od.r }));
      case "BLUE_OD":
        return samples.map((s) => ({ t: s.t, value: s.od.b }));
      case "CHROM":
        return this.chromRawSeries(samples);
      case "POS":
        return this.posRawSeries(samples);
      case "RG_RATIO_OD":
        return samples.map((s) => ({ t: s.t, value: s.od.r / (s.od.g + 1e-6) }));
      case "PCA_1":
        return this.pcaRawSeries(samples);
      default:
        return [];
    }
  }

  private chromRawSeries(samples: PPGOpticalSample[]): TimeSample[] {
    if (samples.length < 3) return [];
    const rN = normalizeArray(samples.map((s) => s.od.r));
    const gN = normalizeArray(samples.map((s) => s.od.g));
    const bN = normalizeArray(samples.map((s) => s.od.b));
    const avgSatR = mean(samples.map((s) => s.saturation.rHigh));
    const avgSatB = mean(samples.map((s) => s.saturation.bHigh));
    const redWeight = 0.5 * clamp(1 - avgSatR * 2.5, 0.05, 1);
    const blueWeight = 0.5 * clamp(1 - avgSatB * 2.5, 0.05, 1);
    return samples.map((s, i) => ({
      t: s.t,
      value: gN[i] - redWeight * rN[i] - blueWeight * bN[i],
    }));
  }

  private posRawSeries(samples: PPGOpticalSample[]): TimeSample[] {
    // Plane Orthogonal to Skin (POS) algorithm approximation
    if (samples.length < 3) return [];
    const r = normalizeArray(samples.map((s) => s.linear.r));
    const g = normalizeArray(samples.map((s) => s.linear.g));
    const b = normalizeArray(samples.map((s) => s.linear.b));
    // Simplified POS: projection orthogonal to [1, 1, 1] weighted by std
    return samples.map((s, i) => ({
      t: s.t,
      value: g[i] - 0.5 * r[i] - 0.5 * b[i],
    }));
  }

  private pcaRawSeries(samples: PPGOpticalSample[]): TimeSample[] {
    if (samples.length < 12) return [];
    const rN = normalizeArray(samples.map((s) => s.od.r));
    const gN = normalizeArray(samples.map((s) => s.od.g));
    const bN = normalizeArray(samples.map((s) => s.od.b));
    const rows = samples.map((_, i) => [rN[i], gN[i], bN[i]]);
    const pc = firstPrincipalVector(rows);
    return samples.map((s, i) => ({
      t: s.t,
      value: rows[i][0] * pc[0] + rows[i][1] * pc[1] + rows[i][2] * pc[2],
    }));
  }

  private calculateChannelMetrics(
    series: TimeSample[],
    opticalSamples: PPGOpticalSample[],
    name: ChannelName,
  ): ChannelMetrics {
    // Derive target Fs from measured FPS, limit to reasonable range
    const avgFps = mean(opticalSamples.map((s) => s.fps));
    const targetFs = clamp(avgFps, 15, 60); // Limit to 15-60 Hz

    // Preprocess with real Fs
    const preprocessResult = preprocessPPGRobust(series, 0.5, 4.0, targetFs);
    if (!preprocessResult.valid) {
      // Fallback to simple preprocessing if validation fails
      const processed = series.map((s) => ({ t: s.t, value: s.value }));
      return this.createFallbackMetrics(name, processed, opticalSamples);
    }
    const processed = preprocessResult.samples;
    const actualFs = preprocessResult.actualFs;

    // Spectral metrics with actual Fs
    const spectral = spectralMetrics(processed, 0.5, 4.0);

    // Autocorr metrics with actual Fs
    const autocorr = autocorrBpm(processed);

    // FFT BPM for agreement calculation
    const fftBpm = spectral.bandPowerRatio >= 0.35 ? spectral.dominantFrequencyBpm : null;

    // Calculate agreement with FFT
    let fftAgreement = 0;
    if (fftBpm !== null && autocorr.bpm !== null) {
      const diff = Math.abs(fftBpm - autocorr.bpm);
      fftAgreement = Math.max(0, 1 - diff / 30); // 30 BPM tolerance
    }

    // Average saturation for this channel
    let avgSaturation = 0;
    if (name === "GREEN_OD" || name === "CHROM" || name === "POS") {
      avgSaturation = mean(opticalSamples.map((s) => s.saturation.gHigh));
    } else if (name === "RED_OD" || name === "RG_RATIO_OD") {
      avgSaturation = mean(opticalSamples.map((s) => s.saturation.rHigh));
    } else {
      avgSaturation = Math.max(
        mean(opticalSamples.map((s) => s.saturation.rHigh)),
        mean(opticalSamples.map((s) => s.saturation.gHigh)),
        mean(opticalSamples.map((s) => s.saturation.bHigh)),
      );
    }

    // DC drift (stability of baseline)
    const baselines = opticalSamples.map((s) => s.baseline);
    const dcDrift = std(baselines.map((b) => b.r + b.g + b.b));

    // Stability score (requires at least 8s of stable data)
    const stabilityScore = opticalSamples.every((s) => s.baselineValid) ? 1 : 0.5;

    // Final score combining all criteria
    const finalScore =
      spectral.snrDb * 0.25 +
      spectral.bandPowerRatio * 30 +
      (autocorr.score || 0) * 20 +
      fftAgreement * 15 -
      avgSaturation * 25 -
      dcDrift * 5 +
      stabilityScore * 10;

    return {
      name,
      snrDb: spectral.snrDb,
      bandPowerRatio: spectral.bandPowerRatio,
      autocorrPeakStrength: autocorr.score || 0,
      fftAgreement,
      avgSaturation,
      dcDrift,
      stabilityScore,
      finalScore,
      series: processed,
      actualFs,
    };
  }

  private createFallbackMetrics(
    name: ChannelName,
    series: TimeSample[],
    opticalSamples: PPGOpticalSample[],
  ): ChannelMetrics {
    const avgSaturation = mean(opticalSamples.map((s) => s.saturation.gHigh));
    const dcDrift = std(opticalSamples.map((s) => s.baseline.g));
    const stabilityScore = opticalSamples.every((s) => s.baselineValid) ? 1 : 0.5;
    const avgFps = mean(opticalSamples.map((s) => s.fps));
    return {
      name,
      snrDb: -60,
      bandPowerRatio: 0,
      autocorrPeakStrength: 0,
      fftAgreement: 0,
      avgSaturation,
      dcDrift,
      stabilityScore,
      finalScore: -1000,
      series,
      actualFs: clamp(avgFps, 15, 60),
    };
  }

  private selectBestChannel(
    channels: ChannelMetrics[],
    samples: PPGOpticalSample[],
  ): { selected: ChannelMetrics; reason: string } {
    if (channels.length === 0) {
      // Fallback to simple green OD
      const avgFps = mean(samples.map((s) => s.fps));
      return {
        selected: {
          name: "GREEN_OD",
          snrDb: -60,
          bandPowerRatio: 0,
          autocorrPeakStrength: 0,
          fftAgreement: 0,
          avgSaturation: 1,
          dcDrift: 0,
          stabilityScore: 0,
          finalScore: -1000,
          series: samples.map((s) => ({ t: s.t, value: s.od.g })),
          actualFs: clamp(avgFps, 15, 60),
        },
        reason: "NO_VALID_CHANNELS_FALLBACK_GREEN",
      };
    }

    // Sort by final score
    const ranked = [...channels].sort((a, b) => b.finalScore - a.finalScore);
    const best = ranked[0];

    // Build selection reason
    const reasons: string[] = [];
    if (best.snrDb > 5) reasons.push(`SNR:${best.snrDb.toFixed(1)}dB`);
    if (best.bandPowerRatio > 0.4) reasons.push(`BPR:${(best.bandPowerRatio * 100).toFixed(0)}%`);
    if (best.autocorrPeakStrength > 0.3) reasons.push(`AC:${(best.autocorrPeakStrength * 100).toFixed(0)}%`);
    if (best.fftAgreement > 0.7) reasons.push("FFT_AGREE");
    if (best.avgSaturation < 0.1) reasons.push("LOW_SAT");
    if (best.stabilityScore >= 1) reasons.push("STABLE");

    const reason = `${best.name} (${ranked.length} ch) Score:${best.finalScore.toFixed(1)} [${reasons.join(", ")}]`;

    return { selected: best, reason };
  }

  getHistory(seconds = this.maxSeconds): FusedPPGChannels[] {
    if (this.history.length === 0) return [];
    const cutoff = this.history[this.history.length - 1].t - seconds * 1000;
    return this.history.filter((sample) => sample.t >= cutoff);
  }

  getSelectedSeries(seconds = this.maxSeconds): TimeSample[] {
    return this.getHistory(seconds).map((sample) => ({
      t: sample.t,
      value: sample.selected,
    }));
  }

  private getRecentOptical(seconds: number): PPGOpticalSample[] {
    if (this.opticalSamples.length === 0) return [];
    const cutoff = this.opticalSamples[this.opticalSamples.length - 1].t - seconds * 1000;
    return this.opticalSamples.filter((sample) => sample.t >= cutoff);
  }

  // (greenOdSeries / chromSeries / pcaSeries removed — dead code, audit 2026-04-27)

  private prune(now: number): void {
    const cutoff = now - this.maxSeconds * 1000;
    while (this.opticalSamples.length > 0 && this.opticalSamples[0].t < cutoff) {
      this.opticalSamples.shift();
    }
    while (this.history.length > 0 && this.history[0].t < cutoff) {
      this.history.shift();
    }
  }
}
