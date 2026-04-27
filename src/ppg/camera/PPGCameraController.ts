/**
 * PpgCameraController.ts
 * ----------------------------------------------------------------------------
 * Controlador principal de cámara para PPG.
 * 
 * Fases de inicialización:
 * 1. enumerateDevices → seleccionar cámara trasera
 * 2. getUserMedia → abrir stream con resolución alta
 * 3. attach video → esperar loadedmetadata
 * 4. startTorch → encender flash (gesto explícito)
 * 
 * Principios:
 * - Solo cámara trasera (environment)
 * - Resolución mínima 1280x720, ideal 1920x1080
 * - FPS ideal 60, mínimo aceptable 18
 * - No reiniciar cámara en cada render
 * - Stream único, no duplicar
 */

import type { CameraStatus, TorchStatus } from "../signal/PpgTypes";
import { TorchController } from "./TorchController";

export interface CameraCallbacks {
  onStatusChange: (status: CameraStatus, torchStatus: TorchStatus) => void;
  onError: (error: string, fatal: boolean) => void;
  onFrame: (video: HTMLVideoElement) => void;
}

export interface CameraConfig {
  targetWidth: number;
  targetHeight: number;
  minWidth: number;
  minHeight: number;
  targetFps: number;
  minFps: number;
}

const DEFAULT_CAMERA_CONFIG: CameraConfig = {
  targetWidth: 1920,
  targetHeight: 1080,
  minWidth: 1280,
  minHeight: 720,
  targetFps: 60,
  minFps: 18,
};

export class PpgCameraController {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private track: MediaStreamTrack | null = null;
  private torchController: TorchController | null = null;
  private callbacks: CameraCallbacks | null = null;
  private config: CameraConfig;
  
  private status: CameraStatus = {
    ready: false,
    error: null,
    videoWidth: 0,
    videoHeight: 0,
    fpsTarget: 30,
    fpsMeasured: 0,
    facingMode: "unknown",
    deviceId: null,
    label: "",
  };
  
  private isDestroyed = false;
  private frameCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastFrameTime = 0;

  constructor(config: Partial<CameraConfig> = {}) {
    this.config = { ...DEFAULT_CAMERA_CONFIG, ...config };
  }

  async start(videoElement: HTMLVideoElement, callbacks: CameraCallbacks): Promise<boolean> {
    if (this.isDestroyed) {
      callbacks.onError("CONTROLLER_DESTROYED", true);
      return false;
    }

    this.callbacks = callbacks;
    this.video = videoElement;

    const selectedDevice = await this.selectRearCamera();
    if (!selectedDevice) {
      callbacks.onError("NO_REAR_CAMERA_FOUND", true);
      return false;
    }

    const stream = await this.requestStream(selectedDevice.deviceId);
    if (!stream) {
      callbacks.onError("STREAM_REQUEST_FAILED", true);
      return false;
    }

    this.stream = stream;
    this.track = stream.getVideoTracks()[0];

    const attached = await this.attachVideo(stream);
    if (!attached) {
      this.cleanup();
      callbacks.onError("VIDEO_ATTACH_FAILED", true);
      return false;
    }

    this.torchController = new TorchController();
    this.torchController.attach(this.track, {
      onStateChange: (torchStatus) => {
        callbacks.onStatusChange({ ...this.status }, torchStatus);
      },
      onError: (error) => {
        callbacks.onError(error, false);
      },
    });

    const torchOk = await this.torchController.requestOn();
    if (!torchOk) {
      console.warn("[PpgCameraController] Torch could not be enabled, continuing without");
    }

    this.startFrameMonitoring();
    this.status.ready = true;
    callbacks.onStatusChange({ ...this.status }, this.torchController.getStatus());

    return true;
  }

  async stop(): Promise<void> {
    this.stopFrameMonitoring();
    
    if (this.torchController) {
      await this.torchController.turnOff();
      this.torchController.destroy();
      this.torchController = null;
    }

    this.cleanup();
    
    this.status = {
      ready: false,
      error: null,
      videoWidth: 0,
      videoHeight: 0,
      fpsTarget: 30,
      fpsMeasured: 0,
      facingMode: "unknown",
      deviceId: null,
      label: "",
    };
  }

  destroy(): void {
    this.isDestroyed = true;
    this.stop();
    this.callbacks = null;
    this.video = null;
  }

  getStatus(): { camera: CameraStatus; torch: TorchStatus | null } {
    return {
      camera: { ...this.status },
      torch: this.torchController?.getStatus() ?? null,
    };
  }

  getTrack(): MediaStreamTrack | null {
    return this.track;
  }

  getVideo(): HTMLVideoElement | null {
    return this.video;
  }

  private async selectRearCamera(): Promise<MediaDeviceInfo | null> {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
      tempStream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter(d => d.kind === "videoinput");

      if (cameras.length === 0) return null;

      const rearCamera = cameras.find(c => {
        const label = c.label.toLowerCase();
        return label.includes("back") || 
               label.includes("rear") || 
               label.includes("trasera") ||
               label.includes("environment");
      });

      if (rearCamera) return rearCamera;
      return cameras[0];
    } catch (e) {
      console.error("[PpgCameraController] Device enumeration failed:", e);
      return null;
    }
  }

  private async requestStream(deviceId: string): Promise<MediaStream | null> {
    const constraints: MediaStreamConstraints = {
      video: {
        deviceId: { ideal: deviceId },
        width: { ideal: this.config.targetWidth, min: this.config.minWidth },
        height: { ideal: this.config.targetHeight, min: this.config.minHeight },
        frameRate: { ideal: this.config.targetFps, min: this.config.minFps },
        facingMode: { ideal: "environment" },
      },
      audio: false,
    };

    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      try {
        const fallbackConstraints: MediaStreamConstraints = {
          video: {
            deviceId: { ideal: deviceId },
            width: { min: this.config.minWidth },
            height: { min: this.config.minHeight },
            frameRate: { min: this.config.minFps },
          },
          audio: false,
        };
        return await navigator.mediaDevices.getUserMedia(fallbackConstraints);
      } catch (e2) {
        console.error("[PpgCameraController] getUserMedia failed:", e2);
        return null;
      }
    }
  }

  private async attachVideo(stream: MediaStream): Promise<boolean> {
    if (!this.video) return false;

    this.video.srcObject = stream;
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;

    try {
      await this.video.play();
    } catch (e) {
      console.error("[PpgCameraController] video.play() failed:", e);
      return false;
    }

    return new Promise((resolve) => {
      const checkReady = () => {
        if (!this.video) {
          resolve(false);
          return;
        }

        const width = this.video.videoWidth;
        const height = this.video.videoHeight;

        if (width > 0 && height > 0) {
          this.status.videoWidth = width;
          this.status.videoHeight = height;
          this.status.fpsTarget = this.config.targetFps;
          
          const settings = this.track?.getSettings();
          this.status.facingMode = settings?.facingMode as any || "unknown";
          this.status.deviceId = settings?.deviceId || null;
          this.status.label = this.track?.label || "";
          
          resolve(true);
        } else {
          setTimeout(checkReady, 50);
        }
      };

      setTimeout(() => resolve(false), 5000);
      checkReady();
    });
  }

  private startFrameMonitoring(): void {
    this.lastFrameTime = performance.now();
    
    this.frameCheckInterval = setInterval(() => {
      if (!this.video || !this.callbacks) return;

      const now = performance.now();
      const currentTime = this.video.currentTime;
      
      if (currentTime > this.lastFrameTime) {
        const dt = now - this.lastFrameTime;
        const fps = 1000 / dt;
        this.status.fpsMeasured = fps;
        this.lastFrameTime = now;
        
        this.callbacks.onFrame(this.video);
      }

      if (this.track && this.track.readyState === "ended") {
        this.callbacks.onError("TRACK_ENDED", false);
        this.stop();
      }
    }, 1000 / 30);
  }

  private stopFrameMonitoring(): void {
    if (this.frameCheckInterval) {
      clearInterval(this.frameCheckInterval);
      this.frameCheckInterval = null;
    }
  }

  private cleanup(): void {
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    this.track = null;
  }
}