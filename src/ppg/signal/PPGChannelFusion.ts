import type { PPGOpticalSample } from "./RadiometricPPGExtractor";
import {
  clamp,
  mean,
  preprocessPPG,
  spectralMetrics,
  std,
  type TimeSample,
} from "./PPGFilters";

export interface FusedPPGChannels {
  t: number;
  g1: number;
  g2: number;
  g3: number;
  selected: number;
  selectedName: "G1_GREEN_OD" | "G2_CHROM_OD" | "G3_PCA_POS";
  channelSnr: { g1: number; g2: number; g3: number };
}

type ChannelName = FusedPPGChannels["selectedName"];

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

function correlation(a: TimeSample[], b: TimeSample[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 8) return 0;
  const av = a.slice(-n).map((sample) => sample.value);
  const bv = b.slice(-n).map((sample) => sample.value);
  const meanA = mean(av);
  const meanB = mean(bv);
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = av[i] - meanA;
    const db = bv[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  return num / Math.sqrt(Math.max(1e-12, denA * denB));
}

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
    const g1Series = this.greenOdSeries(recent);
    const g2Series = this.chromSeries(recent);
    const g3Series = this.pcaSeries(recent, g1Series, g2Series);
    const snr1 = spectralMetrics(g1Series).snrDb;
    const snr2 = spectralMetrics(g2Series).snrDb;
    const snr3 = spectralMetrics(g3Series).snrDb;

    const avgSatG = mean(recent.map((item) => item.saturation.gHigh));
    const avgSatR = mean(recent.map((item) => item.saturation.rHigh));
    const avgSatB = mean(recent.map((item) => item.saturation.bHigh));
    const scores: Array<{ name: ChannelName; score: number }> = [
      { name: "G1_GREEN_OD", score: snr1 - avgSatG * 18 },
      { name: "G2_CHROM_OD", score: snr2 - (avgSatR + avgSatB) * 6 },
      { name: "G3_PCA_POS", score: snr3 - Math.max(avgSatR, avgSatG, avgSatB) * 10 },
    ].sort((a, b) => b.score - a.score);

    const selectedName = scores[0]?.name ?? "G1_GREEN_OD";
    const g1 = latestValue(g1Series);
    const g2 = latestValue(g2Series);
    const g3 = latestValue(g3Series);
    const selected =
      selectedName === "G1_GREEN_OD" ? g1 : selectedName === "G2_CHROM_OD" ? g2 : g3;

    const fused: FusedPPGChannels = {
      t: sample.t,
      g1,
      g2,
      g3,
      selected,
      selectedName,
      channelSnr: { g1: snr1, g2: snr2, g3: snr3 },
    };

    this.history.push(fused);
    this.prune(sample.t);
    return fused;
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

  private greenOdSeries(samples: PPGOpticalSample[]): TimeSample[] {
    return preprocessPPG(samples.map((sample) => ({ t: sample.t, value: sample.od.g })));
  }

  private chromSeries(samples: PPGOpticalSample[]): TimeSample[] {
    if (samples.length < 3) {
      return samples.map((sample) => ({ t: sample.t, value: sample.od.g }));
    }

    const rN = normalizeArray(samples.map((sample) => sample.od.r));
    const gN = normalizeArray(samples.map((sample) => sample.od.g));
    const bN = normalizeArray(samples.map((sample) => sample.od.b));
    const avgSatR = mean(samples.map((sample) => sample.saturation.rHigh));
    const avgSatB = mean(samples.map((sample) => sample.saturation.bHigh));
    const redWeight = 0.5 * clamp(1 - avgSatR * 2.5, 0.05, 1);
    const blueWeight = 0.5 * clamp(1 - avgSatB * 2.5, 0.05, 1);

    const raw = samples.map((sample, index) => ({
      t: sample.t,
      value: gN[index] - redWeight * rN[index] - blueWeight * bN[index],
    }));
    return preprocessPPG(raw);
  }

  private pcaSeries(
    samples: PPGOpticalSample[],
    g1Series: TimeSample[],
    g2Series: TimeSample[],
  ): TimeSample[] {
    if (samples.length < 12) {
      return preprocessPPG(samples.map((sample) => ({ t: sample.t, value: sample.od.g })));
    }

    const rN = normalizeArray(samples.map((sample) => sample.od.r));
    const gN = normalizeArray(samples.map((sample) => sample.od.g));
    const bN = normalizeArray(samples.map((sample) => sample.od.b));
    const rows = samples.map((_, index) => [rN[index], gN[index], bN[index]]);
    const pc = firstPrincipalVector(rows);
    let raw = samples.map((sample, index) => ({
      t: sample.t,
      value: rows[index][0] * pc[0] + rows[index][1] * pc[1] + rows[index][2] * pc[2],
    }));

    const processed = preprocessPPG(raw);
    const align = Math.abs(correlation(processed, g1Series)) >= Math.abs(correlation(processed, g2Series))
      ? correlation(processed, g1Series)
      : correlation(processed, g2Series);
    if (align < 0) {
      raw = raw.map((sample) => ({ t: sample.t, value: -sample.value }));
      return preprocessPPG(raw);
    }

    return processed;
  }

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
