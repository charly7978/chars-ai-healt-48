import { ProcessedSignal, ProcessingError, SignalProcessor as SignalProcessorInterface } from '../../types/signal';
import { KalmanFilter } from './KalmanFilter';
import { SavitzkyGolayFilter } from './SavitzkyGolayFilter';
import { AdaptiveROIMask, ROIMaskResult } from './AdaptiveROIMask';
import { PressureProxyEstimator, PressureEstimate } from './PressureProxyEstimator';
import { SignalSourceRanker, RankerOutput, SourceType } from './SignalSourceRanker';
import { SignalQualityEstimator, SQIResult } from './SignalQualityEstimator';
import { RingBuffer } from './RingBuffer';

/**
 * CONTACT STATES V2 — extended state machine
 */
export type ContactState =
  | 'NO_CONTACT'
  | 'ACQUIRING_CONTACT'
  | 'UNSTABLE_CONTACT'
  | 'STABLE_CONTACT'
  | 'SATURATED_CONTACT'
  | 'EXCESSIVE_PRESSURE';

export interface PPGDiagnostics {
  contactState: ContactState;
  pressureState: string;
  activeSource: SourceType;
  sqi: SQIResult;
  fps: number;
  processingTimeMs: number;
  coverage: number;
  clipHigh: number;
  clipLow: number;
  perfusionIndex: number;
  maskStability: number;
  validPixels: number;
  guidanceMessage: string;
}

/**
 * PPGSignalProcessor V2 — Production-grade finger-PPG pipeline
 * Adaptive ROI, pressure proxy, multi-source ranking, comprehensive SQI
 */
export class PPGSignalProcessor implements SignalProcessorInterface {
  public isProcessing = false;

  // Sub-systems
  private roiMask = new AdaptiveROIMask();
  private pressureEstimator = new PressureProxyEstimator();
  private sourceRanker = new SignalSourceRanker();
  private sqiEstimator = new SignalQualityEstimator();
  private kalman = new KalmanFilter();
  private sgFilter = new SavitzkyGolayFilter();

  // Buffers (ring-buffer based, no push/shift)
  private redBuffer = new RingBuffer(90);
  private greenBuffer = new RingBuffer(90);
  private acBuffer = new RingBuffer(60);

  // Previous frame values for temporal diff source
  private prevAvgR = 0;
  private prevAvgG = 0;

  // Contact state machine
  private contactState: ContactState = 'NO_CONTACT';
  private contactScore = 0;
  private consecutiveGoodFrames = 0;
  private consecutiveBadFrames = 0;

  // Frame counting & timing
  private frameCount = 0;
  private lastFrameTime = 0;
  private fps = 0;
  private lastProcessingTime = 0;

  // Diagnostics (exposed for debug overlay)
  public lastDiagnostics: PPGDiagnostics | null = null;

  // Thresholds (adaptive base)
  private readonly MIN_COVERAGE = 0.15;
  private readonly MIN_RED_FOR_FINGER = 40;
  private readonly STABLE_ENTRY_FRAMES = 8;
  private readonly UNSTABLE_EXIT_FRAMES = 12;

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

    // ──── 1. ADAPTIVE ROI MASK (excludes clipped/saturated pixels) ────
    const roi: ROIMaskResult = this.roiMask.process(imageData, 0.75);

    // ──── 2. FINGER DETECTION via tile analysis ────
    const fingerDetected = this.evaluateFingerContact(roi);

    // ──── 3. BUFFERS ────
    this.redBuffer.push(roi.avgR);
    this.greenBuffer.push(roi.avgG);

    // AC component (recent max-min of red)
    const redStats = this.redBuffer.stats();
    const acComponent = redStats.max - redStats.min;
    this.acBuffer.push(acComponent);
    const dcComponent = redStats.mean;

    // ──── 4. TILE UNIFORMITY (simplified: variance of R across coarse grid) ────
    const uniformity = this.computeUniformity(imageData, roi.roiBounds);

    // ──── 5. PRESSURE PROXY ────
    const pressure: PressureEstimate = this.pressureEstimator.estimate(
      roi.avgR, roi.coverage, roi.clipHighRatio, uniformity, acComponent, dcComponent
    );

    // ──── 6. CONTACT STATE MACHINE ────
    this.updateContactState(fingerDetected, pressure, roi);

    // ──── 7. MULTI-SOURCE SIGNAL RANKING ────
    const ranked: RankerOutput = this.sourceRanker.rank(
      roi.avgR, roi.avgG, roi.avgB,
      this.prevAvgR, this.prevAvgG,
      roi.clipHighRatio, roi.clipLowRatio
    );
    this.prevAvgR = roi.avgR;
    this.prevAvgG = roi.avgG;

    // ──── 8. FILTERING (only when finger detected) ────
    let filteredValue = ranked.activeValue;
    if (this.contactState === 'STABLE_CONTACT' || this.contactState === 'UNSTABLE_CONTACT') {
      filteredValue = this.kalman.filter(filteredValue);
      filteredValue = this.sgFilter.filter(filteredValue);
    }

    // ──── 9. PERFUSION INDEX ────
    const perfusionIndex = dcComponent > 0 ? (acComponent / dcComponent) * 100 : 0;

    // ──── 10. COMPREHENSIVE SQI ────
    const isDetected = this.contactState === 'STABLE_CONTACT' || this.contactState === 'UNSTABLE_CONTACT';
    const sqi: SQIResult = this.sqiEstimator.calculate({
      sourceSQI: ranked.activeSQI,
      perfusionIndex,
      clipHighRatio: roi.clipHighRatio,
      clipLowRatio: roi.clipLowRatio,
      coverage: roi.coverage,
      maskStability: roi.maskStability,
      pressureState: pressure.state,
      pressureScore: pressure.score,
      activeSource: ranked.activeSource,
      validPixels: roi.validPixels,
      fingerDetected: isDetected,
      acDcRatio: dcComponent > 0 ? acComponent / dcComponent : 0
    });

    // ──── 11. FPS CALCULATION ────
    const now = performance.now();
    if (this.lastFrameTime > 0) {
      const dt = now - this.lastFrameTime;
      this.fps = this.fps * 0.9 + (1000 / dt) * 0.1;
    }
    this.lastFrameTime = now;
    this.lastProcessingTime = now - t0;

    // ──── 12. DIAGNOSTICS ────
    this.lastDiagnostics = {
      contactState: this.contactState,
      pressureState: pressure.state,
      activeSource: ranked.activeSource,
      sqi,
      fps: Math.round(this.fps),
      processingTimeMs: Math.round(this.lastProcessingTime * 10) / 10,
      coverage: roi.coverage,
      clipHigh: roi.clipHighRatio,
      clipLow: roi.clipLowRatio,
      perfusionIndex,
      maskStability: roi.maskStability,
      validPixels: roi.validPixels,
      guidanceMessage: sqi.guidanceMessage
    };

    // Log every 60 frames
    if (this.frameCount % 60 === 0) {
      console.log("📊 PPG V2:", {
        contact: this.contactState,
        pressure: pressure.state,
        source: ranked.activeSource,
        sqi: sqi.sqiGlobal,
        fps: Math.round(this.fps),
        coverage: (roi.coverage * 100).toFixed(0) + '%',
        clipH: (roi.clipHighRatio * 100).toFixed(1) + '%',
        perfusion: perfusionIndex.toFixed(2),
        procMs: this.lastProcessingTime.toFixed(1)
      });
    }

    // ──── 13. EMIT PROCESSED SIGNAL ────
    const processedSignal: ProcessedSignal = {
      timestamp: now,
      rawValue: roi.avgR,
      filteredValue,
      quality: sqi.sqiGlobal,
      fingerDetected: isDetected,
      roi: {
        x: roi.roiBounds.x,
        y: roi.roiBounds.y,
        width: roi.roiBounds.w,
        height: roi.roiBounds.h
      },
      perfusionIndex: Math.max(0, perfusionIndex),
      rgbRaw: { r: roi.rawR, g: roi.rawG, b: roi.rawB }
    };

    this.onSignalReady(processedSignal);
  }

  /**
   * Evaluate whether a finger is on the camera based on ROI mask results.
   * Uses adaptive thresholds based on recent history.
   */
  private evaluateFingerContact(roi: ROIMaskResult): boolean {
    // Primary checks
    if (roi.coverage < this.MIN_COVERAGE) return false;
    if (roi.avgR < this.MIN_RED_FOR_FINGER) return false;

    // Red dominance check (finger transmits mostly red via hemoglobin)
    const total = roi.avgR + roi.avgG + roi.avgB + 1e-6;
    const redRatio = roi.avgR / total;
    if (redRatio < 0.30) return false;

    // R/G ratio for skin (with flash, finger should be red-dominant)
    const rgRatio = roi.avgR / (roi.avgG + 1);
    if (rgRatio < 0.8 || rgRatio > 5.0) return false;

    // Reject excessive clipping
    if (roi.clipHighRatio > 0.6) return false;
    if (roi.clipLowRatio > 0.5) return false;

    // Require minimum mask stability after initial frames
    if (this.frameCount > 10 && roi.maskStability < 0.4) return false;

    // Pulsatility check (need some variation in red channel)
    if (this.redBuffer.length >= 15) {
      const stats = this.redBuffer.stats();
      const cv = Math.sqrt(stats.variance) / (stats.mean + 1e-6);
      // Too uniform = not a real finger or excessive pressure
      if (cv < 0.001) return false;
    }

    return true;
  }

  /**
   * Contact state machine with hysteresis.
   */
  private updateContactState(
    fingerDetected: boolean,
    pressure: PressureEstimate,
    roi: ROIMaskResult
  ): void {
    if (fingerDetected) {
      this.consecutiveGoodFrames++;
      this.consecutiveBadFrames = 0;
    } else {
      this.consecutiveBadFrames++;
      this.consecutiveGoodFrames = 0;
    }

    // Determine target state
    if (!fingerDetected) {
      if (this.consecutiveBadFrames >= this.UNSTABLE_EXIT_FRAMES) {
        this.contactState = 'NO_CONTACT';
      } else if (this.contactState !== 'NO_CONTACT') {
        this.contactState = 'ACQUIRING_CONTACT';
      }
      return;
    }

    // Finger detected — check sub-states
    if (pressure.state === 'HIGH_PRESSURE') {
      this.contactState = 'EXCESSIVE_PRESSURE';
      return;
    }

    if (roi.clipHighRatio > 0.35) {
      this.contactState = 'SATURATED_CONTACT';
      return;
    }

    if (this.consecutiveGoodFrames >= this.STABLE_ENTRY_FRAMES && pressure.state === 'OPTIMAL_PRESSURE') {
      this.contactState = 'STABLE_CONTACT';
    } else if (this.consecutiveGoodFrames >= 3) {
      if (this.contactState === 'STABLE_CONTACT') {
        // Stay stable unless degraded for long
      } else {
        this.contactState = 'UNSTABLE_CONTACT';
      }
    } else {
      this.contactState = 'ACQUIRING_CONTACT';
    }
  }

  /**
   * Compute spatial uniformity from a 5x5 tile grid (0=varied, 1=perfectly uniform).
   * High uniformity with a finger = possibly too much pressure.
   */
  private computeUniformity(imageData: ImageData, bounds: { x: number; y: number; w: number; h: number }): number {
    const { data, width } = imageData;
    const gridSize = 5;
    const tileW = Math.floor(bounds.w / gridSize);
    const tileH = Math.floor(bounds.h / gridSize);
    if (tileW < 2 || tileH < 2) return 0.5;

    const tileMeans: number[] = [];
    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        const sx = bounds.x + gx * tileW;
        const sy = bounds.y + gy * tileH;
        let sum = 0, count = 0;
        // Sample every 2nd pixel for speed
        for (let y = sy; y < sy + tileH; y += 2) {
          for (let x = sx; x < sx + tileW; x += 2) {
            const pi = (y * width + x) * 4;
            sum += data[pi]; // Red channel
            count++;
          }
        }
        if (count > 0) tileMeans.push(sum / count);
      }
    }

    if (tileMeans.length < 4) return 0.5;
    const mean = tileMeans.reduce((a, b) => a + b, 0) / tileMeans.length;
    const variance = tileMeans.reduce((a, b) => a + (b - mean) ** 2, 0) / tileMeans.length;
    const cv = Math.sqrt(variance) / (mean + 1e-6);

    // cv near 0 = very uniform; cv > 0.3 = varied
    return Math.max(0, Math.min(1, 1 - cv * 3));
  }

  private reset(): void {
    this.roiMask.reset();
    this.pressureEstimator.reset();
    this.sourceRanker.reset();
    this.kalman.reset();
    this.sgFilter.reset();
    this.redBuffer.clear();
    this.greenBuffer.clear();
    this.acBuffer.clear();
    this.prevAvgR = 0;
    this.prevAvgG = 0;
    this.contactState = 'NO_CONTACT';
    this.contactScore = 0;
    this.consecutiveGoodFrames = 0;
    this.consecutiveBadFrames = 0;
    this.frameCount = 0;
    this.lastFrameTime = 0;
    this.fps = 0;
    this.lastDiagnostics = null;
  }

  private handleError(code: string, message: string): void {
    const error: ProcessingError = { code, message, timestamp: Date.now() };
    if (typeof this.onError === 'function') this.onError(error);
  }
}
