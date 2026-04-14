/**
 * BeatDetector - Detección robusta de picos sistólicos
 * Multi-detector con histéresis, período refractario y scoring de confianza
 */

import type { ResampledSignal, BeatCandidate, ConfirmedBeat } from './cardiac-types';

export interface DetectorConfig {
  minBpm: number;
  maxBpm: number;
  hardRefractoryMs: number;
  softRefractoryMs: number;
  minProminence: number;
  minWidthMs: number;
  maxWidthMs: number;
  adaptiveProminenceAlpha: number;
  minConfidence: number;
}

const DEFAULT_CONFIG: DetectorConfig = {
  minBpm: 35,
  maxBpm: 200,
  hardRefractoryMs: 200,
  softRefractoryMs: 280,
  minProminence: 0.02,
  minWidthMs: 80,
  maxWidthMs: 400,
  adaptiveProminenceAlpha: 0.08,
  minConfidence: 0.45,
};

export class BeatDetector {
  private config: DetectorConfig;
  private adaptiveProminenceFloor: number = 0.04;
  private lastAcceptedTimestamp: number | null = null;
  private lastConfirmedBeat: ConfirmedBeat | null = null;
  private pendingCandidate: BeatCandidate | null = null;
  private sessionAccepted: number = 0;
  private sessionRejected: number = 0;

  constructor(config?: Partial<DetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Procesa señal re-muestreada y detecta beats
   */
  process(signal: ResampledSignal, upstreamQuality: number, fingerDetected: boolean): {
    candidates: BeatCandidate[];
    confirmed: ConfirmedBeat | null;
  } {
    if (signal.length < 10 || !fingerDetected || upstreamQuality < 15) {
      return { candidates: [], confirmed: null };
    }

    const candidates = this.findPeakCandidates(signal);
    const validated = this.validateCandidates(candidates, signal);
    const confirmed = this.confirmBeat(validated, signal);

    return { candidates: validated, confirmed };
  }

  /**
   * Encuentra candidatos de picos usando múltiples detectores
   */
  private findPeakCandidates(signal: ResampledSignal): BeatCandidate[] {
    const candidates: BeatCandidate[] = [];
    const lookback = Math.floor(signal.sampleRate * 0.3);
    const lookahead = Math.floor(signal.sampleRate * 0.3);

    for (let i = lookback; i < signal.length - lookahead; i++) {
      if (this.isLocalMaximum(signal.values, i)) {
        const candidate = this.buildCandidate(signal, i);
        if (candidate.prominence >= this.adaptiveProminenceFloor * 0.3) {
          candidates.push(candidate);
        }
      }
    }

    // Filtrar candidatos muy cercanos (doble conteo)
    return this.filterNearbyPeaks(candidates, this.config.hardRefractoryMs);
  }

  /**
   * Verifica si un índice es máximo local
   */
  private isLocalMaximum(values: Float32Array, i: number): boolean {
    if (i < 2 || i >= values.length - 2) return false;
    return values[i] > values[i - 1] && values[i] > values[i + 1] &&
           values[i] > values[i - 2] && values[i] > values[i + 2];
  }

  /**
   * Construye candidato de pico con métricas
   */
  private buildCandidate(signal: ResampledSignal, idx: number): BeatCandidate {
    const i0 = Math.max(0, idx - Math.floor(signal.sampleRate * 0.2));
    const i1 = Math.min(signal.length - 1, idx + Math.floor(signal.sampleRate * 0.2));

    const peakValue = signal.values[idx];
    const peakTime = signal.timestamps[idx];

    // Encontrar baseline local
    let minL = peakValue;
    let minR = peakValue;
    for (let i = i0; i < idx; i++) minL = Math.min(minL, signal.values[i]);
    for (let i = idx + 1; i <= i1; i++) minR = Math.min(minR, signal.values[i]);
    const baseline = Math.max(minL, minR);
    const prominence = peakValue - baseline;

    // Calcular ancho del pico (half-max)
    const halfMax = baseline + prominence * 0.5;
    let leftIdx = idx;
    let rightIdx = idx;
    for (let i = idx; i > i0; i--) {
      if (signal.values[i] < halfMax) { leftIdx = i; break; }
    }
    for (let i = idx; i < i1; i++) {
      if (signal.values[i] < halfMax) { rightIdx = i; break; }
    }
    const widthMs = Math.abs(signal.timestamps[rightIdx] - signal.timestamps[leftIdx]);

    // Calcular upslope máximo
    let maxUpslope = 0;
    for (let i = Math.max(i0, idx - 10); i < idx; i++) {
      const dt = Math.max(1e-6, signal.timestamps[i + 1] - signal.timestamps[i]);
      const slope = (signal.values[i + 1] - signal.values[i]) / dt;
      maxUpslope = Math.max(maxUpslope, slope);
    }

    // Calcular score de confianza
    const score = this.calculateCandidateScore(prominence, widthMs, maxUpslope);

    return {
      timestamp: peakTime,
      value: peakValue,
      prominence,
      upslope: maxUpslope,
      widthMs,
      confidence: score,
      score,
      adjudication: 'pending',
    };
  }

  /**
   * Calcula score de confianza para candidato
   */
  private calculateCandidateScore(prominence: number, widthMs: number, upslope: number): number {
    let score = 0;

    // Prominencia
    score += Math.min(prominence * 20, 0.4);

    // Ancho plausible
    if (widthMs >= this.config.minWidthMs && widthMs <= this.config.maxWidthMs) {
      score += 0.25;
    } else if (widthMs > this.config.maxWidthMs * 1.5 || widthMs < this.config.minWidthMs * 0.5) {
      score -= 0.15;
    }

    // Upslope
    score += Math.min(Math.abs(upslope) * 1000, 0.2);

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Filtra candidatos muy cercanos (evitar doble conteo)
   */
  private filterNearbyPeaks(candidates: BeatCandidate[], minGapMs: number): BeatCandidate[] {
    if (candidates.length === 0) return [];

    const filtered: BeatCandidate[] = [];
    const sorted = [...candidates].sort((a, b) => a.timestamp - b.timestamp);

    let lastKept = sorted[0];
    filtered.push(lastKept);

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].timestamp - lastKept.timestamp >= minGapMs) {
        lastKept = sorted[i];
        filtered.push(lastKept);
      } else {
        // Mantener el de mayor score
        if (sorted[i].score > lastKept.score) {
          filtered[filtered.length - 1] = sorted[i];
          lastKept = sorted[i];
        }
      }
    }

    return filtered;
  }

  /**
   * Valida candidatos con reglas fisiológicas
   */
  private validateCandidates(candidates: BeatCandidate[], signal: ResampledSignal): BeatCandidate[] {
    const expectedRR = this.getExpectedRR();
    const refractory = this.computeRefractory(expectedRR);

    return candidates.map(cand => {
      // Verificar período refractario
      if (this.lastAcceptedTimestamp !== null) {
        const dt = cand.timestamp - this.lastAcceptedTimestamp;
        if (dt < refractory.hardMs) {
          cand.adjudication = 'rejected';
          cand.rejectionReason = 'hard_refractory';
          this.sessionRejected++;
          return cand;
        }
      }

      // Verificar ancho
      if (cand.widthMs < this.config.minWidthMs || cand.widthMs > this.config.maxWidthMs) {
        cand.adjudication = 'rejected';
        cand.rejectionReason = 'invalid_width';
        this.sessionRejected++;
        return cand;
      }

      // Verificar prominencia mínima
      if (cand.prominence < this.adaptiveProminenceFloor * 0.5) {
        cand.adjudication = 'rejected';
        cand.rejectionReason = 'low_prominence';
        this.sessionRejected++;
        return cand;
      }

      // Verificar consistencia con período esperado
      if (expectedRR > 0 && this.lastAcceptedTimestamp !== null) {
        const dt = cand.timestamp - this.lastAcceptedTimestamp;
        const error = Math.abs(dt - expectedRR) / expectedRR;
        if (error > 0.4 && cand.confidence < 0.6) {
          cand.adjudication = 'rejected';
          cand.rejectionReason = 'period_mismatch';
          this.sessionRejected++;
          return cand;
        }
      }

      cand.adjudication = 'pending';
      return cand;
    });
  }

  /**
   * Confirma beat con histéresis y tracking
   */
  private confirmBeat(candidates: BeatCandidate[], signal: ResampledSignal): ConfirmedBeat | null {
    // Encontrar mejor candidato pendiente
    const pending = candidates.filter(c => c.adjudication === 'pending');
    if (pending.length === 0) return null;

    const best = pending.reduce((a, b) => (a.score > b.score ? a : b));

    if (best.confidence < this.config.minConfidence) {
      best.adjudication = 'rejected';
      best.rejectionReason = 'low_confidence';
      this.sessionRejected++;
      return null;
    }

    // Confirmar beat
    const confirmed: ConfirmedBeat = {
      timestamp: best.timestamp,
      value: best.value,
      confidence: best.confidence,
    };

    // Calcular RR si hay beat previo
    if (this.lastAcceptedTimestamp !== null) {
      confirmed.rrMs = best.timestamp - this.lastAcceptedTimestamp;
    }

    this.lastAcceptedTimestamp = best.timestamp;
    this.lastConfirmedBeat = confirmed;
    this.sessionAccepted++;

    // Adaptar umbral de prominencia
    this.adaptiveProminenceFloor = 
      this.adaptiveProminenceFloor * (1 - this.config.adaptiveProminenceAlpha) +
      best.prominence * 0.5 * this.config.adaptiveProminenceAlpha;

    return confirmed;
  }

  /**
   * Obtiene RR esperado basado en beats recientes
   */
  private getExpectedRR(): number {
    if (!this.lastConfirmedBeat || !this.lastConfirmedBeat.rrMs) return 0;
    return this.lastConfirmedBeat.rrMs;
  }

  /**
   * Calcula períodos refractarios
   */
  private computeRefractory(expectedRR: number): { hardMs: number; softMs: number } {
    const baseRR = expectedRR > 0 ? expectedRR : 600;
    return {
      hardMs: Math.max(this.config.hardRefractoryMs, baseRR * 0.25),
      softMs: Math.max(this.config.softRefractoryMs, baseRR * 0.4),
    };
  }

  /**
   * Obtiene último beat confirmado
   */
  getLastConfirmedBeat(): ConfirmedBeat | null {
    return this.lastConfirmedBeat;
  }

  /**
   * Obtiene estadísticas de sesión
   */
  getSessionStats(): { accepted: number; rejected: number; acceptanceRate: number } {
    const total = this.sessionAccepted + this.sessionRejected;
    return {
      accepted: this.sessionAccepted,
      rejected: this.sessionRejected,
      acceptanceRate: total > 0 ? this.sessionAccepted / total : 0,
    };
  }

  /**
   * Reinicia detector
   */
  reset(): void {
    this.adaptiveProminenceFloor = 0.04;
    this.lastAcceptedTimestamp = null;
    this.lastConfirmedBeat = null;
    this.pendingCandidate = null;
    this.sessionAccepted = 0;
    this.sessionRejected = 0;
  }
}
