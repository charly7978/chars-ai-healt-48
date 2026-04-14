/**
 * HeartRateFusion - Fusión entre BPM temporal y espectral
 * Elige fuente más confiable y degrada confianza cuando divergen
 */

import type { 
  TemporalBpmEstimate, 
  SpectralBpmEstimate, 
  HeartRateFusionResult,
  TemporalSQI,
  SpectralSQI 
} from './cardiac-types';

export interface FusionConfig {
  divergenceThreshold: number;
  temporalWeight: number;
  spectralWeight: number;
  minConfidence: number;
}

const DEFAULT_CONFIG: FusionConfig = {
  divergenceThreshold: 10,
  temporalWeight: 0.6,
  spectralWeight: 0.4,
  minConfidence: 0.4,
};

export class HeartRateFusion {
  private config: FusionConfig;
  private lastBpm: number = 0;
  private history: { temporal: number; spectral: number; fused: number }[] = [];

  constructor(config?: Partial<FusionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Fusiona BPM temporal y espectral
   */
  fuse(
    temporal: TemporalBpmEstimate,
    spectral: SpectralBpmEstimate,
    temporalSQI: TemporalSQI,
    spectralSQI: SpectralSQI,
    upstreamQuality: number,
    fingerDetected: boolean
  ): HeartRateFusionResult {
    const divergence = Math.abs(temporal.medianBpm - spectral.bpm);

    // Penalización por contacto
    const contactPenalty = fingerDetected ? 0 : 0.3;

    // Calcular confianza ajustada
    const temporalConf = Math.max(0, temporal.confidence - contactPenalty);
    const spectralConf = Math.max(0, spectral.confidence - contactPenalty);

    let activeSource: 'TEMPORAL' | 'SPECTRAL' | 'FUSED';
    let finalBpm: number;
    let confidence: number;

    if (divergence < this.config.divergenceThreshold) {
      // Concordancia: fusionar ponderado por confianza
      activeSource = 'FUSED';
      const tWeight = temporalConf * this.config.temporalWeight;
      const sWeight = spectralConf * this.config.spectralWeight;
      const totalWeight = tWeight + sWeight;
      
      finalBpm = totalWeight > 0 
        ? (temporal.medianBpm * tWeight + spectral.bpm * sWeight) / totalWeight
        : temporal.medianBpm;
      
      confidence = (temporalConf + spectralConf) / 2;
    } else if (temporalConf > spectralConf + 0.15) {
      // Divergencia moderada: elegir más confiable (temporal)
      activeSource = 'TEMPORAL';
      finalBpm = temporal.medianBpm;
      confidence = temporalConf * 0.85; // Degradar por divergencia
    } else if (spectralConf > temporalConf + 0.15) {
      // Divergencia moderada: elegir más confiable (espectral)
      activeSource = 'SPECTRAL';
      finalBpm = spectral.bpm;
      confidence = spectralConf * 0.85; // Degradar por divergencia
    } else {
      // Divergencia fuerte sin claro ganador: usar upstream quality como tiebreaker
      const sqiScore = (temporalSQI.score + spectralSQI.score) / 2;
      if (sqiScore > 0.5) {
        activeSource = 'TEMPORAL';
        finalBpm = temporal.medianBpm;
      } else {
        activeSource = 'SPECTRAL';
        finalBpm = spectral.bpm;
      }
      confidence = Math.max(temporalConf, spectralConf) * 0.7; // Degradar fuerte
    }

    // Aplicar upstream quality
    confidence = confidence * (upstreamQuality / 100);

    // Suavizar BPM final
    if (this.lastBpm === 0) {
      this.lastBpm = finalBpm;
    } else {
      const alpha = confidence > 0.7 ? 0.3 : 0.15;
      this.lastBpm = this.lastBpm * (1 - alpha) + finalBpm * alpha;
    }

    // Guardar historial
    this.history.push({ temporal: temporal.medianBpm, spectral: spectral.bpm, fused: this.lastBpm });
    if (this.history.length > 20) this.history.shift();

    return {
      activeSource,
      instantBpm: temporal.instantBpm,
      temporalBpm: temporal,
      spectralBpm: spectral,
      finalBpm: this.lastBpm,
      confidence: Math.max(0, Math.min(1, confidence)),
      divergence,
    };
  }

  /**
   * Obtiene estabilidad de fusión
   */
  getStability(): number {
    if (this.history.length < 5) return 0;

    const fusedValues = this.history.map(h => h.fused);
    const mean = fusedValues.reduce((a, b) => a + b, 0) / fusedValues.length;
    const variance = fusedValues.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / fusedValues.length;
    const std = Math.sqrt(variance);

    return mean > 0 ? Math.max(0, 1 - std / mean) : 0;
  }

  /**
   * Obtiene divergencia promedio reciente
   */
  getAverageDivergence(): number {
    if (this.history.length < 3) return 0;

    const divergences = this.history.map(h => Math.abs(h.temporal - h.spectral));
    return divergences.reduce((a, b) => a + b, 0) / divergences.length;
  }

  /**
   * Reinicia fusión
   */
  reset(): void {
    this.lastBpm = 0;
    this.history = [];
  }
}
