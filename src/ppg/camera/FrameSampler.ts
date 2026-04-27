export interface RealFrame {
  imageData: ImageData;
  width: number;
  height: number;
  timestampMs: number;
  mediaTime?: number;
  presentedFrames?: number;
  measuredFps: number;
  sampleIntervalMs: number;
  isRoiReduced: boolean;
}

export interface FrameSamplerStats {
  measuredFps: number;
  frameCount: number;
  droppedFrames: number;
  width: number;
  height: number;
  sampleIntervalMs: number;
  sampleIntervalStdMs: number;
  lastFrameTimeMs: number;
  isActive: boolean;
}

export type RealFrameCallback = (frame: RealFrame) => void;

interface BrowserVideoFrameMetadata {
  mediaTime?: number;
  presentedFrames?: number;
}

type BrowserVideoFrameCallback = (
  now: number,
  metadata: BrowserVideoFrameMetadata,
) => void;

type VideoElementWithFrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback: (callback: BrowserVideoFrameCallback) => number;
  cancelVideoFrameCallback: (handle: number) => void;
};

interface FrameInterval {
  timestamp: number;
  interval: number;
}

export class FrameSampler {
  private running = false;
  private video: HTMLVideoElement | null = null;
  private callback: RealFrameCallback | null = null;
  private requestId: number | null = null;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private context:
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null = null;
  private lastTimestampMs = 0;
  private lastPresentedFrames: number | null = null;
  private stats: FrameSamplerStats = {
    measuredFps: 0,
    frameCount: 0,
    droppedFrames: 0,
    width: 0,
    height: 0,
    sampleIntervalMs: 0,
    sampleIntervalStdMs: 0,
    lastFrameTimeMs: 0,
    isActive: false,
  };

  // Ring buffer for interval tracking (last 60 samples = ~2s at 30fps)
  private intervalBuffer: FrameInterval[] = [];
  private readonly maxIntervalBufferSize = 60;

  // ROI tracking
  private currentRoi = { x: 0, y: 0, width: 0, height: 0 };
  private fullFrameAnalysisCount = 0;

  constructor(
    private readonly maxAnalysisWidth = 640,
    private readonly reducedRoiRatio = 0.4, // Start with reduced ROI
  ) {}

  getStats(): FrameSamplerStats {
    return { ...this.stats };
  }

  private calculateIntervalStats(): { mean: number; std: number } {
    if (this.intervalBuffer.length < 2) return { mean: 0, std: 0 };

    const intervals = this.intervalBuffer.map((f) => f.interval);
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;

    const variance =
      intervals.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
      intervals.length;
    const std = Math.sqrt(variance);

    return { mean, std };
  }

  private updateIntervalBuffer(timestamp: number): void {
    if (this.lastTimestampMs > 0) {
      const interval = timestamp - this.lastTimestampMs;
      this.intervalBuffer.push({ timestamp, interval });

      if (this.intervalBuffer.length > this.maxIntervalBufferSize) {
        this.intervalBuffer.shift();
      }
    }
  }

  start(video: HTMLVideoElement, callback: RealFrameCallback): void {
    if (this.running) return;

    this.video = video;
    this.callback = callback;
    this.running = true;
    this.lastTimestampMs = 0;
    this.lastPresentedFrames = null;
    this.intervalBuffer = [];
    this.fullFrameAnalysisCount = 0;
    this.currentRoi = { x: 0, y: 0, width: 0, height: 0 };

    this.stats = {
      measuredFps: 0,
      frameCount: 0,
      droppedFrames: 0,
      width: 0,
      height: 0,
      sampleIntervalMs: 0,
      sampleIntervalStdMs: 0,
      lastFrameTimeMs: 0,
      isActive: true,
    };

    this.scheduleNext();
  }

  stop(): void {

    this.running = false;
    this.stats.isActive = false;

    if (this.requestId !== null && this.video) {
      if ("cancelVideoFrameCallback" in HTMLVideoElement.prototype) {
        (this.video as VideoElementWithFrameCallbacks).cancelVideoFrameCallback(this.requestId);
      } else {
        cancelAnimationFrame(this.requestId);
      }
    }

    this.requestId = null;
    this.callback = null;
    this.video = null;
    this.intervalBuffer = [];
  }

  private scheduleNext(): void {
    if (!this.running || !this.video) return;

    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      this.requestId = (this.video as VideoElementWithFrameCallbacks).requestVideoFrameCallback(
        (now: number, metadata: BrowserVideoFrameMetadata) => this.handleFrame(now, metadata),
      );
      return;
    }

    this.requestId = requestAnimationFrame((now) => this.handleFrame(now));
  }

  private handleFrame(now: number, metadata?: BrowserVideoFrameMetadata): void {
    if (!this.running || !this.video || !this.callback) return;

    const videoWidth = this.video.videoWidth;
    const videoHeight = this.video.videoHeight;

    // Validate video dimensions
    if (videoWidth === 0 || videoHeight === 0) {
      this.scheduleNext();
      return;
    }

    if (this.video.readyState < 2) {
      this.scheduleNext();
      return;
    }

    // Determine analysis dimensions and ROI
    const scale = Math.min(1, this.maxAnalysisWidth / videoWidth);
    const fullWidth = Math.max(1, Math.round(videoWidth * scale));
    const fullHeight = Math.max(1, Math.round(videoHeight * scale));

    // Use reduced ROI initially, expand if needed based on external signal
    const isReducedMode = this.fullFrameAnalysisCount < 3;
    let roiWidth = isReducedMode ? Math.floor(fullWidth * this.reducedRoiRatio) : fullWidth;
    let roiHeight = isReducedMode ? Math.floor(fullHeight * this.reducedRoiRatio) : fullHeight;

    // Center the ROI
    const roiX = Math.floor((fullWidth - roiWidth) / 2);
    const roiY = Math.floor((fullHeight - fullHeight) / 2); // Keep full height for now
    roiHeight = fullHeight; // Always use full height for better finger coverage

    this.ensureCanvas(fullWidth, fullHeight);

    if (this.context) {
      try {
        // Draw full frame
        this.context.drawImage(this.video, 0, 0, fullWidth, fullHeight);

        // Get FULL frame image data - ROI analyzer handles ROI internally
        // Passing cropped ImageData was causing coordinate misalignment
        const imageData = this.context.getImageData(0, 0, fullWidth, fullHeight);

        // Use monotonic timestamp
        const timestampMs = performance.now();

        // Update interval buffer for accurate interval stats
        this.updateIntervalBuffer(timestampMs);
        const intervalStats = this.calculateIntervalStats();

        const dt = this.lastTimestampMs > 0 ? timestampMs - this.lastTimestampMs : 0;
        let instantFps = 0;
        if (dt > 0) {
          instantFps = 1000 / dt;
          // Exponential moving average for FPS
          this.stats.measuredFps =
            this.stats.measuredFps <= 0
              ? instantFps
              : this.stats.measuredFps * 0.9 + instantFps * 0.1;
        }

        this.lastTimestampMs = timestampMs;
        this.stats.lastFrameTimeMs = timestampMs;
        this.stats.sampleIntervalMs = intervalStats.mean;
        this.stats.sampleIntervalStdMs = intervalStats.std;

        // Track dropped frames from browser metadata
        const presentedFrames =
          typeof metadata?.presentedFrames === "number" ? metadata.presentedFrames : undefined;

        if (
          presentedFrames !== undefined &&
          this.lastPresentedFrames !== null &&
          presentedFrames > this.lastPresentedFrames + 1
        ) {
          this.stats.droppedFrames += presentedFrames - this.lastPresentedFrames - 1;
        }
        if (presentedFrames !== undefined) {
          this.lastPresentedFrames = presentedFrames;
        }

        this.stats.frameCount += 1;
        this.stats.width = roiWidth;
        this.stats.height = roiHeight;

        this.callback({
          imageData,
          width: roiWidth,
          height: roiHeight,
          timestampMs,
          mediaTime: typeof metadata?.mediaTime === "number" ? metadata.mediaTime : undefined,
          presentedFrames,
          measuredFps: this.stats.measuredFps,
          sampleIntervalMs: intervalStats.mean,
          isRoiReduced: isReducedMode,
        });
      } catch (err) {
        // getImageData may fail if the browser cannot read this frame
      }
    }

    this.scheduleNext();
  }

  /**
   * Signal that full frame analysis is needed (e.g., when ROI detection fails)
   */
  requestFullFrameAnalysis(): void {
    this.fullFrameAnalysisCount = Math.max(this.fullFrameAnalysisCount, 3);
  }

  private ensureCanvas(width: number, height: number): void {
    // Check if canvas exists with correct dimensions
    if (this.canvas) {
      const currentWidth = this.canvas instanceof OffscreenCanvas ? this.canvas.width : (this.canvas as HTMLCanvasElement).width;
      const currentHeight = this.canvas instanceof OffscreenCanvas ? this.canvas.height : (this.canvas as HTMLCanvasElement).height;
      if (currentWidth === width && currentHeight === height) {
        return;
      }
    }

    if (typeof OffscreenCanvas !== "undefined") {
      this.canvas = new OffscreenCanvas(width, height);
      this.context = this.canvas.getContext("2d", {
        willReadFrequently: true,
        alpha: false,
      });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      this.canvas = canvas;
      this.context = canvas.getContext("2d", {
        willReadFrequently: true,
        alpha: false,
      });
    }

    if (!this.context) {
      console.error("[FrameSampler] Failed to create 2D context");
    }
  }
}
