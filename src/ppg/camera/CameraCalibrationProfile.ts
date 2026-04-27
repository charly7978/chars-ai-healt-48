/**
 * CameraCalibrationProfile
 * ------------------------
 * Per-device/per-camera-lens calibration metadata required to publish
 * radiometrically meaningful PPG-derived metrics (especially SpO2).
 *
 * Policy:
 *   - BPM may be published without a CalibrationProfile (it only depends on
 *     temporal periodicity of the optical signal).
 *   - SpO2 publication REQUIRES at least a "partial" profile that gives the
 *     ratio-of-ratios estimator per-channel gain corrections. A "calibrated"
 *     profile additionally provides spo2Coefficients fitted against a
 *     reference pulse oximeter.
 *
 * Profiles are NEVER fabricated from runtime measurements; they must come
 * from a known source ("manual", "lab-fit", "generic-fallback", ...).
 */

export type CalibrationStatus = "calibrated" | "partial" | "uncalibrated";

export type CalibrationSource =
  | "manual"
  | "lab-fit"
  | "generic-fallback"
  | "imported";

export type LinearizationMode = "sRGB" | "gamma" | "linear";

export interface SpO2Coefficients {
  /** SpO2 ≈ a − b * R, where R is the ratio-of-ratios. */
  a: number;
  b: number;
  /** Optional secondary term for non-linear fits. */
  c?: number;
  /** Validity range of R (ratio) the fit was trained on. */
  rMin?: number;
  rMax?: number;
}

export interface CameraCalibrationProfile {
  phoneModelKey: string;
  /** Regex pattern (string form) matched against MediaStreamTrack.label. */
  cameraLabelPattern: string;
  /**
   * Linearization to apply to raw RGB before optical-density extraction.
   *  - "sRGB": IEC 61966-2-1 inverse companding
   *  - "gamma": pow(x, gammaCompensation)
   *  - "linear": pass-through (camera already produces linear samples)
   */
  linearizationMode: LinearizationMode;
  gammaCompensation: number;
  /** Per-channel gain corrections (multiplicative, applied post-linearization). */
  redGain: number;
  greenGain: number;
  blueGain: number;
  /** Zero-light reference (residual sensor offset) per channel, optional. */
  zloR?: number;
  zloG?: number;
  zloB?: number;
  /** SpO2 calibration; if absent the device is at most "partial". */
  spo2Coefficients?: SpO2Coefficients;
  createdAt: string;
  source: CalibrationSource;
  version: number;
}

/**
 * Generic fallback per device family. These are NOT clinical calibrations.
 * They merely allow the pipeline to run with sane sRGB linearization while a
 * real per-device profile is being collected. SpO2 publication remains
 * gated as "partial" (badge in UI) — never as "calibrated".
 */
const GENERIC_PROFILES: CameraCalibrationProfile[] = [
  {
    phoneModelKey: "generic-android-rear",
    cameraLabelPattern:
      "(back|rear|environment|trasera|posterior|world|principal)",
    linearizationMode: "sRGB",
    gammaCompensation: 2.2,
    redGain: 1.0,
    greenGain: 1.0,
    blueGain: 1.0,
    createdAt: "2025-01-01T00:00:00Z",
    source: "generic-fallback",
    version: 1,
  },
  {
    phoneModelKey: "generic-ios-rear",
    cameraLabelPattern: "(back|rear|wide|trasera)",
    linearizationMode: "sRGB",
    gammaCompensation: 2.2,
    redGain: 1.0,
    greenGain: 1.0,
    blueGain: 1.0,
    createdAt: "2025-01-01T00:00:00Z",
    source: "generic-fallback",
    version: 1,
  },
];

/** Real calibrated profiles registered by phoneModelKey. Empty by default. */
const CALIBRATED_REGISTRY: CameraCalibrationProfile[] = [];

export interface CalibrationLookupParams {
  cameraLabel: string;
  userAgent?: string;
}

export interface CalibrationLookupResult {
  profile: CameraCalibrationProfile | null;
  status: CalibrationStatus;
  matchedBy: "calibrated-registry" | "generic-fallback" | "none";
  reason: string;
}

function detectFamily(userAgent?: string): "ios" | "android" | "unknown" {
  if (!userAgent) return "unknown";
  const ua = userAgent.toLowerCase();
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) {
    return "ios";
  }
  if (ua.includes("android")) return "android";
  return "unknown";
}

export function lookupCalibrationProfile(
  params: CalibrationLookupParams,
): CalibrationLookupResult {
  const label = params.cameraLabel ?? "";

  // 1. Exact / regex match against the calibrated registry.
  for (const profile of CALIBRATED_REGISTRY) {
    try {
      if (new RegExp(profile.cameraLabelPattern, "i").test(label)) {
        return {
          profile,
          status: profile.spo2Coefficients ? "calibrated" : "partial",
          matchedBy: "calibrated-registry",
          reason: `matched calibrated profile ${profile.phoneModelKey}`,
        };
      }
    } catch {
      // bad regex in registry — skip
    }
  }

  // 2. Generic fallback by device family.
  const family = detectFamily(params.userAgent);
  const familyKey =
    family === "ios" ? "generic-ios-rear" : "generic-android-rear";
  const generic =
    GENERIC_PROFILES.find((p) => p.phoneModelKey === familyKey) ??
    GENERIC_PROFILES[0];
  if (generic) {
    try {
      if (new RegExp(generic.cameraLabelPattern, "i").test(label)) {
        return {
          profile: generic,
          status: "partial",
          matchedBy: "generic-fallback",
          reason: `generic ${family} fallback (no calibrated profile for label "${label}")`,
        };
      }
    } catch {
      /* unreachable: GENERIC_PROFILES patterns are static */
    }
  }

  return {
    profile: null,
    status: "uncalibrated",
    matchedBy: "none",
    reason: `no calibration profile matched camera label "${label}"`,
  };
}

/** Test/extension hook: register a real calibration profile at runtime. */
export function registerCalibratedProfile(profile: CameraCalibrationProfile): void {
  CALIBRATED_REGISTRY.push(profile);
}
