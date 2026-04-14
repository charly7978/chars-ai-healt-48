import { TimeSeriesRing } from './TimeSeriesRing';
import {
  AcceptedBeat,
  BeatCandidate,
  BeatFlag,
  BPMFusionState,
  BPMHypothesis,
  BPMHypothesisKey,
  DetectorHits,
  HeartBeatDebugSnapshot,
  HeartBeatProcessContext,
  HeartBeatProcessOutput,
  RejectionReason,
} from './types';

const MIN_BPM = 35;
const MAX_BPM = 200;
const WARMUP_MS = 1200;
const TEMPLATE_LEN = 40;
const MAX_TEMPLATE_BEATS = 10;
const RR_CAP = 24;
const PEAK_LOOKBACK = 24;
const PEAK_LOOKAHEAD = 24;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function medianArr(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function trimmedMeanArr(a: number[], trimEach: number): number {
  if (a.length <= trimEach * 2 + 1) return medianArr(a);
  const s = [...a].sort((x, y) => x - y);
  const slice = s.slice(trimEach, s.length - trimEach);
  let sum = 0;
  for (let i = 0; i < slice.length; i++) sum += slice[i];
  return sum / slice.length;
}

/**
 * Motor por capas: candidatos multi-detector, adjudicación, RR/BPM, plantilla, fusión, SQI por latido.
 */
export class HeartBeatEngine {
  private readonly series: TimeSeriesRing;
  private readonly cap: number;

  private baseline = 0;
  private readonly baselineAlpha = 0.92;

  private lastPushTs = 0;
  private estFs = 30;

  private adaptiveProminenceFloor = 0.04;

  private lastAcceptedTs: number | null = null;
  private previousAcceptedTs: number | null = null;

  private rrRing: Float64Array;
  private rrWrite = 0;
  private rrCount = 0;
  private missedSearchKey = -1;

  private ibiInstant = 0;

  private readonly templates: Float32Array[] = [];
  private templateMedian = new Float32Array(TEMPLATE_LEN);
  private templateValid = false;

  private pending: BeatCandidate | null = null;
  private pendingSince = 0;

  private lastDuplicateCheckTs = 0;

  private sessionAccepted = 0;
  private sessionRejected = 0;
  private doublePeakCount = 0;
  private missedBeatCount = 0;
  private suspiciousCount = 0;
  private prematureCount = 0;

  private lastPeakOutput = false;
  private lastCandidate: BeatCandidate | null = null;
  private lastRejection: RejectionReason = 'none';
  private lastAccepted: AcceptedBeat | null = null;

  private envelopeEma = 0;
  private readonly envAlpha = 0.08;

  private periodicityScore = 0;

  private fusedBpm = 0;
  private fusionState: BPMFusionState = {
    hypotheses: [],
    activeHypothesis: 'medianIbi',
    finalBpm: 0,
    spread: 0,
  };

  private lastOutputBpm = 0;
  private hysteresisBpm = 0;

  private lastDedupTs = -1;
  private lastDedupNorm = NaN;

  private startWallMs = 0;

  private derivState = { prevNorm: 0, prevTs: 0, maxUpslope: 0, upslopeStartTs: 0, inUpslope: false };

  constructor(capacity = 200) {
    this.cap = capacity;
    this.series = new TimeSeriesRing(capacity);
    this.rrRing = new Float64Array(RR_CAP);
    this.startWallMs = typeof performance !== 'undefined' ? performance.now() : 0;
  }

  reset(): void {
    this.series.clear();
    this.baseline = 0;
    this.lastPushTs = 0;
    this.estFs = 30;
    this.adaptiveProminenceFloor = 0.04;
    this.lastAcceptedTs = null;
    this.previousAcceptedTs = null;
    this.rrWrite = 0;
    this.rrCount = 0;
    this.missedSearchKey = -1;
    this.ibiInstant = 0;
    this.templates.length = 0;
    this.templateValid = false;
    this.pending = null;
    this.pendingSince = 0;
    this.sessionAccepted = 0;
    this.sessionRejected = 0;
    this.doublePeakCount = 0;
    this.missedBeatCount = 0;
    this.suspiciousCount = 0;
    this.prematureCount = 0;
    this.lastPeakOutput = false;
    this.lastCandidate = null;
    this.lastRejection = 'none';
    this.lastAccepted = null;
    this.envelopeEma = 0;
    this.periodicityScore = 0;
    this.fusedBpm = 0;
    this.hysteresisBpm = 0;
    this.lastOutputBpm = 0;
    this.lastDedupTs = -1;
    this.lastDedupNorm = NaN;
    this.derivState = { prevNorm: 0, prevTs: 0, maxUpslope: 0, upslopeStartTs: 0, inUpslope: false };
    this.startWallMs = typeof performance !== 'undefined' ? performance.now() : 0;
  }

  process(
    filteredValue: number,
    timestamp: number,
    ctx: HeartBeatProcessContext
  ): HeartBeatProcessOutput {
    this.lastPeakOutput = false;
    this.lastRejection = 'none';

    if (this.lastDedupTs === timestamp && this.lastDedupNorm === filteredValue) {
      return this.buildOutput(filteredValue, ctx, false);
    }
    this.lastDedupTs = timestamp;
    this.lastDedupNorm = filteredValue;

    this.baseline = this.baseline * this.baselineAlpha + filteredValue * (1 - this.baselineAlpha);
    const norm = filteredValue - this.baseline;
    const absn = Math.abs(norm);
    this.envelopeEma = this.envelopeEma * (1 - this.envAlpha) + absn * this.envAlpha;

    if (this.lastPushTs > 0) {
      const dt = Math.max(1, timestamp - this.lastPushTs);
      this.estFs = clamp(0.85 * this.estFs + 0.15 * (1000 / dt), 12, 90);
    }
    this.lastPushTs = timestamp;

    this.series.push(timestamp, norm);

    const dtDeriv = Math.max(1e-6, timestamp - this.derivState.prevTs);
    const deriv = (norm - this.derivState.prevNorm) / dtDeriv;
    this.updateDerivativeDetector(timestamp, norm, deriv);

    if (this.series.length >= 5) {
      this.periodicityScore = this.computePeriodicityScore();
    }

    if (this.series.length >= 8) {
      this.maybeDetectMissedBeat(timestamp, ctx);
    }

    if (this.series.length >= 4) {
      const peakIdx = this.series.length - 2;
      if (this.isLocalMaximum(peakIdx)) {
        this.evaluatePeakAtIndex(peakIdx, timestamp, ctx);
      }
    }

    if (this.pending && timestamp - this.pendingSince > 600) {
      this.pending = null;
    }

    return this.buildOutput(filteredValue, ctx, this.lastPeakOutput);
  }

  private updateDerivativeDetector(ts: number, norm: number, deriv: number): void {
    const thr = -0.0008 * Math.max(1, this.estFs / 30);
    if (deriv > Math.abs(thr) * 0.5) {
      if (!this.derivState.inUpslope) {
        this.derivState.inUpslope = true;
        this.derivState.upslopeStartTs = ts;
        this.derivState.maxUpslope = deriv;
      } else if (deriv > this.derivState.maxUpslope) {
        this.derivState.maxUpslope = deriv;
      }
    } else if (deriv < thr && this.derivState.inUpslope) {
      this.derivState.inUpslope = false;
    }
    this.derivState.prevNorm = norm;
    this.derivState.prevTs = ts;
  }

  private isLocalMaximum(i: number): boolean {
    if (i < 1 || i >= this.series.length - 1) return false;
    const a = this.series.valueAt(i - 1);
    const b = this.series.valueAt(i);
    const c = this.series.valueAt(i + 1);
    return b > a && b >= c;
  }

  private evaluatePeakAtIndex(peakIdx: number, frameTs: number, ctx: HeartBeatProcessContext): void {
    const tPeak = this.series.timeAt(peakIdx);
    const peakVal = this.series.valueAt(peakIdx);

    let cand = this.buildCandidate(peakIdx, tPeak, peakVal, frameTs, ctx);

    const refr = this.computeRefractory();
    if (this.lastAcceptedTs !== null) {
      const dt = tPeak - this.lastAcceptedTs;
      if (dt < refr.hardMs) {
        const scoreA = this.scoreCandidateQuality(cand);
        const exceptional = scoreA > 0.82 && cand.detectorAgreement > 0.65 && cand.templateCorrelation > 0.55;
        if (!exceptional) {
          this.resolveDoublePeak(cand, refr, ctx);
          return;
        }
      } else if (dt < refr.softMs) {
        if (cand.detectorAgreement < 0.45 && cand.morphologyScore < 0.55) {
          cand.adjudication = 'rejected';
          cand.rejectionReason = 'soft_refractory_double';
          this.lastRejection = cand.rejectionReason;
          this.sessionRejected++;
          this.doublePeakCount++;
          this.lastCandidate = cand;
          return;
        }
      }
    }

    if (cand.prominence < this.adaptiveProminenceFloor * 0.35) {
      cand.adjudication = 'rejected';
      cand.rejectionReason = 'low_prominence';
      this.lastRejection = cand.rejectionReason;
      this.sessionRejected++;
      this.lastCandidate = cand;
      return;
    }

    if (cand.widthMs < 45 || cand.widthMs > 420) {
      cand.adjudication = 'rejected';
      cand.rejectionReason = 'width_invalid';
      this.sessionRejected++;
      this.lastCandidate = cand;
      this.lastRejection = cand.rejectionReason;
      return;
    }

    const clipPen =
      (ctx.clipHighRatio ?? 0) * 0.55 + (ctx.clipLowRatio ?? 0) * 0.45;
    cand.localClipPenalty = clipPen;
    if (clipPen > 0.45) {
      cand.adjudication = 'rejected';
      cand.rejectionReason = 'clip_penalty';
      this.sessionRejected++;
      this.lastCandidate = cand;
      this.lastRejection = cand.rejectionReason;
      return;
    }

    const contact = ctx.contactState ?? '';
    if (
      contact === 'NO_CONTACT' ||
      contact === 'ACQUIRING_CONTACT' ||
      (ctx.fingerDetected === false && (ctx.upstreamSqi ?? 0) < 25)
    ) {
      cand.adjudication = 'rejected';
      cand.rejectionReason = 'unstable_contact';
      this.sessionRejected++;
      this.lastCandidate = cand;
      this.lastRejection = cand.rejectionReason;
      return;
    }

    if (cand.detectorAgreement < 0.32 && cand.morphologyScore < 0.5 && cand.periodicitySupport < 0.4) {
      cand.adjudication = 'rejected';
      cand.rejectionReason = 'poor_detector_support';
      this.sessionRejected++;
      this.lastCandidate = cand;
      this.lastRejection = cand.rejectionReason;
      return;
    }

    if (cand.detectorAgreement < 0.28 && cand.templateCorrelation < 0.35 && cand.periodicitySupport < 0.35) {
      cand.adjudication = 'pending';
      cand.rejectionReason = 'none';
      this.pending = cand;
      this.pendingSince = tPeak;
      this.lastCandidate = cand;
      return;
    }

    let flags = this.classifyBeat(cand, refr);

    if (this.pending) {
      this.pending = null;
    }

    cand.adjudication = 'accepted';
    cand.rejectionReason = 'none';
    this.finalizeBeat(cand, flags, ctx);
  }

  private resolveDoublePeak(
    cand: BeatCandidate,
    _refr: { hardMs: number },
    ctx: HeartBeatProcessContext
  ): void {
    if (!this.lastCandidate || this.lastCandidate.timestamp === cand.timestamp) {
      cand.adjudication = 'rejected';
      cand.rejectionReason = 'soft_refractory_double';
      this.sessionRejected++;
      this.doublePeakCount++;
      this.lastRejection = cand.rejectionReason;
      this.lastCandidate = cand;
      return;
    }
    const sNew = this.scoreCandidateQuality(cand);
    const sOld = this.scoreCandidateQuality(this.lastCandidate);
    const keep = sNew >= sOld ? cand : this.lastCandidate;
    const drop = sNew >= sOld ? this.lastCandidate : cand;
    drop.adjudication = 'rejected';
    drop.rejectionReason = 'duplicate_secondary';
    this.sessionRejected++;
    this.lastRejection = 'duplicate_secondary';
    this.lastCandidate = keep;
    if (keep === cand && sNew >= sOld) {
      this.finalizeBeat(keep, ['double_peak'], ctx);
    }
  }

  private scoreCandidateQuality(c: BeatCandidate): number {
    return (
      c.morphologyScore * 0.35 +
      c.detectorAgreement * 0.3 +
      c.templateCorrelation * 0.25 +
      c.periodicitySupport * 0.1
    );
  }

  private classifyBeat(cand: BeatCandidate, refr: { hardMs: number; softMs: number }): BeatFlag[] {
    const flags: BeatFlag[] = [];
    const exp = this.expectedRr();
    if (this.lastAcceptedTs) {
      const ibi = cand.timestamp - this.lastAcceptedTs;
      if (ibi < exp * 0.78) flags.push('premature');
      if (ibi > exp * 1.22) flags.push('suspicious');
    }
    if (cand.detectorAgreement < 0.42 || cand.morphologyScore < 0.48) {
      flags.push('weak');
    } else {
      flags.push('normal');
    }
    if (cand.timestamp - this.lastDuplicateCheckTs < refr.softMs && cand.detectorAgreement < 0.5) {
      flags.push('double_peak');
    }
    this.lastDuplicateCheckTs = cand.timestamp;
    return flags;
  }

  private finalizeBeat(cand: BeatCandidate, flags: BeatFlag[], ctx: HeartBeatProcessContext): void {
    const t = cand.timestamp;
    this.previousAcceptedTs = this.lastAcceptedTs;
    this.lastAcceptedTs = t;

    let ibi = 0;
    if (this.previousAcceptedTs !== null && this.lastAcceptedTs !== null) {
      ibi = this.lastAcceptedTs - this.previousAcceptedTs;
      if (ibi > 200 && ibi < 2200) {
        this.pushRr(ibi);
        this.ibiInstant = ibi;
      }
    }

    const instantBpm = ibi > 0 ? 60000 / ibi : 0;
    const { beatSQI, morph, rhythm, agr, tpl, src } = this.computeBeatSqi(cand, flags, ctx);

    const accepted: AcceptedBeat = {
      timestamp: t,
      ibiMs: ibi,
      instantBpm: instantBpm,
      beatSQI,
      morphologyScore: morph,
      rhythmScore: rhythm,
      detectorAgreementScore: agr,
      templateScore: tpl,
      sourceConsistencyScore: src,
      flags: [...new Set(flags)],
    };
    this.lastAccepted = accepted;
    this.sessionAccepted++;
    this.lastPeakOutput = true;
    this.missedSearchKey = -1;

    this.updateTemplate(cand);
    this.runBpmFusion(cand, ctx);
    this.adaptProminence(cand);

    if (flags.includes('premature')) this.prematureCount++;
    if (flags.includes('suspicious')) this.suspiciousCount++;

    this.lastCandidate = cand;
  }

  private computeBeatSqi(
    cand: BeatCandidate,
    flags: BeatFlag[],
    ctx: HeartBeatProcessContext
  ): {
    beatSQI: number;
    morph: number;
    rhythm: number;
    agr: number;
    tpl: number;
    src: number;
  } {
    const morph = clamp(cand.morphologyScore * 100, 0, 100);
    const agr = clamp(cand.detectorAgreement * 100, 0, 100);
    const tpl = clamp(cand.templateCorrelation * 100, 0, 100);
    const rhythm = clamp(cand.periodicitySupport * 100, 0, 100);
    const upstream = clamp((ctx.upstreamSqi ?? 50) / 100, 0, 1);
    const band = clamp(cand.localBandPowerRatio * 100, 0, 100);
    const perf = clamp(Math.min(1, (ctx.perfusionIndex ?? 1) / 80) * 100, 0, 100);

    let penalty =
      cand.localMotionPenalty * 22 +
      cand.localPressurePenalty * 18 +
      cand.localClipPenalty * 35 +
      (ctx.positionDrifting ? 12 : 0);

    if (flags.includes('weak')) penalty += 8;
    if (flags.includes('premature')) penalty += 10;
    if (flags.includes('suspicious')) penalty += 6;

    let raw =
      morph * 0.22 +
      agr * 0.18 +
      tpl * 0.16 +
      rhythm * 0.12 +
      band * 0.1 +
      perf * 0.08 +
      upstream * 100 * 0.14;
    raw -= penalty;
    const beatSQI = clamp(Math.round(raw), 0, 100);

    const maskStab = ctx.maskStability ?? 0.7;
    const src = clamp(((ctx.upstreamSqi ?? 50) / 100) * 0.5 + maskStab * 0.5, 0, 1) * 100;

    return { beatSQI, morph, rhythm, agr, tpl, src };
  }

  private buildCandidate(
    peakIdx: number,
    tPeak: number,
    peakVal: number,
    frameTs: number,
    ctx: HeartBeatProcessContext
  ): BeatCandidate {
    const i0 = Math.max(0, peakIdx - PEAK_LOOKBACK);
    const i1 = Math.min(this.series.length - 1, peakIdx + PEAK_LOOKAHEAD);

    let minL = peakVal;
    let minR = peakVal;
    for (let i = i0; i < peakIdx; i++) minL = Math.min(minL, this.series.valueAt(i));
    for (let i = peakIdx + 1; i <= i1; i++) minR = Math.min(minR, this.series.valueAt(i));
    const localBaseline = (minL + minR) / 2;
    const prominence = peakVal - Math.max(minL, minR);

    let upMax = -1e9;
    let downMin = 1e9;
    for (let i = i0; i < peakIdx; i++) {
      const d =
        (this.series.valueAt(i + 1) - this.series.valueAt(i)) /
        Math.max(1e-6, this.series.timeAt(i + 1) - this.series.timeAt(i));
      if (d > upMax) upMax = d;
    }
    for (let i = peakIdx; i < i1; i++) {
      const d =
        (this.series.valueAt(i + 1) - this.series.valueAt(i)) /
        Math.max(1e-6, this.series.timeAt(i + 1) - this.series.timeAt(i));
      if (d < downMin) downMin = d;
    }
    const half = localBaseline + prominence * 0.5;
    let leftCross = peakIdx;
    for (let i = peakIdx; i > i0; i--) {
      if (this.series.valueAt(i) < half) {
        leftCross = i;
        break;
      }
    }
    let rightCross = peakIdx;
    for (let i = peakIdx; i < i1; i++) {
      if (this.series.valueAt(i) < half) {
        rightCross = i;
        break;
      }
    }
    const widthMs = Math.abs(this.series.timeAt(rightCross) - this.series.timeAt(leftCross));

    const d1 = prominence >= this.adaptiveProminenceFloor && widthMs > 40;

    const upslopeWindowMs = 180;
    let d2 = false;
    if (Math.abs(tPeak - this.derivState.upslopeStartTs) < upslopeWindowMs && this.derivState.maxUpslope > 0) {
      d2 = true;
    }

    const envThr = this.envelopeEma * 0.85;
    const d3 = peakVal > envThr;

    const hits: DetectorHits = {
      systolicPeak: d1,
      derivativeUpslope: d2,
      envelopeSupport: d3,
    };

    let agreement = 0;
    if (d1 && d2) agreement = 0.92;
    else if (d1 && d3) agreement = 0.72;
    else if (d2 && d3) agreement = 0.58;
    else if (d1) agreement = 0.48;
    else if (d2) agreement = 0.35;
    else if (d3) agreement = 0.28;

    const zc =
      peakIdx > 0 && peakIdx < this.series.length - 1
        ? this.series.valueAt(peakIdx - 1) < 0 && peakVal > 0
          ? 1
          : 0.4
        : 0.4;

    const per = this.periodicitySupportForCandidate(tPeak);

    let tpl = 0.5;
    if (this.templateValid) {
      tpl = this.correlateTemplate(peakIdx);
    }

    const expRr = this.expectedRr();
    const lastT = this.lastAcceptedTs ?? tPeak - expRr;
    const rrCompat = 1 - Math.min(1, Math.abs(tPeak - lastT - expRr) / (expRr + 1e-6));

    const motionPen = clamp((ctx.motionArtifact ?? 0) / 100, 0, 1);
    const pressurePen =
      ctx.pressureState === 'HIGH_PRESSURE' || ctx.pressureState === 'LOW_PRESSURE' ? 0.35 : 0.08;
    const clipPen =
      (ctx.clipHighRatio ?? 0) * 0.55 + (ctx.clipLowRatio ?? 0) * 0.45;

    const bandRatio = this.localBandPower(peakIdx);

    const morphScore = clamp(
      prominence * 3.2 +
        (widthMs / 400) * 0.25 +
        tpl * 0.35 +
        Math.max(0, upMax) * 0.001 -
        clipPen * 0.4,
      0,
      1
    );

    return {
      timestamp: tPeak,
      sampleIndex: peakIdx,
      amplitude: peakVal,
      prominence,
      widthMs,
      upSlope: upMax,
      downSlope: downMin,
      localBaseline,
      detectorHits: hits,
      detectorAgreement: agreement,
      zeroCrossingSupport: zc,
      periodicitySupport: per * 0.5 + rrCompat * 0.5,
      templateCorrelation: tpl,
      localBandPowerRatio: bandRatio,
      localPerfusion: clamp((ctx.perfusionIndex ?? 0) / 100, 0, 1.5),
      localMotionPenalty: motionPen,
      localPressurePenalty: pressurePen,
      localClipPenalty: clipPen,
      morphologyScore: morphScore,
      adjudication: 'pending',
      rejectionReason: 'none',
    };
  }

  private localBandPower(peakIdx: number): number {
    const w = 12;
    const i0 = Math.max(0, peakIdx - w);
    const i1 = Math.min(this.series.length - 1, peakIdx + w);
    let e = 0;
    for (let i = i0; i < i1; i++) {
      const v = this.series.valueAt(i);
      e += v * v;
    }
    const n = i1 - i0 + 1e-6;
    return clamp(e / n, 0, 1);
  }

  private periodicitySupportForCandidate(tPeak: number): number {
    const exp = this.expectedRr();
    if (!this.lastAcceptedTs) return 0.5;
    const dt = tPeak - this.lastAcceptedTs;
    const err = Math.abs(dt - exp) / exp;
    return clamp(1 - err, 0, 1);
  }

  private correlateTemplate(peakIdx: number): number {
    const half = Math.floor(TEMPLATE_LEN / 2);
    const start = peakIdx - half;
    if (start < 0 || start + TEMPLATE_LEN > this.series.length) return 0.45;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < TEMPLATE_LEN; i++) {
      const a = this.series.valueAt(start + i);
      const b = this.templateMedian[i];
      sum += a * b;
      n += Math.abs(a) * Math.abs(b);
    }
    if (n < 1e-8) return 0.4;
    return clamp(sum / n, -1, 1);
  }

  private updateTemplate(cand: BeatCandidate): void {
    const peakIdx = cand.sampleIndex;
    const half = Math.floor(TEMPLATE_LEN / 2);
    const start = peakIdx - half;
    if (start < 0 || start + TEMPLATE_LEN > this.series.length) return;
    if (cand.morphologyScore < 0.42 || cand.templateCorrelation < 0.25) return;

    const snippet = new Float32Array(TEMPLATE_LEN);
    let maxAbs = 1e-6;
    for (let i = 0; i < TEMPLATE_LEN; i++) {
      snippet[i] = this.series.valueAt(start + i);
      maxAbs = Math.max(maxAbs, Math.abs(snippet[i]));
    }
    for (let i = 0; i < TEMPLATE_LEN; i++) snippet[i] /= maxAbs;

    this.templates.push(snippet);
    if (this.templates.length > MAX_TEMPLATE_BEATS) this.templates.shift();

    for (let i = 0; i < TEMPLATE_LEN; i++) {
      const row: number[] = [];
      for (let k = 0; k < this.templates.length; k++) row.push(this.templates[k][i]);
      this.templateMedian[i] = medianArr(row);
    }
    this.templateValid = this.templates.length >= 3;
  }

  private adaptProminence(cand: BeatCandidate): void {
    const target = clamp(cand.prominence * 0.55, 0.02, 0.22);
    this.adaptiveProminenceFloor =
      this.adaptiveProminenceFloor * 0.92 + target * 0.08;
  }

  private pushRr(ms: number): void {
    const pos = this.rrWrite % RR_CAP;
    this.rrRing[pos] = ms;
    this.rrWrite++;
    if (this.rrCount < RR_CAP) this.rrCount++;
  }

  private rrSlice(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.rrCount; i++) {
      const idx = (this.rrWrite - this.rrCount + i + RR_CAP * 2) % RR_CAP;
      out.push(this.rrRing[idx]);
    }
    return out;
  }

  private expectedRr(): number {
    const r = this.rrSlice();
    if (r.length === 0) return 800;
    return medianArr(r);
  }

  private computeRefractory(): { hardMs: number; softMs: number; recoveryMs: number } {
    const exp = this.expectedRr();
    const hardMs = clamp(exp * 0.26, 200, 480);
    const softMs = clamp(exp * 0.4, 280, 620);
    const recoveryMs = clamp(exp * 1.75, 700, 1600);
    return { hardMs, softMs, recoveryMs };
  }

  private computePeriodicityScore(): number {
    const n = Math.min(90, this.series.length);
    if (n < 40) return 0;
    const base = this.series.length - n;
    let sum = 0;
    let sumsq = 0;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = this.series.valueAt(base + i);
      buf[i] = v;
      sum += v;
      sumsq += v * v;
    }
    const mean = sum / n;
    const varr = Math.max(1e-8, sumsq / n - mean * mean);
    const std = Math.sqrt(varr);
    for (let i = 0; i < n; i++) buf[i] = (buf[i] - mean) / std;

    const minLag = Math.floor(this.estFs * 60 / MAX_BPM);
    const maxLag = Math.floor(this.estFs * 60 / MIN_BPM);
    let best = 0;
    for (let lag = minLag; lag <= maxLag && lag < n / 2; lag++) {
      let c = 0;
      for (let i = 0; i < n - lag; i++) c += buf[i] * buf[i + lag];
      c /= n - lag;
      if (c > best) best = c;
    }
    this.periodicityScore = clamp(best, 0, 1);
    return this.periodicityScore;
  }

  private autocorrBpm(): number {
    const n = Math.min(120, this.series.length);
    if (n < 50) return 0;
    const base = this.series.length - n;
    const buf = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      buf[i] = this.series.valueAt(base + i);
      mean += buf[i];
    }
    mean /= n;
    let varr = 0;
    for (let i = 0; i < n; i++) {
      buf[i] -= mean;
      varr += buf[i] * buf[i];
    }
    varr = Math.max(1e-8, varr / n);
    const std = Math.sqrt(varr);
    for (let i = 0; i < n; i++) buf[i] /= std;

    const minLag = Math.floor(this.estFs * 60 / MAX_BPM);
    const maxLag = Math.floor(this.estFs * 60 / MIN_BPM);
    let bestLag = minLag;
    let best = -1;
    for (let lag = minLag; lag <= maxLag && lag < n / 2; lag++) {
      let c = 0;
      for (let i = 0; i < n - lag; i++) c += buf[i] * buf[i + lag];
      c /= n - lag;
      if (c > best) {
        best = c;
        bestLag = lag;
      }
    }
    const ibiMs = (bestLag / this.estFs) * 1000;
    return ibiMs > 0 ? 60000 / ibiMs : 0;
  }

  private runBpmFusion(cand: BeatCandidate, ctx: HeartBeatProcessContext): void {
    const rrs = this.rrSlice();
    const medianRr = rrs.length ? medianArr(rrs) : 0;
    const trimmedRr = rrs.length >= 5 ? trimmedMeanArr(rrs, 1) : medianRr;

    const bpmInstant = this.ibiInstant > 0 ? 60000 / this.ibiInstant : 0;
    const bpmMed = medianRr > 0 ? 60000 / medianRr : 0;
    const bpmTrim = trimmedRr > 0 ? 60000 / trimmedRr : 0;
    const bpmAuto = this.autocorrBpm();

    const bpmSpectral =
      bpmAuto > 0 ? clamp(this.periodicityScore * bpmAuto + (1 - this.periodicityScore) * bpmMed, 0, 220) : bpmMed;

    const hypotheses: BPMHypothesis[] = [
      { id: 'instant', bpm: bpmInstant, confidence: 0, weight: 0 },
      { id: 'medianIbi', bpm: bpmMed, confidence: 0, weight: 0 },
      { id: 'trimmedIbi', bpm: bpmTrim, confidence: 0, weight: 0 },
      { id: 'autocorr', bpm: bpmAuto, confidence: 0, weight: 0 },
      { id: 'spectral', bpm: bpmSpectral, confidence: 0, weight: 0 },
    ];

    const nBeats = this.rrCount;
    const avgBeatSqi =
      this.lastAccepted && this.lastAccepted.beatSQI
        ? this.lastAccepted.beatSQI
        : cand.morphologyScore * 100;

    let wPeak = clamp(
      nBeats * 0.06 + cand.detectorAgreement * 0.35 + (avgBeatSqi / 100) * 0.25 + this.periodicityScore * 0.2,
      0,
      1
    );
    if (this.lastAccepted?.flags.includes('weak')) wPeak *= 0.85;
    const wFreq = clamp(1 - wPeak * 0.85 + (nBeats < 4 ? 0.25 : 0), 0, 1);

    for (const h of hypotheses) {
      let conf = 0.5;
      if (h.id === 'instant') conf = nBeats >= 2 ? 0.75 : 0.35;
      if (h.id === 'medianIbi') conf = nBeats >= 4 ? 0.85 : 0.4;
      if (h.id === 'trimmedIbi') conf = nBeats >= 6 ? 0.82 : 0.42;
      if (h.id === 'autocorr') conf = this.periodicityScore;
      if (h.id === 'spectral') conf = this.periodicityScore * 0.9;
      h.confidence = conf;
    }

    hypotheses[0].weight = wPeak * 0.35 * hypotheses[0].confidence;
    hypotheses[1].weight = wPeak * 0.3 * hypotheses[1].confidence;
    hypotheses[2].weight = wPeak * 0.15 * hypotheses[2].confidence;
    hypotheses[3].weight = wFreq * 0.45 * hypotheses[3].confidence;
    hypotheses[4].weight = wFreq * 0.2 * Math.max(0.2, hypotheses[4].confidence);

    let sumW = 0;
    let sum = 0;
    for (const h of hypotheses) {
      if (h.bpm >= MIN_BPM && h.bpm <= MAX_BPM && h.weight > 0) {
        sum += h.bpm * h.weight;
        sumW += h.weight;
      }
    }

    let fused = sumW > 0 ? sum / sumW : bpmMed || bpmInstant || 0;

    const spread = this.hypothesisSpread(hypotheses);
    if (spread > 18 && nBeats >= 4) {
      fused = (fused * 0.45 + bpmMed * 0.55) as number;
    }

    const maxW = hypotheses.reduce((m, h) => Math.max(m, h.weight), 0);
    const active: BPMHypothesisKey =
      hypotheses.find((h) => h.weight === maxW)?.id ?? 'medianIbi';

    if (this.hysteresisBpm <= 0) this.hysteresisBpm = fused;
    const alpha = spread > 15 ? 0.22 : 0.38;
    this.hysteresisBpm = this.hysteresisBpm * (1 - alpha) + fused * alpha;
    this.fusedBpm = this.hysteresisBpm;

    this.fusionState = {
      hypotheses,
      activeHypothesis: active,
      finalBpm: this.fusedBpm,
      spread,
    };
  }

  private hypothesisSpread(h: BPMHypothesis[]): number {
    const vals = h.filter((x) => x.bpm >= MIN_BPM && x.bpm <= MAX_BPM).map((x) => x.bpm);
    if (vals.length < 2) return 0;
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    return mx - mn;
  }

  private maybeDetectMissedBeat(timestamp: number, ctx: HeartBeatProcessContext): void {
    if (this.lastAcceptedTs === null) return;
    const gap = timestamp - this.lastAcceptedTs;
    const exp = this.expectedRr();
    const refr = this.computeRefractory();
    if (gap < exp * 1.25) return;

    const gapKey = Math.floor((timestamp - this.lastAcceptedTs) / 200);
    if (gapKey === this.missedSearchKey) return;
    if (gap > refr.recoveryMs) {
      this.missedSearchKey = gapKey;
      const i1 = this.series.length - 1;
      const win = Math.min(50, this.series.length - 2);
      let bestI = -1;
      let bestScore = -1;
      for (let i = i1 - win; i < i1 - 3; i++) {
        if (i < 1) continue;
        if (!this.isLocalMaximum(i)) continue;
        const pk = this.series.valueAt(i);
        const prom = pk - Math.min(this.series.valueAt(i - 4), this.series.valueAt(i + 4));
        if (prom < this.adaptiveProminenceFloor * 0.5) continue;
        const sc = prom * 2 + (this.templateValid ? this.correlateTemplate(i) : 0);
        if (sc > bestScore) {
          bestScore = sc;
          bestI = i;
        }
      }
      if (bestI > 0 && bestScore > 0.35) {
        const c = this.buildCandidate(bestI, this.series.timeAt(bestI), this.series.valueAt(bestI), timestamp, ctx);
        if (c.detectorAgreement > 0.35 && c.morphologyScore > 0.42) {
          c.adjudication = 'accepted';
          this.finalizeBeat(c, ['missed_beat_inferred'], ctx);
          this.missedBeatCount++;
        }
      }
    }
  }

  private bpmConfidence(ctx: HeartBeatProcessContext): number {
    const rrs = this.rrSlice();
    let rrStab = 1;
    if (rrs.length >= 3) {
      const med = medianArr(rrs);
      const dev = rrs.reduce((s, x) => s + Math.abs(x - med), 0) / rrs.length;
      rrStab = clamp(1 - dev / (med + 1e-6), 0, 1);
    }

    const hypSpread = this.fusionState.spread;
    const coh = clamp(1 - hypSpread / 45, 0, 1);

    const nBeats = Math.min(this.rrCount, 12);
    const countScore = clamp(nBeats / 10, 0, 1);

    const suspiciousPen = clamp(this.suspiciousCount / 8, 0, 1) * 0.15;

    const srcStable = ctx.positionDrifting ? 0.55 : 0.92;
    const contactOk =
      ctx.contactState === 'STABLE_CONTACT' || ctx.contactState === 'UNSTABLE_CONTACT' ? 1 : 0.65;

    let conf =
      rrStab * 0.24 +
      coh * 0.2 +
      countScore * 0.16 +
      this.periodicityScore * 0.14 +
      ((ctx.upstreamSqi ?? 50) / 100) * 0.12 +
      srcStable * 0.08 +
      contactOk * 0.06;
    conf -= suspiciousPen;
    conf = clamp(conf, 0, 1);

    if (nBeats < 2) conf *= 0.55;
    return conf;
  }

  private buildOutput(
    filteredValue: number,
    ctx: HeartBeatProcessContext,
    peak: boolean
  ): HeartBeatProcessOutput {
    const upstream = ctx.upstreamSqi ?? 0;
    const bpmConf = this.bpmConfidence(ctx);
    const displayBpm =
      this.fusedBpm > 0 && this.rrCount >= 2
        ? Math.round(this.fusedBpm)
        : this.lastAccepted && this.lastAccepted.instantBpm > 0
          ? Math.round(this.lastAccepted.instantBpm)
          : 0;

    if (displayBpm > 0) this.lastOutputBpm = displayBpm;

    const refr = this.computeRefractory();
    const rrList = this.rrSlice();

    const debug: HeartBeatDebugSnapshot = {
      expectedRrMs: this.expectedRr(),
      hardRefractoryMs: refr.hardMs,
      softRefractoryMs: refr.softMs,
      recoveryWindowMs: refr.recoveryMs,
      sampleRateHz: this.estFs,
      beatsAcceptedSession: this.sessionAccepted,
      beatsRejectedSession: this.sessionRejected,
      doublePeakCount: this.doublePeakCount,
      missedBeatCount: this.missedBeatCount,
      suspiciousCount: this.suspiciousCount,
      prematureCount: this.prematureCount,
      lastCandidate: this.lastCandidate,
      lastRejectionReason: this.lastRejection,
      templateCorrelationLast: this.lastCandidate?.templateCorrelation ?? 0,
      morphologyScoreLast: this.lastCandidate?.morphologyScore ?? 0,
      periodicityScore: this.periodicityScore,
      fusion: this.fusionState,
    };

    const inWarmup =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - this.startWallMs <
      WARMUP_MS;

    const out: HeartBeatProcessOutput = {
      bpm: inWarmup ? 0 : displayBpm,
      bpmConfidence: bpmConf,
      confidence: bpmConf,
      isPeak: peak,
      filteredValue,
      sqi: upstream,
      beatSQI: this.lastAccepted ? this.lastAccepted.beatSQI : null,
      arrhythmiaCount: 0,
      signalQuality: upstream,
      rrData: {
        intervals: rrList.slice(-12),
        lastPeakTime: this.lastAcceptedTs,
        lastIbiMs: this.ibiInstant > 0 ? this.ibiInstant : null,
      },
      activeHypothesis: this.fusionState.activeHypothesis,
      detectorAgreement: this.lastCandidate?.detectorAgreement ?? 0,
      rejectionReason: this.lastRejection,
      beatFlags: this.lastAccepted ? this.lastAccepted.flags : [],
      lastAcceptedBeat: this.lastAccepted,
      debug,
    };

    return out;
  }

  isWarmup(): boolean {
    return (
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - this.startWallMs < WARMUP_MS
    );
  }

  getFusedBpm(): number {
    return this.fusedBpm;
  }

  getLastAcceptedTimestamp(): number | null {
    return this.lastAcceptedTs;
  }

  getIntervalMsList(): number[] {
    return this.rrSlice();
  }

  peekLastDebug(filteredValue: number, ctx: HeartBeatProcessContext): HeartBeatDebugSnapshot {
    return this.buildOutput(filteredValue, ctx, false).debug;
  }
}
