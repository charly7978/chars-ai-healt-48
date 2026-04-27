/**
 * PPG Module
 * ----------------------------------------------------------------------------
 * Pipeline completo de fotopletismografía.
 * 
 * Arquitectura:
 *   camera/    → Captura de frames (cámara + torch + sampler)
 *   radiometry/ → Procesamiento de intensidad (sRGB → OD)
 *   roi/       → Detección de región de interés
 *   signal/    → Extracción PPG, beats, quality, gate
 *   hooks/     → usePpgEngine hook principal
 *   ui/        → Componentes visuales
 */

// Cámara
export {
  PpgCameraController,
  TorchController,
  FrameSampler,
  type CameraCallbacks,
  type CameraConfig,
} from "./camera";

// Radiometría
export {
  processImageData,
  srgbToLinear,
  calculateOD,
  calculateDCBaseline,
  calculatePerfusionIndex,
  DCBaselineTracker,
  type Rgb8,
  type RgbLinear,
  type OpticalDensity,
} from "./radiometry";

// ROI
export {
  RoiScanner,
  RoiTracker,
  determineRoiState,
  type RoiCandidate,
} from "./roi";

// Señal y procesamiento
export {
  PpgExtractor,
  PublicationGate,
  BeatDetector,
  type ExtractionResult,
  type GateInput,
  type TimeSample,
} from "./signal";

// Tipos fundamentales
export type {
  PpgEngineState,
  CameraStatus,
  TorchStatus,
  RealFrame,
  PpgSample,
  RoiRect,
  RoiEvidence,
  RoiState,
  SignalQuality,
  Beat,
  BeatDetectionResult,
  Spo2Calibration,
  PublicationGate as IPublicationGate,
  PpgConfig,
} from "./signal/PpgTypes";

export {
  DEFAULT_PPG_CONFIG,
  createEmptySignalQuality,
  createEmptyBeatDetection,
  createEmptyRoiEvidence,
} from "./signal/PpgTypes";

// Hook principal
export { usePpgEngine, type PpgEngineState as EngineState } from "./hooks/usePpgEngine";

// UI
export {
  CardiacMonitorCanvas,
  FloatingVitalsOverlay,
} from "./ui";
