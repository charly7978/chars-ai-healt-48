/**
 * NoFingerSelfTest
 * -----------------------------------------------------------------------------
 * Forensic self-test that monitors the live ROI evidence stream and verifies
 * the publication gate ALWAYS stays closed when the scene contains no finger
 * (i.e. when hemoglobin signature is absent).
 *
 * What "no finger" means here, derived from REAL ROI evidence — never simulated:
 *   1. roi.contactState === "absent" — the ROI detector sees no contact.
 *   2. redDominance < RED_DOMINANCE_THRESHOLD — without a finger pressed
 *      against the lens under flash, the red channel does not dominate
 *      green+blue (hemoglobin absorbs green+blue strongly while red passes).
 *   3. linearMean.r < MIN_RED_FOR_FINGER OR coverageScore < MIN_COVERAGE — the
 *      camera is not seeing a sustained red, well-illuminated surface.
 *
 * On every published measurement we ALSO check the gate's verdict:
 *   - If publication.canPublishVitals === true while the scene is "no-finger",
 *     this is a hard violation. We accumulate `falsePositives` and emit a
 *     console.error so QA / forensic audits can prove the system never
 *     fabricated vitals from ambient light or random pixels.
 *
 * The self-test is OBSERVATION ONLY. It never changes the gate, the ROI or the
 * thresholds. It exists to prove (via numbers, not assertions in code) that the
 * blocking behaviour is real and persistent.
 */

import type { FingerOpticalEvidence } from "../roi/FingerOpticalROI";
import type { PublishedPPGMeasurement } from "../publication/PPGPublicationGate";

const RED_DOMINANCE_THRESHOLD = 0.10;
const MIN_RED_FOR_FINGER = 0.18;       // linear-light scale (0..1)
const MIN_COVERAGE_FOR_FINGER = 0.40;
const NO_FINGER_REASON_TOKENS = [
  "INSUFFICIENT_VALID_PIXELS",
  "COVERAGE_TOO_LOW",
  "COVERAGE_LOW",
  "WEAK_CONTACT",
  "NOT_FINGER_LIKE",
  "UNDEREXPOSED",
  "FLAT_SURFACE_NO_TEXTURE",
];

export type NoFingerSampleVerdict =
  | "no-finger"
  | "finger-likely"
  | "ambiguous";

export interface NoFingerSelfTestSample {
  t: number;
  verdict: NoFingerSampleVerdict;
  contactState: string;
  redDominance: number;
  linearMeanR: number;
  coverageScore: number;
  publishedVitals: boolean;
  reason: string;
}

export interface NoFingerSelfTestReport {
  totalSamples: number;
  noFingerSamples: number;
  fingerLikelySamples: number;
  ambiguousSamples: number;
  /** CRITICAL: number of frames where the gate published vitals while the
   *  scene was clearly no-finger. MUST stay at 0 for a valid forensic build. */
  falsePositives: number;
  /** Number of frames where vitals correctly stayed blocked under no-finger. */
  correctBlocks: number;
  /** Most recent verdicts (ring-buffered for UI display). */
  recentSamples: NoFingerSelfTestSample[];
  lastViolationAt: number | null;
  lastViolationReason: string | null;
}

export class NoFingerSelfTest {
  private totalSamples = 0;
  private noFingerSamples = 0;
  private fingerLikelySamples = 0;
  private ambiguousSamples = 0;
  private falsePositives = 0;
  private correctBlocks = 0;
  private recent: NoFingerSelfTestSample[] = [];
  private lastViolationAt: number | null = null;
  private lastViolationReason: string | null = null;
  private readonly recentCapacity: number;

  constructor(recentCapacity = 32) {
    this.recentCapacity = recentCapacity;
  }

  reset(): void {
    this.totalSamples = 0;
    this.noFingerSamples = 0;
    this.fingerLikelySamples = 0;
    this.ambiguousSamples = 0;
    this.falsePositives = 0;
    this.correctBlocks = 0;
    this.recent = [];
    this.lastViolationAt = null;
    this.lastViolationReason = null;
  }

  /**
   * Classify a single ROI sample as no-finger / finger-likely / ambiguous and
   * cross-check the publication verdict for a forensic audit trail.
   */
  observe(input: {
    t: number;
    roi: FingerOpticalEvidence;
    published: PublishedPPGMeasurement;
  }): NoFingerSampleVerdict {
    const { t, roi, published } = input;
    const reasonTokens = roi.reason ?? [];
    const matchesNoFingerReason = reasonTokens.some((r) =>
      NO_FINGER_REASON_TOKENS.includes(r),
    );

    const noFingerByContact = roi.contactState === "absent";
    const noFingerByOptics =
      roi.redDominance < RED_DOMINANCE_THRESHOLD ||
      roi.linearMean.r < MIN_RED_FOR_FINGER ||
      roi.coverageScore < MIN_COVERAGE_FOR_FINGER;

    const fingerLikely =
      roi.contactState === "stable" &&
      roi.redDominance >= RED_DOMINANCE_THRESHOLD * 1.4 &&
      roi.linearMean.r >= MIN_RED_FOR_FINGER * 1.1 &&
      roi.coverageScore >= MIN_COVERAGE_FOR_FINGER;

    let verdict: NoFingerSampleVerdict;
    if (noFingerByContact || (noFingerByOptics && matchesNoFingerReason)) {
      verdict = "no-finger";
    } else if (fingerLikely) {
      verdict = "finger-likely";
    } else {
      verdict = "ambiguous";
    }

    this.totalSamples += 1;
    if (verdict === "no-finger") this.noFingerSamples += 1;
    else if (verdict === "finger-likely") this.fingerLikelySamples += 1;
    else this.ambiguousSamples += 1;

    let reason = `${verdict}`;
    if (verdict === "no-finger") {
      if (published.canPublishVitals) {
        // Forensic violation: gate published vitals from a no-finger scene.
        this.falsePositives += 1;
        this.lastViolationAt = t;
        this.lastViolationReason =
          `redDom=${roi.redDominance.toFixed(2)} ` +
          `meanR=${roi.linearMean.r.toFixed(2)} ` +
          `cov=${roi.coverageScore.toFixed(2)} ` +
          `state=${roi.contactState} ` +
          `bpm=${published.bpm ?? "null"}`;
        reason = `VIOLATION: ${this.lastViolationReason}`;
        // eslint-disable-next-line no-console
        console.error("[NoFingerSelfTest] FALSE POSITIVE:", this.lastViolationReason);
      } else {
        this.correctBlocks += 1;
        reason = `blocked-correctly`;
      }
    }

    const sample: NoFingerSelfTestSample = {
      t,
      verdict,
      contactState: roi.contactState,
      redDominance: roi.redDominance,
      linearMeanR: roi.linearMean.r,
      coverageScore: roi.coverageScore,
      publishedVitals: published.canPublishVitals,
      reason,
    };
    this.recent.push(sample);
    if (this.recent.length > this.recentCapacity) this.recent.shift();
    return verdict;
  }

  report(): NoFingerSelfTestReport {
    return {
      totalSamples: this.totalSamples,
      noFingerSamples: this.noFingerSamples,
      fingerLikelySamples: this.fingerLikelySamples,
      ambiguousSamples: this.ambiguousSamples,
      falsePositives: this.falsePositives,
      correctBlocks: this.correctBlocks,
      recentSamples: [...this.recent],
      lastViolationAt: this.lastViolationAt,
      lastViolationReason: this.lastViolationReason,
    };
  }
}
