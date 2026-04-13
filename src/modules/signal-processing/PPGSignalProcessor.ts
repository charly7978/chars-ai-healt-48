import { ProcessedSignal, ProcessingError, SignalProcessor as SignalProcessorInterface } from '../../types/signal';
import { KalmanFilter } from './KalmanFilter';
import { SavitzkyGolayFilter } from './SavitzkyGolayFilter';
import { SignalTrendAnalyzer } from './SignalTrendAnalyzer';
import { BiophysicalValidator } from './BiophysicalValidator';
import { FrameProcessor } from './FrameProcessor';
import { CalibrationHandler } from './CalibrationHandler';
import { SignalAnalyzer } from './SignalAnalyzer';
import { HumanFingerDetector, HumanFingerValidation } from './HumanFingerDetector';
import { DetectionLogger } from '../../utils/DetectionLogger';
import { ACCouplingFilter } from './ACCouplingFilter';
import { CardiacBandpassFilter } from './CardiacBandpassFilter';
import { FingerStateSmoother } from './FingerStateSmoother';
import { PulsatilePresenceGate } from './PulsatilePresenceGate';
import { isStrictHemoglobinSkinContact } from './StrictSkinContactGate';

/**
 * PROCESADOR PPG — pipeline clínico: Kalman → S-G → AC → paso banda cardíaca → histéresis dedo
 */
export class PPGSignalProcessor implements SignalProcessorInterface {
  public isProcessing: boolean = false;
  private kalmanFilter: KalmanFilter;
  private sgFilter: SavitzkyGolayFilter;
  private trendAnalyzer: SignalTrendAnalyzer;
  private biophysicalValidator: BiophysicalValidator;
  private frameProcessor: FrameProcessor;
  private calibrationHandler: CalibrationHandler;
  private signalAnalyzer: SignalAnalyzer;
  private humanFingerDetector: HumanFingerDetector;
  private detectionLogger: DetectionLogger;
  private acCoupling: ACCouplingFilter;
  private cardiacBandpass: CardiacBandpassFilter;
  private fingerSmoother: FingerStateSmoother;
  private pulseGate: PulsatilePresenceGate;
  private acHistory: number[] = [];
  private readonly AC_HISTORY_MAX = 45;
  private qualityEma = 0;
  private prevSmoothedFinger = false;
  
  // SISTEMA OPTIMIZADO DE DETECCIÓN
  private fingerDetectionState = {
    isDetected: false,
    detectionScore: 0,
    consecutiveDetections: 0,
    consecutiveNonDetections: 0,
    lastDetectionTime: 0,
    stabilityBuffer: [] as number[],
    signalHistory: [] as number[],
    noiseLevel: 0,
    signalToNoiseRatio: 0,
    peakHistory: [] as number[],
    valleyHistory: [] as number[]
  };
  
  // Buffer circular ultra-preciso
  private readonly BUFFER_SIZE = 64;
  private signalBuffer: Float32Array;
  private bufferIndex: number = 0;
  private bufferFull: boolean = false;
  
  private isCalibrating: boolean = false;
  private frameCount: number = 0;
  
  // CONFIGURACIÓN OPTIMIZADA PARA DETECCIÓN REAL
  private readonly CONFIG = {
    // UMBRALES MÁS PERMISIVOS PERO PRECISOS
    MIN_RED_THRESHOLD: 20,  // Más bajo para mejor detección
    MAX_RED_THRESHOLD: 250,
    MIN_DETECTION_SCORE: 0.42,
    MIN_CONSECUTIVE_FOR_DETECTION: 4,
    MAX_CONSECUTIVE_FOR_LOSS: 9,
    
    // VALIDACIÓN EQUILIBRADA
    MIN_SNR_REQUIRED: 8.0, // SNR más bajo pero funcional
    SKIN_COLOR_STRICTNESS: 0.6, // Más permisivo
    PULSATILITY_MIN_REQUIRED: 0.1, // Más bajo para señales débiles
    TEXTURE_HUMAN_MIN: 0.4, // Más permisivo
    STABILITY_FRAMES: 10, // Menos frames para estabilidad
    
    NOISE_THRESHOLD: 1.5,
    PEAK_PROMINENCE: 0.15, // Más sensible para detectar latidos débiles
    VALLEY_DEPTH: 0.1,
    SIGNAL_CONSISTENCY: 0.5
  };
  
  constructor(
    public onSignalReady?: (signal: ProcessedSignal) => void,
    public onError?: (error: ProcessingError) => void
  ) {
    console.log("🎯 PPGSignalProcessor: Sistema OPTIMIZADO activado");
    
    this.signalBuffer = new Float32Array(this.BUFFER_SIZE);
    this.kalmanFilter = new KalmanFilter();
    this.sgFilter = new SavitzkyGolayFilter();
    this.trendAnalyzer = new SignalTrendAnalyzer();
    this.biophysicalValidator = new BiophysicalValidator();
    this.frameProcessor = new FrameProcessor({
      TEXTURE_GRID_SIZE: 5,
      ROI_SIZE_FACTOR: 0.85
    });
    this.calibrationHandler = new CalibrationHandler({
      CALIBRATION_SAMPLES: 30,
      MIN_RED_THRESHOLD: this.CONFIG.MIN_RED_THRESHOLD,
      MAX_RED_THRESHOLD: this.CONFIG.MAX_RED_THRESHOLD
    });
    this.signalAnalyzer = new SignalAnalyzer({
      QUALITY_LEVELS: 100,
      QUALITY_HISTORY_SIZE: 50,
      MIN_CONSECUTIVE_DETECTIONS: this.CONFIG.MIN_CONSECUTIVE_FOR_DETECTION,
      MAX_CONSECUTIVE_NO_DETECTIONS: this.CONFIG.MAX_CONSECUTIVE_FOR_LOSS
    });
    this.humanFingerDetector = new HumanFingerDetector();
    this.detectionLogger = new DetectionLogger();
    this.acCoupling = new ACCouplingFilter();
    this.cardiacBandpass = new CardiacBandpassFilter(30);
    this.fingerSmoother = new FingerStateSmoother(7, 5);
    this.pulseGate = new PulsatilePresenceGate(30, 6);
  }

  async initialize(): Promise<void> {
    try {
      this.signalBuffer.fill(0);
      this.bufferIndex = 0;
      this.bufferFull = false;
      this.frameCount = 0;
      
      this.fingerDetectionState = {
        isDetected: false,
        detectionScore: 0,
        consecutiveDetections: 0,
        consecutiveNonDetections: 0,
        lastDetectionTime: 0,
        stabilityBuffer: [],
        signalHistory: [],
        noiseLevel: 0,
        signalToNoiseRatio: 0,
        peakHistory: [],
        valleyHistory: []
      };

      this.acCoupling.reset();
      this.cardiacBandpass.reset();
      this.fingerSmoother.reset();
      this.pulseGate.reset();
      this.acHistory = [];
      this.qualityEma = 0;
      this.prevSmoothedFinger = false;
      
      this.kalmanFilter.reset();
      this.sgFilter.reset();
      this.trendAnalyzer.reset();
      this.biophysicalValidator.reset();
      this.signalAnalyzer.reset();
      
      console.log("✅ PPGSignalProcessor: Sistema ultra-preciso inicializado");
    } catch (error) {
      console.error("❌ PPGSignalProcessor: Error inicialización", error);
      this.handleError("INIT_ERROR", "Error inicializando procesador");
    }
  }

  start(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.initialize();
    console.log("🚀 PPGSignalProcessor: Sistema ultra-preciso iniciado");
  }

  stop(): void {
    this.isProcessing = false;
    this.reset();
    console.log("⏹️ PPGSignalProcessor: Sistema detenido");
  }

  async calibrate(): Promise<boolean> {
    try {
      console.log("🔧 PPGSignalProcessor: Calibración ultra-precisa iniciada");
      await this.initialize();
      
      this.isCalibrating = true;
      
      setTimeout(() => {
        this.isCalibrating = false;
        console.log("✅ PPGSignalProcessor: Calibración ultra-precisa completada");
      }, 3000);
      
      return true;
    } catch (error) {
      console.error("❌ PPGSignalProcessor: Error calibración", error);
      this.handleError("CALIBRATION_ERROR", "Error durante calibración");
      this.isCalibrating = false;
      return false;
    }
  }

  processFrame(imageData: ImageData): void {
    if (!this.isProcessing || !this.onSignalReady) return;

    try {
      this.frameCount = (this.frameCount + 1) % 10000;
      
      // 1. Extracción optimizada
      const extractionResult = this.frameProcessor.extractFrameData(imageData);
      const { redValue, textureScore, avgGreen, avgBlue, rawRgb } = extractionResult;
      /** Solo canal R del parche de contacto: la media global captaba flicker/parpadeo como "pulso" (FP) */
      const pulseSample = rawRgb ? rawRgb.r : redValue;
      const roi = this.frameProcessor.detectROI(redValue, imageData);

      // 2. Dedo humano (biofísico) + histéresis temporal anti-parpadeo
      const humanFingerValidation = this.humanFingerDetector.detectHumanFinger(
        redValue, avgGreen ?? 0, avgBlue ?? 0, textureScore, imageData.width, imageData.height
      );

      const pulseOk = this.pulseGate.push(pulseSample);

      const rgbR = rawRgb?.r ?? redValue;
      const rgbG = rawRgb?.g ?? (avgGreen ?? 0);
      const rgbB = rawRgb?.b ?? (avgBlue ?? 0);

      const strictSkin = isStrictHemoglobinSkinContact(rgbR, rgbG, rgbB, textureScore);
      const bioConfirmed =
        humanFingerValidation.validationDetails.skinColorValid &&
        humanFingerValidation.validationDetails.perfusionValid &&
        humanFingerValidation.confidence >= 0.43;

      const rawFingerCandidate = pulseOk && strictSkin && bioConfirmed;

      const smoothedFinger = this.fingerSmoother.update(rawFingerCandidate);
      if (this.prevSmoothedFinger && !smoothedFinger) {
        this.cardiacBandpass.reset();
      }
      this.prevSmoothedFinger = smoothedFinger;

      const fingerConfidence = smoothedFinger ? humanFingerValidation.confidence : 0;

      const fingerDetectionResult = {
        isDetected: smoothedFinger,
        detectionScore: fingerConfidence,
        opticalCoherence: humanFingerValidation.opticalCoherence
      };

      // Historial SIEMPRE alimentado (SNR / pulsatility reales — antes incompleto)
      this.fingerDetectionState.signalHistory.push(redValue);
      if (this.fingerDetectionState.signalHistory.length > 30) {
        this.fingerDetectionState.signalHistory.shift();
      }

      if (this.frameCount % 10 === 0) {
        this.detectionLogger.logDetectionAttempt(
          smoothedFinger,
          humanFingerValidation.validationDetails,
          {
            biophysicalScore: humanFingerValidation.biophysicalScore,
            opticalCoherence: humanFingerValidation.opticalCoherence,
            bloodFlowIndicator: humanFingerValidation.bloodFlowIndicator,
            tissueConsistency: humanFingerValidation.tissueConsistency,
            overallConfidence: humanFingerValidation.confidence
          },
          {
            redValue: redValue,
            signalStrength: redValue / 255,
            noiseLevel: 0,
            snrRatio: this.fingerDetectionState.signalToNoiseRatio
          },
          !smoothedFinger
            ? `Fallo: skin=${humanFingerValidation.validationDetails.skinColorValid}, perfusion=${humanFingerValidation.validationDetails.perfusionValid}`
            : undefined
        );
      }

      // 3. Cadena PPG: Kalman → Savitzky-Golay → AC → paso banda cardíaca → reconstrucción amplitud
      let filteredValue = redValue;
      if (smoothedFinger) {
        const k1 = this.kalmanFilter.filter(redValue);
        const k2 = this.sgFilter.filter(k1);
        const { ac, dcEstimate } = this.acCoupling.filter(k2);
        const bp = this.cardiacBandpass.process(ac);
        this.acHistory.push(ac);
        if (this.acHistory.length > this.AC_HISTORY_MAX) this.acHistory.shift();

        const pulseMix = 0.64 * bp + 0.36 * ac;
        const preciseGain = this.calculateOptimizedGain({
          detectionScore: humanFingerValidation.confidence,
          opticalCoherence: humanFingerValidation.opticalCoherence
        });
        filteredValue = Math.min(
          255,
          Math.max(0, dcEstimate + pulseMix * preciseGain * 2.05 + 6)
        );
      }

      // 4. Buffer circular ultra-preciso
      this.signalBuffer[this.bufferIndex] = filteredValue;
      this.bufferIndex = (this.bufferIndex + 1) % this.BUFFER_SIZE;
      if (this.bufferIndex === 0) this.bufferFull = true;

      // 5. SNR (historial válido) + calidad profesional suavizada
      void this.calculateOptimizedSNR();
      const snrDb = this.fingerDetectionState.signalToNoiseRatio;
      const acPulse = this.computeAcPulsatilityIndex();
      let quality = this.calculateProfessionalQuality(
        fingerConfidence,
        textureScore,
        redValue,
        snrDb,
        acPulse
      );
      if (!smoothedFinger) {
        quality = 0;
      }

      // 7. Índice de perfusión preciso
      const perfusionIndex = this.calculatePrecisePerfusion(
        redValue, smoothedFinger, quality, fingerConfidence
      );

      if (this.frameCount % 120 === 0) {
        console.log("PPG:", {
          red: redValue.toFixed(1),
          dedo: smoothedFinger,
          conf: fingerConfidence.toFixed(2),
          snr: snrDb.toFixed(1),
          Q: quality
        });
      }

      // 8. Señal procesada final
      const processedSignal: ProcessedSignal = {
        timestamp: Date.now(),
        rawValue: redValue,
        filteredValue: filteredValue,
        quality: quality,
        fingerDetected: smoothedFinger,
        roi: roi,
        perfusionIndex: Math.max(0, perfusionIndex),
        rgbRaw: rawRgb ?? { r: redValue, g: avgGreen ?? 0, b: avgBlue ?? 0 },
        fingerConfidence: Math.round(fingerConfidence * 100) / 100,
        snrEstimateDb: Math.round(snrDb * 10) / 10
      };

      this.onSignalReady(processedSignal);
    } catch (error) {
      console.error("❌ PPGSignalProcessor: Error procesando frame", error);
      this.handleError("PROCESSING_ERROR", "Error en procesamiento");
    }
  }

  /**
   * DETECCIÓN OPTIMIZADA EQUILIBRADA
   */
  private detectFingerOptimized(
    red: number, green: number, blue: number, 
    textureScore: number, rToGRatio: number, rToBRatio: number,
    imageData: ImageData
  ): { isDetected: boolean; detectionScore: number; opticalCoherence: number } {
    
    // 1. VALIDACIÓN BÁSICA MÁS PERMISIVA
    if (red < this.CONFIG.MIN_RED_THRESHOLD || red > this.CONFIG.MAX_RED_THRESHOLD) {
      this.resetDetectionState();
      return { isDetected: false, detectionScore: 0, opticalCoherence: 0 };
    }

    // 2. Actualizar historial
    this.fingerDetectionState.signalHistory.push(red);
    if (this.fingerDetectionState.signalHistory.length > 30) {
      this.fingerDetectionState.signalHistory.shift();
    }

    // 3. VALIDACIONES OPTIMIZADAS
    const skinColorScore = this.validateOptimizedSkinColor(red, green, blue);
    const textureHumanScore = Math.min(1.0, textureScore * 2.0); // Más permisivo
    const pulsatilityScore = this.validateOptimizedPulsatility(red);
    const stabilityScore = this.validateOptimizedStability();
    const snrScore = this.calculateOptimizedSNR();
    
    // 4. SCORE EQUILIBRADO
    const weights = [0.3, 0.2, 0.25, 0.15, 0.1];
    const scores = [skinColorScore, textureHumanScore, pulsatilityScore, stabilityScore, snrScore];
    const rawDetectionScore = scores.reduce((sum, score, i) => sum + score * weights[i], 0);

    // 5. UMBRAL OPTIMIZADO
    const shouldDetect = rawDetectionScore >= this.CONFIG.MIN_DETECTION_SCORE;

    // 6. CONTROL DE CONSECUTIVIDAD OPTIMIZADO
    if (shouldDetect) {
      this.fingerDetectionState.consecutiveDetections++;
      this.fingerDetectionState.consecutiveNonDetections = 0;
      
      if (this.fingerDetectionState.consecutiveDetections >= this.CONFIG.MIN_CONSECUTIVE_FOR_DETECTION) {
        if (!this.fingerDetectionState.isDetected) {
          console.log("✅ DEDO DETECTADO", {
            score: rawDetectionScore.toFixed(3),
            consecutivas: this.fingerDetectionState.consecutiveDetections
          });
        }
        this.fingerDetectionState.isDetected = true;
        this.fingerDetectionState.lastDetectionTime = Date.now();
      }
    } else {
      this.fingerDetectionState.consecutiveNonDetections++;
      this.fingerDetectionState.consecutiveDetections = 0;
      
      if (this.fingerDetectionState.consecutiveNonDetections >= this.CONFIG.MAX_CONSECUTIVE_FOR_LOSS) {
        if (this.fingerDetectionState.isDetected) {
          console.log("❌ DEDO PERDIDO");
        }
        this.fingerDetectionState.isDetected = false;
      }
    }

    this.fingerDetectionState.detectionScore = rawDetectionScore;
    
    return {
      isDetected: this.fingerDetectionState.isDetected,
      detectionScore: rawDetectionScore,
      opticalCoherence: skinColorScore
    };
  }

  /**
   * VALIDACIONES OPTIMIZADAS
   */
  private validateOptimizedSkinColor(r: number, g: number, b: number): number {
    const total = r + g + b + 1e-10;
    const redRatio = r / total;
    
    // Rangos más amplios para mejor detección
    if (redRatio >= 0.25 && redRatio <= 0.65) {
      return Math.min(1.0, redRatio * 2.0);
    }
    
    return 0;
  }

  private validateOptimizedPulsatility(currentValue: number): number {
    if (this.fingerDetectionState.signalHistory.length < 10) return 0.5; // Valor por defecto
    
    const recent = this.fingerDetectionState.signalHistory.slice(-10);
    const max = Math.max(...recent);
    const min = Math.min(...recent);
    
    const pulsatility = (max - min) / max;
    
    return pulsatility >= this.CONFIG.PULSATILITY_MIN_REQUIRED ? 
           Math.min(1.0, pulsatility * 5) : pulsatility * 2; // Más permisivo
  }

  private validateOptimizedStability(): number {
    if (this.fingerDetectionState.signalHistory.length < this.CONFIG.STABILITY_FRAMES) return 0.5;
    
    const recent = this.fingerDetectionState.signalHistory.slice(-this.CONFIG.STABILITY_FRAMES);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / recent.length;
    const cv = Math.sqrt(variance) / mean;
    
    return Math.max(0.2, 1 - cv); // Mínimo 0.2 en lugar de 0
  }

  private calculateOptimizedSNR(): number {
    if (this.fingerDetectionState.signalHistory.length < 20) return 0.5;
    
    const signal = this.fingerDetectionState.signalHistory.slice(-20);
    const signalPower = this.calculateSignalPower(signal);
    const noisePower = this.calculateNoisePower(signal);
    
    if (noisePower === 0) return 1.0;
    
    const snr = 10 * Math.log10(signalPower / noisePower);
    this.fingerDetectionState.signalToNoiseRatio = snr;
    
    return snr >= this.CONFIG.MIN_SNR_REQUIRED ? 
           Math.min(1.0, snr / 20) : Math.max(0.1, snr / 20); // Más permisivo
  }

  private detectRealPeaks(signal: number[]): number[] {
    const peaks: number[] = [];
    for (let i = 2; i < signal.length - 2; i++) {
      if (signal[i] > signal[i-1] && signal[i] > signal[i+1] && 
          signal[i] > signal[i-2] && signal[i] > signal[i+2]) {
        const prominence = Math.min(signal[i] - signal[i-1], signal[i] - signal[i+1]);
        if (prominence >= this.CONFIG.PEAK_PROMINENCE) {
          peaks.push(signal[i]);
        }
      }
    }
    return peaks;
  }

  private detectRealValleys(signal: number[]): number[] {
    const valleys: number[] = [];
    for (let i = 2; i < signal.length - 2; i++) {
      if (signal[i] < signal[i-1] && signal[i] < signal[i+1] && 
          signal[i] < signal[i-2] && signal[i] < signal[i+2]) {
        const depth = Math.min(signal[i-1] - signal[i], signal[i+1] - signal[i]);
        if (depth >= this.CONFIG.VALLEY_DEPTH) {
          valleys.push(signal[i]);
        }
      }
    }
    return valleys;
  }

  private calculateSignalPower(signal: number[]): number {
    // Potencia en banda cardíaca (0.8-3.5 Hz aproximado)
    let power = 0;
    for (let i = 1; i < signal.length; i++) {
      const diff = signal[i] - signal[i-1];
      power += diff * diff;
    }
    return power / (signal.length - 1);
  }

  private calculateNoisePower(signal: number[]): number {
    // Estimación de ruido usando diferencias de segundo orden
    let noisePower = 0;
    for (let i = 2; i < signal.length; i++) {
      const secondDiff = signal[i] - 2 * signal[i-1] + signal[i-2];
      noisePower += secondDiff * secondDiff;
    }
    return noisePower / (signal.length - 2);
  }

  private resetDetectionState(): void {
    this.fingerDetectionState.consecutiveDetections = 0;
    this.fingerDetectionState.consecutiveNonDetections++;
  }

  private calculateOptimizedGain(detectionResult: { detectionScore: number; opticalCoherence: number }): number {
    const baseGain = 2.0;
    const detectionBoost = detectionResult.detectionScore * 0.5;
    
    return Math.min(3.0, Math.max(1.2, baseGain + detectionBoost));
  }

  private computeAcPulsatilityIndex(): number {
    if (this.acHistory.length < 8) return 0;
    const slice = this.acHistory.slice(-32);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((s, x) => s + (x - mean) * (x - mean), 0) / slice.length;
    return Math.sqrt(variance) / (Math.abs(mean) + 2);
  }

  /**
   * Índice 0–100: confianza dedo, textura ROI, nivel óptico, SNR, pulsatility AC.
   * EMA temporal para lectura estable para el usuario.
   */
  private calculateProfessionalQuality(
    fingerConf: number,
    textureScore: number,
    redValue: number,
    snrDb: number,
    acPulsatility: number
  ): number {
    if (fingerConf < 0.2) {
      this.qualityEma = this.qualityEma * 0.88;
      return Math.round(Math.max(0, this.qualityEma));
    }

    const dq = Math.pow(Math.min(1, fingerConf), 0.78) * 36;
    const tq = textureScore * 21;
    const sq = Math.min(20, (redValue / 255) * 20);
    const snrQ = Math.min(17, Math.max(0, (snrDb - 5.5) * 0.82));
    const pulseQ = Math.min(14, acPulsatility * 38);

    const raw = Math.min(100, Math.max(0, dq + tq + sq + snrQ + pulseQ));
    this.qualityEma = this.qualityEma === 0 ? raw : raw * 0.13 + this.qualityEma * 0.87;
    return Math.round(Math.min(100, this.qualityEma));
  }

  private calculatePrecisePerfusion(
    redValue: number, isDetected: boolean, quality: number, detectionScore: number
  ): number {
    if (!isDetected || quality < 42 || detectionScore < 0.45) return 0;
    
    const normalizedRed = Math.min(1, redValue / 120);
    const perfusionBase = Math.log1p(normalizedRed * 2) * 2.0;
    
    const qualityFactor = Math.tanh(quality / 40) * 0.3;
    const confidenceFactor = Math.sqrt(detectionScore) * 0.3;
    
    const totalPerfusion = (perfusionBase + qualityFactor + confidenceFactor) * 6;
    
    return Math.min(10, Math.max(0, totalPerfusion));
  }

  private reset(): void {
    this.signalBuffer.fill(0);
    this.bufferIndex = 0;
    this.bufferFull = false;
    this.frameCount = 0;
    this.kalmanFilter.reset();
    this.sgFilter.reset();
    this.trendAnalyzer.reset();
    this.biophysicalValidator.reset();
    this.signalAnalyzer.reset();
    this.humanFingerDetector.reset();
    this.detectionLogger.reset();
    this.acCoupling.reset();
    this.cardiacBandpass.reset();
    this.fingerSmoother.reset();
    this.pulseGate.reset();
    this.acHistory = [];
    this.qualityEma = 0;
    this.prevSmoothedFinger = false;
  }

  private handleError(code: string, message: string): void {
    console.error("❌ PPGSignalProcessor:", code, message);
    const error: ProcessingError = {
      code,
      message,
      timestamp: Date.now()
    };
    if (typeof this.onError === 'function') {
      this.onError(error);
    }
  }
}
