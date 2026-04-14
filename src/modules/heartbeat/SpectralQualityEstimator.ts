/**
 * SpectralQualityEstimator - Calcula SQI espectral robusto
 * Basado en pico dominante, SNR espectral, periodicidad, entropía
 */

import type { ResampledSignal, TemporalSQI, SpectralSQI, RRData } from './cardiac-types';

export interface SQIConfig {
  minBpm: number;
  maxBpm: number;
  minPeakProminence: number;
  minSpectralSNR: number;
  maxSpectralEntropy: number;
}

const DEFAULT_CONFIG: SQIConfig = {
  minBpm: 35,
  maxBpm: 200,
  minPeakProminence: 1.5,
  minSpectralSNR: 2.0,
  maxSpectralEntropy: 0.6,
};

export class SpectralQualityEstimator {
  private config: SQIConfig;

  constructor(config?: Partial<SQIConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calcula SQI temporal desde RR
   */
  calculateTemporalSQI(rrData: RRData, beatQuality: number): TemporalSQI {
    const { filtered, std, mean, outlierRatio } = rrData;

    if (filtered.length < 5) {
      return this.getEmptyTemporalSQI();
    }

    // Consistencia RR
    const cv = mean > 0 ? (std / mean) * 100 : 0;
    const consistency = Math.max(0, 1 - cv / 20);

    // Estabilidad entre beats
    const stability = Math.max(0, 1 - outlierRatio * 2);

    // Regularidad de amplitud (simulado desde varianza)
    const amplitudeStability = Math.max(0, 1 - std / (mean + 1e-6));

    // Estabilidad de intervalos
    const intervalStability = consistency;

    // Calidad local de beats
    const localBeatQuality = beatQuality;

    // Ratio de rechazo
    const rejectionRatio = outlierRatio;

    // Score combinado
    const score = (
      consistency * 0.25 +
      stability * 0.2 +
      amplitudeStability * 0.15 +
      intervalStability * 0.15 +
      localBeatQuality * 0.15 +
      (1 - rejectionRatio) * 0.1
    );

    return {
      consistency,
      stability,
      regularity: consistency,
      amplitudeStability,
      intervalStability,
      localBeatQuality,
      rejectionRatio,
      score: Math.max(0, Math.min(1, score)),
    };
  }

  /**
   * Calcula SQI espectral desde señal
   */
  calculateSpectralSQI(signal: ResampledSignal): SpectralSQI {
    if (signal.length < 256) {
      return this.getEmptySpectralSQI();
    }

    const fft = this.computeFFT(signal);
    const dominantPeak = this.findDominantPeak(fft);

    if (!dominantPeak) {
      return this.getEmptySpectralSQI();
    }

    // Claridad del pico
    const peakClarity = this.calculatePeakClarity(dominantPeak, fft);

    // SNR espectral
    const spectralSnr = this.calculateSpectralSNR(dominantPeak, fft);

    // Periodicidad (autocorrelación)
    const periodicity = this.calculatePeriodicity(signal);

    // Consistencia fundamental + armónico
    const harmonicConsistency = this.calculateHarmonicConsistency(dominantPeak, fft);

    // Entropía espectral
    const spectralEntropy = this.calculateSpectralEntropy(fft);

    // Confinamiento en banda
    const bandConfinement = this.calculateBandConfinement(dominantPeak, fft);

    // Estabilidad de frecuencia (simulada)
    const frequencyStability = peakClarity;

    // Score combinado
    const score = (
      peakClarity * 0.2 +
      Math.min(spectralSnr / 5, 1) * 0.2 +
      periodicity * 0.15 +
      harmonicConsistency * 0.15 +
      (1 - spectralEntropy) * 0.15 +
      bandConfinement * 0.1 +
      frequencyStability * 0.05
    );

    return {
      peakClarity,
      spectralSnr: Math.min(spectralSnr / 5, 1),
      periodicity,
      harmonicConsistency,
      spectralEntropy,
      bandConfinement,
      frequencyStability,
      score: Math.max(0, Math.min(1, score)),
    };
  }

  /**
   * Calcula FFT
   */
  private computeFFT(signal: ResampledSignal): { frequencies: number[]; magnitudes: number[] } {
    const n = Math.min(512, signal.length);
    const frequencies: number[] = [];
    const magnitudes: number[] = [];

    const window = Array.from(signal.values.subarray(0, n));
    const hanning = this.createHanningWindow(n);
    const windowed = window.map((v, i) => v * hanning[i]);

    const minFreq = this.config.minBpm / 60;
    const maxFreq = this.config.maxBpm / 60;
    const freqResolution = signal.sampleRate / n;

    for (let f = minFreq; f <= maxFreq; f += freqResolution) {
      const magnitude = this.calculateDFT(windowed, f, signal.sampleRate);
      frequencies.push(f);
      magnitudes.push(magnitude);
    }

    return { frequencies, magnitudes };
  }

  /**
   * Calcula DFT para frecuencia específica
   */
  private calculateDFT(signal: number[], frequency: number, sampleRate: number): number {
    let real = 0;
    let imag = 0;
    const n = signal.length;

    for (let i = 0; i < n; i++) {
      const angle = 2 * Math.PI * frequency * i / sampleRate;
      real += signal[i] * Math.cos(angle);
      imag -= signal[i] * Math.sin(angle);
    }

    return Math.sqrt(real * real + imag * imag) / n;
  }

  /**
   * Crea ventana Hanning
   */
  private createHanningWindow(n: number): number[] {
    const window: number[] = [];
    for (let i = 0; i < n; i++) {
      window.push(0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))));
    }
    return window;
  }

  /**
   * Encuentra pico dominante
   */
  private findDominantPeak(fft: { frequencies: number[]; magnitudes: number[] }): { frequency: number; power: number; index: number } | null {
    if (fft.magnitudes.length === 0) return null;

    let maxIdx = 0;
    let maxPower = fft.magnitudes[0];

    for (let i = 1; i < fft.magnitudes.length; i++) {
      if (fft.magnitudes[i] > maxPower) {
        maxPower = fft.magnitudes[i];
        maxIdx = i;
      }
    }

    return {
      frequency: fft.frequencies[maxIdx],
      power: maxPower,
      index: maxIdx,
    };
  }

  /**
   * Calcula claridad del pico
   */
  private calculatePeakClarity(
    peak: { frequency: number; power: number; index: number },
    fft: { frequencies: number[]; magnitudes: number[] }
  ): number {
    const leftMin = Math.min(...fft.magnitudes.slice(0, peak.index));
    const rightMin = Math.min(...fft.magnitudes.slice(peak.index + 1));
    const baseline = Math.max(leftMin, rightMin);
    return baseline > 0 ? Math.min((peak.power - baseline) / baseline / this.config.minPeakProminence, 1) : 0;
  }

  /**
   * Calcula SNR espectral
   */
  private calculateSpectralSNR(
    peak: { frequency: number; power: number; index: number },
    fft: { frequencies: number[]; magnitudes: number[] }
  ): number {
    const bandWidth = 0.3;
    const bandPower = fft.magnitudes
      .filter((_, i) => Math.abs(fft.frequencies[i] - peak.frequency) <= bandWidth)
      .reduce((a, b) => a + b, 0);

    const totalPower = fft.magnitudes.reduce((a, b) => a + b, 0);
    const noisePower = totalPower - bandPower;

    return noisePower > 0 ? bandPower / noisePower : 0;
  }

  /**
   * Calcula periodicidad (autocorrelación)
   */
  private calculatePeriodicity(signal: ResampledSignal): number {
    const n = Math.min(256, signal.length);
    if (n < 64) return 0;

    const values = Array.from(signal.values.subarray(0, n));
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const centered = values.map(v => v - mean);

    let maxCorr = 0;
    const minLag = Math.floor(signal.sampleRate * 60 / this.config.maxBpm);
    const maxLag = Math.floor(signal.sampleRate * 60 / this.config.minBpm);

    for (let lag = minLag; lag <= maxLag && lag < n / 2; lag++) {
      let corr = 0;
      for (let i = 0; i < n - lag; i++) {
        corr += centered[i] * centered[i + lag];
      }
      corr /= n - lag;
      if (corr > maxCorr) maxCorr = corr;
    }

    return maxCorr;
  }

  /**
   * Calcula consistencia con armónico
   */
  private calculateHarmonicConsistency(
    peak: { frequency: number; power: number; index: number },
    fft: { frequencies: number[]; magnitudes: number[] }
  ): number {
    const harmonicFreq = peak.frequency * 2;
    const harmonicIdx = fft.frequencies.findIndex(f => Math.abs(f - harmonicFreq) < 0.1);

    if (harmonicIdx === -1) return 0;

    const harmonicPower = fft.magnitudes[harmonicIdx];
    const ratio = harmonicPower > 0 ? peak.power / harmonicPower : 0;

    // Ratio esperado entre 0.5 y 3
    if (ratio >= 0.5 && ratio <= 3) return 1;
    if (ratio >= 0.3 && ratio <= 5) return 0.5;
    return 0;
  }

  /**
   * Calcula entropía espectral
   */
  private calculateSpectralEntropy(fft: { frequencies: number[]; magnitudes: number[] }): number {
    const totalPower = fft.magnitudes.reduce((a, b) => a + b, 0);
    if (totalPower === 0) return 1;

    const probabilities = fft.magnitudes.map(m => m / totalPower);
    let entropy = 0;

    for (const p of probabilities) {
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    const maxEntropy = Math.log2(fft.magnitudes.length);
    return maxEntropy > 0 ? entropy / maxEntropy : 1;
  }

  /**
   * Calcula confinamiento en banda
   */
  private calculateBandConfinement(
    peak: { frequency: number; power: number; index: number },
    fft: { frequencies: number[]; magnitudes: number[] }
  ): number {
    const bandWidth = 0.5;
    const bandPower = fft.magnitudes
      .filter((_, i) => Math.abs(fft.frequencies[i] - peak.frequency) <= bandWidth)
      .reduce((a, b) => a + b, 0);

    const totalPower = fft.magnitudes.reduce((a, b) => a + b, 0);

    return totalPower > 0 ? bandPower / totalPower : 0;
  }

  /**
   * Retorna SQI temporal vacío
   */
  private getEmptyTemporalSQI(): TemporalSQI {
    return {
      consistency: 0,
      stability: 0,
      regularity: 0,
      amplitudeStability: 0,
      intervalStability: 0,
      localBeatQuality: 0,
      rejectionRatio: 1,
      score: 0,
    };
  }

  /**
   * Retorna SQI espectral vacío
   */
  private getEmptySpectralSQI(): SpectralSQI {
    return {
      peakClarity: 0,
      spectralSnr: 0,
      periodicity: 0,
      harmonicConsistency: 0,
      spectralEntropy: 1,
      bandConfinement: 0,
      frequencyStability: 0,
      score: 0,
    };
  }

  /**
   * Reinicia estimador
   */
  reset(): void {
    // No hay estado persistente
  }
}
