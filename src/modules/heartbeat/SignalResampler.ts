/**
 * SignalResampler - Convierte muestras irregulares en serie temporal uniforme
 * Interpolación lineal robusta con buffers circulares
 */

import type { ResampledSignal } from './cardiac-types';

interface Sample {
  value: number;
  timestamp: number;
}

export interface ResamplerConfig {
  targetSampleRate: number;
  shortWindowSeconds: number;
  longWindowSeconds: number;
  maxJitterMs: number;
}

const DEFAULT_CONFIG: ResamplerConfig = {
  targetSampleRate: 60,
  shortWindowSeconds: 8,
  longWindowSeconds: 12,
  maxJitterMs: 500,
};

export class SignalResampler {
  private config: ResamplerConfig;
  private samples: Sample[] = [];
  private maxSamples: number;
  private lastTimestamp: number | null = null;

  constructor(config?: Partial<ResamplerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.maxSamples = Math.ceil(
      this.config.longWindowSeconds * this.config.targetSampleRate * 2
    );
  }

  /**
   * Agrega una muestra con timestamp
   */
  addSample(value: number, timestamp: number): void {
    if (this.lastTimestamp !== null && timestamp <= this.lastTimestamp) {
      return; // Rechazar timestamps no monótonos
    }

    this.samples.push({ value, timestamp });
    this.lastTimestamp = timestamp;

    // Limitar tamaño del buffer
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /**
   * Obtiene señal re-muestreada para ventana corta
   */
  getShortWindow(): ResampledSignal | null {
    return this.getResampledWindow(this.config.shortWindowSeconds);
  }

  /**
   * Obtiene señal re-muestreada para ventana larga
   */
  getLongWindow(): ResampledSignal | null {
    return this.getResampledWindow(this.config.longWindowSeconds);
  }

  /**
   * Re-muestrea señal a frecuencia objetivo con interpolación lineal
   */
  private getResampledWindow(durationSeconds: number): ResampledSignal | null {
    if (this.samples.length < 2) return null;

    const now = this.lastTimestamp;
    if (now === null) return null;

    const startTime = now - durationSeconds * 1000;
    const relevantSamples = this.samples.filter(s => s.timestamp >= startTime);

    if (relevantSamples.length < 2) return null;

    const targetLength = Math.ceil(durationSeconds * this.config.targetSampleRate);
    const values = new Float32Array(targetLength);
    const timestamps = new Float64Array(targetLength);

    const dt = 1000 / this.config.targetSampleRate;
    let outputIdx = 0;

    for (let t = startTime; t < now && outputIdx < targetLength; t += dt) {
      values[outputIdx] = this.interpolate(t, relevantSamples);
      timestamps[outputIdx] = t;
      outputIdx++;
    }

    return {
      values: values.subarray(0, outputIdx),
      timestamps: timestamps.subarray(0, outputIdx),
      sampleRate: this.config.targetSampleRate,
      length: outputIdx,
    };
  }

  /**
   * Interpolación lineal en tiempo t
   */
  private interpolate(t: number, samples: Sample[]): number {
    if (samples.length === 0) return 0;
    if (samples.length === 1) return samples[0].value;

    // Encontrar muestras alrededor de t
    let i = 0;
    while (i < samples.length - 1 && samples[i + 1].timestamp < t) {
      i++;
    }

    if (i === samples.length - 1) return samples[i].value;
    if (samples[i].timestamp > t) return samples[i].value;

    const s0 = samples[i];
    const s1 = samples[i + 1];

    const alpha = (t - s0.timestamp) / (s1.timestamp - s0.timestamp);
    return s0.value + alpha * (s1.value - s0.value);
  }

  /**
   * Obtiene estadísticas de jitter temporal
   */
  getJitterStats(): { mean: number; max: number; std: number } {
    if (this.samples.length < 2) {
      return { mean: 0, max: 0, std: 0 };
    }

    const intervals: number[] = [];
    for (let i = 1; i < this.samples.length; i++) {
      intervals.push(this.samples[i].timestamp - this.samples[i - 1].timestamp);
    }

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const max = Math.max(...intervals);
    const variance = intervals.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / intervals.length;
    const std = Math.sqrt(variance);

    return { mean, max, std };
  }

  /**
   * Reinicia el resampler
   */
  reset(): void {
    this.samples = [];
    this.lastTimestamp = null;
  }

  /**
   * Obtiene número de muestras almacenadas
   */
  getSampleCount(): number {
    return this.samples.length;
  }
}
