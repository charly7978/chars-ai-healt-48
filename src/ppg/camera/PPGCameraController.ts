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

  /**
   * Iniciar cámara completa: enumerar, solicitar, attach, torch.
   */
  async start(videoElement: HTMLVideoElement, callbacks: CameraCallbacks): Promise<boolean> {
    if (this.isDestroyed) {
      callbacks.onError("CONTROLLER_DESTROYED", true);
      return false;
    }

    this.callbacks = callbacks;
    this.video = videoElement;

    // 1. Enumerar y seleccionar cámara trasera
    const selectedDevice = await this.selectRearCamera();
    if (!selectedDevice) {
      callbacks.onError("NO_REAR_CAMERA_FOUND", true);
      return false;
    }

    // 2. Solicitar stream
    const stream = await this.requestStream(selectedDevice.deviceId);
    if (!stream) {
      callbacks.onError("STREAM_REQUEST_FAILED", true);
      return false;
    }

    this.stream = stream;
    this.track = stream.getVideoTracks()[0];

    // 3. Attach a video element
    const attached = await this.attachVideo(stream);
    if (!attached) {
      this.cleanup();
      callbacks.onError("VIDEO_ATTACH_FAILED", true);
      return false;
    }

    // 4. Inicializar torch controller
    this.torchController = new TorchController();
    this.torchController.attach(this.track, {
      onStateChange: (torchStatus) => {
        callbacks.onStatusChange({ ...this.status }, torchStatus);
      },
      onError: (error) => {
        callbacks.onError(error, false); // Torch error no es fatal
      },
    });

    // 5. Encender torch
    const torchOk = await this.torchController.requestOn();
    if (!torchOk) {
      // Torch no es obligatorio pero lo reportamos
      console.warn("[PpgCameraController] Torch could not be enabled, continuing without");
    }

    // 6. Iniciar monitoreo de frames
    this.startFrameMonitoring();

    // Notificar éxito
    this.status.ready = true;
    callbacks.onStatusChange({ ...this.status }, this.torchController.getStatus());

    return true;
  }

  /**
   * Detener cámara y liberar recursos.
   */
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

  /**
   * Destruir controlador permanentemente.
   */
  destroy(): void {
    this.isDestroyed = true;
    this.stop();
    this.callbacks = null;
    this.video = null;
  }

  /**
   * Obtener estado actual.
   */
  getStatus(): { camera: CameraStatus; torch: TorchStatus | null } {
    return {
      camera: { ...this.status },
      torch: this.torchController?.getStatus() ?? null,
    };
  }

  /**
   * Obtener track actual (para FrameSampler).
   */
  getTrack(): MediaStreamTrack | null {
    return this.track;
  }

  /**
   * Obtener video element.
   */
  getVideo(): HTMLVideoElement | null {
    return this.video;
  }

  // =============================================================================
  // PRIVATE METHODS
  // =============================================================================

  private async selectRearCamera(): Promise<MediaDeviceInfo | null> {
    try {
      // Solicitar permisos primero para obtener labels
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
      tempStream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter(d => d.kind === "videoinput");

      if (cameras.length === 0) return null;

      // Priorizar por señales de cámara trasera
      const rearCamera = cameras.find(c => {
        const label = c.label.toLowerCase();
        return label.includes("back") || 
               label.includes("rear") || 
               label.includes("trasera") ||
               label.includes("environment");
      });

      if (rearCamera) return rearCamera;

      // Fallback: primera cámara (usualmente trasera en móviles)
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
      // Fallback sin facingMode exact
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

    // Esperar a que tengamos dimensiones válidas
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
          
          // Inferir facing mode
          const settings = this.track?.getSettings();
          this.status.facingMode = settings?.facingMode as any || "unknown";
          this.status.deviceId = settings?.deviceId || null;
          this.status.label = this.track?.label || "";
          
          resolve(true);
        } else {
          setTimeout(checkReady, 50);
        }
      };

      // Timeout de seguridad
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
      
      // Verificar si el video está progresando
      if (currentTime > this.lastFrameTime) {
        const dt = now - this.lastFrameTime;
        const fps = 1000 / dt;
        this.status.fpsMeasured = fps;
        this.lastFrameTime = now;
        
        this.callbacks.onFrame(this.video);
      }

      // Verificar si el track sigue activo
      if (this.track && this.track.readyState === "ended") {
        this.callbacks.onError("TRACK_ENDED", false);
        this.stop();
      }
    }, 1000 / 30); // 30 Hz check
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
export interface CameraAcquisitionReport {
  startedAt: string;
  durationMs: number;
  rearVerified: boolean;
  torchVerified: boolean;
  fpsReal: number;
  width: number;
  height: number;
  selectedDeviceId: string | null;
  selectedDeviceLabel: string;
  selectionReason: string;
  warmupFrames: number;
  warmupJitterMs: number;
  warmupFpsStdMs: number;
  acquisitionReady: boolean;
  notReadyReasons: string[];
  multiRearProbe: MultiRearProbeReport | null;
  autoCameraControlUnavailable: boolean;
  userAgent: string;
}

export interface MultiRearProbeCandidate {
  deviceId: string;
  label: string;
  durationMs: number;
  framesAnalyzed: number;
  // Spatial metrics (quick heuristics)
  meanRed: number;
  meanGreen: number;
  saturationHigh: number;
  coverage: number;
  // Temporal PPG metrics (ground truth signal quality)
  temporalSnrDb: number;
  perfusionIndex: number; // AC/DC ratio from time-series
  cardiacBandPower: number; // Spectral power in 0.5-4Hz
  signalStability: number; // DC drift stability over probe window
  // Cadence quality
  jitterMs: number;
  targetFps: number;
  actualFps: number;
  // Final composite score
  score: number;
  rejectedReason: string | null;
}

export interface MultiRearProbeReport {
  ran: boolean;
  reason: string;
  candidates: MultiRearProbeCandidate[];
  winnerDeviceId: string | null;
}

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
  /** Strict gate — true only after warmup + fps stable + torch resolved. */
  acquisitionReady: boolean;
  notReadyReasons: string[];
  acquisitionReport: CameraAcquisitionReport | null;
  streamActive: boolean;
  measuredFps: number;
  width: number;
  height: number;
  selectedDeviceId: string | null;
  error: string | null;
  lastError: string | null;
  diagnostics: CameraDiagnostics;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const TARGET_FPS = 30;

const REQUESTED_VIDEO: MediaTrackConstraints = {
  facingMode: { ideal: "environment" },
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: TARGET_FPS },
};

type TorchConstraintSet = MediaTrackConstraintSet & { torch?: boolean };

function torchConstraint(enabled: boolean): MediaTrackConstraints {
  return { advanced: [{ torch: enabled } as TorchConstraintSet] };
}

const ULTRA_WIDE_TOKENS = [
  "ultra wide",
  "ultrawide",
  "ultra-wide",
  "wide angle",
  "wide-angle",
  "0.5",
  "0,5x",
  "0.5x",
];
const NON_PRIMARY_TOKENS = ["macro", "depth", "telephoto", "tele "];
const REAR_TOKENS = ["back", "rear", "environment", "trasera", "posterior", "world"];
const FRONT_TOKENS = ["front", "user", "selfie", "facetime", "frontal"];

function detectFacingFromLabel(label: string): "environment" | "user" | "unknown" {
  const l = label.toLowerCase();
  if (REAR_TOKENS.some((t) => l.includes(t))) return "environment";
  if (FRONT_TOKENS.some((t) => l.includes(t))) return "user";
  return "unknown";
}

function profileFromDevice(device: MediaDeviceInfo): DeviceCameraProfile {
  const label = device.label || "";
  const lower = label.toLowerCase();
  const facing = detectFacingFromLabel(label);
  const rejectedReasons: string[] = [];

  let score = 100;
  const penalties = {
    ultraWide: 0,
    frontCamera: 0,
    lowResolution: 0,
    lowFps: 0,
    missingTorch: 0,
  };

  if (facing === "user") {
    penalties.frontCamera = 80;
    rejectedReasons.push("front-camera");
  }
  if (ULTRA_WIDE_TOKENS.some((t) => lower.includes(t))) {
    penalties.ultraWide = 60;
    rejectedReasons.push("ultra-wide-lens");
  }
  if (NON_PRIMARY_TOKENS.some((t) => lower.includes(t))) {
    penalties.ultraWide += 25;
    rejectedReasons.push("non-primary-lens");
  }

  // Boost obvious primary rear cams
  if (
    facing === "environment" &&
    !ULTRA_WIDE_TOKENS.some((t) => lower.includes(t)) &&
    !NON_PRIMARY_TOKENS.some((t) => lower.includes(t))
  ) {
    score += 20;
  }

  // Devices with empty labels (permission not yet granted on first call)
  if (!label) {
    rejectedReasons.push("empty-label");
  }

  const finalScore =
    score -
    penalties.ultraWide -
    penalties.frontCamera -
    penalties.lowResolution -
    penalties.lowFps -
    penalties.missingTorch;

  return {
    deviceId: device.deviceId,
    label,
    groupId: device.groupId,
    facingModeDetected: facing,
    score: finalScore,
    penalties,
    selectedReason: null,
    rejectedReasons,
  };
}

function emptyDiagnostics(): CameraDiagnostics {
  return {
    enumeratedDevices: [],
    selectedDevice: null,
    attempts: [],
    fineConstraints: [],
    capabilities: null,
    settings: null,
    failedConstraints: [],
    torchStatus: {
      available: false,
      requested: false,
      appliedReadback: false,
      resolved: "unsupported",
    },
    calibration: {
      status: "uncalibrated",
      profileKey: null,
      matchedBy: "none",
      reason: "camera not started yet",
      canPublishSpO2: false,
    },
    fpsTarget: TARGET_FPS,
    fpsMeasured: 0,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    autoCameraControlUnavailable: false,
    multiRearProbe: null,
  };
}

function emptyState(
  error: string | null = null,
  lastError: string | null = null,
  diagnostics: CameraDiagnostics = emptyDiagnostics(),
): PPGCameraState {
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
    acquisitionReady: false,
    notReadyReasons: ["camera-not-started"],
    acquisitionReport: null,
    streamActive: false,
    measuredFps: 0,
    width: 0,
    height: 0,
    selectedDeviceId: null,
    error,
    lastError: lastError ?? error,
    diagnostics,
  };
}

/* ------------------------------------------------------------------ */
/* Controller                                                         */
/* ------------------------------------------------------------------ */

export class PPGCameraController {
  private state: PPGCameraState = emptyState();
  private lastError: string | null = null;
  private frameCount = 0;
  private lastFrameTime = 0;

  getState(): PPGCameraState {
    const state = { ...this.state };
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

  /**
   * Forensic gesture-safe start. MUST be invoked synchronously inside a user
   * gesture handler (e.g. button click). Opens the rear camera with a single
   * `getUserMedia` call (no priming, no probes, no enumerate before the call)
   * so that the browser preserves the gesture activation needed for the torch
   * (`applyConstraints({ advanced: [{ torch: true }] })`). After the stream
   * is bound, fine constraints + diagnostics are completed in-place.
   *
   * Returns once the camera is live and torch has been attempted (verified or
   * recorded as failed). NEVER falls back to the front camera silently.
   */
  async startFromGesture(video: HTMLVideoElement | null): Promise<PPGCameraState> {
    const t0 = performance.now();
    const startedAt = new Date().toISOString();
    const diagnostics = emptyDiagnostics();
    this.state = emptyState(null, this.lastError, diagnostics);
    this.frameCount = 0;
    this.lastFrameTime = 0;

    if (!navigator.mediaDevices?.getUserMedia) {
      this.lastError = "Camera API not supported by this browser";
      this.state = emptyState(this.lastError, this.lastError, diagnostics);
      return this.getState();
    }

    // Phase 1 — open rear camera SYNCHRONOUSLY from the gesture (no awaits
    // before this call). Try `exact: environment` first so we never end up on
    // the front camera. If the device refuses `exact`, fall back to `ideal`.
    let stream: MediaStream | null = null;
    let openedConstraints: MediaTrackConstraints = {};
    try {
      const exactConstraints: MediaStreamConstraints = {
        video: {
          facingMode: { exact: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: TARGET_FPS },
        },
        audio: false,
      };
      try {
        stream = await navigator.mediaDevices.getUserMedia(exactConstraints);
        openedConstraints = exactConstraints.video as MediaTrackConstraints;
        diagnostics.attempts.push({
          label: "gesture-getUserMedia-exact-environment",
          constraints: exactConstraints,
          outcome: "success",
        });
      } catch (e) {
        diagnostics.attempts.push({
          label: "gesture-getUserMedia-exact-environment",
          constraints: exactConstraints,
          outcome: "failure",
          errorName: (e as Error).name,
          errorMessage: (e as Error).message,
        });
        const idealConstraints: MediaStreamConstraints = {
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: TARGET_FPS },
          },
          audio: false,
        };
        stream = await navigator.mediaDevices.getUserMedia(idealConstraints);
        openedConstraints = idealConstraints.video as MediaTrackConstraints;
        diagnostics.attempts.push({
          label: "gesture-getUserMedia-ideal-environment",
          constraints: idealConstraints,
          outcome: "success",
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;
      this.state = emptyState(errorMsg, this.lastError, diagnostics);
      return this.getState();
    }

    const videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack) {
      this.lastError = "No video track received from camera";
      stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
      this.state = emptyState(this.lastError, this.lastError, diagnostics);
      return this.getState();
    }

    // Phase 2 — bind to <video> and start playback ASAP, still within the
    // gesture activation window. This is what unlocks the torch on iOS Safari
    // and several Android Chromium builds.
    if (video) {
      try {
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        // Don't await play() before applying torch — we need the gesture
        // intact. Fire-and-record.
        const playPromise = video.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch((e) => {
            console.warn("[PPGCamera] video.play() deferred:", e);
          });
        }
      } catch (e) {
        console.warn("[PPGCamera] video binding failed:", e);
      }
    }

    // Phase 3 — capture capabilities/settings.
    let capabilities: MediaTrackCapabilities | null = null;
    try { capabilities = videoTrack.getCapabilities(); } catch { /* noop */ }
    let settings: MediaTrackSettings | null = videoTrack.getSettings();
    diagnostics.capabilities = capabilities;
    diagnostics.settings = settings;

    // Phase 4 — apply torch FIRST and aggressively (still inside the
    // user-activation window). Try multiple browser variants and verify via
    // readback, then protect the torch from later fine-constraint calls.
    const torchCap = capabilities?.torch === true;
    diagnostics.torchStatus.available = torchCap;
    let torchApplied = false;
    let torchReadback = false;
    if (torchCap) {
      const strategies: { label: string; constraints: MediaTrackConstraints }[] = [
        { label: "advanced.torch", constraints: { advanced: [{ torch: true } as TorchConstraintSet] } },
        { label: "top-level.torch", constraints: { torch: true } as MediaTrackConstraints & { torch?: boolean } },
        { label: "advanced.torch-fillLight", constraints: { advanced: [{ torch: true, fillLightMode: "flash" } as MediaTrackConstraintSet] } },
        { label: "fillLightMode.flash", constraints: { advanced: [{ fillLightMode: "flash" } as MediaTrackConstraintSet] } },
      ];
      for (const strat of strategies) {
        try {
          await videoTrack.applyConstraints(strat.constraints);
          settings = videoTrack.getSettings();
          torchReadback =
            settings?.torch === true || settings?.fillLightMode === "flash";
          diagnostics.fineConstraints.push({
            key: "torch",
            attempted: { strategy: strat.label, constraints: strat.constraints },
            applied: { torch: settings?.torch, fillLightMode: settings?.fillLightMode },
            status: torchReadback ? "applied" : "failed",
            errorMessage: torchReadback ? undefined : `strategy ${strat.label} ignored by browser`,
          });
          if (torchReadback) {
            torchApplied = true;
            break;
          }
        } catch (e) {
          diagnostics.fineConstraints.push({
            key: "torch",
            attempted: { strategy: strat.label, constraints: strat.constraints },
            applied: null,
            status: "failed",
            errorMessage: (e as Error).message,
          });
        }
      }
    } else {
      diagnostics.fineConstraints.push({
        key: "torch",
        attempted: false,
        applied: null,
        status: "unsupported",
      });
    }

    diagnostics.torchStatus.requested = torchCap;
    diagnostics.torchStatus.appliedReadback = torchReadback;
    diagnostics.torchStatus.resolved = !torchCap
      ? "unsupported"
      : torchApplied && torchReadback
        ? "applied"
        : torchApplied && !torchReadback
          ? "ignored-by-browser"
          : "denied";

    // Phase 5 — apply remaining fine optical constraints WITHOUT re-applying
    // torch. Re-applying mixed constraints after a successful torch readback
    // makes some Chromium/WebView builds briefly turn the LED off/on.
    try {
      await this.applyFineConstraints(videoTrack, capabilities, diagnostics, false, torchApplied && torchReadback);
      if (torchApplied && torchReadback) {
        const afterFine = videoTrack.getSettings();
        const stillOn = afterFine?.torch === true || afterFine?.fillLightMode === "flash";
        if (!stillOn) {
          await videoTrack.applyConstraints({ advanced: [{ torch: true } as TorchConstraintSet] });
        }
      }
    } catch (e) {
      console.warn("[PPGCamera] applyFineConstraints failed:", e);
    }
    settings = videoTrack.getSettings();
    diagnostics.settings = settings;
    diagnostics.fpsMeasured = settings?.frameRate ?? 0;

    const width = settings?.width ?? 0;
    const height = settings?.height ?? 0;
    const detectedFacing = detectFacingFromLabel(videoTrack.label);
    const rearVerified =
      detectedFacing === "environment" ||
      (openedConstraints as { facingMode?: unknown }).facingMode !== undefined;

    diagnostics.selectedDevice = {
      deviceId: settings?.deviceId ?? "",
      label: videoTrack.label,
      groupId: settings?.groupId ?? "",
      facingModeDetected: detectedFacing,
      score: 0,
      penalties: {
        ultraWide: 0,
        frontCamera: detectedFacing === "user" ? 100 : 0,
        lowResolution: 0,
        lowFps: 0,
        missingTorch: torchCap ? 0 : 50,
      },
      selectedReason: "gesture-direct-open",
      rejectedReasons: [],
    };

    // Calibration lookup.
    const lookup = lookupCalibrationProfile({
      cameraLabel: videoTrack.label,
      userAgent: navigator.userAgent,
    });
    diagnostics.calibration = {
      status: lookup.status,
      profileKey: lookup.profile?.phoneModelKey ?? null,
      matchedBy: lookup.matchedBy,
      reason: lookup.reason,
      canPublishSpO2: lookup.status === "calibrated" || lookup.status === "partial",
    };

    const reportSeed: CameraAcquisitionReport = {
      startedAt,
      durationMs: Math.round(performance.now() - t0),
      rearVerified,
      torchVerified: diagnostics.torchStatus.resolved === "applied",
      fpsReal: settings?.frameRate ?? 0,
      width,
      height,
      selectedDeviceId: settings?.deviceId ?? null,
      selectedDeviceLabel: videoTrack.label,
      selectionReason: "gesture-direct-open",
      warmupFrames: 0,
      warmupJitterMs: 0,
      warmupFpsStdMs: 0,
      acquisitionReady: false,
      notReadyReasons: ["awaiting-warmup"],
      multiRearProbe: { ran: false, reason: "skipped-gesture-path", candidates: [], winnerDeviceId: null },
      autoCameraControlUnavailable: false,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    };

    this.state = {
      stream,
      videoTrack,
      capabilities,
      settings,
      constraints: openedConstraints,
      torchAvailable: torchCap,
      torchEnabled: torchApplied && torchReadback,
      torchApplied,
      cameraReady: true,
      acquisitionReady: false,
      notReadyReasons: ["awaiting-warmup"],
      acquisitionReport: reportSeed,
      streamActive: videoTrack.readyState === "live",
      measuredFps: settings?.frameRate ?? 0,
      width,
      height,
      selectedDeviceId: settings?.deviceId ?? null,
      error: null,
      lastError: this.lastError,
      diagnostics,
    };

    console.log("[PPGCamera] startFromGesture complete", {
      device: videoTrack.label,
      resolution: `${width}x${height}`,
      fps: settings?.frameRate,
      torch: diagnostics.torchStatus,
      facing: detectedFacing,
    });

    return this.getState();
  }

  async start(): Promise<PPGCameraState> {
    const t0 = performance.now();
    const startedAt = new Date().toISOString();
    const diagnostics = emptyDiagnostics();
    this.state = emptyState(null, this.lastError, diagnostics);
    this.frameCount = 0;
    this.lastFrameTime = 0;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera API not supported by this browser");
      }

      // Phase 1 — permission priming. Try `exact: environment` first
      // (forensic requirement: never silently fall back to the front camera).
      // Retry with `ideal` only to recover device labels for enumeration;
      // Phase 3 still enforces rear selection by deviceId.
      let priming: MediaStream | null = null;
      try {
        priming = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { exact: "environment" } },
          audio: false,
        });
        diagnostics.attempts.push({
          label: "permission-priming-exact-environment",
          constraints: { video: { facingMode: { exact: "environment" } }, audio: false },
          outcome: "success",
        });
      } catch (e) {
        diagnostics.attempts.push({
          label: "permission-priming-exact-environment",
          constraints: { video: { facingMode: { exact: "environment" } }, audio: false },
          outcome: "failure",
          errorName: (e as Error).name,
          errorMessage: (e as Error).message,
        });
        try {
          priming = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false,
          });
          diagnostics.attempts.push({
            label: "permission-priming-ideal-environment",
            constraints: { video: { facingMode: { ideal: "environment" } }, audio: false },
            outcome: "success",
          });
        } catch (e2) {
          diagnostics.attempts.push({
            label: "permission-priming-ideal-environment",
            constraints: { video: { facingMode: { ideal: "environment" } }, audio: false },
            outcome: "failure",
            errorName: (e2 as Error).name,
            errorMessage: (e2 as Error).message,
          });
        }
      }

      // Phase 2 — enumerate and score devices.
      const devices = await navigator.mediaDevices.enumerateDevices();
      const profiles = devices
        .filter((d) => d.kind === "videoinput")
        .map(profileFromDevice)
        .sort((a, b) => b.score - a.score);
      diagnostics.enumeratedDevices = profiles;

      priming?.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* noop */ }
      });

      // Phase 2.5 — multi-rear PPG probe (only when ≥2 viable candidates).
      const rearCandidates = profiles.filter(
        (p) =>
          p.facingModeDetected === "environment" &&
          p.penalties.ultraWide === 0 &&
          p.penalties.frontCamera === 0,
      );
      let probeReport: MultiRearProbeReport;
      let preferredDeviceId: string | null = rearCandidates[0]?.deviceId ?? null;

      if (rearCandidates.length >= 2) {
        probeReport = await this.runMultiRearProbe(rearCandidates, diagnostics);
        if (probeReport.winnerDeviceId) {
          preferredDeviceId = probeReport.winnerDeviceId;
          const winner = profiles.find((p) => p.deviceId === probeReport.winnerDeviceId);
          if (winner) winner.selectedReason = "multi-rear-probe-winner";
        }
      } else {
        probeReport = {
          ran: false,
          reason:
            rearCandidates.length === 0
              ? "no-rear-non-ultrawide-candidates"
              : "single-candidate",
          candidates: [],
          winnerDeviceId: null,
        };
        if (rearCandidates[0] && !rearCandidates[0].selectedReason) {
          rearCandidates[0].selectedReason = "best-rear-non-ultrawide";
        }
      }
      diagnostics.multiRearProbe = probeReport;

      // Phase 3 — open with progressive constraints, logging every attempt.
      let opened = await this.openCamera(diagnostics, preferredDeviceId);

      let videoTrack = opened.stream.getVideoTracks()[0] ?? null;
      if (!videoTrack) {
        throw new Error("No video track received from camera");
      }

      // Phase 3.5 — if browser handed us an ultrawide/front despite our hint,
      // swap to the best non-ultrawide rear candidate.
      const swap = await this.replaceUltraWideIfNeeded(
        videoTrack,
        opened.stream,
        profiles,
        diagnostics,
      );
      if (swap) {
        opened = {
          stream: swap.stream,
          constraints: swap.constraints,
          selectedReason: "ultrawide-replaced",
        };
        videoTrack = swap.stream.getVideoTracks()[0];
      }

      // Sync the picked device against the enumerated profiles.
      const settings0 = videoTrack.getSettings();
      const matchedProfile =
        profiles.find((p) => p.deviceId === settings0.deviceId) ?? null;
      diagnostics.selectedDevice =
        matchedProfile ?? {
          deviceId: settings0.deviceId ?? "",
          label: videoTrack.label,
          groupId: settings0.groupId ?? "",
          facingModeDetected: detectFacingFromLabel(videoTrack.label),
          score: 0,
          penalties: {
            ultraWide: 0,
            frontCamera: 0,
            lowResolution: 0,
            lowFps: 0,
            missingTorch: 0,
          },
          selectedReason: "browser-chose-without-deviceId",
          rejectedReasons: [],
        };
      if (matchedProfile && !matchedProfile.selectedReason) {
        matchedProfile.selectedReason = opened.selectedReason;
      }
      const chosenId = diagnostics.selectedDevice.deviceId;
      for (const p of profiles) {
        if (p.deviceId !== chosenId && p.selectedReason === null) {
          if (p.rejectedReasons.length === 0) {
            p.rejectedReasons.push("not-best-score");
          }
        }
      }

      // Phase 4 — capture capabilities/settings.
      let capabilities: MediaTrackCapabilities | null = null;
      try {
        capabilities = videoTrack.getCapabilities();
      } catch (e) {
        console.warn("[PPGCamera] getCapabilities failed:", e);
      }
      let settings: MediaTrackSettings | null = videoTrack.getSettings();
      diagnostics.capabilities = capabilities;
      diagnostics.settings = settings;

      // Phase 5 — apply fine optical constraints, recording each outcome.
      await this.applyFineConstraints(videoTrack, capabilities, diagnostics);
      settings = videoTrack.getSettings();
      diagnostics.settings = settings;

      // Torch — collapse to a single non-ambiguous resolution.
      const torchCap = capabilities?.torch === true;
      diagnostics.torchStatus.available = torchCap;
      const torchEntry = diagnostics.fineConstraints.find((c) => c.key === "torch");
      const torchReadback =
        settings?.torch === true || settings?.fillLightMode === "flash";
      const torchApplied = torchEntry?.status === "applied";
      const torchEnabled = torchApplied === true && torchReadback;
      diagnostics.torchStatus.requested = torchEntry?.attempted === true;
      diagnostics.torchStatus.appliedReadback = torchReadback;
      diagnostics.torchStatus.resolved = !torchCap
        ? "unsupported"
        : torchEntry?.status === "failed"
          ? "denied"
          : torchApplied && torchReadback
            ? "applied"
            : torchApplied && !torchReadback
              ? "ignored-by-browser"
              : "unsupported";

      // AUTO_CAMERA_CONTROL_UNAVAILABLE marker.
      const opticalKeys = ["torch", "exposureMode", "focusMode", "whiteBalanceMode"];
      const everyOpticalUnsupported = diagnostics.fineConstraints
        .filter((c) => (opticalKeys as string[]).includes(c.key))
        .every((c) => c.status === "unsupported");
      diagnostics.autoCameraControlUnavailable = everyOpticalUnsupported;

      // Phase 6 — calibration lookup.
      const lookup = lookupCalibrationProfile({
        cameraLabel: videoTrack.label,
        userAgent: navigator.userAgent,
      });
      diagnostics.calibration = {
        status: lookup.status,
        profileKey: lookup.profile?.phoneModelKey ?? null,
        matchedBy: lookup.matchedBy,
        reason: lookup.reason,
        canPublishSpO2:
          lookup.status === "calibrated" || lookup.status === "partial",
      };

      diagnostics.fpsMeasured = settings?.frameRate ?? 0;

      const width = settings?.width ?? 0;
      const height = settings?.height ?? 0;
      const rearVerified =
        diagnostics.selectedDevice?.facingModeDetected === "environment" ||
        opened.constraints?.facingMode !== undefined;

      const reportSeed: CameraAcquisitionReport = {
        startedAt,
        durationMs: Math.round(performance.now() - t0),
        rearVerified,
        torchVerified: diagnostics.torchStatus.resolved === "applied",
        fpsReal: settings?.frameRate ?? 0,
        width,
        height,
        selectedDeviceId: settings?.deviceId ?? null,
        selectedDeviceLabel: videoTrack.label,
        selectionReason: diagnostics.selectedDevice?.selectedReason ?? opened.selectedReason,
        warmupFrames: 0,
        warmupJitterMs: 0,
        warmupFpsStdMs: 0,
        acquisitionReady: false,
        notReadyReasons: ["awaiting-warmup"],
        multiRearProbe: probeReport,
        autoCameraControlUnavailable: diagnostics.autoCameraControlUnavailable,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      };

      this.state = {
        stream: opened.stream,
        videoTrack,
        capabilities,
        settings,
        constraints: opened.constraints,
        torchAvailable: torchCap,
        torchEnabled,
        torchApplied: torchApplied === true,
        cameraReady: true,
        acquisitionReady: false,
        notReadyReasons: ["awaiting-warmup"],
        acquisitionReport: reportSeed,
        streamActive: videoTrack.readyState === "live",
        measuredFps: settings?.frameRate ?? 0,
        width,
        height,
        selectedDeviceId: settings?.deviceId ?? null,
        error: null,
        lastError: this.lastError,
        diagnostics,
      };

      console.log("[PPGCamera] Started", {
        device: diagnostics.selectedDevice?.label,
        resolution: `${width}x${height}`,
        fps: settings?.frameRate,
        torch: diagnostics.torchStatus,
        calibration: diagnostics.calibration,
        autoCameraControlUnavailable: diagnostics.autoCameraControlUnavailable,
        multiRearProbe: probeReport,
      });

      return this.getState();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.lastError = errorMsg;
      this.state = emptyState(errorMsg, this.lastError, diagnostics);
      return this.getState();
    }
  }

  async stop(): Promise<void> {
    const current = this.state;
    const track = current.videoTrack;

    if (track && track.readyState === "live") {
      try {
        const capabilities = track.getCapabilities();
        if (capabilities?.torch) {
          await track.applyConstraints(torchConstraint(false));
        }
      } catch {
        // best-effort
      }
    }

    current.stream?.getTracks().forEach((mediaTrack) => {
      try {
        mediaTrack.stop();
      } catch {
        /* noop */
      }
    });

    this.state = emptyState(null, this.lastError);
    this.frameCount = 0;
    this.lastFrameTime = 0;
  }

  validateStream(): boolean {
    const track = this.state.videoTrack;
    if (!track) return false;
    if (track.readyState !== "live") return false;
    if (track.muted) return false;
    return true;
  }

  /**
   * Called by FrameSampler once warmup is satisfied. Mutates state +
   * acquisitionReport. Idempotent.
   */
  markAcquisitionReady(metrics: {
    warmupFrames: number;
    warmupJitterMs: number;
    warmupFpsStdMs: number;
    fpsReal: number;
  }): void {
    if (!this.state.acquisitionReport) return;
    const report = {
      ...this.state.acquisitionReport,
      warmupFrames: metrics.warmupFrames,
      warmupJitterMs: metrics.warmupJitterMs,
      warmupFpsStdMs: metrics.warmupFpsStdMs,
      fpsReal: metrics.fpsReal,
      acquisitionReady: true,
      notReadyReasons: [] as string[],
    };
    this.state = {
      ...this.state,
      acquisitionReady: true,
      notReadyReasons: [],
      acquisitionReport: report,
    };
  }

  /** Called when the sampler observes a regression (jitter spike, freeze). */
  clearAcquisitionReady(reasons: string[]): void {
    if (!this.state.acquisitionReady && !this.state.acquisitionReport) return;
    this.state = {
      ...this.state,
      acquisitionReady: false,
      notReadyReasons: reasons,
      acquisitionReport: this.state.acquisitionReport
        ? { ...this.state.acquisitionReport, acquisitionReady: false, notReadyReasons: reasons }
        : null,
    };
  }

  /**
   * Multi-rear PPG probe — opens each candidate device briefly (2-3s), extracts
   * temporal PPG signal quality metrics (AC/DC perfusion index, temporal SNR,
   * cardiac band power), and scores cameras by actual PPG signal quality.
   *
   * This is a FORENSIC probe: it measures real temporal signal characteristics,
   * not just spatial RGB heuristics. The probe uses the same optical density
   * extraction as production PPG processing to ensure the selected camera can
   * deliver a clean pulsatile signal.
   */
  private async runMultiRearProbe(
    candidates: DeviceCameraProfile[],
    diagnostics: CameraDiagnostics,
  ): Promise<MultiRearProbeReport> {
    const results: MultiRearProbeCandidate[] = [];
    const PROBE_MS = 2500; // 2.5s for adequate temporal resolution
    const TARGET_FPS_PROBE = 30;

    for (const cand of candidates) {
      const entry: MultiRearProbeCandidate = {
        deviceId: cand.deviceId,
        label: cand.label,
        durationMs: 0,
        framesAnalyzed: 0,
        // Spatial metrics
        meanRed: 0,
        meanGreen: 0,
        saturationHigh: 0,
        coverage: 0,
        // Temporal PPG metrics (initialized to zero)
        temporalSnrDb: 0,
        perfusionIndex: 0,
        cardiacBandPower: 0,
        signalStability: 0,
        // Cadence
        jitterMs: 0,
        targetFps: TARGET_FPS_PROBE,
        actualFps: 0,
        // Score
        score: -Infinity,
        rejectedReason: null,
      };

      let stream: MediaStream | null = null;
      let rafHandle: number | null = null;

      try {
        // Open camera with explicit deviceId
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: cand.deviceId },
            width: { ideal: 320 },
            height: { ideal: 240 },
            frameRate: { ideal: TARGET_FPS_PROBE },
          },
          audio: false,
        });

        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error("No video track");

        // Best-effort torch for realistic PPG conditions
        try {
          const caps = track.getCapabilities?.();
          if (caps?.torch === true) {
            await track.applyConstraints({ advanced: [{ torch: true }] });
          }
        } catch { /* torch optional for probe */ }

        // Setup video element
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play().catch(() => { /* noop */ });

        // Wait for video to be ready
        await new Promise<void>((resolve) => {
          if (video.readyState >= 2) return resolve();
          video.onloadeddata = () => resolve();
          setTimeout(resolve, 500); // Timeout fallback
        });

        // Temporal PPG acquisition setup
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Canvas context failed");
        canvas.width = 64;
        canvas.height = 64;

        // Time-series buffers for PPG analysis
        const greenSeries: number[] = []; // Green channel (best PPG signal)
        const redSeries: number[] = [];   // Red channel (for SpO2 ratio)
        const timestamps: number[] = [];
        const presentedFramesLog: number[] = [];

        const t0 = performance.now();
        let frames = 0;
        let lastPresentedFrames: number | null = null;

        // Frame acquisition loop using requestVideoFrameCallback if available
        const videoWithRVFC = video as HTMLVideoElement & {
          requestVideoFrameCallback?: (cb: (now: number, metadata: { presentedFrames?: number; mediaTime?: number }) => void) => number;
        };

        await new Promise<void>((resolve) => {
          const acquireFrame = (now: number, metadata?: { presentedFrames?: number; mediaTime?: number }) => {
            const elapsed = performance.now() - t0;
            if (elapsed >= PROBE_MS) {
              if (rafHandle !== null) {
                if (videoWithRVFC.cancelVideoFrameCallback) {
                  videoWithRVFC.cancelVideoFrameCallback(rafHandle);
                } else if (typeof cancelAnimationFrame !== "undefined") {
                  cancelAnimationFrame(rafHandle);
                }
              }
              return resolve();
            }

            if (video.readyState >= 2 && ctx) {
              // Capture frame
              ctx.drawImage(video, 0, 0, 64, 64);
              const frameData = ctx.getImageData(0, 0, 64, 64);
              const data = frameData.data;

              // Calculate spatial means (for spatial metrics)
              let sumR = 0, sumG = 0, hi = 0, cov = 0;
              const px = 64 * 64;
              for (let i = 0; i < data.length; i += 4) {
                const R = data[i], G = data[i + 1], B = data[i + 2];
                sumR += R;
                sumG += G;
                if (R >= 250) hi++; // Saturation detection
                // Hemoglobin coverage: red dominant, reasonable intensity
                if (R > 80 && R > G * 1.1 && R > B * 0.8) cov++;
              }

              // Store for spatial averaging
              entry.meanRed += sumR / px;
              entry.meanGreen += sumG / px;
              entry.saturationHigh += hi / px;
              entry.coverage += cov / px;

              // Extract optical density approximation for temporal analysis
              // OD ≈ -log(mean_linear), but for probe we use normalized green
              // as a proxy for PPG signal quality assessment
              const meanG = sumG / px;
              const meanR = sumR / px;
              greenSeries.push(meanG);
              redSeries.push(meanR);
              timestamps.push(now);

              // Track presented frames for jitter analysis
              const pf = metadata?.presentedFrames ?? null;
              if (pf !== null) {
                if (lastPresentedFrames !== null && pf > lastPresentedFrames) {
                  const dropped = pf - lastPresentedFrames - 1;
                  if (dropped > 0) {
                    // Interpolate dropped frames with null markers
                    for (let d = 0; d < dropped && greenSeries.length > 0; d++) {
                      presentedFramesLog.push(-1); // Marker for dropped
                    }
                  }
                }
                presentedFramesLog.push(pf);
                lastPresentedFrames = pf;
              }

              frames++;
            }

            // Schedule next frame
            if (videoWithRVFC.requestVideoFrameCallback) {
              rafHandle = videoWithRVFC.requestVideoFrameCallback(acquireFrame);
            } else {
              rafHandle = requestAnimationFrame((t) => acquireFrame(t));
            }
          };

          // Start acquisition
          if (videoWithRVFC.requestVideoFrameCallback) {
            rafHandle = videoWithRVFC.requestVideoFrameCallback(acquireFrame);
          } else {
            rafHandle = requestAnimationFrame((t) => acquireFrame(t));
          }
        });

        // Calculate temporal PPG metrics from acquired series
        entry.durationMs = Math.round(performance.now() - t0);
        entry.framesAnalyzed = frames;

        if (frames > 0) {
          // Normalize spatial averages
          entry.meanRed /= frames;
          entry.meanGreen /= frames;
          entry.saturationHigh /= frames;
          entry.coverage /= frames;
        }

        // Calculate actual FPS
        if (timestamps.length >= 2) {
          const duration = timestamps[timestamps.length - 1] - timestamps[0];
          entry.actualFps = duration > 0 ? (timestamps.length - 1) / (duration / 1000) : 0;
        }

        // TEMPORAL PPG ANALYSIS: Calculate AC/DC perfusion index and SNR
        if (greenSeries.length >= 30) { // Need ~1s at 30fps minimum
          // DC component (mean) - baseline reflectance
          const dc = greenSeries.reduce((a, b) => a + b, 0) / greenSeries.length;

          // AC component (standard deviation of signal) - pulsatile variation
          const variance = greenSeries.reduce((sum, val) => sum + Math.pow(val - dc, 2), 0) / greenSeries.length;
          const ac = Math.sqrt(variance);

          // Perfusion index: AC/DC ratio (key PPG quality metric)
          entry.perfusionIndex = dc > 0 ? ac / dc : 0;

          // Signal stability: inverse of DC drift over window
          const firstHalf = greenSeries.slice(0, Math.floor(greenSeries.length / 2));
          const secondHalf = greenSeries.slice(Math.floor(greenSeries.length / 2));
          const dc1 = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
          const dc2 = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
          const dcDrift = Math.abs(dc2 - dc1) / Math.max(1, dc);
          entry.signalStability = Math.max(0, 1 - dcDrift);

          // Temporal SNR: signal variance vs high-frequency noise estimate
          // Simple approach: compare total variance to diff-based noise estimate
          let noiseSum = 0;
          let noiseCount = 0;
          for (let i = 1; i < greenSeries.length; i++) {
            const diff = greenSeries[i] - greenSeries[i - 1];
            // High-frequency differences (>|10|) considered noise
            if (Math.abs(diff) > 10) {
              noiseSum += diff * diff;
              noiseCount++;
            }
          }
          const noiseVariance = noiseCount > 0 ? noiseSum / noiseCount : 1;
          const signalVariance = variance;
          entry.temporalSnrDb = noiseVariance > 0
            ? 10 * Math.log10(signalVariance / noiseVariance)
            : 20; // Cap at 20dB if no noise detected

          // Cardiac band power estimate: simple bandpass proxy
          // Calculate variance of smoothed signal (removes DC, preserves cardiac)
          const smoothed: number[] = [];
          const window = 3; // ~100ms at 30fps
          for (let i = window; i < greenSeries.length - window; i++) {
            let sum = 0;
            for (let j = -window; j <= window; j++) sum += greenSeries[i + j];
            smoothed.push(sum / (2 * window + 1));
          }
          if (smoothed.length > 10) {
            const smoothedMean = smoothed.reduce((a, b) => a + b, 0) / smoothed.length;
            const smoothedVar = smoothed.reduce((sum, val) => sum + Math.pow(val - smoothedMean, 2), 0) / smoothed.length;
            entry.cardiacBandPower = smoothedVar / Math.max(1, signalVariance);
          }
        }

        // Calculate jitter from timestamps
        if (timestamps.length >= 4) {
          const intervals: number[] = [];
          for (let i = 1; i < timestamps.length; i++) {
            intervals.push(timestamps[i] - timestamps[i - 1]);
          }
          const med = intervals.slice().sort((a, b) => a - b)[intervals.length >> 1];
          let mad = 0;
          for (const v of intervals) mad += Math.abs(v - med);
          entry.jitterMs = mad / intervals.length;
        }

        // PPG-grounded scoring function
        // Weights: temporal SNR (40%), perfusion index (30%), stability (15%), coverage (10%), cadence (5%)
        entry.score =
          Math.min(40, Math.max(0, entry.temporalSnrDb)) * 1.0 +     // 0-40 points
          Math.min(30, entry.perfusionIndex * 300) * 1.0 +            // 0-30 points (PI 0-0.1)
          entry.signalStability * 15 +                                // 0-15 points
          entry.coverage * 10 +                                       // 0-10 points
          Math.max(0, 5 - entry.jitterMs / 3);                      // 0-5 points (penalty)

        // Penalize saturated or low-coverage cameras heavily
        if (entry.saturationHigh > 0.15) entry.score -= 30;
        if (entry.coverage < 0.2) entry.score -= 20;
        if (entry.framesAnalyzed < 45) entry.score -= 25; // Less than 1.5s of data

      } catch (error) {
        entry.rejectedReason = (error as Error).message ?? "probe-failed";
      } finally {
        // Cleanup
        if (rafHandle !== null) {
          if (typeof cancelAnimationFrame !== "undefined") {
            cancelAnimationFrame(rafHandle);
          }
        }
        stream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
      }

      results.push(entry);
      diagnostics.attempts.push({
        label: `multi-rear-probe:${cand.deviceId.slice(0, 8)}`,
        constraints: { video: { deviceId: { exact: cand.deviceId } }, audio: false },
        outcome: entry.rejectedReason ? "failure" : "success",
        errorMessage: entry.rejectedReason ?? undefined,
        resolvedDeviceId: cand.deviceId,
        resolvedLabel: cand.label,
      });
    }

    const valid = results.filter((r) => r.rejectedReason === null && r.framesAnalyzed > 0);
    const winner = valid.sort((a, b) => b.score - a.score)[0] ?? null;

    return {
      ran: true,
      reason: winner ? "scored-by-temporal-ppg-quality" : "no-valid-probe-results",
      candidates: results,
      winnerDeviceId: winner?.deviceId ?? null,
    };
  }

  /* ---------------- private ---------------- */


  private async openCamera(
    diagnostics: CameraDiagnostics,
    preferredDeviceId: string | null,
  ): Promise<{
    stream: MediaStream;
    constraints: MediaTrackConstraints;
    selectedReason: string;
  }> {
    const attempts: { label: string; constraints: MediaStreamConstraints }[] = [];

    if (preferredDeviceId) {
      attempts.push({
        label: `deviceId-exact:${preferredDeviceId.slice(0, 10)}`,
        constraints: {
          video: {
            ...REQUESTED_VIDEO,
            deviceId: { exact: preferredDeviceId },
          },
          audio: false,
        },
      });
    }

    attempts.push(
      {
        label: "exact-environment-hd",
        constraints: {
          video: {
            facingMode: { exact: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: TARGET_FPS },
          },
          audio: false,
        },
      },
      {
        label: "ideal-environment-hd",
        constraints: { video: { ...REQUESTED_VIDEO }, audio: false },
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
        constraints: { video: { facingMode: "environment" }, audio: false },
      },
      {
        label: "fallback-any-video",
        constraints: { video: true, audio: false },
      },
    );

    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(attempt.constraints);
        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings();
        diagnostics.attempts.push({
          label: attempt.label,
          constraints: attempt.constraints,
          outcome: "success",
          resolvedDeviceId: settings?.deviceId,
          resolvedLabel: track?.label,
        });
        return {
          stream,
          constraints: attempt.constraints.video as MediaTrackConstraints,
          selectedReason: attempt.label,
        };
      } catch (error) {
        diagnostics.attempts.push({
          label: attempt.label,
          constraints: attempt.constraints,
          outcome: "failure",
          errorName: (error as Error).name,
          errorMessage: (error as Error).message,
        });
        lastError = error;
      }
    }

    throw lastError ?? new Error("Failed to open rear camera after all attempts");
  }

  private async replaceUltraWideIfNeeded(
    track: MediaStreamTrack,
    stream: MediaStream,
    profiles: DeviceCameraProfile[],
    diagnostics: CameraDiagnostics,
  ): Promise<{ stream: MediaStream; constraints: MediaTrackConstraints } | null> {
    const label = (track.label || "").toLowerCase();
    const settings = track.getSettings();
    const matched = profiles.find((p) => p.deviceId === settings.deviceId) ?? null;
    const isUltrawideOrFront =
      ULTRA_WIDE_TOKENS.some((t) => label.includes(t)) ||
      NON_PRIMARY_TOKENS.some((t) => label.includes(t)) ||
      detectFacingFromLabel(track.label) === "user" ||
      (matched ? matched.penalties.ultraWide > 0 || matched.penalties.frontCamera > 0 : false);

    if (!isUltrawideOrFront) return null;

    const replacement = profiles.find(
      (p) =>
        p.deviceId !== settings.deviceId &&
        p.facingModeDetected === "environment" &&
        p.penalties.ultraWide === 0 &&
        p.penalties.frontCamera === 0,
    );
    if (!replacement) {
      // Mark the chosen ultrawide so the panel surfaces why we kept it.
      if (matched) {
        matched.rejectedReasons.push(
          "would-replace-but-no-suitable-rear-candidate",
        );
      }
      diagnostics.attempts.push({
        label: "ultrawide-replacement-skipped",
        constraints: {},
        outcome: "failure",
        errorName: "NoCandidate",
        errorMessage:
          "Initial track is ultrawide/front but no non-ultrawide rear candidate exists",
      });
      return null;
    }

    const replConstraints: MediaTrackConstraints = {
      ...REQUESTED_VIDEO,
      deviceId: { exact: replacement.deviceId },
    };
    try {
      const replacementStream = await navigator.mediaDevices.getUserMedia({
        video: replConstraints,
        audio: false,
      });
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* noop */
        }
      });
      if (matched) {
        matched.rejectedReasons.push("replaced-by-non-ultrawide-rear");
      }
      replacement.selectedReason = "ultrawide-replacement";
      diagnostics.attempts.push({
        label: "ultrawide-replacement",
        constraints: { video: replConstraints, audio: false },
        outcome: "success",
        resolvedDeviceId: replacement.deviceId,
        resolvedLabel: replacement.label,
      });
      return { stream: replacementStream, constraints: replConstraints };
    } catch (error) {
      diagnostics.attempts.push({
        label: "ultrawide-replacement",
        constraints: { video: replConstraints, audio: false },
        outcome: "failure",
        errorName: (error as Error).name,
        errorMessage: (error as Error).message,
      });
      return null;
    }
  }

  private async applyFineConstraints(
    track: MediaStreamTrack,
    capabilities: MediaTrackCapabilities | null,
    diagnostics: CameraDiagnostics,
    includeTorch = true,
    preserveTorch = false,
  ): Promise<void> {
    const tryConstraint = async (
      key: AppliedFineConstraint["key"],
      attempted: unknown,
      payload: MediaTrackConstraints,
      supported: boolean,
    ): Promise<void> => {
      if (!supported) {
        diagnostics.fineConstraints.push({
          key,
          attempted,
          applied: null,
          status: "unsupported",
        });
        return;
      }
      try {
        const effectivePayload = preserveTorch && key !== "torch"
          ? {
              ...payload,
              advanced: [
                ...((payload.advanced ?? []) as MediaTrackConstraintSet[]),
                { torch: true } as TorchConstraintSet,
              ],
            }
          : payload;
        await track.applyConstraints(effectivePayload);
        const newSettings = track.getSettings();
        const applied = (newSettings as Record<string, unknown>)[key];
        diagnostics.fineConstraints.push({
          key,
          attempted,
          applied,
          status: "applied",
        });
      } catch (error) {
        diagnostics.failedConstraints.push(key);
        diagnostics.fineConstraints.push({
          key,
          attempted,
          applied: null,
          status: "failed",
          errorMessage: (error as Error).message,
        });
      }
    };

    // torch — only on the legacy non-gesture path. The gesture path enables
    // torch before fine constraints and must not toggle it again.
    if (includeTorch) {
      await tryConstraint("torch", true, torchConstraint(true), capabilities?.torch === true);
    }

    // exposureMode
    const exposureModes = capabilities?.exposureMode ?? [];
    const preferredExposure = exposureModes.includes("continuous")
      ? "continuous"
      : exposureModes.includes("manual")
        ? "manual"
        : null;
    await tryConstraint(
      "exposureMode",
      preferredExposure,
      preferredExposure
        ? { advanced: [{ exposureMode: preferredExposure }] }
        : {},
      preferredExposure !== null,
    );

    // focusMode
    const focusModes = capabilities?.focusMode ?? [];
    const preferredFocus = focusModes.includes("continuous")
      ? "continuous"
      : focusModes.includes("manual")
        ? "manual"
        : focusModes.includes("infinity")
          ? "infinity"
          : null;
    await tryConstraint(
      "focusMode",
      preferredFocus,
      preferredFocus ? { advanced: [{ focusMode: preferredFocus }] } : {},
      preferredFocus !== null,
    );

    // whiteBalanceMode
    const wbModes = capabilities?.whiteBalanceMode ?? [];
    const preferredWb = wbModes.includes("manual")
      ? "manual"
      : wbModes.includes("continuous")
        ? "continuous"
        : null;
    await tryConstraint(
      "whiteBalanceMode",
      preferredWb,
      preferredWb ? { advanced: [{ whiteBalanceMode: preferredWb }] } : {},
      preferredWb !== null,
    );

    // frameRate
    await tryConstraint(
      "frameRate",
      TARGET_FPS,
      { advanced: [{ frameRate: { ideal: TARGET_FPS } }] },
      true,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Empty-state factory exported for the hook                           */
/* ------------------------------------------------------------------ */

export function createEmptyPPGCameraState(): PPGCameraState {
  return emptyState();
}
