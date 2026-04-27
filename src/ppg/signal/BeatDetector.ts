/**
 * Professional-grade beat detector for camera PPG.
 *
 * Pipeline:
 *   1. Robust preprocessing (resample + bandpass + detrend) via PPGFilters.
 *   2. State machine over the filtered signal:
 *        seeking_foot -> rising -> candidate_peak -> falling -> refractory
 *      Each transition is anchored to a SAMPLE (with a real timestamp), not
 *      to an arbitrary index, so the temporal axis is physically meaningful.
 *   3. For every accepted beat we compute a full morphology feature set:
 *        foot/onset, systolic peak, trough, amplitude, rise time, decay
 *        time, pulse width (FWHM), area, up/down slope.
 *   4. Adaptive amplitude threshold based on rolling MAD (1.4826 * MAD ~= sigma)
 *      and a local percentile floor; the threshold is recomputed against the
 *      most recent ~6 s, not over the whole window.
 *   5. Refractory period is dynamic and tied to the running median IBI,
 *      bounded by the [minBpm, maxBpm] physiological window. Limits are
 *      expressed in seconds and converted by the actual sampleRateHz.
 *   6. Multi-estimator BPM:
 *        - peakBpm    (median IBI over accepted beats)
 *        - medianIbiBpm (alias kept for clarity / external consumers)
 *        - fftBpm     (spectral peak inside cardiac band)
 *        - autocorrBpm (lag-domain period)
 *      Plus an estimatorAgreement metric (max - min) used by the gate.
 *   7. Beat rejection reasons:
 *        - amplitude below adaptive threshold
 *        - prominence below MAD floor
 *        - pulse width outside physiological range
 *        - IBI outside [minBpm, maxBpm]
 *        - dicrotic-notch double peak (caught by morphological refractory)
 *        - motion artefact (oversized prominence vs neighbours)
 *
 * No beat is invented. Each Beat carries a timestamp and full feature set.
 * Confidence is a function of morphology, not just amplitude.
 */

import {
  autocorrBpm as filtersAutocorrBpm,
  clamp,
  durationMs,
  mad,
  median,
  preprocessPPGRobust,
  spectralMetrics,
  type TimeSample,
} from "./PPGFilters";

/* ------------------------------------------------------------------ */
/*                              Types                                 */
/* ------------------------------------------------------------------ */

export type BeatRejectionReason =
  | "AMPLITUDE_BELOW_THRESHOLD"
  | "PROMINENCE_BELOW_MAD"
  | "PULSE_WIDTH_OUT_OF_RANGE"
  | "RR_OUT_OF_RANGE"
  | "DICROTIC_DOUBLE_PEAK"
  | "MOTION_ARTIFACT"
  | "REFRACTORY_VIOLATION"
  | "MORPHOLOGY_INVALID";

export interface BeatMorphology {
  /** Foot / pulse onset (last local minimum before the rising edge). */
  onsetT: number | null;
  onsetValue: number | null;
  /** Systolic peak — the publishable beat marker. */
  peakT: number;
  peakValue: number;
  /** Following trough (diastolic minimum). */
  troughT: number | null;
  troughValue: number | null;
  /** Peak amplitude over preceding foot. */
  amplitude: number;
  /** Rise time foot -> peak (ms). */
  riseTimeMs: number | null;
  /** Decay time peak -> trough (ms). */
  decayTimeMs: number | null;
  /** Full-width at half maximum (ms). */
  pulseWidthMs: number;
  /** Area under the pulse from foot to trough (a.u. * ms). */
  areaUnderPulse: number;
  /** Average rising slope (a.u./ms). */
  upSlope: number;
  /** Average falling slope (a.u./ms). */
  downSlope: number;
}

export interface Beat extends BeatMorphology {
  /** Peak timestamp (ms, monotonic). Mirrors `peakT` for backwards compat. */
  t: number;
  /** Same as `peakValue` — kept for older consumers. */
  prominence: number;
  /** Cardiac interval to previous accepted beat (ms). */
  rrMs?: number;
  /** Beat-level confidence in [0,1]. */
  confidence: number;
  /** If non-null, the candidate was withheld — stored for debug/visualisation. */
  rejectionReason?: BeatRejectionReason;
  /** Backwards-compat alias for amplitude relative to immediate left valley. */
  valleyPeakDistance?: number;
  /** Backwards-compat alias for FWHM. */
  pulseWidth?: number;
}

export interface BeatDetectionResult {
  /** Accepted beats only (rejected ones live in `withheldBeats`). */
  beats: Beat[];
  /** Candidates discarded by morphology / RR / motion guards. */
  withheldBeats: Beat[];
  /** Published BPM — only when estimators agree, otherwise null. */
  bpm: number | null;
  /** All detected RR intervals between accepted beats (ms). */
  rrIntervalsMs: number[];
  /** Aggregated confidence in [0,1]. */
  confidence: number;
  /** BPM derived from accepted peaks (median 60000/IBI). */
  peakBpm: number | null;
  /** Alias of peakBpm; kept explicit per spec. */
  medianIbiBpm: number | null;
  /** BPM from spectral peak in the cardiac band. */
  fftBpm: number | null;
  /** BPM from autocorrelation lag. */
  autocorrBpm: number | null;
  /** max(estimates) - min(estimates) in BPM (smaller is better). */
  estimatorAgreementBpm: number;
  /** Reason BPM was suppressed even when peaks exist. */
  publicationException?: string;
  /** Count of rejected candidates this window. */
  rejectedCandidates: number;
  /** Effective sample rate used for processing (Hz). */
  sampleRateHz: number;
  /** Simple irregularity flag — pSD(IBI)/median(IBI) > 0.18. NOT diagnostic. */
  irregularityFlag: boolean;
  /** Standard deviation of IBI in ms (HRV-like, informative only). */
  ibiStdMs: number;
}

function emptyResult(sampleRateHz = 30): BeatDetectionResult {
  return {
    beats: [],
    withheldBeats: [],
    bpm: null,
    rrIntervalsMs: [],
    confidence: 0,
    peakBpm: null,
    medianIbiBpm: null,
    fftBpm: null,
    autocorrBpm: null,
    estimatorAgreementBpm: 999,
    rejectedCandidates: 0,
    sampleRateHz,
    irregularityFlag: false,
    ibiStdMs: 0,
  };
}

/* ------------------------------------------------------------------ */
/*                          State machine                             */
/* ------------------------------------------------------------------ */

type DetectorState = "seeking_foot" | "rising" | "candidate_peak" | "falling" | "refractory";

interface Anchor {
  index: number;
  t: number;
  value: number;
}

/* ------------------------------------------------------------------ */
/*                           Detector                                 */
/* ------------------------------------------------------------------ */

export class BeatDetector {
  // Physiological bounds (BPM <-> seconds)
  private readonly minBpm = 30;
  private readonly maxBpm = 220;
  private readonly minIbiSec = 60 / this.maxBpm; // ~0.273 s
  private readonly maxIbiSec = 60 / this.minBpm; // 2.0 s
  // Pulse width physiological window (seconds, FWHM).
  private readonly minPulseWidthSec = 0.12;
  private readonly maxPulseWidthSec = 0.7;

  reset(): void {
    /* state-less per call */
  }

  detect(samples: TimeSample[]): BeatDetectionResult {
    if (samples.length < 40 || durationMs(samples) < 3500) return emptyResult();

    const avgFps = 1000 / (durationMs(samples) / samples.length);
    const targetFs = clamp(avgFps, 15, 60);

    const pre = preprocessPPGRobust(samples, 0.5, 4.0, targetFs);
    if (!pre.valid) return emptyResult(targetFs);

    const signal = pre.samples;
    const fs = pre.actualFs;
    if (signal.length < 40) return emptyResult(fs);

    const values = signal.map((s) => s.value);
    const times = signal.map((s) => s.t);

    // Adaptive amplitude threshold: rolling MAD over the last ~6 s.
    const tailLen = Math.min(values.length, Math.floor(fs * 6));
    const tail = values.slice(values.length - tailLen);
    const tailMedian = median(tail);
    const sigmaTail = 1.4826 * mad(tail) || 1e-3;
    const amplitudeFloor = tailMedian + Math.max(0.18, sigmaTail * 0.4);
    const prominenceFloor = Math.max(0.20, sigmaTail * 0.55);

    // Dynamic refractory in seconds. We start near 60/maxBpm and tighten as
    // beats accumulate (median IBI converges).
    let refractorySec = this.minIbiSec;

    // ---------- State machine ----------
    let state: DetectorState = "seeking_foot";
    let foot: Anchor | null = null;
    let peak: Anchor | null = null;
    let lastAcceptedPeakT = -Infinity;

    const accepted: Beat[] = [];
    const withheld: Beat[] = [];
    const rrIntervals: number[] = [];

    const pushAccept = (beat: Beat) => {
      const prev = accepted[accepted.length - 1];
      if (prev) {
        const rr = beat.t - prev.t;
        beat.rrMs = rr;
        rrIntervals.push(rr);
        // Tighten refractory toward median IBI (clamped to physiologic).
        if (rrIntervals.length >= 3) {
          const medRr = median(rrIntervals) / 1000;
          refractorySec = clamp(medRr * 0.55, this.minIbiSec, 0.85);
        }
      }
      accepted.push(beat);
      lastAcceptedPeakT = beat.t;
    };

    for (let i = 1; i < values.length - 1; i += 1) {
      const v = values[i];
      const vPrev = values[i - 1];
      const vNext = values[i + 1];

      switch (state) {
        case "seeking_foot": {
          // A foot is a local minimum below the running median.
          if (v <= vPrev && v <= vNext && v < tailMedian) {
            foot = { index: i, t: times[i], value: v };
            state = "rising";
          }
          break;
        }
        case "rising": {
          if (!foot) { state = "seeking_foot"; break; }
          // Lower the foot if we keep dropping.
          if (v < foot.value) foot = { index: i, t: times[i], value: v };
          // Promote to candidate when we cross the amplitude floor going up.
          if (v >= amplitudeFloor && v > vPrev) {
            state = "candidate_peak";
            peak = { index: i, t: times[i], value: v };
          }
          break;
        }
        case "candidate_peak": {
          if (!peak) { state = "seeking_foot"; break; }
          if (v > peak.value) {
            peak = { index: i, t: times[i], value: v };
          } else if (v < peak.value && vNext < v) {
            // Confirmed peak — start falling.
            state = "falling";
          }
          break;
        }
        case "falling": {
          if (!peak || !foot) { state = "seeking_foot"; break; }
          // Detect trough: local min after peak, OR end-of-window guard.
          const isTrough = v <= vPrev && v <= vNext;
          if (isTrough || i === values.length - 2) {
            const troughIdx = i;
            const beat = this.buildBeat({
              foot,
              peak,
              troughIdx,
              values,
              times,
              fs,
              tailMedian,
              prominenceFloor,
              sigmaTail,
              minPulseWidthMs: this.minPulseWidthSec * 1000,
              maxPulseWidthMs: this.maxPulseWidthSec * 1000,
              lastAcceptedPeakT,
              refractorySec,
            });

            if (beat.rejectionReason) {
              withheld.push(beat);
            } else {
              // RR sanity vs previous accepted beat
              const prev = accepted[accepted.length - 1];
              if (prev) {
                const rrMs = beat.t - prev.t;
                if (rrMs < this.minIbiSec * 1000 || rrMs > this.maxIbiSec * 1000) {
                  beat.rejectionReason = "RR_OUT_OF_RANGE";
                  withheld.push(beat);
                } else {
                  pushAccept(beat);
                }
              } else {
                pushAccept(beat);
              }
            }
            // Move into refractory anchored to *peak* time, not trough.
            state = "refractory";
            foot = { index: troughIdx, t: times[troughIdx], value: values[troughIdx] };
            peak = null;
          }
          break;
        }
        case "refractory": {
          if (lastAcceptedPeakT > 0 && (times[i] - lastAcceptedPeakT) / 1000 >= refractorySec) {
            state = "seeking_foot";
          }
          break;
        }
      }
    }

    if (accepted.length === 0) {
      return {
        ...emptyResult(fs),
        withheldBeats: withheld,
        rejectedCandidates: withheld.length,
      };
    }

    // ----------- Multi-estimator BPM -----------
    const peakBpm = rrIntervals.length >= 1 ? 60000 / median(rrIntervals) : null;
    const medianIbiBpm = peakBpm;

    const spectral = spectralMetrics(signal, this.minBpm / 60, this.maxBpm / 60);
    const fftBpm = spectral.bandPowerRatio >= 0.25 ? spectral.dominantFrequencyBpm : null;
    const autoc = filtersAutocorrBpm(signal, this.minBpm, this.maxBpm);
    const autocBpmValue = autoc.bpm;

    const estimates = [peakBpm, fftBpm, autocBpmValue].filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= this.minBpm && v <= this.maxBpm,
    );
    const estimatorAgreementBpm = estimates.length >= 2
      ? Math.max(...estimates) - Math.min(...estimates)
      : 999;

    // ----------- Confidence & exception -----------
    const meanBeatConf = accepted.reduce((s, b) => s + b.confidence, 0) / accepted.length;
    const rrMedian = rrIntervals.length ? median(rrIntervals) : 0;
    const rrDev = rrIntervals.length ? median(rrIntervals.map((rr) => Math.abs(rr - rrMedian))) : 0;
    const rrConsistency = rrMedian > 0 ? clamp(1 - rrDev / Math.max(1, rrMedian), 0, 1) : 0;

    let confidenceFactor = 1.0;
    let publicationException: string | undefined;

    if (estimates.length < 2) {
      confidenceFactor *= 0.5;
      publicationException = "ONLY_ONE_ESTIMATOR_AVAILABLE";
    } else if (estimatorAgreementBpm > 12) {
      confidenceFactor *= 0.45;
      publicationException = `ESTIMATORS_DISAGREE_${estimatorAgreementBpm.toFixed(1)}_BPM`;
    } else if (estimatorAgreementBpm > 6) {
      confidenceFactor *= 0.78;
    }
    if (accepted.length < 4) confidenceFactor *= 0.6;

    // Publish BPM only when estimators agree OR a strong-temporal exception applies.
    const strongTemporalException =
      peakBpm !== null &&
      meanBeatConf >= 0.7 &&
      rrConsistency >= 0.65 &&
      spectral.bandPowerRatio >= 0.4;

    const bpmCanPublish =
      peakBpm !== null &&
      (estimates.length >= 2 && estimatorAgreementBpm <= 8 || strongTemporalException);

    const ibiMean = rrIntervals.length ? rrIntervals.reduce((s, v) => s + v, 0) / rrIntervals.length : 0;
    const ibiVar = rrIntervals.length
      ? rrIntervals.reduce((s, v) => s + (v - ibiMean) * (v - ibiMean), 0) / rrIntervals.length
      : 0;
    const ibiStdMs = Math.sqrt(ibiVar);
    const irregularityFlag = rrMedian > 0 && ibiStdMs / rrMedian > 0.18;

    return {
      beats: accepted,
      withheldBeats: withheld,
      bpm: bpmCanPublish ? peakBpm : null,
      rrIntervalsMs: rrIntervals,
      confidence: clamp((meanBeatConf * 0.6 + rrConsistency * 0.4) * confidenceFactor, 0, 1),
      peakBpm,
      medianIbiBpm,
      fftBpm,
      autocorrBpm: autocBpmValue,
      estimatorAgreementBpm,
      publicationException: bpmCanPublish ? undefined : publicationException ?? "INSUFFICIENT_AGREEMENT",
      rejectedCandidates: withheld.length,
      sampleRateHz: fs,
      irregularityFlag,
      ibiStdMs,
    };
  }

  /* -------------------------------------------------------------- */
  /*                       Beat construction                        */
  /* -------------------------------------------------------------- */

  private buildBeat(p: {
    foot: Anchor;
    peak: Anchor;
    troughIdx: number;
    values: number[];
    times: number[];
    fs: number;
    tailMedian: number;
    prominenceFloor: number;
    sigmaTail: number;
    minPulseWidthMs: number;
    maxPulseWidthMs: number;
    lastAcceptedPeakT: number;
    refractorySec: number;
  }): Beat {
    const { foot, peak, troughIdx, values, times, prominenceFloor, sigmaTail,
      minPulseWidthMs, maxPulseWidthMs, lastAcceptedPeakT, refractorySec } = p;

    const troughValue = values[troughIdx];
    const troughT = times[troughIdx];

    const amplitude = peak.value - foot.value;
    const prominence = peak.value - Math.max(foot.value, troughValue);

    // FWHM
    const halfHeight = foot.value + amplitude * 0.5;
    let leftHalf = peak.index;
    while (leftHalf > foot.index && values[leftHalf] > halfHeight) leftHalf -= 1;
    let rightHalf = peak.index;
    while (rightHalf < troughIdx && values[rightHalf] > halfHeight) rightHalf += 1;
    const pulseWidthMs = times[rightHalf] - times[leftHalf];

    // Slopes
    const riseMs = peak.t - foot.t;
    const decayMs = troughT - peak.t;
    const upSlope = riseMs > 0 ? amplitude / riseMs : 0;
    const downSlope = decayMs > 0 ? (peak.value - troughValue) / decayMs : 0;

    // Area under pulse (trapezoidal)
    let area = 0;
    for (let k = foot.index; k < troughIdx; k += 1) {
      const dt = times[k + 1] - times[k];
      const a = values[k] - foot.value;
      const b = values[k + 1] - foot.value;
      area += ((a + b) / 2) * dt;
    }

    const morph: BeatMorphology = {
      onsetT: foot.t,
      onsetValue: foot.value,
      peakT: peak.t,
      peakValue: peak.value,
      troughT,
      troughValue,
      amplitude,
      riseTimeMs: riseMs,
      decayTimeMs: decayMs,
      pulseWidthMs,
      areaUnderPulse: area,
      upSlope,
      downSlope,
    };

    let rejection: BeatRejectionReason | undefined;

    if (peak.value < p.tailMedian + Math.max(0.18, sigmaTail * 0.4)) {
      rejection = "AMPLITUDE_BELOW_THRESHOLD";
    } else if (prominence < prominenceFloor) {
      rejection = "PROMINENCE_BELOW_MAD";
    } else if (pulseWidthMs < minPulseWidthMs || pulseWidthMs > maxPulseWidthMs) {
      rejection = "PULSE_WIDTH_OUT_OF_RANGE";
    } else if (riseMs <= 0 || decayMs <= 0) {
      rejection = "MORPHOLOGY_INVALID";
    } else if (riseMs > decayMs * 2.2) {
      // Dicrotic notch double-peak: a real systolic peak rises faster than it decays.
      rejection = "DICROTIC_DOUBLE_PEAK";
    } else if (amplitude > sigmaTail * 12) {
      // Outsized excursion vs local noise => motion artefact.
      rejection = "MOTION_ARTIFACT";
    } else if (lastAcceptedPeakT > 0 && (peak.t - lastAcceptedPeakT) / 1000 < refractorySec) {
      rejection = "REFRACTORY_VIOLATION";
    }

    const promScore = clamp(prominence / Math.max(0.6, sigmaTail * 1.6), 0, 1);
    const slopeScore = clamp((upSlope + downSlope) * 50, 0, 1);
    const widthScore = pulseWidthMs > 0
      ? clamp(1 - Math.abs(pulseWidthMs - 320) / 320, 0, 1)
      : 0;
    const confidence = clamp(promScore * 0.55 + slopeScore * 0.25 + widthScore * 0.20, 0, 1);

    return {
      ...morph,
      t: peak.t,
      prominence,
      valleyPeakDistance: amplitude,
      pulseWidth: pulseWidthMs,
      confidence: rejection ? confidence * 0.4 : confidence,
      rejectionReason: rejection,
    };
  }
}
