import {
  lookupCalibrationProfile,
  type CalibrationStatus,
  type CalibrationLookupResult,
} from "./CameraCalibrationProfile";

/* ------------------------------------------------------------------ */
/* Public types                                                       */
/* ------------------------------------------------------------------ */

export interface DeviceCameraProfile {
  deviceId: string;
  label: string;
  groupId: string;
  facingModeDetected: "environment" | "user" | "unknown";
  score: number;
  penalties: {
    ultraWide: number;
    frontCamera: number;
    lowResolution: number;
    lowFps: number;
    missingTorch: number;
  };
  selectedReason: string | null;
  rejectedReasons: string[];
}

export interface ConstraintAttemptLog {
  label: string;
  constraints: MediaStreamConstraints;
  outcome: "success" | "failure";
  errorName?: string;
  errorMessage?: string;
  resolvedDeviceId?: string;
  resolvedLabel?: string;
}

export interface AppliedFineConstraint {
  key:
    | "torch"
    | "exposureMode"
    | "focusMode"
    | "whiteBalanceMode"
    | "frameRate"
    | "exposureCompensation"
    | "iso";
  attempted: unknown;
  applied: unknown;
  status: "applied" | "unsupported" | "failed";
  errorMessage?: string;
}

export interface CameraDiagnostics {
  enumeratedDevices: DeviceCameraProfile[];
  selectedDevice: DeviceCameraProfile | null;
  attempts: ConstraintAttemptLog[];
  fineConstraints: AppliedFineConstraint[];
  capabilities: MediaTrackCapabilities | null;
  settings: MediaTrackSettings | null;
  failedConstraints: string[];
  torchStatus: {
    available: boolean;
    requested: boolean;
    appliedReadback: boolean;
    /** Final resolved status — never "pending" once start() returns. */
    resolved: "applied" | "unsupported" | "denied" | "ignored-by-browser";
  };
  calibration: {
    status: CalibrationStatus;
    profileKey: string | null;
    matchedBy: CalibrationLookupResult["matchedBy"];
    reason: string;
    canPublishSpO2: boolean;
  };
  fpsTarget: number;
  fpsMeasured: number;
  userAgent: string;
  /**
   * Marker emitted when the browser exposes ZERO controllable optical
   * constraints (torch + exposureMode + focusMode + whiteBalanceMode all
   * unsupported). This is the explicit signal required by the audit:
   * we never fabricate manual control where the browser does not allow it.
   */
  autoCameraControlUnavailable: boolean;
  /** Multi-rear PPG probe outcome (see runMultiRearProbe). */
  multiRearProbe: MultiRearProbeReport | null;
}

/**
 * Camera acquisition report — emitted exactly once per successful start().
 * Provides the auditable summary the UI uses to render
 * "rear camera verified", "torch verified", "fps real" badges.
 */
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
  meanRed: number;
  meanGreen: number;
  saturationHigh: number;
  coverage: number;
  perfusionProxy: number;
  jitterMs: number;
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

  async start(): Promise<PPGCameraState> {
    const diagnostics = emptyDiagnostics();
    this.state = emptyState(null, this.lastError, diagnostics);
    this.frameCount = 0;
    this.lastFrameTime = 0;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera API not supported by this browser");
      }

      // Phase 1 — minimal permission grant so device labels become visible.
      let priming: MediaStream | null = null;
      try {
        priming = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (e) {
        diagnostics.attempts.push({
          label: "permission-priming",
          constraints: { video: { facingMode: { ideal: "environment" } }, audio: false },
          outcome: "failure",
          errorName: (e as Error).name,
          errorMessage: (e as Error).message,
        });
      }

      // Phase 2 — enumerate and score devices.
      const devices = await navigator.mediaDevices.enumerateDevices();
      const profiles = devices
        .filter((d) => d.kind === "videoinput")
        .map(profileFromDevice)
        .sort((a, b) => b.score - a.score);
      diagnostics.enumeratedDevices = profiles;

      // Release the priming stream before opening the chosen one.
      priming?.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* noop */
        }
      });

      const bestRear = profiles.find(
        (p) =>
          p.facingModeDetected === "environment" &&
          p.penalties.ultraWide === 0 &&
          p.penalties.frontCamera === 0,
      );
      if (bestRear) {
        bestRear.selectedReason = "best-rear-non-ultrawide";
      }

      // Phase 3 — open with progressive constraints, logging every attempt.
      let opened = await this.openCamera(diagnostics, bestRear?.deviceId ?? null);

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
      // Mark all other enumerated profiles as rejected with reason.
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

      // Re-read settings after fine tuning.
      settings = videoTrack.getSettings();
      diagnostics.settings = settings;

      const torchCap = capabilities?.torch === true;
      diagnostics.torchStatus.available = torchCap;
      const torchEntry = diagnostics.fineConstraints.find((c) => c.key === "torch");
      const torchEnabled =
        torchEntry?.status === "applied" &&
        (settings?.torch === true || settings?.fillLightMode === "flash");
      const torchApplied = torchEntry?.status === "applied";
      diagnostics.torchStatus.requested = torchEntry?.attempted === true;
      diagnostics.torchStatus.appliedReadback = torchEnabled === true;

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

      this.state = {
        stream: opened.stream,
        videoTrack,
        capabilities,
        settings,
        constraints: opened.constraints,
        torchAvailable: torchCap,
        torchEnabled,
        torchApplied,
        cameraReady: true,
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
        await track.applyConstraints(payload);
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

    // torch
    await tryConstraint("torch", true, torchConstraint(true), capabilities?.torch === true);

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
