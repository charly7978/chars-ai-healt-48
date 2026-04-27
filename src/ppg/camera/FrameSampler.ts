/**
 * FrameSampler
 * ----------------------------------------------------------------------------
 * Real-frame sampler that decouples capture from the React render loop.
 *
 * Acquisition strategy:
 *   1. requestVideoFrameCallback (rVFC) — preferred. Fires once per *presented*
 *      video frame and provides the browser's monotonic `now`, plus optional
 *      `mediaTime` and `presentedFrames` metadata that lets us measure dropped
 *      frames at the source.
 *   2. requestAnimationFrame fallback — only when rVFC is unavailable. Coupled
 *      to render rate, so jitter and dropped-frame estimation are degraded.
 *   3. setInterval fallback — only if neither is available (very rare; e.g.
 *      background tabs). Always reported in `acquisitionMethod` so the
 *      pipeline can penalise the sample quality downstream.
 *
 * Each emitted RealFrame carries a sequential id, a monotonic timestamp
 * (`performance.now()`), the upstream `videoTime`, and per-frame timing
 * statistics (instantaneous fps, median fps, MAD-based jitter, dropped-frame
 * estimate, fps quality 0..100). PPGPublicationGate uses fpsQuality to refuse
 * publication when the capture cadence is too unstable.
 *
 * Performance: a single canvas + 2D context is reused across frames and the
 * RealFrame object is allocated fresh per frame but kept tiny — the heavy
 * `imageData.data` array is the underlying ArrayBuffer the consumer reads
 * directly, never copied.
 */

export type AcquisitionMethod =
  | "requestVideoFrameCallback"
  | "requestAnimationFrame"
  | "intervalFallback";

export interface RealFrame {
  /** Monotonic sequential id since last start(). */
  id: number;
  /** performance.now() at the moment the frame was processed. */
  timestampMs: number;
  /** Upstream HTMLVideoElement.currentTime equivalent (rVFC mediaTime), if available. */
  videoTime?: number;
  /** Underlying RGBA pixel data for the analyzed canvas region. */
  imageData: ImageData;
  /** Real width of `imageData` (always equals analyzed canvas width). */
  imageWidth: number;
  /** Real height of `imageData` (always equals analyzed canvas height). */
  imageHeight: number;
  /** Optional ROI hint into imageData. Consumers may ignore it. */
  roiHint?: { x: number; y: number; width: number; height: number };
  /** Instantaneous fps from the most recent dt (1000/dt). */
  fpsInstant: number;
  /** Median fps over the rolling window. Robust to single dropped frames. */
  fpsMedian: number;
  /** Median Absolute Deviation of dt in ms — robust jitter estimator. */
  jitterMs: number;
  /** Inferred number of dropped frames since the previous sample. */
  droppedFrameEstimate: number;
  /** Which API actually delivered this frame. */
  acquisitionMethod: AcquisitionMethod;
  /** Cadence quality 0..100 (100 = perfectly periodic at target fps). */
  fpsQuality: number;
  /** EMA-smoothed fps for legacy consumers. */
  measuredFps: number;
  /** Mean dt in ms over the rolling window. */
  sampleIntervalMs: number;
  /** Set when the sampler is operating in reduced-ROI bootstrap mode. */
  isRoiReduced: boolean;
}

export interface FrameSamplerStats {
  measuredFps: number;
  fpsInstant: number;
  fpsMedian: number;
  fpsQuality: number;
  jitterMs: number;
  frameCount: number;
  droppedFrames: number;
  droppedFrameEstimate: number;
  width: number;
  height: number;
  sampleIntervalMs: number;
  sampleIntervalStdMs: number;
  lastFrameTimeMs: number;
  isActive: boolean;
  acquisitionMethod: AcquisitionMethod | "none";
  targetFps: number;
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

const DT_RING_SIZE = 60; // ~2s of intervals at 30fps

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function medianAbsoluteDeviation(values: number[], med: number): number {
  if (values.length === 0) return 0;
  const deviations = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) deviations[i] = Math.abs(values[i] - med);
  return median(deviations);
}

export class FrameSampler {
  private running = false;
  private video: HTMLVideoElement | null = null;
  private callback: RealFrameCallback | null = null;
  private rafHandle: number | null = null;
  private rvfcHandle: number | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private context:
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null = null;

  // Frame timing
  private frameId = 0;
  private lastTimestampMs = 0;
  private lastPresentedFrames: number | null = null;
  private acquisitionMethod: AcquisitionMethod | "none" = "none";

  // Ring buffer for dt (avoids repeated allocations).
  private readonly dtRing: Float32Array = new Float32Array(DT_RING_SIZE);
  private dtRingFill = 0;
  private dtRingHead = 0;

  private stats: FrameSamplerStats = this.createEmptyStats();

  constructor(
    private readonly maxAnalysisWidth = 640,
    private readonly reducedRoiRatio = 0.4,
    private readonly targetFps = 30,
  ) {}

  private createEmptyStats(): FrameSamplerStats {
    return {
      measuredFps: 0,
      fpsInstant: 0,
      fpsMedian: 0,
      fpsQuality: 0,
      jitterMs: 0,
      frameCount: 0,
      droppedFrames: 0,
      droppedFrameEstimate: 0,
      width: 0,
      height: 0,
      sampleIntervalMs: 0,
      sampleIntervalStdMs: 0,
      lastFrameTimeMs: 0,
      isActive: false,
      acquisitionMethod: "none",
      targetFps: this.targetFps,
    };
  }

  getStats(): FrameSamplerStats {
    return { ...this.stats };
  }

  /** Push a dt sample into the ring buffer (drops oldest). */
  private pushDt(dt: number): void {
    this.dtRing[this.dtRingHead] = dt;
    this.dtRingHead = (this.dtRingHead + 1) % DT_RING_SIZE;
    if (this.dtRingFill < DT_RING_SIZE) this.dtRingFill++;
  }

  private dtSnapshot(): number[] {
    const out = new Array<number>(this.dtRingFill);
    for (let i = 0; i < this.dtRingFill; i++) out[i] = this.dtRing[i];
    return out;
  }

  private computeIntervalStats(): {
    mean: number;
    std: number;
    med: number;
    mad: number;
  } {
    if (this.dtRingFill < 2) return { mean: 0, std: 0, med: 0, mad: 0 };
    const values = this.dtSnapshot();
    let sum = 0;
    for (const v of values) sum += v;
    const mean = sum / values.length;
    let sqSum = 0;
    for (const v of values) sqSum += (v - mean) * (v - mean);
    const std = Math.sqrt(sqSum / values.length);
    const med = median(values);
    const mad = medianAbsoluteDeviation(values, med);
    return { mean, std, med, mad };
  }

  /**
   * fpsQuality 0..100:
   *  - 100 when median dt matches target dt and MAD is near zero.
   *  - 0 when median dt is wildly off OR jitter (MAD) exceeds half the target dt.
   */
  private computeFpsQuality(medianDt: number, mad: number): number {
    if (medianDt <= 0) return 0;
    const targetDt = 1000 / this.targetFps;
    const cadenceError = Math.min(1, Math.abs(medianDt - targetDt) / targetDt);
    const jitterError = Math.min(1, mad / (targetDt * 0.5));
    const quality = (1 - cadenceError) * 0.5 + (1 - jitterError) * 0.5;
    return Math.max(0, Math.min(100, Math.round(quality * 100)));
  }

  start(video: HTMLVideoElement, callback: RealFrameCallback): void {
    if (this.running) return;

    this.video = video;
    this.callback = callback;
    this.running = true;
    this.frameId = 0;
    this.lastTimestampMs = 0;
    this.lastPresentedFrames = null;
    this.dtRingFill = 0;
    this.dtRingHead = 0;

    // Choose acquisition method ONCE so downstream consumers can correlate.
    if (
      typeof HTMLVideoElement !== "undefined" &&
      "requestVideoFrameCallback" in HTMLVideoElement.prototype
    ) {
      this.acquisitionMethod = "requestVideoFrameCallback";
    } else if (typeof requestAnimationFrame === "function") {
      this.acquisitionMethod = "requestAnimationFrame";
    } else {
      this.acquisitionMethod = "intervalFallback";
    }

    this.stats = this.createEmptyStats();
    this.stats.isActive = true;
    this.stats.acquisitionMethod = this.acquisitionMethod;

    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    this.stats.isActive = false;

    if (this.rvfcHandle !== null && this.video) {
      try {
        (this.video as VideoElementWithFrameCallbacks).cancelVideoFrameCallback(this.rvfcHandle);
      } catch {
        /* noop */
      }
      this.rvfcHandle = null;
    }
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    this.callback = null;
    this.video = null;
  }

  private scheduleNext(): void {
    if (!this.running || !this.video) return;

    if (this.acquisitionMethod === "requestVideoFrameCallback") {
      this.rvfcHandle = (this.video as VideoElementWithFrameCallbacks).requestVideoFrameCallback(
        (now, metadata) => this.handleFrame(now, metadata),
      );
      return;
    }

    if (this.acquisitionMethod === "requestAnimationFrame") {
      this.rafHandle = requestAnimationFrame((now) => this.handleFrame(now));
      return;
    }

    // intervalFallback — fire at target cadence, no metadata available.
    if (this.intervalHandle === null) {
      const period = Math.max(1, Math.round(1000 / this.targetFps));
      this.intervalHandle = setInterval(() => this.handleFrame(performance.now()), period);
    }
  }

  private handleFrame(_now: number, metadata?: BrowserVideoFrameMetadata): void {
    if (!this.running || !this.video || !this.callback) {
      if (this.acquisitionMethod !== "intervalFallback") this.scheduleNext();
      return;
    }

    const videoWidth = this.video.videoWidth;
    const videoHeight = this.video.videoHeight;

    if (videoWidth === 0 || videoHeight === 0 || this.video.readyState < 2) {
      if (this.acquisitionMethod !== "intervalFallback") this.scheduleNext();
      return;
    }

    const scale = Math.min(1, this.maxAnalysisWidth / videoWidth);
    const fullWidth = Math.max(1, Math.round(videoWidth * scale));
    const fullHeight = Math.max(1, Math.round(videoHeight * scale));

    // ROI hint — the actual ROI selection is performed by FingerOpticalROI.
    // We always deliver the full analyzed frame so downstream stats are
    // coordinate-consistent. `roiHint` is offered as guidance only.
    const isReducedMode = this.frameId < 3;
    const roiWidth = isReducedMode ? Math.floor(fullWidth * this.reducedRoiRatio) : fullWidth;
    const roiHeight = fullHeight;
    const roiX = Math.floor((fullWidth - roiWidth) / 2);
    const roiY = 0;

    this.ensureCanvas(fullWidth, fullHeight);

    if (!this.context) {
      if (this.acquisitionMethod !== "intervalFallback") this.scheduleNext();
      return;
    }

    try {
      this.context.drawImage(this.video, 0, 0, fullWidth, fullHeight);
      // imageData width/height ALWAYS equal the analyzed canvas dimensions —
      // the previous version reported ROI dims but returned full-frame data,
      // which caused coordinate misalignment in consumers.
      const imageData = this.context.getImageData(0, 0, fullWidth, fullHeight);

      const timestampMs = performance.now();
      const dt = this.lastTimestampMs > 0 ? timestampMs - this.lastTimestampMs : 0;
      if (dt > 0) this.pushDt(dt);

      const intervalStats = this.computeIntervalStats();
      const fpsInstant = dt > 0 ? 1000 / dt : 0;
      const fpsMedian = intervalStats.med > 0 ? 1000 / intervalStats.med : 0;
      const fpsQuality = this.computeFpsQuality(intervalStats.med, intervalStats.mad);

      // EMA fps for legacy code paths.
      const measuredFps =
        this.stats.measuredFps <= 0
          ? fpsInstant
          : this.stats.measuredFps * 0.9 + fpsInstant * 0.1;

      // Dropped-frame estimate. Prefer browser-provided counter when present.
      let droppedFrameEstimate = 0;
      const presentedFrames =
        typeof metadata?.presentedFrames === "number" ? metadata.presentedFrames : undefined;
      if (
        presentedFrames !== undefined &&
        this.lastPresentedFrames !== null &&
        presentedFrames > this.lastPresentedFrames + 1
      ) {
        droppedFrameEstimate = presentedFrames - this.lastPresentedFrames - 1;
        this.stats.droppedFrames += droppedFrameEstimate;
      } else if (intervalStats.med > 0 && dt > intervalStats.med * 1.75) {
        // Heuristic fallback: a dt that is ≥1.75× the rolling median strongly
        // suggests at least one missed frame. Round down to be conservative.
        droppedFrameEstimate = Math.max(0, Math.floor(dt / intervalStats.med) - 1);
        this.stats.droppedFrames += droppedFrameEstimate;
      }
      if (presentedFrames !== undefined) this.lastPresentedFrames = presentedFrames;

      this.lastTimestampMs = timestampMs;
      this.frameId += 1;

      // Mutate stats in place (no churn).
      this.stats.measuredFps = measuredFps;
      this.stats.fpsInstant = fpsInstant;
      this.stats.fpsMedian = fpsMedian;
      this.stats.fpsQuality = fpsQuality;
      this.stats.jitterMs = intervalStats.mad;
      this.stats.frameCount += 1;
      this.stats.droppedFrameEstimate = droppedFrameEstimate;
      this.stats.width = imageData.width;
      this.stats.height = imageData.height;
      this.stats.sampleIntervalMs = intervalStats.mean;
      this.stats.sampleIntervalStdMs = intervalStats.std;
      this.stats.lastFrameTimeMs = timestampMs;

      const videoTime =
        typeof metadata?.mediaTime === "number" ? metadata.mediaTime : this.video.currentTime;

      this.callback({
        id: this.frameId,
        timestampMs,
        videoTime,
        imageData,
        imageWidth: imageData.width,
        imageHeight: imageData.height,
        roiHint: { x: roiX, y: roiY, width: roiWidth, height: roiHeight },
        fpsInstant,
        fpsMedian,
        jitterMs: intervalStats.mad,
        droppedFrameEstimate,
        acquisitionMethod: this.acquisitionMethod as AcquisitionMethod,
        fpsQuality,
        measuredFps,
        sampleIntervalMs: intervalStats.mean,
        isRoiReduced: isReducedMode,
      });
    } catch {
      // getImageData can throw on tainted canvases or when the video element
      // has not yet produced a valid frame. Swallow and reschedule.
    }

    if (this.acquisitionMethod !== "intervalFallback") this.scheduleNext();
  }

  /** Backwards-compatible no-op — full-frame analysis is now always on. */
  requestFullFrameAnalysis(): void {
    this.frameId = Math.max(this.frameId, 3);
  }

  private ensureCanvas(width: number, height: number): void {
    if (this.canvas) {
      const cw =
        this.canvas instanceof OffscreenCanvas
          ? this.canvas.width
          : (this.canvas as HTMLCanvasElement).width;
      const ch =
        this.canvas instanceof OffscreenCanvas
          ? this.canvas.height
          : (this.canvas as HTMLCanvasElement).height;
      if (cw === width && ch === height) return;
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
