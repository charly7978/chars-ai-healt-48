/**
 * FrameCaptureEngine - High-efficiency frame capture decoupled from React rendering
 * Uses requestVideoFrameCallback with fallback to requestAnimationFrame
 * Minimizes main thread work, uses reduced resolution for analysis
 */

export interface CaptureConfig {
  analysisWidth: number;
  analysisHeight: number;
  maxProcessingMs: number;
}

export interface FrameTiming {
  lastCaptureTime: number;
  realFps: number;
  droppedFrames: number;
  frameCount: number;
  avgProcessingMs: number;
}

export interface CapturedFrame {
  imageData: ImageData;
  timestamp: number;
  frameNumber: number;
  timing: FrameTiming;
}

export type FrameCallback = (frame: CapturedFrame) => void;

export class FrameCaptureEngine {
  private isRunning = false;
  private videoElement: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private frameCallbackId: number | null = null;
  private frameNumber = 0;
  private onFrame: FrameCallback | null = null;
  
  private timing: FrameTiming = {
    lastCaptureTime: 0,
    realFps: 0,
    droppedFrames: 0,
    frameCount: 0,
    avgProcessingMs: 0
  };
  
  private processingTimes: number[] = [];
  private readonly MAX_PROCESSING_SAMPLES = 30;
  
  private readonly config: CaptureConfig;

  constructor(config?: Partial<CaptureConfig>) {
    this.config = {
      analysisWidth: config?.analysisWidth || 320,
      analysisHeight: config?.analysisHeight || 240,
      maxProcessingMs: config?.maxProcessingMs || 16
    };
  }

  /**
   * Initialize with video element ref
   */
  attachVideo(video: HTMLVideoElement): void {
    this.videoElement = video;
    
    // Create canvas once
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.config.analysisWidth;
      this.canvas.height = this.config.analysisHeight;
      this.ctx = this.canvas.getContext('2d', { 
        willReadFrequently: true,
        alpha: false 
      });
    }
  }

  /**
   * Start capture loop
   */
  start(callback: FrameCallback): void {
    if (this.isRunning || !this.videoElement || !this.ctx) {
      console.warn('FrameCaptureEngine: Cannot start - invalid state');
      return;
    }

    this.isRunning = true;
    this.onFrame = callback;
    this.frameNumber = 0;
    this.resetTiming();

    const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

    const processImage = (now: number, metadata?: any) => {
      if (!this.isRunning || !this.videoElement || !this.ctx) return;

      const t0 = performance.now();

      // Real frame timestamp from metadata or performance.now()
      const frameTime = metadata?.mediaTime ? metadata.mediaTime * 1000 : now;

      // FPS calculation
      if (this.timing.lastCaptureTime > 0) {
        const dt = frameTime - this.timing.lastCaptureTime;
        if (dt > 0) {
          this.timing.realFps = this.timing.realFps * 0.9 + (1000 / dt) * 0.1;
        }
      }
      this.timing.lastCaptureTime = frameTime;
      this.timing.frameCount++;

      // Dropped frames detection
      if (metadata?.presentedFrames !== undefined) {
        const expected = this.timing.frameCount;
        const presented = metadata.presentedFrames;
        if (presented > expected + 1) {
          this.timing.droppedFrames += (presented - expected - 1);
        }
      }

      try {
        if (this.videoElement.readyState >= 2) {
          const vw = this.videoElement.videoWidth || this.config.analysisWidth;
          const vh = this.videoElement.videoHeight || this.config.analysisHeight;
          
          // Draw to canvas at reduced resolution
          this.ctx.drawImage(
            this.videoElement, 
            0, 0, vw, vh, 
            0, 0, this.config.analysisWidth, this.config.analysisHeight
          );
          
          const imageData = this.ctx.getImageData(
            0, 0, 
            this.config.analysisWidth, 
            this.config.analysisHeight
          );

          // Update processing time stats
          const processingMs = performance.now() - t0;
          this.updateProcessingStats(processingMs);

          // Emit frame
          if (this.onFrame) {
            this.onFrame({
              imageData,
              timestamp: frameTime,
              frameNumber: this.frameNumber,
              timing: { ...this.timing }
            });
          }

          this.frameNumber++;
        }
      } catch (e) {
        console.error('FrameCaptureEngine: Frame processing error', e);
      }

      // Schedule next frame
      if (this.isRunning) {
        if (hasRVFC) {
          this.frameCallbackId = (this.videoElement as any).requestVideoFrameCallback(processImage);
        } else {
          this.frameCallbackId = requestAnimationFrame((t) => processImage(t));
        }
      }
    };

    // Start loop
    if (hasRVFC) {
      this.frameCallbackId = (this.videoElement as any).requestVideoFrameCallback(processImage);
    } else {
      this.frameCallbackId = requestAnimationFrame((t) => processImage(t));
    }

    console.log('FrameCaptureEngine: Started capture');
  }

  /**
   * Stop capture loop
   */
  stop(): void {
    this.isRunning = false;
    
    if (this.frameCallbackId !== null) {
      if ('cancelVideoFrameCallback' in HTMLVideoElement.prototype) {
        (this.videoElement as any)?.cancelVideoFrameCallback(this.frameCallbackId);
      } else {
        cancelAnimationFrame(this.frameCallbackId);
      }
      this.frameCallbackId = null;
    }

    this.onFrame = null;
    console.log('FrameCaptureEngine: Stopped capture');
  }

  /**
   * Get current timing statistics
   */
  getTiming(): FrameTiming {
    return { ...this.timing };
  }

  /**
   * Reset timing statistics
   */
  private resetTiming(): void {
    this.timing = {
      lastCaptureTime: 0,
      realFps: 0,
      droppedFrames: 0,
      frameCount: 0,
      avgProcessingMs: 0
    };
    this.processingTimes = [];
  }

  /**
   * Update processing time statistics
   */
  private updateProcessingStats(ms: number): void {
    this.processingTimes.push(ms);
    if (this.processingTimes.length > this.MAX_PROCESSING_SAMPLES) {
      this.processingTimes.shift();
    }
    
    const sum = this.processingTimes.reduce((a, b) => a + b, 0);
    this.timing.avgProcessingMs = sum / this.processingTimes.length;
  }

  /**
   * Check if capture is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get configuration
   */
  getConfig(): CaptureConfig {
    return { ...this.config };
  }
}
