export interface TimeSample {
  t: number;
  value: number;
}

export class PPGFilterRing {
  private samples: TimeSample[] = [];

  constructor(private readonly maxSeconds = 30) {}

  add(sample: TimeSample): void {
    if (!Number.isFinite(sample.t) || !Number.isFinite(sample.value)) return;
    this.samples.push(sample);
    const cutoff = sample.t - this.maxSeconds * 1000;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  clear(): void {
    this.samples = [];
  }

  all(): TimeSample[] {
    return [...this.samples];
  }

  recent(seconds: number): TimeSample[] {
    if (this.samples.length === 0) return [];
    const cutoff = this.samples[this.samples.length - 1].t - seconds * 1000;
    return this.samples.filter((sample) => sample.t >= cutoff);
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function median(values: number[]): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[mid - 1] + finite[mid]) / 2 : finite[mid];
}

export function mean(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

export function std(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return 0;
  const avg = mean(finite);
  const variance = finite.reduce((sum, value) => sum + (value - avg) ** 2, 0) / finite.length;
  return Math.sqrt(Math.max(0, variance));
}

export function mad(values: number[]): number {
  const med = median(values);
  return median(values.map((value) => Math.abs(value - med)));
}

export function durationMs(samples: TimeSample[]): number {
  if (samples.length < 2) return 0;
  return samples[samples.length - 1].t - samples[0].t;
}

export function resampleUniform(samples: TimeSample[], targetHz = 30): TimeSample[] {
  const clean = samples.filter(
    (sample) => Number.isFinite(sample.t) && Number.isFinite(sample.value),
  );
  if (clean.length < 2) return clean;

  const stepMs = 1000 / targetHz;
  const out: TimeSample[] = [];
  let cursor = 1;
  const start = clean[0].t;
  const end = clean[clean.length - 1].t;

  for (let t = start; t <= end; t += stepMs) {
    while (cursor < clean.length - 1 && clean[cursor].t < t) {
      cursor += 1;
    }
    const prev = clean[Math.max(0, cursor - 1)];
    const next = clean[cursor];
    if (!next || next.t === prev.t) {
      out.push({ t, value: prev.value });
      continue;
    }
    const f = clamp((t - prev.t) / (next.t - prev.t), 0, 1);
    out.push({ t, value: prev.value + (next.value - prev.value) * f });
  }

  return out;
}

export function detrendEma(samples: TimeSample[], cutoffHz = 0.25): TimeSample[] {
  if (samples.length < 2) return samples;
  let trend = samples[0].value;
  const out: TimeSample[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    const dt = i === 0 ? 1000 / 30 : Math.max(1, samples[i].t - samples[i - 1].t);
    const rc = 1000 / (2 * Math.PI * cutoffHz);
    const alpha = clamp(dt / (rc + dt), 0.001, 1);
    trend += alpha * (samples[i].value - trend);
    out.push({ t: samples[i].t, value: samples[i].value - trend });
  }
  return out;
}

export function onePoleLowPass(samples: TimeSample[], cutoffHz = 4): TimeSample[] {
  if (samples.length < 2) return samples;
  let y = samples[0].value;
  const out: TimeSample[] = [];
  for (let i = 0; i < samples.length; i += 1) {
    const dt = i === 0 ? 1000 / 30 : Math.max(1, samples[i].t - samples[i - 1].t);
    const rc = 1000 / (2 * Math.PI * cutoffHz);
    const alpha = clamp(dt / (rc + dt), 0.001, 1);
    y += alpha * (samples[i].value - y);
    out.push({ t: samples[i].t, value: y });
  }
  return out;
}

export function bandpass(samples: TimeSample[], lowHz = 0.5, highHz = 4.0): TimeSample[] {
  const highPassed = detrendEma(samples, lowHz);
  return onePoleLowPass(highPassed, highHz);
}

export function hampel(samples: TimeSample[], windowRadius = 5, threshold = 3): TimeSample[] {
  if (samples.length < windowRadius * 2 + 1) return samples;
  return samples.map((sample, index) => {
    const lo = Math.max(0, index - windowRadius);
    const hi = Math.min(samples.length, index + windowRadius + 1);
    const neighborhood = samples.slice(lo, hi).map((item) => item.value);
    const med = median(neighborhood);
    const scale = 1.4826 * mad(neighborhood) || std(neighborhood) || 1e-6;
    if (Math.abs(sample.value - med) > threshold * scale) {
      return { t: sample.t, value: med };
    }
    return sample;
  });
}

export function robustNormalize(samples: TimeSample[]): TimeSample[] {
  if (samples.length === 0) return [];
  const values = samples.map((sample) => sample.value);
  const med = median(values);
  const scale = 1.4826 * mad(values) || std(values) || 1;
  return samples.map((sample) => ({
    t: sample.t,
    value: clamp((sample.value - med) / scale, -6, 6),
  }));
}

export function preprocessPPG(
  samples: TimeSample[],
  lowHz = 0.5,
  highHz = 4.0,
  targetHz = 30,
): TimeSample[] {
  if (samples.length < 3) return samples;
  const uniform = resampleUniform(samples, targetHz);
  const clean = hampel(uniform, 5, 3);
  const filtered = bandpass(clean, lowHz, highHz);
  return robustNormalize(filtered);
}

export function savitzkyGolayVisual(samples: TimeSample[]): TimeSample[] {
  if (samples.length < 5) return samples;
  const coeff = [-3, 12, 17, 12, -3];
  const norm = 35;
  return samples.map((sample, index) => {
    if (index < 2 || index > samples.length - 3) return sample;
    let value = 0;
    for (let k = -2; k <= 2; k += 1) {
      value += samples[index + k].value * coeff[k + 2];
    }
    return { t: sample.t, value: value / norm };
  });
}

export interface SpectralMetrics {
  dominantFrequencyHz: number;
  dominantFrequencyBpm: number;
  bandPowerRatio: number;
  spectralPeakProminence: number;
  snrDb: number;
}

export function spectralMetrics(
  samples: TimeSample[],
  lowHz = 0.5,
  highHz = 4.0,
): SpectralMetrics {
  const uniform = resampleUniform(samples, 30);
  const n = uniform.length;
  if (n < 48 || durationMs(uniform) < 2500) {
    return {
      dominantFrequencyHz: 0,
      dominantFrequencyBpm: 0,
      bandPowerRatio: 0,
      spectralPeakProminence: 0,
      snrDb: -60,
    };
  }

  const values = robustNormalize(uniform).map((sample) => sample.value);
  const sampleRate = 1000 / ((uniform[n - 1].t - uniform[0].t) / Math.max(1, n - 1));
  const maxK = Math.floor(n / 2);
  let totalPower = 0;
  let bandPower = 0;
  let peakPower = 0;
  let peakFrequency = 0;
  let bandBins = 0;

  for (let k = 1; k <= maxK; k += 1) {
    const frequency = (k * sampleRate) / n;
    if (frequency > 8) break;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i += 1) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
      const angle = (2 * Math.PI * k * i) / n;
      const value = values[i] * window;
      re += value * Math.cos(angle);
      im -= value * Math.sin(angle);
    }
    const power = re * re + im * im;
    if (frequency >= 0.1) totalPower += power;
    if (frequency >= lowHz && frequency <= highHz) {
      bandPower += power;
      bandBins += 1;
      if (power > peakPower) {
        peakPower = power;
        peakFrequency = frequency;
      }
    }
  }

  const noisePower = Math.max(1e-12, totalPower - peakPower);
  const averageBandRemainder = Math.max(1e-12, (bandPower - peakPower) / Math.max(1, bandBins - 1));
  return {
    dominantFrequencyHz: peakFrequency,
    dominantFrequencyBpm: peakFrequency * 60,
    bandPowerRatio: bandPower / Math.max(1e-12, totalPower),
    spectralPeakProminence: peakPower / averageBandRemainder,
    snrDb: 10 * Math.log10(peakPower / noisePower),
  };
}

export function autocorrBpm(
  samples: TimeSample[],
  minBpm = 35,
  maxBpm = 200,
): { bpm: number | null; score: number } {
  const uniform = robustNormalize(resampleUniform(samples, 30));
  const n = uniform.length;
  if (n < 90) return { bpm: null, score: 0 };
  const values = uniform.map((sample) => sample.value);
  const sampleRate = 1000 / ((uniform[n - 1].t - uniform[0].t) / Math.max(1, n - 1));
  const minLag = Math.max(1, Math.floor((sampleRate * 60) / maxBpm));
  const maxLag = Math.min(Math.floor((sampleRate * 60) / minBpm), Math.floor(n / 2));
  let bestLag = 0;
  let bestScore = -1;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n - lag; i += 1) {
      sum += values[i] * values[i + lag];
      count += 1;
    }
    const score = sum / Math.max(1, count);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag <= 0 || bestScore < 0.18) return { bpm: null, score: Math.max(0, bestScore) };
  return {
    bpm: (60 * sampleRate) / bestLag,
    score: clamp(bestScore, 0, 1),
  };
}
