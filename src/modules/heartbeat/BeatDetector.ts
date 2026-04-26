/**
 * BeatDetector — Detección multi-detector con scoring por latido y template matching dinámico
 * Detector 1: pico sistólico (máximo local con prominencia robusta)
 * Detector 2: derivada / upslope (slope-sum sobre la primera derivada)
 * Detector 3 (soporte): envolvente por percentil local
 *
 * Cada candidato lleva detectorHits, detectorAgreement, templateScore, morphologyScore,
 * rhythmScore. La aceptación/rechazo es explícita por reglas (hard / soft / accept-strong /
 * accept-weak) y queda trazada en rejectionReason.
 */

import type { ResampledSignal, BeatCandidate, ConfirmedBeat, DetectorHits, BeatFlag } from './cardiac-types';

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
  templateLength: number;        // muestras para alinear template
  templateMinBeats: number;      // mínimo beats de buena calidad para construir template
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
  minConfidence: 0.42,
  templateLength: 24,
  templateMinBeats: 4,
};

interface DerivativePeak {
  sampleIndex: number;
  timestamp: number;
  slopeSum: number;
}

export class BeatDetector {
  private config: DetectorConfig;
  private adaptiveProminenceFloor = 0.04;
  private lastAcceptedTimestamp: number | null = null;
  private lastConfirmedBeat: ConfirmedBeat | null = null;
  private sessionAccepted = 0;
  private sessionRejected = 0;
  private lastRejectionReason: string = 'none';

  // Template dinámico (mediana móvil de latidos buenos), normalizado en amplitud
  private template: Float32Array | null = null;
  private templateBuffer: Float32Array[] = [];
  private templateMaxBuffer = 8;

  // Para detectar double peak / missed beat necesitamos historial de aceptados
  private recentAccepted: ConfirmedBeat[] = [];
  private recentAcceptedMax = 12;

  // Cache para debug / introspección
  private lastFrameCandidates: BeatCandidate[] = [];
  private lastRefractory: { hardMs: number; softMs: number; recoveryMs: number } = {
    hardMs: 200, softMs: 280, recoveryMs: 450,
  };

  constructor(config?: Partial<DetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  process(signal: ResampledSignal, upstreamQuality: number, fingerDetected: boolean): {
    candidates: BeatCandidate[];
    confirmed: ConfirmedBeat | null;
  } {
    if (signal.length < 16 || !fingerDetected || upstreamQuality < 12) {
      return { candidates: [], confirmed: null };
    }

    // 1) Pre-cómputo: derivada y envolvente
    const derivative = this.computeDerivative(signal);
    const envelope = this.computeEnvelope(signal, Math.floor(signal.sampleRate * 0.6));

    // 2) Detectores
    const peakCands = this.detectSystolicPeaks(signal);
    const slopePeaks = this.detectSlopePeaks(signal, derivative);

    // 3) Construir candidatos enriquecidos: anclamos en cada pico sistólico y buscamos
    //    soporte de upslope en ventana corta antes del pico
    const enriched: BeatCandidate[] = peakCands.map((idx) => {
      const cand = this.buildCandidate(signal, idx, envelope);
      const supportSlope = this.matchSlopeSupport(idx, slopePeaks, signal.sampleRate);
      const supportEnv = signal.values[idx] > envelope[idx] * 0.985;
      const hits: DetectorHits = {
        systolicPeak: true,
        derivativeUpslope: supportSlope !== null,
        envelopeSupport: supportEnv,
      };
      const agreement =
        (hits.systolicPeak ? 0.5 : 0) +
        (hits.derivativeUpslope ? 0.35 : 0) +
        (hits.envelopeSupport ? 0.15 : 0);
      cand.detectorHits = hits;
      cand.detectorAgreement = agreement;

      // Template score
      cand.templateScore = this.scoreAgainstTemplate(signal, idx);
      // Morphology score: combinación de prominencia, ancho y upslope normalizados
      cand.morphologyScore = this.morphologyScore(cand);
      return cand;
    });

    // 4) Filtrar candidatos demasiado cercanos manteniendo el de mejor score combinado
    const deduped = this.suppressDoublePeaks(enriched);

    // 5) Adjudicación con reglas explícitas (cachea refractory para introspección)
    this.lastRefractory = this.computeRefractory(this.expectedRR());
    const validated = this.adjudicate(deduped);

    // 6) Confirmación: tomar el mejor "accepted/pending" y promoverlo a ConfirmedBeat
    const confirmed = this.confirmBeat(validated, signal);

    // Cache para introspección debug
    this.lastFrameCandidates = validated;

    return { candidates: validated, confirmed };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Detectores
  // ─────────────────────────────────────────────────────────────────────────────

  private detectSystolicPeaks(signal: ResampledSignal): number[] {
    const out: number[] = [];
    const v = signal.values;
    const lookback = Math.max(2, Math.floor(signal.sampleRate * 0.06));
    const lookahead = Math.max(2, Math.floor(signal.sampleRate * 0.06));
    for (let i = lookback; i < signal.length - lookahead; i++) {
      let isMax = true;
      for (let k = 1; k <= lookback; k++) {
        if (v[i] <= v[i - k]) { isMax = false; break; }
      }
      if (!isMax) continue;
      for (let k = 1; k <= lookahead; k++) {
        if (v[i] < v[i + k]) { isMax = false; break; }
      }
      if (isMax) out.push(i);
    }
    return out;
  }

  private computeDerivative(signal: ResampledSignal): Float32Array {
    const n = signal.length;
    const d = new Float32Array(n);
    for (let i = 1; i < n - 1; i++) {
      d[i] = (signal.values[i + 1] - signal.values[i - 1]) * 0.5;
    }
    return d;
  }

  /** Slope-sum: suma de derivadas positivas en ventana corta → picos = upslopes sistólicos */
  private detectSlopePeaks(signal: ResampledSignal, deriv: Float32Array): DerivativePeak[] {
    const win = Math.max(3, Math.floor(signal.sampleRate * 0.12));
    const ssf = new Float32Array(signal.length);
    for (let i = win; i < signal.length; i++) {
      let s = 0;
      for (let k = 0; k < win; k++) {
        const d = deriv[i - k];
        if (d > 0) s += d;
      }
      ssf[i] = s;
    }
    // máximos locales del slope-sum
    const peaks: DerivativePeak[] = [];
    for (let i = 2; i < signal.length - 2; i++) {
      if (ssf[i] > ssf[i - 1] && ssf[i] > ssf[i + 1] && ssf[i] > 0) {
        peaks.push({ sampleIndex: i, timestamp: signal.timestamps[i], slopeSum: ssf[i] });
      }
    }
    return peaks;
  }

  /** Envolvente superior por percentil local (simplificada como max móvil) */
  private computeEnvelope(signal: ResampledSignal, win: number): Float32Array {
    const n = signal.length;
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - win);
      const b = Math.min(n - 1, i + win);
      let m = signal.values[a];
      for (let k = a + 1; k <= b; k++) if (signal.values[k] > m) m = signal.values[k];
      env[i] = m;
    }
    return env;
  }

  private matchSlopeSupport(peakIdx: number, slopePeaks: DerivativePeak[], sampleRate: number): DerivativePeak | null {
    // El slope-sum debería tener su pico ~80–180 ms ANTES del pico sistólico
    const windowBack = Math.floor(sampleRate * 0.22);
    const windowFwd = Math.floor(sampleRate * 0.04);
    let best: DerivativePeak | null = null;
    let bestSlope = 0;
    for (const sp of slopePeaks) {
      const dt = peakIdx - sp.sampleIndex;
      if (dt >= -windowFwd && dt <= windowBack) {
        if (sp.slopeSum > bestSlope) {
          best = sp;
          bestSlope = sp.slopeSum;
        }
      }
    }
    return best;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Construcción de candidato
  // ─────────────────────────────────────────────────────────────────────────────

  private buildCandidate(signal: ResampledSignal, idx: number, envelope: Float32Array): BeatCandidate {
    const sr = signal.sampleRate;
    const i0 = Math.max(0, idx - Math.floor(sr * 0.25));
    const i1 = Math.min(signal.length - 1, idx + Math.floor(sr * 0.25));
    const peakValue = signal.values[idx];
    const peakTime = signal.timestamps[idx];

    let minL = peakValue, minR = peakValue;
    for (let i = i0; i < idx; i++) if (signal.values[i] < minL) minL = signal.values[i];
    for (let i = idx + 1; i <= i1; i++) if (signal.values[i] < minR) minR = signal.values[i];
    const baseline = Math.max(minL, minR);
    const prominence = peakValue - baseline;

    // Width at half-prominence
    const halfMax = baseline + prominence * 0.5;
    let leftIdx = idx, rightIdx = idx;
    for (let i = idx; i > i0; i--) if (signal.values[i] < halfMax) { leftIdx = i; break; }
    for (let i = idx; i < i1; i++) if (signal.values[i] < halfMax) { rightIdx = i; break; }
    const widthMs = Math.abs(signal.timestamps[rightIdx] - signal.timestamps[leftIdx]);

    // Max upslope en ventana ~150ms antes
    let maxUp = 0;
    const upStart = Math.max(i0, idx - Math.floor(sr * 0.18));
    for (let i = upStart; i < idx; i++) {
      const dt = Math.max(1e-6, signal.timestamps[i + 1] - signal.timestamps[i]);
      const slope = (signal.values[i + 1] - signal.values[i]) / dt;
      if (slope > maxUp) maxUp = slope;
    }

    // Score base inicial (refinado luego con detectorAgreement + template + rhythm)
    const score = this.calculateBaseScore(prominence, widthMs, maxUp);

    return {
      timestamp: peakTime,
      value: peakValue,
      prominence,
      upslope: maxUp,
      widthMs,
      confidence: score,
      score,
      adjudication: 'pending',
    };
  }

  private calculateBaseScore(prom: number, widthMs: number, upslope: number): number {
    let s = 0;
    s += Math.min(prom * 18, 0.4);
    if (widthMs >= this.config.minWidthMs && widthMs <= this.config.maxWidthMs) s += 0.25;
    else if (widthMs > this.config.maxWidthMs * 1.6 || widthMs < this.config.minWidthMs * 0.5) s -= 0.2;
    s += Math.min(Math.abs(upslope) * 900, 0.2);
    return Math.max(0, Math.min(1, s));
  }

  private morphologyScore(c: BeatCandidate): number {
    // 0..1: combina prominencia razonable, ancho fisiológico y upslope claro
    const promScore = Math.min(1, Math.max(0, c.prominence * 14));
    const widthOk =
      c.widthMs >= this.config.minWidthMs && c.widthMs <= this.config.maxWidthMs ? 1 :
      c.widthMs > this.config.maxWidthMs * 1.5 || c.widthMs < this.config.minWidthMs * 0.4 ? 0 :
      0.5;
    const upScore = Math.min(1, Math.abs(c.upslope) * 700);
    return Math.max(0, Math.min(1, promScore * 0.45 + widthOk * 0.3 + upScore * 0.25));
  }

  private scoreAgainstTemplate(signal: ResampledSignal, idx: number): number {
    if (!this.template) return 0.5; // neutral si aún no hay template
    const L = this.template.length;
    const half = Math.floor(L / 2);
    if (idx - half < 0 || idx + (L - half) >= signal.length) return 0.4;
    const seg = new Float32Array(L);
    for (let k = 0; k < L; k++) seg[k] = signal.values[idx - half + k];
    return cosineSimilarityNorm(seg, this.template);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Double-peak suppression con score combinado (no solo prominencia)
  // ─────────────────────────────────────────────────────────────────────────────

  private suppressDoublePeaks(cands: BeatCandidate[]): BeatCandidate[] {
    if (cands.length === 0) return [];
    const sorted = [...cands].sort((a, b) => a.timestamp - b.timestamp);
    const out: BeatCandidate[] = [];
    const expected = this.expectedRR();
    const minGap = Math.max(this.config.hardRefractoryMs, expected > 0 ? expected * 0.45 : 240);

    for (const c of sorted) {
      const last = out[out.length - 1];
      if (!last) { out.push(c); continue; }
      if (c.timestamp - last.timestamp >= minGap) {
        out.push(c);
      } else {
        const sLast = combinedScore(last);
        const sC = combinedScore(c);
        if (sC > sLast) {
          last.adjudication = 'rejected';
          last.rejectionReason = 'double_peak_secondary';
          last.flags = [...(last.flags ?? []), 'double_peak'];
          out[out.length - 1] = c;
        } else {
          c.adjudication = 'rejected';
          c.rejectionReason = 'double_peak_secondary';
          c.flags = [...(c.flags ?? []), 'double_peak'];
          out.push(c); // mantener trazado
        }
      }
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Adjudicación con reglas explícitas
  // ─────────────────────────────────────────────────────────────────────────────

  private adjudicate(cands: BeatCandidate[]): BeatCandidate[] {
    const expected = this.expectedRR();
    const ref = this.computeRefractory(expected);

    return cands.map((c) => {
      if (c.adjudication === 'rejected') return c; // ya descartado por double-peak

      // Hard refractory
      if (this.lastAcceptedTimestamp !== null) {
        const dt = c.timestamp - this.lastAcceptedTimestamp;
        if (dt < ref.hardMs) {
          c.adjudication = 'rejected';
          c.rejectionReason = 'hard_refractory';
          this.sessionRejected++;
          this.lastRejectionReason = 'hard_refractory';
          return c;
        }
        // Soft refractory: requiere morfología fuerte para aceptar
        if (dt < ref.softMs) {
          if ((c.morphologyScore ?? 0) < 0.65 || (c.detectorAgreement ?? 0) < 0.7) {
            c.adjudication = 'rejected';
            c.rejectionReason = 'soft_refractory';
            c.flags = [...(c.flags ?? []), 'premature'];
            this.sessionRejected++;
            this.lastRejectionReason = 'soft_refractory';
            return c;
          }
          c.flags = [...(c.flags ?? []), 'premature'];
        }
      }

      // Width fisiológico
      if (c.widthMs < this.config.minWidthMs * 0.6 || c.widthMs > this.config.maxWidthMs * 1.4) {
        c.adjudication = 'rejected';
        c.rejectionReason = 'invalid_width';
        this.sessionRejected++;
        this.lastRejectionReason = 'invalid_width';
        return c;
      }

      // Prominencia mínima adaptativa
      if (c.prominence < this.adaptiveProminenceFloor * 0.45) {
        c.adjudication = 'rejected';
        c.rejectionReason = 'low_prominence';
        this.sessionRejected++;
        this.lastRejectionReason = 'low_prominence';
        return c;
      }

      // Rhythm score (compatibilidad con expectedRR)
      let rhythmScore = 0.5;
      if (this.lastAcceptedTimestamp !== null && expected > 0) {
        const dt = c.timestamp - this.lastAcceptedTimestamp;
        const err = Math.abs(dt - expected) / expected;
        rhythmScore = Math.max(0, 1 - err * 1.4);
        if (err > 0.45 && (c.morphologyScore ?? 0) < 0.55 && (c.templateScore ?? 0.5) < 0.5) {
          c.adjudication = 'rejected';
          c.rejectionReason = 'rhythm_mismatch';
          c.flags = [...(c.flags ?? []), 'suspicious'];
          this.sessionRejected++;
          this.lastRejectionReason = 'rhythm_mismatch';
          return c;
        }
      }
      c.rhythmScore = rhythmScore;

      // Score combinado final
      const combined = combinedScore(c);
      c.confidence = combined;
      c.score = combined;
      c.adjudication = 'pending';

      // Marcar weak si confianza baja pero no descartado
      if (combined < 0.55) {
        c.flags = [...(c.flags ?? []), 'weak'];
      } else if (!(c.flags ?? []).length) {
        c.flags = ['normal'];
      }

      return c;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Confirmación
  // ─────────────────────────────────────────────────────────────────────────────

  private confirmBeat(candidates: BeatCandidate[], signal: ResampledSignal): ConfirmedBeat | null {
    const pending = candidates.filter((c) => c.adjudication === 'pending');
    if (pending.length === 0) return null;

    const best = pending.reduce((a, b) => (a.confidence > b.confidence ? a : b));

    // Accept-strong vs accept-weak
    const detAgree = best.detectorHits?.derivativeUpslope ? 1 : 0.5;
    const strong =
      detAgree === 1 &&
      (best.morphologyScore ?? 0) >= 0.55 &&
      best.confidence >= this.config.minConfidence;
    const weak =
      best.confidence >= this.config.minConfidence * 0.85 &&
      ((best.templateScore ?? 0) >= 0.7 || (best.rhythmScore ?? 0) >= 0.75);

    if (!strong && !weak) {
      best.adjudication = 'rejected';
      best.rejectionReason = 'low_confidence';
      this.sessionRejected++;
      this.lastRejectionReason = 'low_confidence';
      return null;
    }

    best.adjudication = 'accepted';

    const beatSQI = this.beatSQI(best);
    const confirmed: ConfirmedBeat = {
      timestamp: best.timestamp,
      value: best.value,
      confidence: best.confidence,
      beatSQI,
      morphologyScore: best.morphologyScore,
      templateScore: best.templateScore,
      detectorAgreement: best.detectorAgreement,
      rhythmScore: best.rhythmScore,
      flags: best.flags,
    };
    if (this.lastAcceptedTimestamp !== null) {
      confirmed.rrMs = best.timestamp - this.lastAcceptedTimestamp;
    }

    // Update template solo con beats de buena calidad
    if (beatSQI >= 0.65) {
      this.updateTemplateFromSignal(signal, this.findIndexAtTimestamp(signal, best.timestamp));
    }

    this.lastAcceptedTimestamp = best.timestamp;
    this.lastConfirmedBeat = confirmed;
    this.sessionAccepted++;

    // Adapt prominence floor
    this.adaptiveProminenceFloor =
      this.adaptiveProminenceFloor * (1 - this.config.adaptiveProminenceAlpha) +
      best.prominence * 0.5 * this.config.adaptiveProminenceAlpha;

    // Recientes
    this.recentAccepted.push(confirmed);
    if (this.recentAccepted.length > this.recentAcceptedMax) this.recentAccepted.shift();

    return confirmed;
  }

  private beatSQI(c: BeatCandidate): number {
    // 0..1 — combina morfología, agreement, template y ritmo
    const m = c.morphologyScore ?? 0.5;
    const a = c.detectorAgreement ?? 0.5;
    const t = c.templateScore ?? 0.5;
    const r = c.rhythmScore ?? 0.5;
    const score = m * 0.35 + a * 0.25 + t * 0.2 + r * 0.2;
    return Math.max(0, Math.min(1, score));
  }

  private findIndexAtTimestamp(signal: ResampledSignal, ts: number): number {
    // búsqueda lineal corta (señal pequeña, longitud bounded)
    let bestIdx = 0;
    let bestDt = Infinity;
    for (let i = 0; i < signal.length; i++) {
      const dt = Math.abs(signal.timestamps[i] - ts);
      if (dt < bestDt) { bestDt = dt; bestIdx = i; }
    }
    return bestIdx;
  }

  private updateTemplateFromSignal(signal: ResampledSignal, idx: number): void {
    const L = this.config.templateLength;
    const half = Math.floor(L / 2);
    if (idx - half < 0 || idx + (L - half) >= signal.length) return;
    const seg = new Float32Array(L);
    let mean = 0;
    for (let k = 0; k < L; k++) { seg[k] = signal.values[idx - half + k]; mean += seg[k]; }
    mean /= L;
    let norm = 0;
    for (let k = 0; k < L; k++) { seg[k] -= mean; norm += seg[k] * seg[k]; }
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < L; k++) seg[k] /= norm;

    this.templateBuffer.push(seg);
    if (this.templateBuffer.length > this.templateMaxBuffer) this.templateBuffer.shift();
    if (this.templateBuffer.length < this.config.templateMinBeats) return;

    // Mediana por componente (robusta) + renormalización
    const tpl = new Float32Array(L);
    const tmp = new Float32Array(this.templateBuffer.length);
    for (let k = 0; k < L; k++) {
      for (let b = 0; b < this.templateBuffer.length; b++) tmp[b] = this.templateBuffer[b][k];
      // mediana
      const arr = Array.from(tmp).sort((a, b) => a - b);
      tpl[k] = arr[Math.floor(arr.length / 2)];
    }
    let n = 0; for (let k = 0; k < L; k++) n += tpl[k] * tpl[k];
    n = Math.sqrt(n) || 1;
    for (let k = 0; k < L; k++) tpl[k] /= n;
    this.template = tpl;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Refractory dinámico
  // ─────────────────────────────────────────────────────────────────────────────

  private expectedRR(): number {
    // mediana de los últimos RR aceptados, robusta
    const rrs: number[] = [];
    for (const b of this.recentAccepted) if (b.rrMs && b.rrMs > 200 && b.rrMs < 2000) rrs.push(b.rrMs);
    if (rrs.length === 0) return 0;
    rrs.sort((a, b) => a - b);
    return rrs[Math.floor(rrs.length / 2)];
  }

  private computeRefractory(expectedRR: number): { hardMs: number; softMs: number; recoveryMs: number } {
    const baseRR = expectedRR > 0 ? expectedRR : 750;
    return {
      hardMs: Math.max(this.config.hardRefractoryMs, baseRR * 0.28),
      softMs: Math.max(this.config.softRefractoryMs, baseRR * 0.42),
      recoveryMs: baseRR * 0.6,
    };
  }

  getLastConfirmedBeat(): ConfirmedBeat | null { return this.lastConfirmedBeat; }
  getLastRejectionReason(): string { return this.lastRejectionReason; }
  hasTemplate(): boolean { return this.template !== null; }

  /** Refractory windows actuales (derivadas de expectedRR del último frame procesado) */
  getRefractoryWindows(): { hardMs: number; softMs: number; recoveryMs: number; expectedRrMs: number } {
    return {
      hardMs: this.lastRefractory.hardMs,
      softMs: this.lastRefractory.softMs,
      recoveryMs: this.lastRefractory.recoveryMs,
      expectedRrMs: this.expectedRR(),
    };
  }

  /** Candidatos del último frame con su breakdown completo (para debug) */
  getLastFrameCandidates(): BeatCandidate[] { return this.lastFrameCandidates; }

  getSessionStats(): { accepted: number; rejected: number; acceptanceRate: number } {
    const total = this.sessionAccepted + this.sessionRejected;
    return {
      accepted: this.sessionAccepted,
      rejected: this.sessionRejected,
      acceptanceRate: total > 0 ? this.sessionAccepted / total : 0,
    };
  }

  reset(): void {
    this.adaptiveProminenceFloor = 0.04;
    this.lastAcceptedTimestamp = null;
    this.lastConfirmedBeat = null;
    this.sessionAccepted = 0;
    this.sessionRejected = 0;
    this.lastRejectionReason = 'none';
    this.template = null;
    this.templateBuffer = [];
    this.recentAccepted = [];
    this.lastFrameCandidates = [];
    this.lastRefractory = { hardMs: 200, softMs: 280, recoveryMs: 450 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function combinedScore(c: BeatCandidate): number {
  const base = c.score ?? 0;
  const det = c.detectorAgreement ?? 0.5;
  const tpl = c.templateScore ?? 0.5;
  const morph = c.morphologyScore ?? 0.5;
  const rhythm = c.rhythmScore ?? 0.5;
  const s = base * 0.35 + det * 0.25 + morph * 0.2 + tpl * 0.1 + rhythm * 0.1;
  return Math.max(0, Math.min(1, s));
}

function cosineSimilarityNorm(a: Float32Array, b: Float32Array): number {
  // a sin normalizar; b ya viene normalizado y centrado
  const L = Math.min(a.length, b.length);
  let mean = 0;
  for (let i = 0; i < L; i++) mean += a[i];
  mean /= L;
  let dot = 0, na = 0;
  for (let i = 0; i < L; i++) {
    const ai = a[i] - mean;
    dot += ai * b[i];
    na += ai * ai;
  }
  if (na === 0) return 0;
  const sim = dot / Math.sqrt(na);
  // sim ∈ [-1, 1]; mapear a [0..1]
  return Math.max(0, Math.min(1, (sim + 1) / 2));
}
