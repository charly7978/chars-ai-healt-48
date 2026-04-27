export interface PPGCameraState {
  stream: MediaStream | null;
  videoTrack: MediaStreamTrack | null;
  capabilities: MediaTrackCapabilities | null;
  settings: MediaTrackSettings | null;
  constraints: MediaTrackConstraints | null;
  torchAvailable: boolean;
  torchEnabled: boolean;
  torchApplied: boolean;
  cameraReady: boolean;
  streamActive: boolean;
  measuredFps: number;
  width: number;
  height: number;
  selectedDeviceId: string | null;
  error: string | null;
  lastError: string | null;
}

const REQUESTED_VIDEO: MediaTrackConstraints = {
  facingMode: { ideal: "environment" },
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

const EXACT_ENVIRONMENT: MediaTrackConstraints = {
  facingMode: { exact: "environment" },
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };
type TorchConstraintSet = MediaTrackConstraintSet & { torch?: boolean };

function torchConstraint(enabled: boolean): MediaTrackConstraints {
  return { advanced: [{ torch: enabled } as TorchConstraintSet] };
}

function emptyState(error: string | null = null, lastError: string | null = null): PPGCameraState {
  return {
    stream: null,
    videoTrack: null,
    capabilities: null,
    settings: null,
    constraints: null,
    torchAvailable: false,
    torchEnabled: false,
    torchApplied: false,
    cameraReady: false,
    streamActive: false,
    measuredFps: 0,
    width: 0,
    height: 0,
    selectedDeviceId: null,
    error,
    lastError: lastError ?? error,
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
  private lastError: string | null = null;
  private frameCount = 0;
  private lastFrameTime = 0;

  getState(): PPGCameraState {
    const state = { ...this.state };
    // Update dynamic stream state
    if (state.videoTrack) {
      state.streamActive = state.videoTrack.readyState === "live";
    }
    return state;
  }

  getDetailedState(): PPGCameraState & { frameCount: number; actualFps: number } {
    const now = performance.now();
    const dt = this.lastFrameTime > 0 ? now - this.lastFrameTime : 0;
    const actualFps = dt > 0 ? 1000 / dt : 0;
    return {
      ...this.getState(),
      frameCount: this.frameCount,
      actualFps,
    };
  }

  recordFrame(): void {
    this.frameCount++;
    this.lastFrameTime = performance.now();
  }

  async start(): Promise<PPGCameraState> {
    // Reset state on every start attempt for clean acquisition
    this.state = emptyState(null, this.lastError);
    this.frameCount = 0;
    this.lastFrameTime = 0;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera API not supported by this browser");
      }

      const { stream, constraints, deviceId } = await this.openRearCamera();

      const videoTrack = stream.getVideoTracks()[0] ?? null;
      if (!videoTrack) {
        throw new Error("No video track received from camera");
      }

      // Capture capabilities and settings BEFORE torch manipulation
      let capabilities: MediaTrackCapabilities | null = null;
      let settings: MediaTrackSettings | null = null;
      try {
        capabilities = videoTrack.getCapabilities();
      } catch (e) {
        console.warn("[PPGCamera] getCapabilities failed:", e);
      }

      try {
        settings = videoTrack.getSettings();
      } catch (e) {
        console.warn("[PPGCamera] getSettings failed:", e);
      }

      // Determine torch availability from capabilities
      const torchCap = (capabilities as TorchCapabilities | null)?.torch;
      const torchAvailable = torchCap === true || torchCap === undefined; // undefined = might support but not exposed

      let torchEnabled = false;
      let torchApplied = false;

      // Apply torch if available - verify by re-reading settings
      if (torchAvailable) {
        try {
          await videoTrack.applyConstraints(torchConstraint(true));
          // Verify torch was actually applied
          const newSettings = videoTrack.getSettings();
          // @ts-expect-error - torch may exist in some browsers
          torchEnabled = newSettings?.torch === true || newSettings?.fillLightMode === "flash";
          torchApplied = true;
          console.log("[PPGCamera] Torch applied:", torchEnabled, "settings:", newSettings);
        } catch (e) {
          console.warn("[PPGCamera] Torch apply failed:", e);
          torchEnabled = false;
          torchApplied = false;
        }
      }

      const width = settings?.width ?? 0;
      const height = settings?.height ?? 0;

      this.state = {
        stream,
        videoTrack,
        capabilities,
        settings,
        constraints,
        torchAvailable,
        torchEnabled,
        torchApplied,
        cameraReady: true,
        streamActive: videoTrack.readyState === "live",
        measuredFps: settings?.frameRate ?? 0,
        width,
        height,
        selectedDeviceId: deviceId,
        error: null,
        lastError: this.lastError,
      };

      console.log("[PPGCamera] Started:", {
        deviceId,
        resolution: `${width}x${height}`,
        fps: settings?.frameRate,
        torch: { available: torchAvailable, enabled: torchEnabled, applied: torchApplied },
      });

      return this.getState();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;
      this.state = emptyState(errorMsg, this.lastError);
      return this.getState();
    }
  }

  async stop(): Promise<void> {
    const current = this.state;
    const track = current.videoTrack;

    // Attempt to disable torch before stopping
    if (track && track.readyState === "live") {
      try {
        const capabilities = track.getCapabilities() as TorchCapabilities;
        if (capabilities?.torch) {
          await track.applyConstraints(torchConstraint(false));
          console.log("[PPGCamera] Torch disabled");
        }
      } catch {
        // Torch shutdown is best-effort; track.stop below is authoritative.
      }
    }

    // Stop all tracks
    current.stream?.getTracks().forEach((mediaTrack) => {
      try {
        mediaTrack.stop();
      } catch {
        // Ignore stop errors
      }
    });

    this.state = emptyState(null, this.lastError);
    this.frameCount = 0;
    this.lastFrameTime = 0;
    console.log("[PPGCamera] Stopped");
  }

  private async openRearCamera(): Promise<{ stream: MediaStream; constraints: MediaTrackConstraints; deviceId: string | null }> {
    // Attempt chain from most specific to most permissive
    const attempts: { constraints: MediaStreamConstraints; label: string }[] = [
      {
        label: "exact-environment-hd",
        constraints: {
          video: { ...EXACT_ENVIRONMENT },
          audio: false,
        },
      },
      {
        label: "ideal-environment-hd",
        constraints: {
          video: { ...REQUESTED_VIDEO },
          audio: false,
        },
      },
      {
        label: "exact-environment-sd",
        constraints: {
          video: {
            facingMode: { exact: "environment" },
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
          audio: false,
        },
      },
      {
        label: "any-environment",
        constraints: {
          video: { facingMode: "environment" },
          audio: false,
        },
      },
      {
        label: "fallback-any-video",
        constraints: {
          video: true,
          audio: false,
        },
      },
    ];

    let lastError: unknown = null;

    for (const attempt of attempts) {
      try {
        console.log(`[PPGCamera] Trying ${attempt.label}...`);
        const stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings();
        const deviceId = settings?.deviceId ?? null;

        // Validate it's actually a rear camera if possible
        const label = track?.label?.toLowerCase() ?? "";
        const isRear = label.includes("back") || label.includes("rear") || label.includes("environment") || label.includes("trasera");

        console.log(`[PPGCamera] Success with ${attempt.label}:`, {
          deviceId,
          label: track?.label,
          isRear,
          resolution: `${settings?.width}x${settings?.height}`,
        });

        return {
          stream,
          constraints: attempt.constraints.video as MediaTrackConstraints,
          deviceId,
        };
      } catch (error) {
        console.warn(`[PPGCamera] Failed ${attempt.label}:`, error);
        lastError = error;
      }
    }

    throw lastError ?? new Error("Failed to open rear camera after all attempts");
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
        console.log("[PPGCamera] Replacing ultra-wide with standard lens:", preferred.label);
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

  /**
   * Validate that the current stream is still active and usable
   */
  validateStream(): boolean {
    const track = this.state.videoTrack;
    if (!track) return false;
    if (track.readyState !== "live") return false;
    if (track.muted) return false;
    return true;
  }
}
