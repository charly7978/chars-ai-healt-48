import { HeartBeatProcessor } from '../modules/HeartBeatProcessor';

export interface ProcessedSignal {
  timestamp: number;
  rawValue: number;
  filteredValue: number;
  quality: number;
  fingerDetected: boolean;
  roi: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  perfusionIndex?: number;
  /** Muestras RGB ROI sin preprocesado asimétrico (SpO2 multicanal) */
  rgbRaw?: { r: number; g: number; b: number };
  /** Confianza dedo tras histéresis temporal [0,1] */
  fingerConfidence?: number;
  /** SNR estimado (dB) en ventana corta */
  snrEstimateDb?: number;
  // CAMPOS OPTIMIZADOS - Sistema ZeroPhase+WEPD+RGBFusion
  /** Calidad de fusión multi-canal RGB (0-100) */
  fusionQuality?: number;
  /** Pesos de canales RGB usados en fusión */
  channelWeights?: { r: number; g: number; b: number };
  /** Estimación proxy de SpO2 (70-100%) */
  spo2Proxy?: number;
  /** Flag de detección de artefacto de movimiento */
  isMotionArtifact?: boolean;
  /** Flag de detección de pico (WEPD) */
  peakDetected?: boolean;
  /** Confianza de detección de pico (0-1) */
  peakConfidence?: number;
}

export interface ProcessingError {
  code: string;
  message: string;
  timestamp: number;
}

export interface SignalProcessor {
  initialize: () => Promise<void>;
  start: () => void;
  stop: () => void;
  calibrate: () => Promise<boolean>;
  onSignalReady?: (signal: ProcessedSignal) => void;
  onError?: (error: ProcessingError) => void;
}

declare global {
  interface Window {
    heartBeatProcessor: HeartBeatProcessor;
  }
}
