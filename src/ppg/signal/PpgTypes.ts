/**
 * PpgTypes.ts
 * ----------------------------------------------------------------------------
 * Tipos fundamentales para el pipeline PPG.
 * Zero simulación. Zero valores por defecto. Evidencia real únicamente.
 */

// =============================================================================
// ESTADOS DEL PIPELINE
// =============================================================================

export type PpgEngineState =
  | "idle"                   // Sin cámara activa
  | "requesting_camera"      // Solicitando permisos
  | "camera_ready"           // Cámara activa, sin torch
  | "torch_on"               // Torch encendido
  | "measuring"              // Capturando frames
  | "searching_signal"       // Analizando ROI, buscando evidencia óptica
  | "ppg_candidate"          // Señal candidata detectada
  | "ppg_valid"              // Señal validada, publicación habilitada
  | "no_ppg_signal"          // Frame válido pero sin evidencia PPG
  | "saturated"              // Saturación destructiva
  | "dark_frame"             // Frame oscuro/insuficiente luz
  | "motion_artifact"        // Artefacto de movimiento
  | "low_perfusion"          // Perfusión insuficiente
  | "error";                 // Error crítico

export type RoiState =
  | "SEARCHING_SIGNAL"
  | "OPTICAL_CONTACT_CANDIDATE"
  | "PPG_CANDIDATE"
  | "PPG_VALID"
  | "NO_PPG_SIGNAL"
  | "SATURATED"
  | "DARK_FRAME"
  | "MOTION_ARTIFACT"
  | "LOW_PERFUSION";

export type TorchState =
  | "OFF"
  | "REQUESTING"
  | "ON_CONFIRMED"
  | "DENIED"
  | "UNSUPPORTED";

// =============================================================================
// DATOS DE CÁMARA
// =============================================================================

export interface CameraStatus {
  ready: boolean;
  error: string | null;
  videoWidth: number;
  videoHeight: number;
  fpsTarget: number;
  fpsMeasured: number;
  facingMode: "environment" | "user" | "unknown";
  deviceId: string | null;
  label: string;
}

export interface TorchStatus {
  state: TorchState;
  available: boolean;
  lastError: string | null;
  watchdogActive: boolean;
}

// =============================================================================
// FRAMES Y MUESTRAS ÓPTICAS
// =============================================================================

export interface RealFrame {
  id: number;
  timestampMs: number;
  videoTime?: number;
  imageData: ImageData;
  fpsInstant: number;
  fpsMedian: number;
  jitterMs: number;
  acquisitionMethod: "requestVideoFrameCallback" | "requestAnimationFrame" | "intervalFallback";
  fpsQuality: number;
}

export interface RgbSample {
  r: number;  // 0-1 linear
  g: number;
  b: number;
  timestampMs: number;
  frameId: number;
}

export interface OpticalDensity {
  r: number;
  g: number;
  b: number;
  timestampMs: number;
}

export interface PpgSample {
  timestampMs: number;
  frameId: number;
  
  // Canales raw
  raw: {
    r: number;
    g: number;
    b: number;
  };
  
  // Canales lineales
  linear: {
    r: number;
    g: number;
    b: number;
  };
  
  // Optical Density
  od: {
    r: number;
    g: number;
    b: number;
  };
  
  // Canales procesados
  g1: number;  // Raw green
  g2: number;  // Detrended OD green
  g3: number;  // Filtered OD green
  
  // Señales alternativas
  chrom?: number;
  pos?: number;
}

// =============================================================================
// ROI Y EVIDENCIA ÓPTICA
// =============================================================================

export interface RoiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RoiEvidence {
  rect: RoiRect;
  state: RoiState;
  
  // Métricas de píxeles
  validPixelRatio: number;
  saturationRatio: number;
  darkRatio: number;
  
  // Estadísticas de color
  meanR: number;
  meanG: number;
  meanB: number;
  redDominance: number;
  
  // Calidad temporal
  temporalVariance: number;
  perfusionProxy: number;
  motionProxy: number;
  
  // Espectro
  spectralPeakHz: number | null;
  spectralPeakRatio: number | null;
  
  // Score compuesto
  roiScore: number;
  
  // Razones de rechazo
  reasons: string[];
}

// =============================================================================
// SEÑAL Y FILTRADO
// =============================================================================

export interface SignalQuality {
  sqiOverall: number;
  sqiTemporal: number;
  sqiSpectral: number;
  sqiMorphology: number;
  sqiPerfusion: number;
  sqiMotion: number;
  sqiSaturation: number;
  sqiFps: number;
  
  // Métricas específicas
  perfusionIndex: number;
  signalToNoiseRatio: number;
  spectralPeakHz: number | null;
  spectralPeakRatio: number | null;
  
  // Estado
  sufficientBuffer: boolean;
  reasons: string[];
}

export interface Beat {
  t: number;
  peakT: number;
  peakValue: number;
  amplitude: number;
  prominence: number;
  confidence: number;
  onsetT?: number | null;
  troughT?: number | null;
  rejectionReason?: string;
  rrMs?: number;
}

export interface BeatDetectionResult {
  // Beats aceptados y rechazados
  beats: Beat[];
  withheldBeats?: Beat[];
  rejectedCandidates?: number;
  
  // BPM estimados
  bpm: number | null;
  peakBpm?: number | null;
  medianIbiBpm?: number | null;
  fftBpm?: number | null;
  autocorrBpm?: number | null;
  bpmTimeDomain?: number | null;
  bpmFrequencyDomain?: number | null;
  
  // Métricas de calidad
  confidence: number;
  bpmConfidence?: number;
  estimatorAgreementBpm?: number;
  rrConsistency?: number;
  
  // Intervalos RR
  rrIntervals?: number[];
  rrIntervalsMs?: number[];
  ibiStdMs?: number;
  
  // Flags
  irregularityFlag?: boolean;
  
  // Metadata
  sampleRateHz?: number;
  publicationException?: string;
}

// =============================================================================
// PUBLICACIÓN Y GATE
// =============================================================================

export interface PublicationGate {
  canPublishBpm: boolean;
  canPublishSpo2: boolean;
  publishedBpm: number | null;
  publishedSpo2: number | null;
  bpmConfidence: number;
  spo2Confidence: number;
  blockReasons: string[];
  currentStatus: PpgEngineState;
}

export interface Spo2Calibration {
  badge: "calibrated" | "partial" | "uncalibrated";
  coefficientA: number | null;  // null = no calibrado
  coefficientB: number | null;
  deviceModel: string | null;
}

export interface PublishedMeasurement {
  bpm: number | null;
  spo2: number | null;
  waveform: number[];  // G3 values for display
  beatMarkers: Beat[];
  quality: SignalQuality;
  timestamp: number;
  isValid: boolean;
}

// =============================================================================
// CONFIGURACIÓN
// =============================================================================

export interface PpgConfig {
  // Cámara
  targetResolution: { width: number; height: number };
  minAcceptableResolution: { width: number; height: number };
  targetFps: number;
  minAcceptableFps: number;
  
  // ROI
  roiGridSize: number;
  minValidPixelRatio: number;
  maxSaturationRatio: number;
  maxDarkRatio: number;
  
  // Señal
  bufferDurationMs: number;
  warmupDurationMs: number;
  bandpassLowHz: number;
  bandpassHighHz: number;
  
  // Beat detection
  refractoryPeriodMs: number;
  minRRIntervalMs: number;
  maxRRIntervalMs: number;
  
  // Publication gate
  minSqiForPublication: number;
  minBufferDurationForBpmMs: number;
  minBeatsForPublication: number;
  maxBpmDeviationForPublication: number;
}

export const DEFAULT_PPG_CONFIG: PpgConfig = {
  targetResolution: { width: 1920, height: 1080 },
  minAcceptableResolution: { width: 1280, height: 720 },
  targetFps: 60,
  minAcceptableFps: 18,
  
  roiGridSize: 8,
  minValidPixelRatio: 0.70,
  maxSaturationRatio: 0.45,
  maxDarkRatio: 0.40,
  
  bufferDurationMs: 20000,  // 20 segundos
  warmupDurationMs: 8000,   // 8 segundos
  bandpassLowHz: 0.7,
  bandpassHighHz: 4.0,
  
  refractoryPeriodMs: 280,
  minRRIntervalMs: 300,
  maxRRIntervalMs: 2000,
  
  minSqiForPublication: 0.65,
  minBufferDurationForBpmMs: 8000,
  minBeatsForPublication: 5,
  maxBpmDeviationForPublication: 8,
};

// =============================================================================
// UTILIDADES DE TIPO
// =============================================================================

export function createEmptySignalQuality(): SignalQuality {
  return {
    sqiOverall: 0,
    sqiTemporal: 0,
    sqiSpectral: 0,
    sqiMorphology: 0,
    sqiPerfusion: 0,
    sqiMotion: 0,
    sqiSaturation: 0,
    sqiFps: 0,
    perfusionIndex: 0,
    signalToNoiseRatio: 0,
    spectralPeakHz: null,
    spectralPeakRatio: null,
    sufficientBuffer: false,
    reasons: ["NO_DATA"],
  };
}

export function createEmptyBeatDetection(): BeatDetectionResult {
  return {
    beats: [],
    withheldBeats: [],
    rejectedCandidates: 0,
    bpm: null,
    peakBpm: null,
    medianIbiBpm: null,
    fftBpm: null,
    autocorrBpm: null,
    confidence: 0,
    estimatorAgreementBpm: 999,
    rrIntervals: [],
    irregularityFlag: false,
    sampleRateHz: 30,
    publicationException: "NO_BEATS_DETECTED",
  };
}

export function createEmptyRoiEvidence(): RoiEvidence {
  return {
    rect: { x: 0, y: 0, width: 0, height: 0 },
    state: "NO_PPG_SIGNAL",
    validPixelRatio: 0,
    saturationRatio: 0,
    darkRatio: 0,
    meanR: 0,
    meanG: 0,
    meanB: 0,
    redDominance: 0,
    temporalVariance: 0,
    perfusionProxy: 0,
    motionProxy: 0,
    spectralPeakHz: null,
    spectralPeakRatio: null,
    roiScore: 0,
    reasons: ["INITIALIZING"],
  };
}
