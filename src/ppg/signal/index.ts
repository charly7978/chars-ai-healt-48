/**
 * Señal PPG
 * ----------------------------------------------------------------------------
 * Procesamiento de señal, detección de beats y quality index.
 */

export {
  PpgExtractor,
  type ExtractionResult,
} from "./PpgExtractor";

export {
  PublicationGate,
  type GateInput,
} from "./PublicationGate";

export {
  BeatDetector,
  type Beat,
  type BeatMorphology,
  type BeatDetectionResult,
  type BeatRejectionReason,
} from "./BeatDetector";

export type {
  TimeSample,
} from "./PPGFilters";

// PPGFilters exporta funciones individuales, re-exportar según sea necesario

export type {
  PpgEngineState,
  CameraStatus,
  TorchStatus,
  RealFrame,
  RgbSample,
  OpticalDensity,
  PpgSample,
  RoiRect,
  RoiEvidence,
  RoiState,
  SignalQuality,
  PublicationGate as IPublicationGate,
  Spo2Calibration,
  PublishedMeasurement,
  PpgConfig,
  Beat as BeatType,
} from "./PpgTypes";

export {
  DEFAULT_PPG_CONFIG,
  createEmptySignalQuality,
  createEmptyBeatDetection,
  createEmptyRoiEvidence,
} from "./PpgTypes";
