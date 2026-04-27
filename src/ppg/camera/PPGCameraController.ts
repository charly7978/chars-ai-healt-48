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
   * Multi-rear PPG probe — opens each candidate device briefly (≤2s), measures
   * red saturation / coverage / perfusion proxy / jitter, and returns the
   * winner. Real implementation is best-effort: if a probe fails (browser
   * refuses concurrent access, etc.) the candidate is recorded with a reason
   * and skipped, never silently ignored.
   */
  private async runMultiRearProbe(
    candidates: DeviceCameraProfile[],
    diagnostics: CameraDiagnostics,
  ): Promise<MultiRearProbeReport> {
    const results: MultiRearProbeCandidate[] = [];
    const PROBE_MS = 2000;

    for (const cand of candidates) {
      const entry: MultiRearProbeCandidate = {
        deviceId: cand.deviceId,
        label: cand.label,
        durationMs: 0,
        framesAnalyzed: 0,
        meanRed: 0,
        meanGreen: 0,
        saturationHigh: 0,
        coverage: 0,
        perfusionProxy: 0,
        jitterMs: 0,
        score: -Infinity,
        rejectedReason: null,
      };
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: cand.deviceId },
            width: { ideal: 320 },
            height: { ideal: 240 },
            frameRate: { ideal: 30 },
          },
          audio: false,
        });
        const track = stream.getVideoTracks()[0];
        // Best-effort torch on for the probe so PPG metrics reflect the real
        // operating condition. Ignore failures.
        try {
          if (track.getCapabilities?.().torch === true) {
            await track.applyConstraints(torchConstraint(true));
          }
        } catch { /* noop */ }

        const t0 = performance.now();
        const intervals: number[] = [];
        let frames = 0;
        let lastT = 0;
        let sumR = 0, sumG = 0, sumSat = 0, sumCoverage = 0, sumPerf = 0;

        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        try { await video.play(); } catch { /* noop */ }

        await new Promise<void>((resolve) => {
          const canvas = document.createElement("canvas");
          canvas.width = 64; canvas.height = 64;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          const tick = () => {
            if (performance.now() - t0 >= PROBE_MS) return resolve();
            if (video.readyState >= 2 && ctx) {
              const now = performance.now();
              if (lastT > 0) intervals.push(now - lastT);
              lastT = now;
              ctx.drawImage(video, 0, 0, 64, 64);
              const data = ctx.getImageData(0, 0, 64, 64).data;
              let r = 0, g = 0, hi = 0, cov = 0;
              const px = 64 * 64;
              for (let i = 0; i < data.length; i += 4) {
                const R = data[i], G = data[i + 1];
                r += R; g += G;
                if (R >= 250) hi++;
                if (R > 80 && R > G * 1.2) cov++;
              }
              r /= px; g /= px;
              const satHi = hi / px;
              const coverage = cov / px;
              sumR += r; sumG += g; sumSat += satHi; sumCoverage += coverage;
              sumPerf += Math.max(0, r - g) / Math.max(1, r);
              frames++;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });

        entry.durationMs = Math.round(performance.now() - t0);
        entry.framesAnalyzed = frames;
        if (frames > 0) {
          entry.meanRed = sumR / frames;
          entry.meanGreen = sumG / frames;
          entry.saturationHigh = sumSat / frames;
          entry.coverage = sumCoverage / frames;
          entry.perfusionProxy = sumPerf / frames;
        }
        if (intervals.length >= 4) {
          const med = intervals.slice().sort((a, b) => a - b)[intervals.length >> 1];
          let mad = 0;
          for (const v of intervals) mad += Math.abs(v - med);
          entry.jitterMs = mad / intervals.length;
        }
        // Score: reward perfusion + coverage, penalise saturation + jitter.
        entry.score =
          entry.perfusionProxy * 100 +
          entry.coverage * 50 -
          entry.saturationHigh * 80 -
          Math.min(50, entry.jitterMs);
      } catch (error) {
        entry.rejectedReason = (error as Error).message ?? "probe-failed";
      } finally {
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
      reason: winner ? "scored-by-ppg-metrics" : "no-valid-probe-results",
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
