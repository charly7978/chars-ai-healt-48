export interface PPGCameraState {
  stream: MediaStream | null;
  videoTrack: MediaStreamTrack | null;
  capabilities: MediaTrackCapabilities | null;
  settings: MediaTrackSettings | null;
  torchAvailable: boolean;
  torchEnabled: boolean;
  cameraReady: boolean;
  error: string | null;
}

const REQUESTED_VIDEO: MediaTrackConstraints = {
  facingMode: { ideal: "environment" },
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 60, min: 30 },
};

type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };
type TorchConstraintSet = MediaTrackConstraintSet & { torch?: boolean };

function torchConstraint(enabled: boolean): MediaTrackConstraints {
  return { advanced: [{ torch: enabled } as TorchConstraintSet] };
}

function emptyState(error: string | null = null): PPGCameraState {
  return {
    stream: null,
    videoTrack: null,
    capabilities: null,
    settings: null,
    torchAvailable: false,
    torchEnabled: false,
    cameraReady: false,
    error,
  };
}

function isLikelyRearCamera(device: MediaDeviceInfo): boolean {
  const label = device.label.toLowerCase();
  return (
    label.includes("back") ||
    label.includes("rear") ||
    label.includes("environment") ||
    label.includes("trasera") ||
    label.includes("posterior")
  );
}

function isLikelyUltraWide(device: MediaDeviceInfo): boolean {
  const label = device.label.toLowerCase();
  return (
    label.includes("ultra") ||
    label.includes("wide") ||
    label.includes("0.5") ||
    label.includes("0,5")
  );
}

export class PPGCameraController {
  private state: PPGCameraState = emptyState();
  private torchAttempted = false;

  getState(): PPGCameraState {
    return { ...this.state };
  }

  hasTorchAttempted(): boolean {
    return this.torchAttempted;
  }

  async start(): Promise<PPGCameraState> {
    if (this.state.stream && this.state.videoTrack?.readyState === "live") {
      return this.getState();
    }

    this.state = emptyState();
    this.torchAttempted = false;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("getUserMedia no soportado por este navegador");
      }

      let stream = await this.openRearCamera();
      stream = await this.replaceUltraWideIfPossible(stream);

      const videoTrack = stream.getVideoTracks()[0] ?? null;
      if (!videoTrack) {
        throw new Error("La camara no entrego un video track");
      }

      let capabilities: MediaTrackCapabilities | null = null;
      let settings: MediaTrackSettings | null = null;
      try {
        capabilities = videoTrack.getCapabilities();
      } catch {
        capabilities = null;
      }

      const torchAvailable = Boolean((capabilities as TorchCapabilities | null)?.torch);
      let torchEnabled = false;
      this.torchAttempted = true;

      if (torchAvailable) {
        try {
          await videoTrack.applyConstraints(torchConstraint(true));
          torchEnabled = true;
        } catch {
          torchEnabled = false;
        }
      }

      try {
        settings = videoTrack.getSettings();
      } catch {
        settings = null;
      }

      this.state = {
        stream,
        videoTrack,
        capabilities,
        settings,
        torchAvailable,
        torchEnabled,
        cameraReady: true,
        error: null,
      };

      return this.getState();
    } catch (error) {
      this.state = emptyState(error instanceof Error ? error.message : String(error));
      return this.getState();
    }
  }

  async stop(): Promise<void> {
    const current = this.state;
    const track = current.videoTrack;

    if (track && track.readyState === "live") {
      try {
        const capabilities = track.getCapabilities() as TorchCapabilities;
        if (capabilities?.torch) {
          await track.applyConstraints(torchConstraint(false));
        }
      } catch {
        // Torch shutdown is best-effort; track.stop below is authoritative.
      }
    }

    current.stream?.getTracks().forEach((mediaTrack) => mediaTrack.stop());
    this.state = emptyState();
    this.torchAttempted = false;
  }

  private async openRearCamera(): Promise<MediaStream> {
    const attempts: MediaStreamConstraints[] = [
      {
        video: {
          ...REQUESTED_VIDEO,
          facingMode: { exact: "environment" },
        },
        audio: false,
      },
      {
        video: REQUESTED_VIDEO,
        audio: false,
      },
      {
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60, min: 30 },
        },
        audio: false,
      },
      {
        video: { facingMode: "environment" },
        audio: false,
      },
    ];

    let lastError: unknown = null;
    for (const constraints of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error("No se pudo abrir la camara trasera");
  }

  private async replaceUltraWideIfPossible(stream: MediaStream): Promise<MediaStream> {
    try {
      const currentTrack = stream.getVideoTracks()[0];
      const currentLabel = currentTrack?.label.toLowerCase() ?? "";
      const devices = await navigator.mediaDevices.enumerateDevices();
      const rearCameras = devices
        .filter((device) => device.kind === "videoinput")
        .filter(isLikelyRearCamera);
      const preferred = rearCameras.find((device) => !isLikelyUltraWide(device));

      if (
        preferred?.deviceId &&
        currentLabel &&
        (currentLabel.includes("ultra") || currentLabel.includes("wide")) &&
        !currentLabel.includes(preferred.label.toLowerCase())
      ) {
        const replacement = await navigator.mediaDevices.getUserMedia({
          video: {
            ...REQUESTED_VIDEO,
            deviceId: { exact: preferred.deviceId },
          },
          audio: false,
        });
        stream.getTracks().forEach((track) => track.stop());
        return replacement;
      }
    } catch {
      // Device labels and deviceId selection are browser-dependent.
    }

    return stream;
  }
}
