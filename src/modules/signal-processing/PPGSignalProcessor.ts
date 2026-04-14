import { ProcessedSignal, ProcessingError, SignalProcessor as SignalProcessorInterface } from '../../types/signal';
import { KalmanFilter } from './KalmanFilter';
import { SavitzkyGolayFilter } from './SavitzkyGolayFilter';
import { PressureProxyEstimator, PressureEstimate } from './PressureProxyEstimator';
import { SignalQualityEstimator, SQIResult } from './SignalQualityEstimator';
import { FingerContactDetector, ContactState, ContactAnalysis } from './FingerContactDetector';
import { SignalExtractor, ExtractedSignal, SignalSource } from './SignalExtractor';

export interface PPGDiagnostics {
  contactState: ContactState;
  pressureState: string;
  activeSource: SignalSource;
  sqi: SQIResult;
  fps: number;
  processingTimeMs: number;
  coverage: number;
  clipHigh: number;
  clipLow: number;
  perfusionIndex: number;
  maskStability: number;
  validPixels: number;
  motionScore: number;
  pressureScore: number;
  snr: number;
  guidanceMessage: string;
  droppedFrames: number;
}

/**
 * PPGSignalProcessor V3 — Production-grade finger-PPG pipeline
 * Tile-based finger detection, multi-source extraction, comprehensive SQI
 */
export class PPGSignalProcessor implements SignalProcessorInterface {
  public isProcessing = false;

  // Sub-systems
  private fingerDetector = new FingerContactDetector();
  private signalExtractor = new SignalExtractor();
  private pressureEstimator = new PressureProxyEstimator();
  private sqiEstimator = new SignalQualityEstimator();
  private kalman = new KalmanFilter();
  private sgFilter = new SavitzkyGolayFilter();

  // Previous frame RGB for temporal diff
  private prevFrameRgb: { r: number; g: number; b: number } | null = null;

  // Contact state (managed by FingerContactDetector but stored here)
  private contactState: ContactState = 'NO_CONTACT';

  // Frame counting & timing
  private frameCount = 0;
  private lastFrameTime = 0;
  private fps = 0;
  private lastProcessingTime = 0;
  private droppedFrames = 0;

  // Diagnostics (exposed for debug overlay)
  public lastDiagnostics: PPGDiagnostics | null = null;

  // Source type mapping for compatibility with existing modules
  private readonly sourceTypeMap: Record<SignalSource, any> = {
    'RED_AVG': 'RED_NORM',
    'GREEN_AVG': 'GREEN_NORM',
    'BLUE_AVG': 'GREEN_NORM',
    'RED_ABSORBANCE': 'RED_ABSORBANCE',
    'GREEN_ABSORBANCE': 'GREEN_ABSORBANCE',
    'RG_RATIO': 'RG_WEIGHTED',
    'RGB_WEIGHTED': 'COMBINED',
    'TEMPORAL_DIFF': 'TEMPORAL_DIFF'
  };

  constructor(
    public onSignalReady?: (signal: ProcessedSignal) => void,
    public onError?: (error: ProcessingError) => void
  ) {
    console.log("🎯 PPGSignalProcessor V2: Pipeline inicializado");
  }

  async initialize(): Promise<void> {
    this.reset();
  }

  start(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.reset();
    console.log("🚀 PPGSignalProcessor V2: Iniciado");
  }

  stop(): void {
    this.isProcessing = false;
    this.reset();
    console.log("⏹️ PPGSignalProcessor V2: Detenido");
  }

  async calibrate(): Promise<boolean> {
    this.reset();
    return true;
  }

  /**
   * MAIN PROCESSING PIPELINE — called once per video frame
   */
  processFrame(imageData: ImageData): void {
    if (!this.isProcessing || !this.onSignalReady) return;

    const t0 = performance.now();
    this.frameCount++;

    // ──── 1. FINGER CONTACT DETECTION (tile-based) ────
    const contactAnalysis: ContactAnalysis = this.fingerDetector.analyze(imageData);
    this.contactState = contactAnalysis.state;

    // ──── 2. SIGNAL EXTRACTION (multi-source with quality metrics) ────
    const extracted: ExtractedSignal = this.signalExtractor.extract(
      imageData,
      contactAnalysis.mask,
      contactAnalysis.tileStats,
      this.prevFrameRgb || undefined
    );

    // Store previous frame RGB for temporal diff
    this.prevFrameRgb = extracted.rgbRaw;

    // ──── 3. PRESSURE ESTIMATION ────
    const pressure: PressureEstimate = this.pressureEstimator.estimate(
      extracted.rgbRaw.r,
      contactAnalysis.coverage,
      contactAnalysis.clipHighRatio,
      contactAnalysis.uniformity,
      extracted.perfusionIndex / 100,
      extracted.rgbRaw.r
    );

    // ──── 4. FILTERING (only when finger detected) ────
    let filteredValue = extracted.filteredValue;
    const isStable = this.contactState === 'STABLE_CONTACT' || this.contactState === 'ACQUIRING_CONTACT';
    if (isStable) {
      filteredValue = this.kalman.filter(filteredValue);
      filteredValue = this.sgFilter.filter(filteredValue);
    }

    // ──── 5. COMPREHENSIVE SQI ────
    const sqi: SQIResult = this.sqiEstimator.calculate({
      sourceSQI: extracted.quality,
      perfusionIndex: extracted.perfusionIndex,
      clipHighRatio: contactAnalysis.clipHighRatio,
      clipLowRatio: contactAnalysis.clipLowRatio,
      coverage: contactAnalysis.coverage,
      maskStability: contactAnalysis.maskStability,
      pressureState: pressure.state,
      pressureScore: pressure.score,
      activeSource: this.sourceTypeMap[extracted.activeSource] || 'RED_NORM',
      validPixels: contactAnalysis.validPixels,
      fingerDetected: isStable,
      acDcRatio: extracted.perfusionIndex / 100
    });

    // ──── 6. FPS CALCULATION ────
    const now = performance.now();
    if (this.lastFrameTime > 0) {
      const dt = now - this.lastFrameTime;
      this.fps = this.fps * 0.9 + (1000 / dt) * 0.1;
    }
    this.lastFrameTime = now;
    this.lastProcessingTime = now - t0;

    // ──── 7. DIAGNOSTICS ────
    this.lastDiagnostics = {
      contactState: this.contactState,
      pressureState: pressure.state,
      activeSource: this.sourceTypeMap[extracted.activeSource] || 'RED_NORM',
      sqi,
      fps: Math.round(this.fps),
      processingTimeMs: Math.round(this.lastProcessingTime * 10) / 10,
      coverage: contactAnalysis.coverage,
      clipHigh: contactAnalysis.clipHighRatio,
      clipLow: contactAnalysis.clipLowRatio,
      perfusionIndex: extracted.perfusionIndex,
      maskStability: contactAnalysis.maskStability,
      validPixels: contactAnalysis.validPixels,
      motionScore: contactAnalysis.motionScore,
      pressureScore: contactAnalysis.pressureScore,
      snr: extracted.snr,
      guidanceMessage: contactAnalysis.guidanceMessage,
      droppedFrames: 0 // Will be updated from capture engine timing
    };

    // Log every 60 frames
    if (this.frameCount % 60 === 0) {
      console.log("📊 PPG V3:", {
        contact: this.contactState,
        pressure: pressure.state,
        source: extracted.activeSource,
        sqi: sqi.sqiGlobal,
        fps: Math.round(this.fps),
        coverage: (contactAnalysis.coverage * 100).toFixed(0) + '%',
        clipH: (contactAnalysis.clipHighRatio * 100).toFixed(1) + '%',
        perfusion: extracted.perfusionIndex.toFixed(2),
        snr: extracted.snr.toFixed(2),
        motion: contactAnalysis.motionScore.toFixed(2),
        procMs: this.lastProcessingTime.toFixed(1)
      });
    }

    // ──── 8. EMIT PROCESSED SIGNAL ────
    const motionArtifact = Math.max(0, Math.min(100, contactAnalysis.motionScore * 100));

    const processedSignal: ProcessedSignal = {
      timestamp: now,
      rawValue: extracted.rawValue,
      filteredValue,
      quality: sqi.sqiGlobal,
      fingerDetected: isStable,
      roi: {
        x: 0,
        y: 0,
        width: imageData.width,
        height: imageData.height
      },
      perfusionIndex: Math.max(0, extracted.perfusionIndex),
      rgbRaw: extracted.rgbRaw,
      contactState: this.contactState,
      pressureState: pressure.state,
      activeSource: this.sourceTypeMap[extracted.activeSource] || 'RED_NORM',
      clipHighRatio: contactAnalysis.clipHighRatio,
      clipLowRatio: contactAnalysis.clipLowRatio,
      maskStability: contactAnalysis.maskStability,
      motionArtifact,
      positionDrifting: contactAnalysis.maskStability < 0.55 && this.frameCount > 30,
      sqiGlobal: sqi.sqiGlobal
    };

    this.onSignalReady(processedSignal);
  }

  /**
   * Update dropped frames count from capture engine
   */
  updateDroppedFrames(count: number): void {
    this.droppedFrames = count;
  }

  private reset(): void {
    this.fingerDetector.reset();
    this.signalExtractor.reset();
    this.pressureEstimator.reset();
    this.kalman.reset();
    this.sgFilter.reset();
    this.prevFrameRgb = null;
    this.contactState = 'NO_CONTACT';
    this.frameCount = 0;
    this.lastFrameTime = 0;
    this.fps = 0;
    this.droppedFrames = 0;
    this.lastDiagnostics = null;
  }

  private handleError(code: string, message: string): void {
    const error: ProcessingError = { code, message, timestamp: Date.now() };
    if (typeof this.onError === 'function') this.onError(error);
  }
}
