export interface RealFrame {
  imageData: ImageData;
  width: number;
  height: number;
  timestampMs: number;
  mediaTime?: number;
  presentedFrames?: number;
  measuredFps: number;
}

export interface FrameSamplerStats {
  measuredFps: number;
  frameCount: number;
  droppedFrames: number;
  width: number;
  height: number;
}

export type RealFrameCallback = (frame: RealFrame) => void;

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
  };

  constructor(private readonly maxAnalysisWidth = 640) {}

  getStats(): FrameSamplerStats {
    return { ...this.stats };
  }

  start(video: HTMLVideoElement, callback: RealFrameCallback): void {
    if (this.running) return;
    this.video = video;
    this.callback = callback;
    this.running = true;
    this.lastTimestampMs = 0;
    this.lastPresentedFrames = null;
    this.stats = {
      measuredFps: 0,
      frameCount: 0,
      droppedFrames: 0,
      width: 0,
      height: 0,
    };

    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.requestId !== null && this.video) {
      if ("cancelVideoFrameCallback" in HTMLVideoElement.prototype) {
        (this.video as any).cancelVideoFrameCallback(this.requestId);
      } else {
        cancelAnimationFrame(this.requestId);
      }
    }
    this.requestId = null;
    this.callback = null;
    this.video = null;
  }

  private scheduleNext(): void {
    if (!this.running || !this.video) return;

    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      this.requestId = (this.video as any).requestVideoFrameCallback(
        (now: number, metadata: any) => this.handleFrame(now, metadata),
      );
      return;
    }

    this.requestId = requestAnimationFrame((now) => this.handleFrame(now));
  }

  private handleFrame(now: number, metadata?: any): void {
    if (!this.running || !this.video || !this.callback) return;

    const videoWidth = this.video.videoWidth;
    const videoHeight = this.video.videoHeight;

    if (videoWidth > 0 && videoHeight > 0 && this.video.readyState >= 2) {
      const scale = Math.min(1, this.maxAnalysisWidth / videoWidth);
      const width = Math.max(1, Math.round(videoWidth * scale));
      const height = Math.max(1, Math.round(videoHeight * scale));
      this.ensureCanvas(width, height);

      if (this.context) {
        try {
          this.context.drawImage(this.video, 0, 0, width, height);
          const imageData = this.context.getImageData(0, 0, width, height);
          const timestampMs = now;
          const dt = this.lastTimestampMs > 0 ? timestampMs - this.lastTimestampMs : 0;
          if (dt > 0) {
            const instantFps = 1000 / dt;
            this.stats.measuredFps =
              this.stats.measuredFps <= 0
                ? instantFps
                : this.stats.measuredFps * 0.9 + instantFps * 0.1;
          }
          this.lastTimestampMs = timestampMs;

          const presentedFrames =
            typeof metadata?.presentedFrames === "number"
              ? metadata.presentedFrames
              : undefined;
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
          this.stats.width = width;
          this.stats.height = height;

          this.callback({
            imageData,
            width,
            height,
            timestampMs,
            mediaTime:
              typeof metadata?.mediaTime === "number" ? metadata.mediaTime : undefined,
            presentedFrames,
            measuredFps: this.stats.measuredFps,
          });
        } catch {
          // getImageData may fail if the browser cannot read this frame.
        }
      }
    }

    this.scheduleNext();
  }

  private ensureCanvas(width: number, height: number): void {
    if (this.canvas && this.stats.width === width && this.stats.height === height) {
      return;
    }

    if (typeof OffscreenCanvas !== "undefined") {
      this.canvas = new OffscreenCanvas(width, height);
      this.context = this.canvas.getContext("2d", {
        willReadFrequently: true,
        alpha: false,
      });
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    this.canvas = canvas;
    this.context = canvas.getContext("2d", {
      willReadFrequently: true,
      alpha: false,
    });
  }
}
