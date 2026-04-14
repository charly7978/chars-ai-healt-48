/**
 * @file index.ts
 * @description Exportación centralizada de módulos de procesamiento de señales PPG
 */

// Filtros avanzados
export { ZeroPhaseButterworthFilter } from './ZeroPhaseButterworthFilter';
export type { FilterCoefficients } from './ZeroPhaseButterworthFilter';

// Detectores de picos
export { WEPDPeakDetector } from './WEPDPeakDetector';
export type { PeakDetectionResult, WEPDConfig } from './WEPDPeakDetector';

// Procesamiento multi-canal
export { MultiChannelRGBFusion } from './MultiChannelRGBFusion';
export type { RGBChannels, ChannelAnalysis, FusedPPGResult } from './MultiChannelRGBFusion';

// ROI inteligente
export { SmartEllipseROI } from './SmartEllipseROI';
export type { Point2D, EllipseFit, SmartROI, GridCell } from './SmartEllipseROI';

// Detección CNN
export { FingerCNNDetector } from './FingerCNNDetector';
export type { CNNInput, CNNOutput, SkinToneConfig } from './FingerCNNDetector';

// Filtros legacy (mantenidos por compatibilidad)
export { KalmanFilter } from './KalmanFilter';
export { SavitzkyGolayFilter } from './SavitzkyGolayFilter';
export { ACCouplingFilter } from './ACCouplingFilter';
export { CardiacBandpassFilter } from './CardiacBandpassFilter';

// Detectores y procesadores existentes
export { HumanFingerDetector } from './HumanFingerDetector';
export type { HumanFingerValidation } from './HumanFingerDetector';
export { FrameProcessor } from './FrameProcessor';
export { SignalAnalyzer } from './SignalAnalyzer';
export type { SignalAnalyzerConfig } from './SignalAnalyzer';
export { PPGSignalProcessor } from './PPGSignalProcessor';

// Tipos
export type { 
  SignalProcessorConfig, 
  CalibrationValues, 
  DetectorScores, 
  DetectionResult,
  FrameData
} from './types';
