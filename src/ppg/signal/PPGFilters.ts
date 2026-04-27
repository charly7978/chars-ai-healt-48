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

export function srgbToLinear(v8: number): number {
  const c = v8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function trimmedMean(values: number[], trim = 0.1): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return 0;
  const cut = Math.floor(finite.length * trim);
  const sliced = finite.slice(cut, Math.max(cut + 1, finite.length - cut));
  return sliced.reduce((sum, value) => sum + value, 0) / sliced.length;
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

export interface ResampleResult {
  samples: TimeSample[];
  actualFs: number;
  jitterStdMs: number;
  maxGapMs: number;
  valid: boolean;
  reason?: string;
}

/**
 * Calculate actual sample rate from timestamps
 */
export function calculateActualFs(samples: TimeSample[]): number {
  if (samples.length < 2) return 30; // Default fallback
  const intervals: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt > 0 && dt < 500) { // Ignore gaps > 500ms
      intervals.push(dt);
    }
  }
  if (intervals.length === 0) return 30;
  const medianInterval = median(intervals);
  return 1000 / medianInterval;
}

/**
 * Check window quality before resampling
 */
export function validateWindow(samples: TimeSample[]): { valid: boolean; reason?: string; jitterStdMs: number; maxGapMs: number } {
  if (samples.length < 10) {
    return { valid: false, reason: "INSUFFICIENT_SAMPLES", jitterStdMs: 0, maxGapMs: 0 };
  }

  const intervals: number[] = [];
  let maxGapMs = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt > 0) {
      intervals.push(dt);
      maxGapMs = Math.max(maxGapMs, dt);
    }
  }

  if (intervals.length < 5) {
    return { valid: false, reason: "NO_VALID_INTERVALS", jitterStdMs: 0, maxGapMs };
  }

  const jitterStdMs = std(intervals);
  const medianInterval = median(intervals);

  // Reject if extreme jitter (>50% of median interval)
  if (jitterStdMs > medianInterval * 0.5) {
    return { valid: false, reason: "EXTREME_JITTER", jitterStdMs, maxGapMs };
  }

  // Reject if large gaps (>300ms at expected ~30fps)
  if (maxGapMs > 300) {
    return { valid: false, reason: "LARGE_GAPS", jitterStdMs, maxGapMs };
  }

  return { valid: true, jitterStdMs, maxGapMs };
}

export function resampleUniform(samples: TimeSample[], targetHz = 30): ResampleResult {
  const clean = samples.filter(
    (sample) => Number.isFinite(sample.t) && Number.isFinite(sample.value),
  );

  // Validate window quality
  const validation = validateWindow(clean);
  if (!validation.valid) {
    return { samples: [], actualFs: 0, jitterStdMs: validation.jitterStdMs, maxGapMs: validation.maxGapMs, valid: false, reason: validation.reason };
  }

  if (clean.length < 2) {
    return { samples: clean, actualFs: targetHz, jitterStdMs: 0, maxGapMs: 0, valid: clean.length > 0 };
  }

  // Calculate actual Fs from data
  const actualFs = calculateActualFs(clean);
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

  return { samples: out, actualFs, jitterStdMs: validation.jitterStdMs, maxGapMs: validation.maxGapMs, valid: true };
}

/**
 * Robust detrend using rolling median (less sensitive to outliers than mean)
 */
export function detrendRollingMedian(samples: TimeSample[], windowSize = 15): TimeSample[] {
  if (samples.length < windowSize) return samples;
  const out: TimeSample[] = [];
  for (let i = 0; i < samples.length; i++) {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end = Math.min(samples.length, i + Math.floor(windowSize / 2) + 1);
    const window = samples.slice(start, end).map((s) => s.value);
    const trend = median(window);
    out.push({ t: samples[i].t, value: samples[i].value - trend });
  }
  return out;
}

/**
 * High-pass filter (removes very slow trends)
 */
export function highPassFilter(samples: TimeSample[], cutoffHz: number, fs: number): TimeSample[] {
  if (samples.length < 2) return samples;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / fs;
  const alpha = rc / (rc + dt);

  let y = samples[0].value;
  const out: TimeSample[] = [];
  for (let i = 0; i < samples.length; i++) {
    y = alpha * (y + samples[i].value - (i > 0 ? samples[i - 1].value : samples[0].value));
    out.push({ t: samples[i].t, value: y });
  }
  return out;
}

/**
 * Simple polynomial detrend (linear)
 */
export function detrendPolynomial(samples: TimeSample[], order = 1): TimeSample[] {
  if (samples.length < order + 2) return samples;

  // Fit linear trend: y = mx + b
  const n = samples.length;
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const sumY = samples.reduce((sum, s) => sum + s.value, 0);
  const sumXY = samples.reduce((sum, s, i) => sum + i * s.value, 0);

  const denominator = n * sumX2 - sumX * sumX;
  if (Math.abs(denominator) < 1e-12) return samples;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  return samples.map((s, i) => ({
    t: s.t,
    value: s.value - (slope * i + intercept),
  }));
}

export function detrendEma(samples: TimeSample[], cutoffHz = 0.25, fs = 30): TimeSample[] {
  if (samples.length < 2) return samples;
  let trend = samples[0].value;
  const out: TimeSample[] = [];
  const dt = 1000 / fs;
  const rc = 1000 / (2 * Math.PI * cutoffHz);
  const alpha = clamp(dt / (rc + dt), 0.001, 1);

  for (let i = 0; i < samples.length; i += 1) {
    trend += alpha * (samples[i].value - trend);
    out.push({ t: samples[i].t, value: samples[i].value - trend });
  }
  return out;
}

export function onePoleLowPass(samples: TimeSample[], cutoffHz: number, fs: number): TimeSample[] {
  if (samples.length < 2) return samples;
  let y = samples[0].value;
  const out: TimeSample[] = [];
  const dt = 1000 / fs;
  const rc = 1000 / (2 * Math.PI * cutoffHz);
  const alpha = clamp(dt / (rc + dt), 0.001, 1);

  for (let i = 0; i < samples.length; i += 1) {
    y += alpha * (samples[i].value - y);
    out.push({ t: samples[i].t, value: y });
  }
  return out;
}

/**
 * Band-pass filter using real sample rate (Fs)
 * Adult standard: 0.5-4.0 Hz (30-240 BPM)
 * Extended debug: 0.4-5.0 Hz (24-300 BPM)
 */
export function bandpass(samples: TimeSample[], lowHz: number, highHz: number, fs: number): TimeSample[] {
  // High-pass: remove slow trends
  const highPassed = detrendEma(samples, lowHz, fs);
  // Low-pass: remove high frequency noise
  return onePoleLowPass(highPassed, highHz, fs);
}

/**
 * Full preprocessing pipeline with quality checks
 */
export function preprocessPPGRobust(
  samples: TimeSample[],
  lowHz = 0.5,
  highHz = 4.0,
  targetHz = 30,
): { samples: TimeSample[]; actualFs: number; valid: boolean; reason?: string } {
  if (samples.length < 10) {
    return { samples: [], actualFs: 0, valid: false, reason: "INSUFFICIENT_SAMPLES" };
  }

  // Resample with quality checks
  const resampled = resampleUniform(samples, targetHz);
  if (!resampled.valid) {
    return { samples: [], actualFs: 0, valid: false, reason: resampled.reason };
  }

  // Use actual Fs from data or target
  const fs = resampled.actualFs || targetHz;

  // Apply Hampel filter for outliers
  const cleaned = hampel(resampled.samples, 5, 3);

  // Band-pass with real Fs
  const filtered = bandpass(cleaned, lowHz, highHz, fs);

  // Robust normalization
  const normalized = robustNormalize(filtered);

  return { samples: normalized, actualFs: fs, valid: true };
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

// (Removed during forensic audit:
//   - preprocessPPG  — legacy 30-Hz wrapper, only the publication gate used it
//     for the visualization waveform; replaced by preprocessPPGRobust which is
//     the single source of truth for resample+filter+normalize.
//   - savitzkyGolayVisual — dead code, no static importer.
// Removing them eliminates two duplicate code paths and removes the only
// downstream consumer that bypassed the FPS-aware target rate.)

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
  const result = resampleUniform(samples, 30);
  if (!result.valid) {
    return {
      dominantFrequencyHz: 0,
      dominantFrequencyBpm: 0,
      bandPowerRatio: 0,
      spectralPeakProminence: 0,
      snrDb: -60,
    };
  }
  const uniform = result.samples;
  const fs = result.actualFs || 30;
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
  const sampleRate = fs;
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
  const result = resampleUniform(samples, 30);
  if (!result.valid) return { bpm: null, score: 0 };
  const uniform = robustNormalize(result.samples);
  const n = uniform.length;
  if (n < 90) return { bpm: null, score: 0 };
  const values = uniform.map((sample) => sample.value);
  const sampleRate = result.actualFs || 30;
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
