import type { CameraStatus, TorchStatus } from "../signal/PpgTypes";
import { TorchController } from "./TorchController";
import type { TorchStatus as TorchControllerStatus } from "./TorchController";

export interface CameraConfig {
  facingMode: "environment" | "user";
  width: number;
  height: number;
  frameRate: number;
}

export interface CameraCallbacks {
  onStatusChange: (camera: CameraStatus, torch: TorchStatus) => void;
  onError: (error: string, fatal: boolean) => void;
  onFrame?: (video: HTMLVideoElement) => void;
}

const DEFAULT_CAMERA_CONFIG: CameraConfig = {
  facingMode: "environment",
  width: 1280,
  height: 720,
  frameRate: 30,
};

function createCameraStatus(overrides: Partial<CameraStatus> = {}): CameraStatus {
  return {
    ready: false,
    error: null,
    videoWidth: 0,
    videoHeight: 0,
    fpsTarget: DEFAULT_CAMERA_CONFIG.frameRate,
    fpsMeasured: 0,
    facingMode: "unknown",
    deviceId: null,
    label: "",
    ...overrides,
  };
}

function createTorchStatus(overrides: Partial<TorchStatus> = {}): TorchStatus {
  return {
    state: "OFF",
    available: false,
    lastError: null,
    watchdogActive: false,
    ...overrides,
  };
}

function mapTorchStatus(status: TorchControllerStatus): TorchStatus {
  return {
    state: status.state,
    available: status.available,
    lastError: status.lastError,
    watchdogActive: status.watchdogActive,
  };
}

export class PpgCameraController {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private callbacks: CameraCallbacks | null = null;
  private torchController: TorchController | null = null;
  private cameraStatus = createCameraStatus();
  private torchStatus = createTorchStatus();

  async start(
    video: HTMLVideoElement,
    callbacks: CameraCallbacks,
    config: CameraConfig = DEFAULT_CAMERA_CONFIG,
  ): Promise<boolean> {
    this.stop();
    this.video = video;
    this.callbacks = callbacks;
    this.cameraStatus = createCameraStatus({
      fpsTarget: config.frameRate,
      facingMode: config.facingMode,
    });
    this.torchStatus = createTorchStatus();
    this.notifyStatus();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: config.facingMode },
          width: { ideal: config.width },
          height: { ideal: config.height },
          frameRate: { ideal: config.frameRate },
        },
      });

      this.stream = stream;
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();

      const track = stream.getVideoTracks()[0];
      if (!track) {
        this.fail("NO_VIDEO_TRACK", true);
        return false;
      }

      const settings = track.getSettings();
      this.cameraStatus = createCameraStatus({
        ready: true,
        videoWidth: video.videoWidth || settings.width || 0,
        videoHeight: video.videoHeight || settings.height || 0,
        fpsTarget: config.frameRate,
        fpsMeasured: settings.frameRate ?? 0,
        facingMode: settings.facingMode === "user" || settings.facingMode === "environment"
          ? settings.facingMode
          : config.facingMode,
        deviceId: settings.deviceId ?? null,
        label: track.label,
      });

      this.torchController = new TorchController();
      this.torchController.attach(track, {
        onStateChange: (status) => {
          this.torchStatus = mapTorchStatus(status);
          this.notifyStatus();
        },
        onError: (error) => {
          this.torchStatus = { ...this.torchStatus, lastError: error };
          callbacks.onError(error, false);
          this.notifyStatus();
        },
      });

      if (this.torchStatus.available) {
        await this.torchController.requestOn();
      }

      callbacks.onFrame?.(video);
      this.notifyStatus();
      return true;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error), true);
      return false;
    }
  }

  stop(): void {
    this.torchController?.destroy();
    this.torchController = null;

    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }
    this.stream = null;

    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }

    this.cameraStatus = createCameraStatus();
    this.torchStatus = createTorchStatus();
    this.notifyStatus();
  }

  destroy(): void {
    this.stop();
    this.callbacks = null;
    this.video = null;
  }

  private fail(error: string, fatal: boolean): void {
    this.cameraStatus = createCameraStatus({ error });
    this.notifyStatus();
    this.callbacks?.onError(error, fatal);
    if (fatal) this.stop();
  }

  private notifyStatus(): void {
    this.callbacks?.onStatusChange(this.cameraStatus, this.torchStatus);
  }
}
