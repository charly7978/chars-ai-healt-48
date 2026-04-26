/**
 * BpmEstimator - Estimación BPM temporal y espectral
 * BPM temporal desde RR, BPM espectral desde FFT
 */

import type { RRData, TemporalBpmEstimate, SpectralBpmEstimate, ResampledSignal } from './cardiac-types';

export interface EstimatorConfig {
  minBpm: number;
  maxBpm: number;
  minRRCount: number;
  smoothingAlpha: number;
  fftSize: number;
}

const DEFAULT_CONFIG: EstimatorConfig = {
  minBpm: 35,
  maxBpm: 200,
  minRRCount: 5,
  smoothingAlpha: 0.2,
  fftSize: 512,
};

export class BpmEstimator {
  private config: EstimatorConfig;
  private smoothedBpm: number = 0;
  private lastSpectralBpm: number = 0;
  private spectralHistory: number[] = [];

  constructor(config?: Partial<EstimatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Estima BPM temporal desde RR
   */
  estimateTemporal(rrData: RRData): TemporalBpmEstimate {
    const { filtered, mean, median, std, outlierRatio } = rrData;

    if (filtered.length < this.config.minRRCount) {
      return { instantBpm: 0, medianBpm: 0, trimmedMeanBpm: 0, confidence: 0, stability: 0 };
    }

    const instantBpm = filtered.length > 0 ? 60000 / filtered[filtered.length - 1] : 0;
    const medianBpm = median > 0 ? 60000 / median : 0;
    const trimmedMean = this.calculateTrimmedMean(filtered, 0.1);
    const trimmedMeanBpm = trimmedMean > 0 ? 60000 / trimmedMean : 0;

    if (this.smoothedBpm === 0) {
      this.smoothedBpm = medianBpm;
    } else {
      this.smoothedBpm = this.smoothedBpm * (1 - this.config.smoothingAlpha) + medianBpm * this.config.smoothingAlpha;
    }

    const cv = mean > 0 ? (std / mean) * 100 : 0;
    const stability = Math.max(0, 1 - cv / 15);
    const qualityPenalty = outlierRatio * 0.5;
    const confidence = Math.max(0, Math.min(1, stability - qualityPenalty));

    return {
      instantBpm: this.clampBpm(instantBpm),
      medianBpm: this.clampBpm(medianBpm),
      trimmedMeanBpm: this.clampBpm(trimmedMeanBpm),
      confidence,
      stability,
    };
  }

  /**
   * BPM por autocorrelación de la señal re-muestreada (no depende de picos).
   */
  estimateAutocorrelation(signal: ResampledSignal): { bpm: number; confidence: number } {
    const sr = signal.sampleRate;
    if (signal.length < sr * 3) return { bpm: 0, confidence: 0 };

    const maxLag = Math.floor(sr * 60 / this.config.minBpm);
    const minLag = Math.floor(sr * 60 / this.config.maxBpm);
    if (maxLag <= minLag + 2) return { bpm: 0, confidence: 0 };

    const v = signal.values;
    const N = signal.length;

    let mean = 0;
    for (let i = 0; i < N; i++) mean += v[i];
    mean /= N;

    let r0 = 0;
    for (let i = 0; i < N; i++) { const x = v[i] - mean; r0 += x * x; }
    if (r0 <= 1e-9) return { bpm: 0, confidence: 0 };

    let bestLag = -1;
    let bestVal = -Infinity;
    let secondBest = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      const lim = N - lag;
      for (let i = 0; i < lim; i++) s += (v[i] - mean) * (v[i + lag] - mean);
      const norm = s / r0;
      if (norm > bestVal) { secondBest = bestVal; bestVal = norm; bestLag = lag; }
      else if (norm > secondBest) { secondBest = norm; }
    }
    if (bestLag <= 0 || bestVal <= 0) return { bpm: 0, confidence: 0 };

    const periodMs = (bestLag / sr) * 1000;
    const bpm = this.clampBpm(60000 / periodMs);
    const dominance = bestVal - Math.max(0, secondBest);
    const confidence = Math.max(0, Math.min(1, bestVal * 0.55 + dominance * 0.6));
    return { bpm, confidence };
  }

  /**
   * Estima BPM espectral desde FFT
   */
  estimateSpectral(signal: ResampledSignal): SpectralBpmEstimate {
    if (signal.length < this.config.fftSize) {
      return this.getEmptySpectral();
    }

    const fftResult = this.computeFFT(signal);
    const dominantPeak = this.findDominantPeak(fftResult, signal.sampleRate);

    if (!dominantPeak) {
      return this.getEmptySpectral();
    }

    const frequencyHz = dominantPeak.frequency;
    const bpm = frequencyHz * 60;

    // Calcular métricas espectrales
    const power = dominantPeak.power;
    const prominence = this.calculatePeakProminence(dominantPeak, fftResult);
    const width = this.calculatePeakWidth(dominantPeak, fftResult);
    const snr = this.calculateSpectralSNR(dominantPeak, fftResult);
    const harmonicRatio = this.calculateHarmonicRatio(dominantPeak, fftResult);
    const entropy = this.calculateSpectralEntropy(fftResult);

    // Calcular confianza espectral
    const confidence = this.calculateSpectralConfidence(
      prominence, snr, harmonicRatio, entropy
    );

    // Suavizar BPM espectral
    if (this.lastSpectralBpm === 0) {
      this.lastSpectralBpm = bpm;
    } else {
      const alpha = confidence > 0.7 ? 0.3 : 0.1;
      this.lastSpectralBpm = this.lastSpectralBpm * (1 - alpha) + bpm * alpha;
    }

    // Historial para estabilidad
    this.spectralHistory.push(bpm);
    if (this.spectralHistory.length > 10) this.spectralHistory.shift();

    return {
      bpm: this.clampBpm(this.lastSpectralBpm),
      frequencyHz,
      power,
      prominence,
      width,
      snr,
      harmonicRatio,
      entropy,
      confidence,
    };
  }

  /**
   * Calcula FFT usando método simple
   */
  private computeFFT(signal: ResampledSignal): { frequencies: number[]; magnitudes: number[] } {
    const n = this.config.fftSize;
    const frequencies: number[] = [];
    const magnitudes: number[] = [];

    // Usar ventana de señal
    const window = signal.values.subarray(0, Math.min(n, signal.length));

    // Aplicar ventana Hanning
    const hanning = this.createHanningWindow(window.length);
    const windowed = window.map((v, i) => v * hanning[i]);

    // FFT simple (DFT para frecuencias de interés)
    const minFreq = this.config.minBpm / 60;
    const maxFreq = this.config.maxBpm / 60;
    const freqResolution = signal.sampleRate / window.length;

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
  private calculateDFT(signal: Float32Array, frequency: number, sampleRate: number): number {
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
   * Encuentra pico dominante en espectro
   */
  private findDominantPeak(
    fft: { frequencies: number[]; magnitudes: number[] },
    sampleRate: number
  ): { frequency: number; power: number; index: number } | null {
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
   * Calcula prominencia del pico
   */
  private calculatePeakProminence(
    peak: { frequency: number; power: number; index: number },
    fft: { frequencies: number[]; magnitudes: number[] }
  ): number {
    const leftMin = Math.min(...fft.magnitudes.slice(0, peak.index));
    const rightMin = Math.min(...fft.magnitudes.slice(peak.index + 1));
    const baseline = Math.max(leftMin, rightMin);
    return baseline > 0 ? (peak.power - baseline) / baseline : 0;
  }

  /**
   * Calcula ancho del pico
   */
  private calculatePeakWidth(
    peak: { frequency: number; power: number; index: number },
    fft: { frequencies: number[]; magnitudes: number[] }
  ): number {
    const halfPower = peak.power / 2;
    let leftIdx = peak.index;
    let rightIdx = peak.index;

    while (leftIdx > 0 && fft.magnitudes[leftIdx] > halfPower) leftIdx--;
    while (rightIdx < fft.magnitudes.length - 1 && fft.magnitudes[rightIdx] > halfPower) rightIdx++;

    return fft.frequencies[rightIdx] - fft.frequencies[leftIdx];
  }

  /**
   * Calcula SNR espectral
   */
  private calculateSpectralSNR(
    peak: { frequency: number; power: number; index: number },
    fft: { frequencies: number[]; magnitudes: number[] }
  ): number {
    const bandWidth = 0.5; // Hz alrededor del pico
    const bandPower = fft.magnitudes
      .filter((_, i) => Math.abs(fft.frequencies[i] - peak.frequency) <= bandWidth)
      .reduce((a, b) => a + b, 0);

    const totalPower = fft.magnitudes.reduce((a, b) => a + b, 0);
    const noisePower = totalPower - bandPower;

    return noisePower > 0 ? bandPower / noisePower : 0;
  }

  /**
   * Calcula ratio con segundo armónico
   */
  private calculateHarmonicRatio(
    peak: { frequency: number; power: number; index: number },
    fft: { frequencies: number[]; magnitudes: number[] }
  ): number {
    const harmonicFreq = peak.frequency * 2;
    const harmonicIdx = fft.frequencies.findIndex(f => Math.abs(f - harmonicFreq) < 0.1);

    if (harmonicIdx === -1) return 0;

    const harmonicPower = fft.magnitudes[harmonicIdx];
    return harmonicPower > 0 ? peak.power / harmonicPower : 0;
  }

  /**
   * Calcula entropía espectral
   */
  private calculateSpectralEntropy(fft: { frequencies: number[]; magnitudes: number[] }): number {
    const totalPower = fft.magnitudes.reduce((a, b) => a + b, 0);
    if (totalPower === 0) return 0;

    const probabilities = fft.magnitudes.map(m => m / totalPower);
    let entropy = 0;

    for (const p of probabilities) {
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }

    const maxEntropy = Math.log2(fft.magnitudes.length);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  /**
   * Calcula confianza espectral
   */
  private calculateSpectralConfidence(
    prominence: number,
    snr: number,
    harmonicRatio: number,
    entropy: number
  ): number {
    let confidence = 0;

    // Prominencia alta
    if (prominence > 2) confidence += 0.35;
    else if (prominence > 1) confidence += 0.2;

    // SNR alto
    if (snr > 3) confidence += 0.25;
    else if (snr > 1.5) confidence += 0.15;

    // Ratio armónico razonable
    if (harmonicRatio > 0.5 && harmonicRatio < 3) confidence += 0.2;

    // Entropía baja (espectro concentrado)
    if (entropy < 0.5) confidence += 0.2;
    else if (entropy < 0.7) confidence += 0.1;

    return Math.min(confidence, 1);
  }

  /**
   * Calcula trimmed mean
   */
  private calculateTrimmedMean(values: number[], trimFraction: number): number {
    if (values.length === 0) return 0;
    if (values.length <= 2) return values.reduce((a, b) => a + b, 0) / values.length;

    const sorted = [...values].sort((a, b) => a - b);
    const trimCount = Math.floor(sorted.length * trimFraction);
    const trimmed = sorted.slice(trimCount, sorted.length - trimCount);

    return trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  }

  /**
   * Clampa BPM a rango fisiológico
   */
  private clampBpm(bpm: number): number {
    return Math.max(this.config.minBpm, Math.min(this.config.maxBpm, bpm));
  }

  /**
   * Retorna estimación espectral vacía
   */
  private getEmptySpectral(): SpectralBpmEstimate {
    return {
      bpm: 0,
      frequencyHz: 0,
      power: 0,
      prominence: 0,
      width: 0,
      snr: 0,
      harmonicRatio: 0,
      entropy: 1,
      confidence: 0,
    };
  }

  /**
   * Obtiene estabilidad del BPM espectral
   */
  getSpectralStability(): number {
    if (this.spectralHistory.length < 3) return 0;

    const mean = this.spectralHistory.reduce((a, b) => a + b, 0) / this.spectralHistory.length;
    const variance = this.spectralHistory.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / this.spectralHistory.length;
    const std = Math.sqrt(variance);

    return mean > 0 ? Math.max(0, 1 - std / mean) : 0;
  }

  /**
   * Reinicia estimador
   */
  reset(): void {
    this.smoothedBpm = 0;
    this.lastSpectralBpm = 0;
    this.spectralHistory = [];
  }
}
