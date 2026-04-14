/**
 * Tipos para el módulo de detección cardíaca refactorizado
 * Arquitectura modular: BeatDetector, RRTracker, BpmEstimator, SpectralQualityEstimator, HeartRateFusion
 */

export type HeartState = 
  | 'WARMUP'
  | 'SEARCHING'
  | 'TRACKING_UNCERTAIN'
  | 'TRACKING_LOCKED'
  | 'LOST_LOCK';

export type BpmSource = 
  | 'TEMPORAL'
  | 'SPECTRAL'
  | 'FUSED';

export interface ResampledSignal {
  values: Float32Array;
  timestamps: Float64Array;
  sampleRate: number;
  length: number;
}

export interface BeatCandidate {
  timestamp: number;
  value: number;
  prominence: number;
  upslope: number;
  widthMs: number;
  confidence: number;
  score: number;
  adjudication: 'pending' | 'accepted' | 'rejected';
  rejectionReason?: string;
}

export interface ConfirmedBeat {
  timestamp: number;
  value: number;
  confidence: number;
  rrMs?: number;
}

export interface RRData {
  raw: number[];
  filtered: number[];
  outliers: boolean[];
  mean: number;
  median: number;
  std: number;
  outlierRatio: number;
}

export interface TemporalBpmEstimate {
  instantBpm: number;
  medianBpm: number;
  trimmedMeanBpm: number;
  confidence: number;
  stability: number;
}

export interface SpectralBpmEstimate {
  bpm: number;
  frequencyHz: number;
  power: number;
  prominence: number;
  width: number;
  snr: number;
  harmonicRatio: number;
  entropy: number;
  confidence: number;
}

export interface TemporalSQI {
  consistency: number;
  stability: number;
  regularity: number;
  amplitudeStability: number;
  intervalStability: number;
  localBeatQuality: number;
  rejectionRatio: number;
  score: number;
}

export interface SpectralSQI {
  peakClarity: number;
  spectralSnr: number;
  periodicity: number;
  harmonicConsistency: number;
  spectralEntropy: number;
  bandConfinement: number;
  frequencyStability: number;
  score: number;
}

export interface GlobalSQI {
  temporal: TemporalSQI;
  spectral: SpectralSQI;
  upstream: number;
  fingerDetected: boolean;
  contactPenalty: number;
  score: number;
}

export interface HeartRateFusionResult {
  activeSource: BpmSource;
  instantBpm: number;
  temporalBpm: TemporalBpmEstimate;
  spectralBpm: SpectralBpmEstimate;
  finalBpm: number;
  confidence: number;
  divergence: number;
}

export interface HeartDiagnostics {
  heartState: HeartState;
  activeBpmSource: BpmSource;
  instantBpm: number;
  temporalBpm: number;
  spectralBpm: number;
  finalBpm: number;
  confidence: number;
  temporalSQI: number;
  spectralSQI: number;
  globalSQI: number;
  dominantFrequencyHz: number;
  dominantFrequencyBpm: number;
  beatCount: number;
  acceptedBeats: number;
  rejectedBeats: number;
  rrCount: number;
  rrMean: number;
  rrMedian: number;
  rrOutlierRatio: number;
  processingTimeMs: number;
}

export interface HeartProcessOutput {
  bpm: number;
  confidence: number;
  signalQuality: number;
  beatDetected: boolean;
  diagnostics: HeartDiagnostics;
  rrData: RRData;
  lastBeat: ConfirmedBeat | null;
}
