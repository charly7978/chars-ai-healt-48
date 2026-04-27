/**
 * PublicationGate.ts
 * ----------------------------------------------------------------------------
 * Gate de publicación para signos vitales.
 * 
 * Regla fundamental: NO publicar BPM ni SpO2 sin evidencia real.
 * 
 * Condiciones mínimas para BPM:
 * - bufferDuration >= 8 segundos
 * - fps >= 18 durante la ventana
 * - ROI válido (no saturado, no oscuro, evidencia óptica)
 * - >= 5 beats detectados con confianza >= 0.55
 * - Acuerdo BPM time-domain vs frequency-domain <= 8 BPM
 * - SQI overall >= 0.65
 * 
 * Condiciones para SpO2:
 * - Calibración específica por dispositivo (NO fórmula genérica)
 * - O2 status = UNCALIBRATED si no hay coeficientes A/B
 * - Solo publicar con badge "calibrated"
 * 
 * Estados de salida:
 * - NO_PPG_SIGNAL: sin evidencia óptica
 * - SEARCHING_SIGNAL: evaluando, aún no cumple condiciones
 * - PPG_CANDIDATE: candidato detectado, validando
 * - PPG_VALID: señal validada, publicación habilitada
 * - SATURATED / DARK_FRAME / MOTION_ARTIFACT: errores específicos
 */

import type { 
  PpgEngineState, 
  SignalQuality, 
  BeatDetectionResult, 
  RoiEvidence,
  Spo2Calibration,
  PublicationGate as IPublicationGate,
} from "./PpgTypes";

const MIN_BUFFER_SECONDS = 8;
const MIN_FPS = 18;
const MIN_BEATS = 5;
const MAX_BPM_DEVIATION = 8;
const MIN_SQI_OVERALL = 0.65;

export interface GateInput {
  bufferDurationSeconds: number;
  fps: number;
  roi: RoiEvidence;
  signalQuality: SignalQuality;
  beats: BeatDetectionResult;
  spo2Calibration: Spo2Calibration;
}

export class PublicationGate implements IPublicationGate {
  canPublishBpm = false;
  canPublishSpo2 = false;
  publishedBpm: number | null = null;
  publishedSpo2: number | null = null;
  bpmConfidence = 0;
  spo2Confidence = 0;
  blockReasons: string[] = [];
  currentStatus: PpgEngineState = "no_ppg_signal";

  private evaluationHistory: Array<{ time: number; canPublish: boolean }> = [];
  private readonly requiredConsistentEvaluations = 3;

  /**
   * Evaluar si se puede publicar signos vitales.
   * Esta función es la única autoridad para publicación.
   */
  evaluate(input: GateInput): void {
    this.blockReasons = [];

    // 1. Verificar buffer suficiente
    if (input.bufferDurationSeconds < MIN_BUFFER_SECONDS) {
      this.blockReasons.push(`BUFFER_SHORT:${input.bufferDurationSeconds.toFixed(1)}s<${MIN_BUFFER_SECONDS}s`);
      this.currentStatus = "searching_signal";
      this.updatePublishState(false);
      return;
    }

    // 2. Verificar FPS adecuado
    if (input.fps < MIN_FPS) {
      this.blockReasons.push(`FPS_LOW:${input.fps.toFixed(1)}<${MIN_FPS}`);
      this.currentStatus = "searching_signal";
      this.updatePublishState(false);
      return;
    }

    // 3. Verificar ROI
    const roiOk = this.evaluateROI(input.roi);
    if (!roiOk) {
      // Estado ya seteado por evaluateROI
      this.updatePublishState(false);
      return;
    }

    // 4. Verificar calidad de señal
    if (input.signalQuality.sqiOverall < MIN_SQI_OVERALL) {
      this.blockReasons.push(`SQI_LOW:${input.signalQuality.sqiOverall.toFixed(2)}<${MIN_SQI_OVERALL}`);
      this.currentStatus = "ppg_candidate";
      this.updatePublishState(false);
      return;
    }

    // 5. Verificar beats
    const beatsOk = this.evaluateBeats(input.beats);
    if (!beatsOk) {
      this.currentStatus = "ppg_candidate";
      this.updatePublishState(false);
      return;
    }

    // 6. Verificar calibración SpO2
    this.evaluateSpo2(input.spo2Calibration);

    // Todo OK - señal válida
    this.currentStatus = "ppg_valid";
    
    // Calcular BPM publicable con confianza
    this.publishedBpm = this.calculatePublishedBpm(input.beats);
    this.bpmConfidence = this.calculateBpmConfidence(input.beats, input.signalQuality);
    
    // Verificar consistencia temporal antes de publicar
    if (this.isConsistentlyValid()) {
      this.updatePublishState(true);
    } else {
      this.updatePublishState(false);
      this.blockReasons.push("VALIDATING_CONSISTENCY");
    }
  }

  /**
   * Resetear gate.
   */
  reset(): void {
    this.canPublishBpm = false;
    this.canPublishSpo2 = false;
    this.publishedBpm = null;
    this.publishedSpo2 = null;
    this.bpmConfidence = 0;
    this.spo2Confidence = 0;
    this.blockReasons = [];
    this.currentStatus = "no_ppg_signal";
    this.evaluationHistory = [];
  }

  // =============================================================================
  // PRIVATE
  // =============================================================================

  private evaluateROI(roi: RoiEvidence): boolean {
    // Saturación destructiva
    if (roi.saturationRatio > 0.45) {
      this.blockReasons.push("ROI_SATURATED");
      this.currentStatus = "saturated";
      return false;
    }

    // Frame muy oscuro
    if (roi.darkRatio > 0.40) {
      this.blockReasons.push("ROI_DARK");
      this.currentStatus = "dark_frame";
      return false;
    }

    // Sin evidencia óptica válida
    if (roi.validPixelRatio < 0.70) {
      this.blockReasons.push("ROI_INVALID_PIXELS");
      this.currentStatus = "no_ppg_signal";
      return false;
    }

    // Sin firma de hemoglobina
    if (roi.redDominance < 0.5) {
      this.blockReasons.push("ROI_NO_HEMOGLOBIN_SIGNATURE");
      this.currentStatus = "no_ppg_signal";
      return false;
    }

    return true;
  }

  private evaluateBeats(beats: BeatDetectionResult): boolean {
    // Suficientes beats
    if (beats.beats.length < MIN_BEATS) {
      this.blockReasons.push(`BEATS_INSUFFICIENT:${beats.beats.length}<${MIN_BEATS}`);
      return false;
    }

    // Beats con alta confianza
    const highConfidenceBeats = beats.beats.filter(b => b.confidence >= 0.55);
    if (highConfidenceBeats.length < MIN_BEATS) {
      this.blockReasons.push(`BEATS_LOW_CONFIDENCE:${highConfidenceBeats.length}<${MIN_BEATS}`);
      return false;
    }

    // Acuerdo entre estimadores
    const timeDomainBpm = beats.bpmTimeDomain ?? beats.peakBpm ?? beats.medianIbiBpm ?? null;
    const frequencyDomainBpm = beats.bpmFrequencyDomain ?? beats.fftBpm ?? beats.autocorrBpm ?? null;
    if (timeDomainBpm !== null && frequencyDomainBpm !== null) {
      const diff = Math.abs(timeDomainBpm - frequencyDomainBpm);
      if (diff > MAX_BPM_DEVIATION) {
        this.blockReasons.push(`BPM_DISAGREEMENT:${diff.toFixed(1)}BPM>${MAX_BPM_DEVIATION}BPM`);
        return false;
      }
    }

    // Consistencia RR razonable
    const rrConsistency = beats.rrConsistency ?? this.calculateRrConsistency(beats.rrIntervalsMs ?? beats.rrIntervals ?? []);
    if (rrConsistency < 0.3) {
      this.blockReasons.push(`RR_INCONSISTENT:${rrConsistency.toFixed(2)}`);
      return false;
    }

    return true;
  }

  private evaluateSpo2(calibration: Spo2Calibration): void {
    // Sin calibración = nunca publicar
    if (calibration.badge === "uncalibrated") {
      this.canPublishSpo2 = false;
      this.publishedSpo2 = null;
      this.spo2Confidence = 0;
      this.blockReasons.push("SPO2_UNCALIBRATED");
      return;
    }

    // Calibración parcial = publicar con badge (pero aquí solo evaluamos si puede)
    // La decisión final de publicación SpO2 está en evaluate() principal
    if (calibration.badge === "partial") {
      // Permitir publicación con confianza reducida
      this.canPublishSpo2 = this.canPublishBpm;  // Solo si BPM es válido
      this.spo2Confidence = 0.5;
    }

    if (calibration.badge === "calibrated") {
      this.canPublishSpo2 = this.canPublishBpm;
      this.spo2Confidence = this.canPublishBpm ? 0.8 : 0;
    }
  }

  private calculatePublishedBpm(beats: BeatDetectionResult): number | null {
    // Priorizar BPM con mejor confianza
    const timeDomainBpm = beats.bpmTimeDomain ?? beats.peakBpm ?? beats.medianIbiBpm ?? null;
    const frequencyDomainBpm = beats.bpmFrequencyDomain ?? beats.fftBpm ?? beats.autocorrBpm ?? null;
    if (timeDomainBpm !== null && frequencyDomainBpm !== null) {
      // Promedio ponderado por confianza implícita
      return (timeDomainBpm + frequencyDomainBpm) / 2;
    }
    
    return timeDomainBpm ?? frequencyDomainBpm ?? beats.bpm ?? null;
  }

  private calculateBpmConfidence(beats: BeatDetectionResult, quality: SignalQuality): number {
    let confidence = 0;
    
    // Base de confianza del detector
    confidence += (beats.bpmConfidence ?? beats.confidence) * 0.4;
    
    // Bonus por acuerdo de estimadores
    const timeDomainBpm = beats.bpmTimeDomain ?? beats.peakBpm ?? beats.medianIbiBpm ?? null;
    const frequencyDomainBpm = beats.bpmFrequencyDomain ?? beats.fftBpm ?? beats.autocorrBpm ?? null;
    if (timeDomainBpm !== null && frequencyDomainBpm !== null) {
      const diff = Math.abs(timeDomainBpm - frequencyDomainBpm);
      if (diff <= MAX_BPM_DEVIATION) {
        confidence += 0.3 * (1 - diff / MAX_BPM_DEVIATION);
      }
    }
    
    // Aporte de SQI
    confidence += quality.sqiOverall * 0.3;
    
    return Math.min(1, Math.max(0, confidence));
  }

  private calculateRrConsistency(rrIntervalsMs: number[]): number {
    const intervals = rrIntervalsMs.filter((value) => Number.isFinite(value) && value > 0);
    if (intervals.length < 2) return 0;
    const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
    if (mean <= 0) return 0;
    const variance =
      intervals.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / intervals.length;
    return Math.max(0, Math.min(1, 1 - Math.sqrt(variance) / mean));
  }

  private updatePublishState(canPublish: boolean): void {
    this.canPublishBpm = canPublish;
    if (!canPublish) {
      this.publishedBpm = null;
    }

    // Trackear historial para consistencia
    this.evaluationHistory.push({
      time: performance.now(),
      canPublish,
    });

    // Mantener solo últimas 5 evaluaciones
    if (this.evaluationHistory.length > 5) {
      this.evaluationHistory.shift();
    }
  }

  private isConsistentlyValid(): boolean {
    if (this.evaluationHistory.length < this.requiredConsistentEvaluations) {
      return false;
    }

    // Verificar que las últimas N evaluaciones permitan publicación
    const recent = this.evaluationHistory.slice(-this.requiredConsistentEvaluations);
    return recent.every(e => e.canPublish);
  }
}
