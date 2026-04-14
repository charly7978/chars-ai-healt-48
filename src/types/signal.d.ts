import type { ContactState } from '../modules/signal-processing/PPGSignalProcessor';
import type { SourceType } from '../modules/signal-processing/SignalSourceRanker';
import type { HeartBeatProcessor } from '../modules/HeartBeatProcessor';

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
  /** Contexto opcional para HeartBeatProcessor (PPG V2) */
  contactState?: ContactState;
  pressureState?: string;
  activeSource?: SourceType;
  clipHighRatio?: number;
  clipLowRatio?: number;
  maskStability?: number;
  /** 0–100 derivado de inestabilidad ROI / movimiento relativo */
  motionArtifact?: number;
  positionDrifting?: boolean;
  sqiGlobal?: number;
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
