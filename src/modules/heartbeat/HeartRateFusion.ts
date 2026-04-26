/**
 * HeartRateFusion — Fusión multi-hipótesis con pesos dinámicos, hysteresis y manejo de outliers.
 *
 * Hipótesis fusionadas:
 *  - instantBpm  (desde último IBI aceptado)
 *  - medianBpm   (mediana de RR)
 *  - trimmedBpm  (trimmed-mean de RR)
 *  - autocorrBpm (autocorrelación)
 *  - spectralBpm (FFT)
 *
 * Reglas:
 *  - Hypothesis.weight = baseWeight * confidence
 *  - Outlier (>20% off del cluster) → peso × 0.2 (no se resetea el sistema)
 *  - Hysteresis: si |Δ| > 8 BPM con confidence baja, suaviza más fuerte
 *  - finalBpm jamás se inventa: si total weight < 0.05 → mantener lastBpm
 *  - active source = la hipótesis con mayor peso efectivo
 */

import type {
  TemporalBpmEstimate,
  SpectralBpmEstimate,
  HeartRateFusionResult,
  TemporalSQI,
  SpectralSQI,
} from './cardiac-types';

export interface FusionConfig {
  divergenceThreshold: number;
  baseWeights: { instant: number; median: number; trimmed: number; autocorr: number; spectral: number };
  hysteresisDeltaBpm: number;
  outlierClusterTolBpm: number;
}

const DEFAULT_CONFIG: FusionConfig = {
  divergenceThreshold: 10,
  baseWeights: { instant: 0.18, median: 0.34, trimmed: 0.22, autocorr: 0.14, spectral: 0.12 },
  hysteresisDeltaBpm: 8,
  outlierClusterTolBpm: 12,
};

interface Hypothesis {
  id: 'INSTANT' | 'MEDIAN' | 'TRIMMED' | 'AUTOCORR' | 'SPECTRAL';
  bpm: number;
  confidence: number;
  baseWeight: number;
  effWeight: number;
  isOutlier: boolean;
}

export class HeartRateFusion {
  private config: FusionConfig;
  private lastBpm = 0;
  private history: { bpm: number; activeSource: string }[] = [];
  private lastDivergence = 0;
  private lastHypotheses: Hypothesis[] = [];

  constructor(config?: Partial<FusionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  fuse(
    temporal: TemporalBpmEstimate,
    spectral: SpectralBpmEstimate,
    temporalSQI: TemporalSQI,
    spectralSQI: SpectralSQI,
    upstreamQuality: number,
    fingerDetected: boolean,
    autocorr?: { bpm: number; confidence: number }
  ): HeartRateFusionResult {
    const contactPenalty = fingerDetected ? 0 : 0.35;
    const acQual = upstreamQuality / 100;

    const hyps: Hypothesis[] = [];
    if (temporal.instantBpm > 0) {
      hyps.push({
        id: 'INSTANT',
        bpm: temporal.instantBpm,
        confidence: Math.max(0, temporal.confidence * 0.7 - contactPenalty),
        baseWeight: this.config.baseWeights.instant,
        effWeight: 0,
        isOutlier: false,
      });
    }
    if (temporal.medianBpm > 0) {
      hyps.push({
        id: 'MEDIAN',
        bpm: temporal.medianBpm,
        confidence: Math.max(0, temporal.confidence - contactPenalty),
        baseWeight: this.config.baseWeights.median,
        effWeight: 0,
        isOutlier: false,
      });
    }
    if (temporal.trimmedMeanBpm > 0) {
      hyps.push({
        id: 'TRIMMED',
        bpm: temporal.trimmedMeanBpm,
        confidence: Math.max(0, temporal.confidence * 0.95 - contactPenalty),
        baseWeight: this.config.baseWeights.trimmed,
        effWeight: 0,
        isOutlier: false,
      });
    }
    if (autocorr && autocorr.bpm > 0) {
      hyps.push({
        id: 'AUTOCORR',
        bpm: autocorr.bpm,
        confidence: Math.max(0, autocorr.confidence - contactPenalty),
        baseWeight: this.config.baseWeights.autocorr,
        effWeight: 0,
        isOutlier: false,
      });
    }
    if (spectral.bpm > 0) {
      hyps.push({
        id: 'SPECTRAL',
        bpm: spectral.bpm,
        confidence: Math.max(0, spectral.confidence - contactPenalty),
        baseWeight: this.config.baseWeights.spectral,
        effWeight: 0,
        isOutlier: false,
      });
    }

    if (hyps.length === 0) {
      return this.emptyResult(temporal, spectral);
    }

    // Cluster: mediana ponderada inicial para detectar outliers
    const sortedBpm = [...hyps].sort((a, b) => a.bpm - b.bpm);
    const centerBpm = sortedBpm[Math.floor(sortedBpm.length / 2)].bpm;

    for (const h of hyps) {
      h.isOutlier = Math.abs(h.bpm - centerBpm) > this.config.outlierClusterTolBpm;
      const outlierPenalty = h.isOutlier ? 0.2 : 1;
      h.effWeight = h.baseWeight * h.confidence * outlierPenalty;
    }

    // Adaptación: si pocos beats temporales, sube peso de spectral/autocorr
    const totalTemporalConf = temporal.confidence;
    if (totalTemporalConf < 0.35) {
      for (const h of hyps) {
        if (h.id === 'AUTOCORR' || h.id === 'SPECTRAL') h.effWeight *= 1.6;
        if (h.id === 'INSTANT' || h.id === 'MEDIAN' || h.id === 'TRIMMED') h.effWeight *= 0.65;
      }
    }

    // Sumatoria
    let totalW = 0, sum = 0;
    for (const h of hyps) { totalW += h.effWeight; sum += h.bpm * h.effWeight; }

    let candidateBpm: number;
    if (totalW < 1e-3) {
      candidateBpm = this.lastBpm > 0 ? this.lastBpm : centerBpm;
    } else {
      candidateBpm = sum / totalW;
    }

    // Active source: hipótesis con mayor effWeight
    let active: Hypothesis = hyps[0];
    for (const h of hyps) if (h.effWeight > active.effWeight) active = h;
    const activeSource = (active.id === 'SPECTRAL' ? 'SPECTRAL' :
                          active.id === 'AUTOCORR' ? 'FUSED' :
                          'TEMPORAL') as 'TEMPORAL' | 'SPECTRAL' | 'FUSED';

    // Divergencia entre temporal-median y spectral
    this.lastDivergence = Math.abs(temporal.medianBpm - spectral.bpm);

    // Hysteresis: smoothing alpha depende de confidence agregada
    const aggConf = this.aggregateConfidence(hyps);
    let alpha: number;
    if (this.lastBpm === 0) {
      this.lastBpm = candidateBpm;
    } else {
      const delta = Math.abs(candidateBpm - this.lastBpm);
      if (delta > this.config.hysteresisDeltaBpm && aggConf < 0.55) {
        alpha = 0.08; // cambio brusco con baja confianza → suaviza fuerte
      } else if (aggConf > 0.7) {
        alpha = 0.32;
      } else {
        alpha = 0.18;
      }
      this.lastBpm = this.lastBpm * (1 - alpha) + candidateBpm * alpha;
    }

    // Aplicar quality upstream a confidence final
    const finalConfidence = Math.max(0, Math.min(1, aggConf * (0.55 + 0.45 * acQual)));

    this.lastHypotheses = hyps;
    this.history.push({ bpm: this.lastBpm, activeSource });
    if (this.history.length > 30) this.history.shift();

    return {
      activeSource,
      instantBpm: temporal.instantBpm,
      temporalBpm: temporal,
      spectralBpm: spectral,
      finalBpm: this.lastBpm,
      confidence: finalConfidence,
      divergence: this.lastDivergence,
    };
  }

  private aggregateConfidence(hyps: Hypothesis[]): number {
    let sum = 0, w = 0;
    for (const h of hyps) {
      const wi = h.baseWeight * (h.isOutlier ? 0.3 : 1);
      sum += h.confidence * wi;
      w += wi;
    }
    return w > 0 ? sum / w : 0;
  }

  private emptyResult(t: TemporalBpmEstimate, s: SpectralBpmEstimate): HeartRateFusionResult {
    return {
      activeSource: 'TEMPORAL',
      instantBpm: 0,
      temporalBpm: t,
      spectralBpm: s,
      finalBpm: this.lastBpm,
      confidence: 0,
      divergence: 0,
    };
  }

  getStability(): number {
    if (this.history.length < 5) return 0;
    const vals = this.history.map((h) => h.bpm);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((acc, v) => acc + (v - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    return mean > 0 ? Math.max(0, 1 - std / mean) : 0;
  }

  getAverageDivergence(): number { return this.lastDivergence; }
  getHypotheses(): Hypothesis[] { return this.lastHypotheses; }

  reset(): void {
    this.lastBpm = 0;
    this.history = [];
    this.lastDivergence = 0;
    this.lastHypotheses = [];
  }
}
