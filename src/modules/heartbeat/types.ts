/**
 * Tipos explícitos para pipeline PPG: candidatos, latidos aceptados, fusión BPM y debug.
 */

export type BeatAdjudication = 'accepted' | 'rejected' | 'pending';

export type BeatFlag =
  | 'normal'
  | 'weak'
  | 'double_peak'
  | 'missed_beat_inferred'
  | 'premature'
  | 'suspicious';

export type RejectionReason =
  | 'none'
  | 'hard_refractory'
  | 'soft_refractory_double'
  | 'low_prominence'
  | 'width_invalid'
  | 'clip_penalty'
  | 'unstable_contact'
  | 'poor_detector_support'
  | 'detector_mismatch'
  | 'rr_incompatible'
  | 'morphology_poor'
  | 'template_mismatch'
  | 'motion_penalty'
  | 'pressure_penalty'
  | 'duplicate_secondary'
  | 'pending_expired'
  | 'insufficient_context';

export interface DetectorHits {
  systolicPeak: boolean;
  derivativeUpslope: boolean;
  envelopeSupport: boolean;
}

export interface BeatCandidate {
  timestamp: number;
  sampleIndex: number;
  amplitude: number;
  prominence: number;
  widthMs: number;
  upSlope: number;
  downSlope: number;
  localBaseline: number;
  detectorHits: DetectorHits;
  detectorAgreement: number;
  zeroCrossingSupport: number;
  periodicitySupport: number;
  templateCorrelation: number;
  localBandPowerRatio: number;
  localPerfusion: number;
  localMotionPenalty: number;
  localPressurePenalty: number;
  localClipPenalty: number;
  morphologyScore: number;
  adjudication: BeatAdjudication;
  rejectionReason: RejectionReason;
}

export interface AcceptedBeat {
  timestamp: number;
  ibiMs: number;
  instantBpm: number;
  beatSQI: number;
  morphologyScore: number;
  rhythmScore: number;
  detectorAgreementScore: number;
  templateScore: number;
  sourceConsistencyScore: number;
  flags: BeatFlag[];
}

export type BPMHypothesisKey =
  | 'instant'
  | 'medianIbi'
  | 'trimmedIbi'
  | 'autocorr'
  | 'spectral';

export interface BPMHypothesis {
  id: BPMHypothesisKey;
  bpm: number;
  confidence: number;
  weight: number;
}

export interface BPMFusionState {
  hypotheses: BPMHypothesis[];
  activeHypothesis: BPMHypothesisKey;
  finalBpm: number;
  spread: number;
}

export interface HeartBeatDebugSnapshot {
  expectedRrMs: number;
  hardRefractoryMs: number;
  softRefractoryMs: number;
  recoveryWindowMs: number;
  sampleRateHz: number;
  beatsAcceptedSession: number;
  beatsRejectedSession: number;
  doublePeakCount: number;
  missedBeatCount: number;
  suspiciousCount: number;
  prematureCount: number;
  lastCandidate: BeatCandidate | null;
  lastRejectionReason: RejectionReason;
  templateCorrelationLast: number;
  morphologyScoreLast: number;
  periodicityScore: number;
  fusion: BPMFusionState;
}

export interface HeartBeatProcessContext {
  rawValue?: number;
  upstreamSqi?: number;
  contactState?: string;
  fingerDetected?: boolean;
  perfusionIndex?: number;
  pressureState?: string;
  clipHighRatio?: number;
  clipLowRatio?: number;
  activeSource?: string;
  motionArtifact?: number;
  positionDrifting?: boolean;
  maskStability?: number;
}

/** Entrada explícita (recomendada) con timestamp del pipeline. */
export interface HeartBeatProcessInputFull extends HeartBeatProcessContext {
  filteredValue: number;
  timestamp: number;
  rawValue?: number;
}

export interface HeartBeatProcessOutput {
  bpm: number;
  bpmConfidence: number;
  confidence: number;
  isPeak: boolean;
  filteredValue: number;
  sqi: number;
  beatSQI: number | null;
  arrhythmiaCount: number;
  signalQuality?: number;
  rrData: {
    intervals: number[];
    lastPeakTime: number | null;
    lastIbiMs: number | null;
  };
  activeHypothesis: BPMHypothesisKey;
  detectorAgreement: number;
  rejectionReason: RejectionReason;
  beatFlags: BeatFlag[];
  lastAcceptedBeat: AcceptedBeat | null;
  debug: HeartBeatDebugSnapshot;
}
