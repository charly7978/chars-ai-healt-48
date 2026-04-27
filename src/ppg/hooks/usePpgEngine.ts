/**
 * usePpgEngine.ts
 * ----------------------------------------------------------------------------
 * Hook principal del motor PPG.
 * 
 * Responsabilidades:
 * - Orquestar cámara (PpgCameraController)
 * - Capturar frames (FrameSampler)
 * - Detectar ROI (RoiScanner + RoiTracker)
 * - Extraer señal (PpgExtractor)
 * - Detectar beats (BeatDetector - módulo existente)
 * - Calcular SQI (SignalQualityIndex)
 * - Gate de publicación (PublicationGate)
 * - Exponer estado para UI
 * 
 * Principio: La UI no calcula nada. Solo recibe estado.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type {
  PpgEngineState as PpgState,
  CameraStatus,
  TorchStatus,
  RoiEvidence,
  PpgSample,
  SignalQuality,
  BeatDetectionResult,
  PublicationGate,
  Spo2Calibration,
} from "../signal/PpgTypes";
import {
  createEmptySignalQuality,
  createEmptyBeatDetection,
} from "../signal/PpgTypes";

import { PpgCameraController, type CameraCallbacks } from "../camera/PpgCameraController";
import { FrameSampler } from "../camera/FrameSampler";

import { RoiScanner, RoiTracker } from "../roi";

import { PpgExtractor } from "../signal/PpgExtractor";
import { PublicationGate as PublicationGateClass } from "../signal/PublicationGate";

// Reutilizar BeatDetector existente si está disponible
// Por ahora, importamos el tipo y usaremos el existente
import { BeatDetector } from "../signal/BeatDetector";

export interface PpgEngineState {
  // Estados principales
  engineState: PpgState;
  cameraStatus: CameraStatus;
  torchStatus: TorchStatus;
  
  // ROI
  roi: RoiEvidence | null;
  
  // Señal
  samples: PpgSample[];
  g1: number | null;  // Raw green
  g2: number | null;  // Detrended OD green
  g3: number | null;  // Filtered (display)
  waveform: number[]; // Historial G3 para graficar
  
  // Análisis
  beats: BeatDetectionResult;
  quality: SignalQuality;
  publication: PublicationGate;
  
  // Configuración
  spo2Calibration: Spo2Calibration;
  
  // Debug
  debug: {
    fps: number;
    bufferSize: number;
    lastFrameId: number;
    processingTimeMs: number;
  };
}

interface UsePpgEngineReturn {
  // Referencias
  videoRef: RefObject<HTMLVideoElement>;
  
  // Acciones
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
  
  // Estado completo
  state: PpgEngineState;
}

const DEFAULT_SPO2_CALIBRATION: Spo2Calibration = {
  badge: "uncalibrated",
  coefficientA: null,
  coefficientB: null,
  deviceModel: null,
};

export function usePpgEngine(): UsePpgEngineReturn {
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraControllerRef = useRef<PpgCameraController | null>(null);
  const frameSamplerRef = useRef<FrameSampler | null>(null);
  const roiScannerRef = useRef<RoiScanner | null>(null);
  const roiTrackerRef = useRef<RoiTracker | null>(null);
  const extractorRef = useRef<PpgExtractor | null>(null);
  const beatDetectorRef = useRef<BeatDetector | null>(null);
  const publicationGateRef = useRef<PublicationGateClass | null>(null);

  // Estado
  const [engineState, setEngineState] = useState<PpgState>("idle");
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>({
    ready: false,
    error: null,
    videoWidth: 0,
    videoHeight: 0,
    fpsTarget: 30,
    fpsMeasured: 0,
    facingMode: "unknown",
    deviceId: null,
    label: "",
  });
  const [torchStatus, setTorchStatus] = useState<TorchStatus>({
    state: "OFF",
    available: false,
    lastError: null,
    watchdogActive: false,
  });
  const [roi, setRoi] = useState<RoiEvidence | null>(null);
  const [samples, setSamples] = useState<PpgSample[]>([]);
  const [g1, setG1] = useState<number | null>(null);
  const [g2, setG2] = useState<number | null>(null);
  const [g3, setG3] = useState<number | null>(null);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [beats, setBeats] = useState<BeatDetectionResult>(createEmptyBeatDetection());
  const [quality, setQuality] = useState<SignalQuality>(createEmptySignalQuality());
  const [publication, setPublication] = useState<PublicationGate>({
    canPublishBpm: false,
    canPublishSpo2: false,
    publishedBpm: null,
    publishedSpo2: null,
    bpmConfidence: 0,
    spo2Confidence: 0,
    blockReasons: [],
    currentStatus: "no_ppg_signal",
  });
  const [debug, setDebug] = useState({
    fps: 0,
    bufferSize: 0,
    lastFrameId: 0,
    processingTimeMs: 0,
  });

  // Inicializar controladores
  useEffect(() => {
    cameraControllerRef.current = new PpgCameraController();
    roiScannerRef.current = new RoiScanner();
    roiTrackerRef.current = new RoiTracker();
    extractorRef.current = new PpgExtractor(30, 20);
    beatDetectorRef.current = new BeatDetector();
    publicationGateRef.current = new PublicationGateClass();

    return () => {
      cameraControllerRef.current?.destroy();
    };
  }, []);

  // Callback de procesamiento de frame
  const processFrame = useCallback((frame: import("../signal/PpgTypes").RealFrame) => {
    const startTime = performance.now();

    // 1. Escanear ROI
    const scanner = roiScannerRef.current;
    const tracker = roiTrackerRef.current;
    const extractor = extractorRef.current;
    const beatDetector = beatDetectorRef.current;
    const gate = publicationGateRef.current;

    if (!scanner || !tracker || !extractor || !beatDetector || !gate) return;

    // Escanear candidatos
    const candidates = scanner.scan(frame.imageData, tracker.getCurrentRoi());
    scanner.updateHistory(frame.timestampMs, { r: 0, g: 0, b: 0 });  // Se actualiza con datos reales en extractor

    // Trackear ROI
    const roiEvidence = tracker.update(candidates, frame.timestampMs);
    setRoi(roiEvidence);

    // 2. Extraer señal PPG
    const result = extractor.processFrame(frame, roiEvidence);
    
    if (result) {
      setG1(result.sample.g1);
      setG2(result.sample.g2);
      setG3(result.sample.g3);
      
      // Actualizar waveform (últimos 300 puntos = ~10s a 30fps)
      const newWaveform = [...waveform, result.sample.g3].slice(-300);
      setWaveform(newWaveform);
    }

    // 3. Detectar beats
    const recentSamples = extractor.getHistory(8);  // Últimos 8 segundos
    if (recentSamples.length >= 30) {  // Mínimo 1 segundo
      // Adaptar al formato esperado por BeatDetector existente
    const timeSamples = recentSamples.map(s => ({ 
      t: s.timestampMs, 
      value: s.g3 
    }));
    const beatResult = beatDetector.detect(timeSamples);
    setBeats(beatResult as BeatDetectionResult);
    }

    // 4. Calcular SQI (simplificado)
    const signalQuality: SignalQuality = {
      sqiOverall: result?.quality.valid ? 0.7 : 0.3,
      sqiTemporal: result?.quality.perfusionIndex ?? 0,
      sqiSpectral: 0,  // Se calcularía con FFT
      sqiMorphology: beats.bpmConfidence,
      sqiPerfusion: result?.quality.perfusionIndex ?? 0,
      sqiMotion: 0,  // Se calcularía con diferencia de frames
      sqiSaturation: 1 - (roiEvidence.saturationRatio ?? 0),
      sqiFps: frame.fpsQuality / 100,
      perfusionIndex: result?.quality.perfusionIndex ?? 0,
      signalToNoiseRatio: result?.quality.signalToNoiseRatio ?? 0,
      spectralPeakHz: null,  // Se calcularía con análisis espectral
      spectralPeakRatio: null,
      sufficientBuffer: recentSamples.length >= 30 * 8,  // 8 segundos a 30fps
      reasons: result?.quality.valid ? [] : ["QUALITY_BELOW_THRESHOLD"],
    };
    setQuality(signalQuality);

    // 5. Evaluar gate de publicación
    gate.evaluate({
      bufferDurationSeconds: recentSamples.length / 30,
      fps: frame.fpsMedian,
      roi: roiEvidence,
      signalQuality,
      beats: beatResult as BeatDetectionResult ?? createEmptyBeatDetection(),
      spo2Calibration: DEFAULT_SPO2_CALIBRATION,
    });

    setPublication({
      canPublishBpm: gate.canPublishBpm,
      canPublishSpo2: gate.canPublishSpo2,
      publishedBpm: gate.publishedBpm,
      publishedSpo2: gate.publishedSpo2,
      bpmConfidence: gate.bpmConfidence,
      spo2Confidence: gate.spo2Confidence,
      blockReasons: gate.blockReasons,
      currentStatus: gate.currentStatus,
    });

    setEngineState(gate.currentStatus);

    // Debug
    setDebug({
      fps: frame.fpsMedian,
      bufferSize: recentSamples.length,
      lastFrameId: frame.id,
      processingTimeMs: performance.now() - startTime,
    });
  }, [waveform]);

  // Start measurement
  const start = useCallback(async () => {
    const video = videoRef.current;
    if (!video) {
      console.error("[usePpgEngine] videoRef is null");
      return;
    }

    setEngineState("requesting_camera");

    const callbacks: CameraCallbacks = {
      onStatusChange: (camStatus, torchStat) => {
        setCameraStatus(camStatus);
        setTorchStatus(torchStat);
      },
      onError: (error, fatal) => {
        console.error("[usePpgEngine] Camera error:", error, "fatal:", fatal);
        if (fatal) {
          setEngineState("error");
        }
      },
      onFrame: (video) => {
        // FrameSampler se encarga de capturar frames
      },
    };

    const controller = cameraControllerRef.current;
    if (!controller) return;

    const started = await controller.start(video, callbacks);
    
    if (started) {
      setEngineState("measuring");
      
      // Iniciar FrameSampler
      const sampler = new FrameSampler(640);
      frameSamplerRef.current = sampler;
      
      sampler.start(video, (frame) => {
        processFrame(frame);
      });
    } else {
      setEngineState("error");
    }
  }, [processFrame]);

  // Stop measurement
  const stop = useCallback(() => {
    frameSamplerRef.current?.stop();
    cameraControllerRef.current?.stop();
    
    setEngineState("idle");
    roiTrackerRef.current?.reset();
    extractorRef.current?.reset();
    beatDetectorRef.current?.reset();
    publicationGateRef.current?.reset();
  }, []);

  // Reset
  const reset = useCallback(() => {
    stop();
    setRoi(null);
    setSamples([]);
    setG1(null);
    setG2(null);
    setG3(null);
    setWaveform([]);
    setBeats(createEmptyBeatDetection());
    setQuality(createEmptySignalQuality());
    setPublication({
      canPublishBpm: false,
      canPublishSpo2: false,
      publishedBpm: null,
      publishedSpo2: null,
      bpmConfidence: 0,
      spo2Confidence: 0,
      blockReasons: [],
      currentStatus: "no_ppg_signal",
    });
  }, [stop]);

  return {
    videoRef,
    start,
    stop,
    reset,
    state: {
      engineState,
      cameraStatus,
      torchStatus,
      roi,
      samples,
      g1,
      g2,
      g3,
      waveform,
      beats,
      quality,
      publication,
      spo2Calibration: DEFAULT_SPO2_CALIBRATION,
      debug,
    },
  };
}
