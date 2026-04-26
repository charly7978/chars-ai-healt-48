/**
 * HeartBeatProcessor - Fachada orquestadora para detección cardíaca
 * Integra: SignalResampler, BeatDetector, RRTracker, BpmEstimator, SpectralQualityEstimator, HeartRateFusion
 * Compatibilidad: mantiene interface legacy para no romper useHeartBeatProcessor
 */

import type { ProcessedSignal } from '../types/signal';
import type { ArrhythmiaResult } from './signal-processing/ArrhythmiaDetector';
import type {
  HeartProcessOutput,
  HeartDiagnostics,
  RRData,
  ConfirmedBeat,
  HeartState,
  HeartRateFusionResult,
} from './heartbeat/cardiac-types';

// Tipos legacy para compatibilidad
export interface HeartBeatProcessInputFull {
  filteredValue: number;
  rawValue: number;
  timestamp: number;
  upstreamSqi?: number;
  contactState?: string;
  fingerDetected: boolean;
  perfusionIndex?: number;
  pressureState?: string;
  clipHighRatio?: number;
  clipLowRatio?: number;
  activeSource?: string;
  motionArtifact?: number;
  positionDrifting?: boolean;
  maskStability?: number;
}

export interface HeartBeatProcessOutput {
  bpm: number;
  bpmConfidence: number;
  confidence: number;
  isPeak: boolean;
  filteredValue: number;
  sqi: number;
  beatSQI: number | null;
  rrData: {
    intervals: number[];
    lastPeakTime: number | null;
    lastIbiMs: number | null;
  };
  activeHypothesis: string;
  detectorAgreement: number;
  rejectionReason: string;
  beatFlags: string[];
  lastAcceptedBeat: {
    timestamp: number;
    ibiMs: number;
    instantBpm: number;
    beatSQI: number;
    morphologyScore: number;
    rhythmScore: number;
    detectorAgreementScore: number;
    templateScore: number;
    sourceConsistencyScore: number;
    flags: string[];
  } | null;
  debug: {
    expectedRrMs?: number;
    hardRefractoryMs?: number;
    softRefractoryMs?: number;
    sampleRateHz?: number;
    beatsAcceptedSession?: number;
    beatsRejectedSession?: number;
    doublePeakCount?: number;
    missedBeatCount?: number;
    suspiciousCount?: number;
    prematureCount?: number;
    templateCorrelationLast?: number;
    morphologyScoreLast?: number;
    periodicityScore?: number;
    fusion?: {
      hypotheses: Array<{ id: string; bpm: number; confidence: number; weight: number }>;
      activeHypothesis: string;
      finalBpm: number;
      spread: number;
    };
  };
}

import { SignalResampler } from './heartbeat/SignalResampler';
import { BeatDetector } from './heartbeat/BeatDetector';
import { RRTracker } from './heartbeat/RRTracker';
import { BpmEstimator } from './heartbeat/BpmEstimator';
import { SpectralQualityEstimator } from './heartbeat/SpectralQualityEstimator';
import { HeartRateFusion } from './heartbeat/HeartRateFusion';
import { ArrhythmiaDetector } from './signal-processing/ArrhythmiaDetector';

export interface HeartBeatInput {
  value: number;
  timestamp: number;
  quality: number;
  fingerDetected: boolean;
  contactState?: string;
  pressureState?: string;
  perfusionIndex?: number;
  clipHighRatio?: number;
  clipLowRatio?: number;
  motionArtifact?: number;
  positionDrifting?: boolean;
}

export class HeartBeatProcessor {
  private resampler: SignalResampler;
  private beatDetector: BeatDetector;
  private rrTracker: RRTracker;
  private bpmEstimator: BpmEstimator;
  private sqiEstimator: SpectralQualityEstimator;
  private fusion: HeartRateFusion;
  private arrhythmiaDetector: ArrhythmiaDetector;

  private heartState: HeartState = 'WARMUP';
  private lastBeat: ConfirmedBeat | null = null;
  private lastOutput: HeartProcessOutput | null = null;
  private lastLegacyOutput: HeartBeatProcessOutput | null = null;
  private startTime: number = 0;
  private processingCount: number = 0;

  private audioContext: AudioContext | null = null;
  private lastBeepTime: number = 0;
  private readonly MIN_BEEP_INTERVAL_MS = 520;

  constructor() {
    this.resampler = new SignalResampler({ targetSampleRate: 60 });
    this.beatDetector = new BeatDetector();
    this.rrTracker = new RRTracker();
    this.bpmEstimator = new BpmEstimator();
    this.sqiEstimator = new SpectralQualityEstimator();
    this.fusion = new HeartRateFusion();
    this.arrhythmiaDetector = new ArrhythmiaDetector();
    this.startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.initAudio();
  }

  private async initAudio(): Promise<void> {
    try {
      this.audioContext = new AudioContext();
      await this.audioContext.resume();
    } catch {
      /* noop */
    }
  }

  /**
   * Procesa muestra PPG y detecta latidos
   * Compatibilidad: acepta forma legacy (valor, dedo, timestamp) u objeto rico
   */
  processSignal(
    input: number | HeartBeatProcessInputFull,
    fingerDetected: boolean = true,
    timestamp?: number
  ): HeartBeatProcessOutput {
    const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

    // Normalizar input
    const normalized = this.normalizeInput(input, fingerDetected, timestamp);
    
    // Actualizar estado de calentamiento
    this.updateHeartState(normalized);

    // Agregar muestra al resampler
    this.resampler.addSample(normalized.value, normalized.timestamp);

    // Obtener señal re-muestreada
    const shortWindow = this.resampler.getShortWindow();
    const longWindow = this.resampler.getLongWindow();

    if (!longWindow || this.heartState === 'WARMUP') {
      const legacyOutput = this.getEmptyLegacyOutput(normalized);
      this.lastLegacyOutput = legacyOutput;
      return legacyOutput;
    }

    // Detectar beats
    const { candidates, confirmed } = this.beatDetector.process(
      longWindow,
      normalized.quality,
      normalized.fingerDetected
    );

    let rrData: RRData = this.rrTracker.getRRData();
    let beatDetected = false;

    // Si hay beat confirmado, agregar al tracker RR
    if (confirmed) {
      this.rrTracker.addBeat(confirmed);
      this.lastBeat = confirmed;
      beatDetected = true;

      // Agregar RR al detector de arritmias
      if (confirmed.rrMs) {
        this.arrhythmiaDetector.addRRInterval(confirmed.rrMs);
      }

      // Reproducir sonido
      this.playHeartSound();
    }

    // Actualizar datos RR
    rrData = this.rrTracker.getRRData();

    // Estimar BPM temporal
    const temporalBpm = this.bpmEstimator.estimateTemporal(rrData);

    // Estimar BPM espectral
    const spectralBpm = this.bpmEstimator.estimateSpectral(longWindow);

    // Estimar BPM por autocorrelación (hipótesis adicional independiente)
    const autocorr = this.bpmEstimator.estimateAutocorrelation(longWindow);

    // Calcular SQI temporal
    const temporalSQI = this.sqiEstimator.calculateTemporalSQI(
      rrData,
      this.lastBeat?.confidence || 0
    );

    // Calcular SQI espectral
    const spectralSQI = this.sqiEstimator.calculateSpectralSQI(longWindow);

    // Fusionar BPM (multi-hipótesis con hysteresis y outlier-handling)
    const fusionResult = this.fusion.fuse(
      temporalBpm,
      spectralBpm,
      temporalSQI,
      spectralSQI,
      normalized.quality,
      normalized.fingerDetected,
      autocorr
    );

    // Calcular SQI global
    const globalSQI = this.calculateGlobalSQI(
      temporalSQI,
      spectralSQI,
      normalized.quality,
      normalized.fingerDetected
    );

    // Construir diagnósticos
    const diagnostics = this.buildDiagnostics(
      fusionResult,
      temporalSQI,
      spectralSQI,
      globalSQI,
      spectralBpm,
      rrData,
      startTime
    );

    // Construir output nuevo
    const newOutput: HeartProcessOutput = {
      bpm: fusionResult.finalBpm,
      confidence: fusionResult.confidence,
      signalQuality: globalSQI,
      beatDetected,
      diagnostics,
      rrData,
      lastBeat: this.lastBeat,
    };

    this.lastOutput = newOutput;
    this.processingCount++;

    // Convertir a formato legacy para compatibilidad
    const legacyOutput = this.convertToLegacy(newOutput, normalized);
    this.lastLegacyOutput = legacyOutput;
    return legacyOutput;
  }

  /**
   * Normaliza input a formato estándar
   */
  private normalizeInput(
    input: number | HeartBeatProcessInputFull,
    fingerDetected: boolean,
    timestamp?: number
  ): HeartBeatInput {
    if (typeof input === 'object' && input !== null) {
      return {
        value: input.filteredValue,
        timestamp: input.timestamp,
        quality: input.upstreamSqi ?? 50,
        fingerDetected: input.fingerDetected,
        contactState: input.contactState,
        pressureState: input.pressureState,
        perfusionIndex: input.perfusionIndex,
        clipHighRatio: input.clipHighRatio,
        clipLowRatio: input.clipLowRatio,
        motionArtifact: input.motionArtifact,
        positionDrifting: input.positionDrifting,
      };
    }
    return {
      value: input as number,
      timestamp: timestamp ?? (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      quality: 50,
      fingerDetected,
    };
  }

  /**
   * Actualiza estado del tracker cardíaco
   */
  private updateHeartState(input: HeartBeatInput): void {
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - this.startTime;

    if (elapsed < 2000) {
      this.heartState = 'WARMUP';
      return;
    }

    if (!input.fingerDetected || input.quality < 20) {
      this.heartState = 'LOST_LOCK';
      return;
    }

    const rrCount = this.rrTracker.getCount();
    const rrData = this.rrTracker.getRRData();

    if (rrCount < 5) {
      this.heartState = 'SEARCHING';
    } else if (rrData.outlierRatio > 0.3 || this.fusion.getAverageDivergence() > 15) {
      this.heartState = 'TRACKING_UNCERTAIN';
    } else {
      this.heartState = 'TRACKING_LOCKED';
    }
  }

  /**
   * Calcula SQI global
   */
  private calculateGlobalSQI(
    temporalSQI: { score: number },
    spectralSQI: { score: number },
    upstreamQuality: number,
    fingerDetected: boolean
  ): number {
    const contactPenalty = fingerDetected ? 0 : 0.4;
    const combined = (temporalSQI.score * 0.4 + spectralSQI.score * 0.4) * (1 - contactPenalty);
    const upstream = upstreamQuality / 100;
    return Math.max(0, Math.min(100, combined * 50 + upstream * 50));
  }

  /**
   * Construye diagnósticos completos
   */
  private buildDiagnostics(
    fusion: HeartRateFusionResult,
    temporalSQI: { score: number },
    spectralSQI: { score: number },
    globalSQI: number,
    spectralBpm: { frequencyHz: number; bpm: number },
    rrData: RRData,
    startTime: number
  ): HeartDiagnostics {
    const processingTime = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
    const detectorStats = this.beatDetector.getSessionStats();

    return {
      heartState: this.heartState,
      activeBpmSource: fusion.activeSource,
      instantBpm: fusion.instantBpm,
      temporalBpm: fusion.temporalBpm.medianBpm,
      spectralBpm: fusion.spectralBpm.bpm,
      finalBpm: fusion.finalBpm,
      confidence: fusion.confidence,
      temporalSQI: temporalSQI.score,
      spectralSQI: spectralSQI.score,
      globalSQI: globalSQI / 100,
      dominantFrequencyHz: spectralBpm.frequencyHz,
      dominantFrequencyBpm: spectralBpm.bpm,
      beatCount: this.processingCount,
      acceptedBeats: detectorStats.accepted,
      rejectedBeats: detectorStats.rejected,
      rrCount: rrData.filtered.length,
      rrMean: rrData.mean,
      rrMedian: rrData.median,
      rrOutlierRatio: rrData.outlierRatio,
      processingTimeMs: processingTime,
    };
  }

  /**
   * Convierte output nuevo a formato legacy para compatibilidad
   */
  private convertToLegacy(newOutput: HeartProcessOutput, input: HeartBeatInput): HeartBeatProcessOutput {
    const diagnostics = newOutput.diagnostics;
    const lastRR = newOutput.rrData.filtered.length > 0 
      ? newOutput.rrData.filtered[newOutput.rrData.filtered.length - 1] 
      : null;

    return {
      bpm: Math.round(newOutput.bpm),
      bpmConfidence: diagnostics.confidence,
      confidence: diagnostics.confidence,
      isPeak: newOutput.beatDetected,
      filteredValue: input.value,
      sqi: newOutput.signalQuality,
      beatSQI: newOutput.lastBeat ? newOutput.lastBeat.confidence * 100 : null,
      rrData: {
        intervals: newOutput.rrData.filtered.slice(-12),
        lastPeakTime: newOutput.lastBeat?.timestamp ?? null,
        lastIbiMs: lastRR,
      },
      activeHypothesis: diagnostics.activeBpmSource,
      detectorAgreement: newOutput.lastBeat ? newOutput.lastBeat.confidence : 0,
      rejectionReason: 'none',
      beatFlags: [],
      lastAcceptedBeat: newOutput.lastBeat ? {
        timestamp: newOutput.lastBeat.timestamp,
        ibiMs: newOutput.lastBeat.rrMs ?? 0,
        instantBpm: newOutput.lastBeat.rrMs ? 60000 / newOutput.lastBeat.rrMs : 0,
        beatSQI: newOutput.lastBeat.confidence * 100,
        morphologyScore: newOutput.lastBeat.confidence,
        rhythmScore: diagnostics.confidence * 100,
        detectorAgreementScore: newOutput.lastBeat.confidence * 100,
        templateScore: 0.5,
        sourceConsistencyScore: diagnostics.confidence * 100,
        flags: [],
      } : null,
      debug: {
        expectedRrMs: diagnostics.rrMean,
        hardRefractoryMs: 200,
        softRefractoryMs: 280,
        sampleRateHz: 60,
        beatsAcceptedSession: diagnostics.acceptedBeats,
        beatsRejectedSession: diagnostics.rejectedBeats,
        doublePeakCount: 0,
        missedBeatCount: 0,
        suspiciousCount: 0,
        prematureCount: 0,
        templateCorrelationLast: 0.5,
        morphologyScoreLast: newOutput.lastBeat?.confidence ?? 0,
        periodicityScore: diagnostics.temporalSQI,
        fusion: {
          hypotheses: [
            { id: 'temporal', bpm: diagnostics.temporalBpm, confidence: diagnostics.confidence, weight: 0.6 },
            { id: 'spectral', bpm: diagnostics.spectralBpm, confidence: diagnostics.confidence, weight: 0.4 },
          ],
          activeHypothesis: diagnostics.activeBpmSource,
          finalBpm: diagnostics.finalBpm,
          spread: Math.abs(diagnostics.temporalBpm - diagnostics.spectralBpm),
        },
      },
    };
  }

  /**
   * Retorna output vacío durante warmup
   */
  private getEmptyLegacyOutput(input: HeartBeatInput): HeartBeatProcessOutput {
    return {
      bpm: 0,
      bpmConfidence: 0,
      confidence: 0,
      isPeak: false,
      filteredValue: input.value,
      sqi: input.quality,
      beatSQI: null,
      rrData: {
        intervals: [],
        lastPeakTime: null,
        lastIbiMs: null,
      },
      activeHypothesis: 'TEMPORAL',
      detectorAgreement: 0,
      rejectionReason: 'none',
      beatFlags: [],
      lastAcceptedBeat: null,
      debug: {
        expectedRrMs: 0,
        hardRefractoryMs: 200,
        softRefractoryMs: 280,
        sampleRateHz: 60,
        beatsAcceptedSession: 0,
        beatsRejectedSession: 0,
        doublePeakCount: 0,
        missedBeatCount: 0,
        suspiciousCount: 0,
        prematureCount: 0,
        templateCorrelationLast: 0,
        morphologyScoreLast: 0,
        periodicityScore: 0,
      },
    };
  }

  /**
   * Reproduce sonido de latido (side-effect opcional)
   */
  private playHeartSound(): void {
    if (!this.audioContext || this.heartState === 'WARMUP') return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastBeepTime < this.MIN_BEEP_INTERVAL_MS) return;

    try {
      if (navigator.vibrate) navigator.vibrate([36, 18, 52]);

      const currentTime = this.audioContext.currentTime;
      const o1 = this.audioContext.createOscillator();
      const g1 = this.audioContext.createGain();
      o1.type = 'sine';
      o1.frequency.value = 150;
      g1.gain.setValueAtTime(0, currentTime);
      g1.gain.linearRampToValueAtTime(1.4, currentTime + 0.03);
      g1.gain.exponentialRampToValueAtTime(0.001, currentTime + 0.14);
      o1.connect(g1);
      g1.connect(this.audioContext.destination);
      o1.start(currentTime);
      o1.stop(currentTime + 0.18);

      this.lastBeepTime = now;
    } catch {
      /* noop */
    }
  }

  /**
   * Obtiene resultado de arritmia
   */
  getArrhythmiaResult(): ArrhythmiaResult | null {
    return this.arrhythmiaDetector.analyze();
  }

  /**
   * Obtiene último output nuevo
   */
  getLastOutput(): HeartProcessOutput | null {
    return this.lastOutput;
  }

  /**
   * Obtiene último output legacy (compatibilidad)
   */
  getLastProcessOutput(): HeartBeatProcessOutput | null {
    return this.lastLegacyOutput;
  }

  /**
   * Obtiene RR intervals (compatibilidad legacy)
   */
  getRRIntervals(): { intervals: number[]; lastPeakTime: number | null } {
    const rrData = this.rrTracker.getRRData();
    return {
      intervals: rrData.filtered.slice(-12),
      lastPeakTime: this.lastBeat?.timestamp ?? null,
    };
  }

  /**
   * Obtiene smooth BPM (compatibilidad legacy)
   */
  getSmoothBPM(): number {
    return this.lastLegacyOutput?.bpm ?? 0;
  }

  /**
   * Obtiene final BPM (compatibilidad legacy)
   */
  getFinalBPM(): number {
    return this.getSmoothBPM();
  }

  /**
   * Obtiene signal quality (compatibilidad legacy)
   */
  getSignalQuality(): number {
    return this.lastLegacyOutput?.sqi ?? 0;
  }

  /**
   * Configura estado de arritmia (compatibilidad)
   */
  setArrhythmiaDetected(isDetected: boolean): void {
    // No-op en nueva arquitectura, arrhythmia se detecta automáticamente
  }

  /**
   * Reinicia procesador
   */
  reset(): void {
    this.resampler.reset();
    this.beatDetector.reset();
    this.rrTracker.reset();
    this.bpmEstimator.reset();
    this.sqiEstimator.reset();
    this.fusion.reset();
    this.arrhythmiaDetector.reset();
    this.heartState = 'WARMUP';
    this.lastBeat = null;
    this.lastOutput = null;
    this.lastLegacyOutput = null;
    this.startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.processingCount = 0;
  }
}
