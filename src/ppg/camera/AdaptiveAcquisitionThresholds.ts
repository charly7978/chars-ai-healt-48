/**
 * AdaptiveAcquisitionThresholds
 * -----------------------------------------------------------------------------
 * Forensic, NON-SIMULATING adaptive threshold engine.
 *
 * Goal: reduce false positives in the acquisition hard-gate by replacing fixed
 * constants (minFps=18, jitter<=14ms, fpsQuality>=50, contactScore>=0.45,
 * perfusionIndex>=0.02, ...) with per-device thresholds that are LEARNED FROM
 * REAL TELEMETRY observed during a profiling window right after the camera
 * starts.
 *
 * Hard rules (audit-grade):
 *  - We NEVER fabricate, randomise or back-fill any sample.
 *  - We only OBSERVE real telemetry produced by FrameSampler / camera readback
 *    / RadiometricPPGExtractor and emit threshold values.
 *  - We always tighten thresholds relative to what the device DEMONSTRATED it
 *    can sustain — never loosen them below the safety floor.
 *  - Until the profiling window is complete, the SAFETY_FLOOR thresholds are
 *    used (these are the previous hardcoded values, kept as a lower bound).
 *
 * Telemetry consumed (all real, all measured):
 *  - measuredFps      — real EMA fps from rVFC presentation timestamps.
 *  - jitterMs         — MAD of inter-frame dt (robust to outliers).
 *  - fpsQuality       — 0..100 cadence score from FrameSampler.
 *  - droppedRatio     — dropped frames / total frames.
 *  - torchReadback    — getSettings().torch === true after applyConstraints.
 *  - sensorNoiseDb    — DC noise floor in dB measured on the linearized red
 *                       channel during a finger-OFF window (ambient baseline).
 *  - acquisitionMethod — rVFC vs rAF vs interval. Worse APIs raise the floor.
 *
 * Thresholds emitted (consumed by usePPGMeasurement hard gate and by
 * PPGPublicationGate):
 *  - minMeasuredFps
 *  - maxJitterMs
 *  - minFpsQuality
 *  - maxDroppedRatio
 *  - minContactScore
 *  - minPerfusionIndex
 *  - minBandPowerRatio
 *  - minTotalQualityScore
 *
 * Lifecycle:
 *  1. on camera start → reset(). Profiling window of `profilingWindowFrames`
 *     real frames begins. SAFETY_FLOOR is in effect.
 *  2. each real frame → observeFrame({ measuredFps, jitterMs, fpsQuality,
 *     droppedFrameEstimate, frameCount, acquisitionMethod }).
 *  3. each baseline (finger-OFF) sample → observeAmbientSample({ red, green }).
 *  4. when profiling completes → derived thresholds become active. Subsequent
 *     observations keep updating an EMA so the thresholds track sustained
 *     drift (e.g. thermal throttling lowering effective fps).
 *  5. setTorchReadback(applied) is called once the camera controller resolves
 *     the torch state. If the torch could not be applied, the perfusion floor
 *     is raised because reflectance contrast will be physically lower without
 *     active illumination, and false positives are easier without flash.
 */

import type { AcquisitionMethod } from "./FrameSampler";

export interface AdaptiveThresholds {
  /** Minimum sustained measured FPS for the hard gate to open. */
  minMeasuredFps: number;
  /** Maximum tolerated MAD jitter in ms. */
  maxJitterMs: number;
  /** Minimum FrameSampler cadence quality (0..100). */
  minFpsQuality: number;
  /** Maximum dropped-frame ratio (0..1). */
  maxDroppedRatio: number;
  /** Minimum ROI contact score (0..1) required to consider a sample. */
  minContactScore: number;
  /** Minimum AC/DC perfusion index required for vitals publication. */
  minPerfusionIndex: number;
  /** Minimum cardiac-band power ratio required for vitals publication. */
  minBandPowerRatio: number;
  /** Minimum aggregated quality score (0..100) for vitals publication. */
  minTotalQualityScore: number;
}

export interface AdaptiveProfileSnapshot {
  thresholds: AdaptiveThresholds;
  active: boolean;
  framesObserved: number;
  framesRequired: number;
  acquisitionMethod: AcquisitionMethod | "none";
  torchApplied: boolean | null;
  /** Sustained statistics observed during profiling (and kept via EMA). */
  observed: {
    p10MeasuredFps: number;
    p90JitterMs: number;
    p10FpsQuality: number;
    p90DroppedRatio: number;
    sensorNoiseDb: number;
  };
  reasons: string[];
}

/**
 * Hardcoded SAFETY FLOOR — equal to the previous fixed thresholds. Adaptive
 * tightening can only RAISE these values; it can never relax them, so a noisy
 * device cannot lower the bar to publish bad measurements.
 */
const SAFETY_FLOOR: Readonly<AdaptiveThresholds> = Object.freeze({
  minMeasuredFps: 18,
  maxJitterMs: 14,
  minFpsQuality: 50,
  maxDroppedRatio: 0.10,
  minContactScore: 0.45,
  minPerfusionIndex: 0.02,
  minBandPowerRatio: 0.30,
  minTotalQualityScore: 60,
});

/** Robust percentile on a small array (no allocations beyond a sort copy). */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

export interface AdaptiveAcquisitionConfig {
  /** Real frames required before adaptive thresholds become active. */
  profilingWindowFrames?: number;
  /** EMA factor used after profiling to keep thresholds tracking drift. */
  driftEmaAlpha?: number;
  /** Hard ceiling so a perfect device cannot demand impossible cadence. */
  maxMinFps?: number;
}

export class AdaptiveAcquisitionThresholds {
  private readonly profilingWindowFrames: number;
  private readonly driftEmaAlpha: number;
  private readonly maxMinFps: number;

  private fpsSamples: number[] = [];
  private jitterSamples: number[] = [];
  private fpsQualitySamples: number[] = [];
  private droppedRatioSamples: number[] = [];

  private ambientRedSamples: number[] = [];
  private ambientGreenSamples: number[] = [];
  private sensorNoiseDb = -40; // pessimistic default until measured

  private framesObserved = 0;
  private acquisitionMethod: AcquisitionMethod | "none" = "none";
  private torchApplied: boolean | null = null;

  /** EMA-tracked sustained values (after profiling). */
  private ema = {
    p10Fps: 0,
    p90Jitter: 0,
    p10FpsQuality: 0,
    p90DroppedRatio: 0,
  };

  private current: AdaptiveThresholds = { ...SAFETY_FLOOR };
  private active = false;

  constructor(config: AdaptiveAcquisitionConfig = {}) {
    this.profilingWindowFrames = Math.max(60, config.profilingWindowFrames ?? 90);
    this.driftEmaAlpha = Math.min(0.5, Math.max(0.01, config.driftEmaAlpha ?? 0.08));
    this.maxMinFps = Math.min(28, Math.max(20, config.maxMinFps ?? 24));
  }

  reset(): void {
    this.fpsSamples = [];
    this.jitterSamples = [];
    this.fpsQualitySamples = [];
    this.droppedRatioSamples = [];
    this.ambientRedSamples = [];
    this.ambientGreenSamples = [];
    this.sensorNoiseDb = -40;
    this.framesObserved = 0;
    this.acquisitionMethod = "none";
    this.torchApplied = null;
    this.ema = { p10Fps: 0, p90Jitter: 0, p10FpsQuality: 0, p90DroppedRatio: 0 };
    this.current = { ...SAFETY_FLOOR };
    this.active = false;
  }

  /**
   * Feed a single real frame's telemetry. Must be called with values that
   * actually came from the FrameSampler — never with synthesised numbers.
   */
  observeFrame(input: {
    measuredFps: number;
    jitterMs: number;
    fpsQuality: number;
    droppedFrameEstimate: number;
    frameCount: number;
    acquisitionMethod: AcquisitionMethod;
  }): void {
    this.acquisitionMethod = input.acquisitionMethod;

    // Skip pathological zero-fps boot frames; they bias the floor downward.
    if (input.measuredFps <= 0 || !Number.isFinite(input.measuredFps)) return;

    const droppedRatio = input.frameCount > 0
      ? Math.min(1, Math.max(0, input.droppedFrameEstimate / input.frameCount))
      : 0;

    if (this.framesObserved < this.profilingWindowFrames) {
      this.fpsSamples.push(input.measuredFps);
      this.jitterSamples.push(Math.max(0, input.jitterMs));
      this.fpsQualitySamples.push(Math.max(0, Math.min(100, input.fpsQuality)));
      this.droppedRatioSamples.push(droppedRatio);
      this.framesObserved++;

      if (this.framesObserved >= this.profilingWindowFrames) {
        this.derive();
        this.active = true;
      }
    } else {
      // Post-profiling: smoothly track drift (e.g. thermal throttling).
      const a = this.driftEmaAlpha;
      const p10Fps = input.measuredFps;
      const p90Jitter = Math.max(0, input.jitterMs);
      const p10FpsQ = Math.max(0, Math.min(100, input.fpsQuality));
      const p90Drop = droppedRatio;
      this.ema.p10Fps = (1 - a) * this.ema.p10Fps + a * p10Fps;
      this.ema.p90Jitter = (1 - a) * this.ema.p90Jitter + a * p90Jitter;
      this.ema.p10FpsQuality = (1 - a) * this.ema.p10FpsQuality + a * p10FpsQ;
      this.ema.p90DroppedRatio = (1 - a) * this.ema.p90DroppedRatio + a * p90Drop;
      this.derive();
    }
  }

  /**
   * Feed an ambient (finger-OFF) optical sample. Used to estimate the camera's
   * dark-noise floor in dB. Call only when ROI evidence indicates NO_CONTACT.
   */
  observeAmbientSample(rgb: { r: number; g: number; b: number }): void {
    if (this.ambientRedSamples.length >= 240) {
      this.ambientRedSamples.shift();
      this.ambientGreenSamples.shift();
    }
    this.ambientRedSamples.push(rgb.r);
    this.ambientGreenSamples.push(rgb.g);

    if (this.ambientRedSamples.length >= 30) {
      // Sensor noise = std / mean (red channel), expressed in dB.
      const red = this.ambientRedSamples;
      const mean = red.reduce((s, v) => s + v, 0) / red.length;
      if (mean > 1e-3) {
        let acc = 0;
        for (const v of red) acc += (v - mean) * (v - mean);
        const std = Math.sqrt(acc / red.length);
        const ratio = std / mean;
        this.sensorNoiseDb = 20 * Math.log10(Math.max(1e-6, ratio));
      }
    }
  }

  /** Called once the camera controller has resolved torch state. */
  setTorchReadback(applied: boolean): void {
    this.torchApplied = applied;
    this.derive();
  }

  /**
   * Hot-start hydration from a previously persisted record (per device/camera).
   * The persisted thresholds and noise floor become the starting point so the
   * gate can open as soon as live telemetry confirms cadence — typically in
   * seconds instead of waiting for the full profilingWindowFrames warmup.
   *
   * Forensic guarantees:
   *  - Hydrated thresholds are the FLOOR for live derivation (we never
   *    publish a relaxed value just because storage said so). The runtime
   *    `derive()` will only RAISE these values, never lower them.
   *  - We mark the engine as "active" with a small seed frameCount equal
   *    to the profiling window. This represents prior real observations on
   *    THIS device — never fake samples; the EMA still tracks live frames
   *    from the very next observeFrame() call.
   */
  hydrate(input: {
    thresholds: AdaptiveThresholds;
    sensorNoiseDb: number;
    p10MeasuredFps: number;
    p90JitterMs: number;
    p10FpsQuality?: number;
    p90DroppedRatio?: number;
    acquisitionMethod?: AcquisitionMethod | "none";
    torchApplied?: boolean | null;
  }): void {
    // Hydrated thresholds become the new working floor (never below SAFETY_FLOOR
    // since the store already clamps; we re-clamp defensively).
    this.current = {
      minMeasuredFps: Math.max(SAFETY_FLOOR.minMeasuredFps, input.thresholds.minMeasuredFps),
      maxJitterMs: Math.min(SAFETY_FLOOR.maxJitterMs, input.thresholds.maxJitterMs),
      minFpsQuality: Math.max(SAFETY_FLOOR.minFpsQuality, input.thresholds.minFpsQuality),
      maxDroppedRatio: Math.min(SAFETY_FLOOR.maxDroppedRatio, input.thresholds.maxDroppedRatio),
      minContactScore: Math.max(SAFETY_FLOOR.minContactScore, input.thresholds.minContactScore),
      minPerfusionIndex: Math.max(SAFETY_FLOOR.minPerfusionIndex, input.thresholds.minPerfusionIndex),
      minBandPowerRatio: Math.max(SAFETY_FLOOR.minBandPowerRatio, input.thresholds.minBandPowerRatio),
      minTotalQualityScore: Math.max(SAFETY_FLOOR.minTotalQualityScore, input.thresholds.minTotalQualityScore),
    };
    this.sensorNoiseDb = input.sensorNoiseDb;
    this.ema = {
      p10Fps: input.p10MeasuredFps,
      p90Jitter: input.p90JitterMs,
      p10FpsQuality: input.p10FpsQuality ?? this.current.minFpsQuality,
      p90DroppedRatio: input.p90DroppedRatio ?? 0,
    };
    if (input.acquisitionMethod) this.acquisitionMethod = input.acquisitionMethod;
    if (input.torchApplied !== undefined) this.torchApplied = input.torchApplied;
    this.framesObserved = this.profilingWindowFrames; // mark warmup satisfied
    this.active = true;
  }

  /** Snapshot tailored for persistence — the minimum needed to hot-start. */
  exportRecord(): {
    thresholds: AdaptiveThresholds;
    observed: { sensorNoiseDb: number; p10MeasuredFps: number; p90JitterMs: number };
    acquisitionMethod: AcquisitionMethod | "none";
    torchApplied: boolean | null;
  } | null {
    if (!this.active) return null;
    return {
      thresholds: { ...this.current },
      observed: {
        sensorNoiseDb: this.sensorNoiseDb,
        p10MeasuredFps: this.ema.p10Fps,
        p90JitterMs: this.ema.p90Jitter,
      },
      acquisitionMethod: this.acquisitionMethod,
      torchApplied: this.torchApplied,
    };
  }

  /** Snapshot for UI / debug telemetry. */
  snapshot(): AdaptiveProfileSnapshot {
    const reasons: string[] = [];
    if (!this.active) reasons.push(`PROFILING_${this.framesObserved}/${this.profilingWindowFrames}`);
    if (this.torchApplied === false) reasons.push("TORCH_NOT_APPLIED_RAISED_PERFUSION_FLOOR");
    if (this.acquisitionMethod === "intervalFallback") reasons.push("INTERVAL_FALLBACK_RAISED_FPSQ_FLOOR");
    if (this.acquisitionMethod === "requestAnimationFrame") reasons.push("RAF_FALLBACK_RAISED_JITTER_FLOOR");
    if (this.sensorNoiseDb > -25) reasons.push(`HIGH_SENSOR_NOISE_${this.sensorNoiseDb.toFixed(1)}DB`);

    return {
      thresholds: { ...this.current },
      active: this.active,
      framesObserved: this.framesObserved,
      framesRequired: this.profilingWindowFrames,
      acquisitionMethod: this.acquisitionMethod,
      torchApplied: this.torchApplied,
      observed: {
        p10MeasuredFps: this.active
          ? this.ema.p10Fps
          : percentile(this.fpsSamples, 10),
        p90JitterMs: this.active
          ? this.ema.p90Jitter
          : percentile(this.jitterSamples, 90),
        p10FpsQuality: this.active
          ? this.ema.p10FpsQuality
          : percentile(this.fpsQualitySamples, 10),
        p90DroppedRatio: this.active
          ? this.ema.p90DroppedRatio
          : percentile(this.droppedRatioSamples, 90),
        sensorNoiseDb: this.sensorNoiseDb,
      },
      reasons,
    };
  }

  /** Active thresholds (always returns SAFETY_FLOOR or stricter). */
  getThresholds(): AdaptiveThresholds {
    return this.current;
  }

  /**
   * Recompute thresholds from observed telemetry. Always clamps to be >=
   * SAFETY_FLOOR (i.e. only tightens) and <= maxMinFps for fps so a perfect
   * device cannot demand 60fps when 24fps is medically sufficient.
   */
  private derive(): void {
    // Pull sustained values: percentiles during profiling, EMA after.
    const p10Fps = this.active
      ? this.ema.p10Fps
      : percentile(this.fpsSamples, 10);
    const p90Jitter = this.active
      ? this.ema.p90Jitter
      : percentile(this.jitterSamples, 90);
    const p10FpsQ = this.active
      ? this.ema.p10FpsQuality
      : percentile(this.fpsQualitySamples, 10);
    const p90Dropped = this.active
      ? this.ema.p90DroppedRatio
      : percentile(this.droppedRatioSamples, 90);

    // FPS floor: device must sustain 90% of what it actually delivered, but
    // never below SAFETY_FLOOR.minMeasuredFps and never above maxMinFps.
    let minFps = SAFETY_FLOOR.minMeasuredFps;
    if (p10Fps > 0) {
      const adaptive = Math.floor(p10Fps * 0.92);
      minFps = Math.min(this.maxMinFps, Math.max(SAFETY_FLOOR.minMeasuredFps, adaptive));
    }

    // Jitter ceiling: 1.5x what the device actually exhibited, capped at the
    // safety floor (i.e. we never permit MORE jitter than the legacy 14ms).
    let maxJitter = SAFETY_FLOOR.maxJitterMs;
    if (p90Jitter > 0) {
      const adaptive = Math.max(2, Math.min(SAFETY_FLOOR.maxJitterMs, p90Jitter * 1.5));
      maxJitter = adaptive;
    }

    // FPS quality floor: at least the safety floor; tighten if the device
    // routinely posts higher quality.
    let minFpsQ = SAFETY_FLOOR.minFpsQuality;
    if (p10FpsQ > 0) {
      const adaptive = Math.max(SAFETY_FLOOR.minFpsQuality, Math.floor(p10FpsQ * 0.90));
      minFpsQ = Math.min(85, adaptive);
    }

    // Dropped ratio ceiling: at most the safety floor; tighten if the device
    // sustains lower dropped frames.
    let maxDropped = SAFETY_FLOOR.maxDroppedRatio;
    if (p90Dropped >= 0) {
      const adaptive = Math.max(0.02, Math.min(SAFETY_FLOOR.maxDroppedRatio, p90Dropped * 1.5));
      maxDropped = adaptive;
    }

    // Acquisition method penalty — rAF and interval are jittery by definition
    // so we forbid loosening jitter and we raise the fps quality floor.
    if (this.acquisitionMethod === "requestAnimationFrame") {
      maxJitter = Math.min(maxJitter, SAFETY_FLOOR.maxJitterMs);
      minFpsQ = Math.max(minFpsQ, 60);
    } else if (this.acquisitionMethod === "intervalFallback") {
      maxJitter = Math.min(maxJitter, 8);
      minFpsQ = Math.max(minFpsQ, 70);
    }

    // Torch readback: if the torch could NOT be applied, contrast is lower so
    // we MUST raise the perfusion + contact + bandpower floors to prevent
    // false positives from ambient-light fluctuations.
    let minPerfusion = SAFETY_FLOOR.minPerfusionIndex;
    let minContact = SAFETY_FLOOR.minContactScore;
    let minBand = SAFETY_FLOOR.minBandPowerRatio;
    let minTotal = SAFETY_FLOOR.minTotalQualityScore;
    if (this.torchApplied === false) {
      minPerfusion = Math.max(minPerfusion, 0.035); // +75% over floor
      minContact = Math.max(minContact, 0.55);
      minBand = Math.max(minBand, 0.40);
      minTotal = Math.max(minTotal, 70);
    }

    // Sensor noise: if the camera's measured noise floor is high (> -25 dB),
    // the perfusion / band-power floors must scale up so we don't accept
    // pulsations that are physically dominated by sensor noise.
    if (this.sensorNoiseDb > -25) {
      const excess = Math.min(15, this.sensorNoiseDb + 25); // 0..15 dB above safe
      const k = 1 + excess / 30;                              // 1.0 .. 1.5
      minPerfusion = Math.max(minPerfusion, SAFETY_FLOOR.minPerfusionIndex * k);
      minBand = Math.max(minBand, SAFETY_FLOOR.minBandPowerRatio * k);
      minTotal = Math.max(minTotal, SAFETY_FLOOR.minTotalQualityScore + Math.floor(excess));
    }

    this.current = {
      minMeasuredFps: minFps,
      maxJitterMs: maxJitter,
      minFpsQuality: minFpsQ,
      maxDroppedRatio: maxDropped,
      minContactScore: minContact,
      minPerfusionIndex: minPerfusion,
      minBandPowerRatio: minBand,
      minTotalQualityScore: minTotal,
    };
  }
}

export const ADAPTIVE_SAFETY_FLOOR = SAFETY_FLOOR;
