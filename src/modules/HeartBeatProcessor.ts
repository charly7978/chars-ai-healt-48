import { HeartBeatEngine } from './heartbeat/HeartBeatEngine';
import type {
  HeartBeatDebugSnapshot,
  HeartBeatProcessContext,
  HeartBeatProcessInputFull,
  HeartBeatProcessOutput,
} from './heartbeat/types';

export type {
  AcceptedBeat,
  BeatCandidate,
  BeatFlag,
  BPMFusionState,
  BPMHypothesis,
  HeartBeatDebugSnapshot,
  HeartBeatProcessContext,
  HeartBeatProcessInputFull,
  HeartBeatProcessOutput,
} from './heartbeat/types';

/**
 * Procesador de latidos PPG: capa de E/S + audio + compatibilidad.
 * La lógica de picos, fusión BPM y SQI por latido vive en HeartBeatEngine.
 */
export class HeartBeatProcessor {
  private readonly engine: HeartBeatEngine;

  private readonly SIGNAL_BOOST_FACTOR = 1.25;
  private recentForBoost: Float32Array;
  private boostIdx = 0;
  private readonly BOOST_WIN = 16;

  private audioContext: AudioContext | null = null;
  private lastBeepTime = 0;
  private readonly MIN_BEEP_INTERVAL_MS = 520;
  private readonly VIBRATION_PATTERN = [36, 18, 52];

  private isArrhythmiaDetected = false;

  private lastProcessResult: HeartBeatProcessOutput | null = null;

  constructor() {
    this.engine = new HeartBeatEngine(220);
    this.recentForBoost = new Float32Array(this.BOOST_WIN);
    this.initAudio();
  }

  private async initAudio(): Promise<void> {
    try {
      this.audioContext = new AudioContext();
      await this.audioContext.resume();
    } catch {
      /* noop */
    }
  }

  /**
   * Procesa una muestra. Acepta forma legacy (valor, dedo, timestamp) u objeto rico del pipeline.
   */
  processSignal(
    input: number | HeartBeatProcessInputFull,
    fingerDetected: boolean = true,
    timestamp?: number
  ): HeartBeatProcessOutput & {
    arrhythmiaCount: number;
    signalQuality?: number;
  } {
    let filteredValue: number;
    let ts: number;
    let ctx: HeartBeatProcessContext;

    if (typeof input === 'object' && input !== null && 'filteredValue' in input) {
      filteredValue = input.filteredValue;
      ts = input.timestamp;
      ctx = { ...input };
    } else {
      const v = input as number;
      filteredValue = v;
      ts =
        typeof timestamp === 'number'
          ? timestamp
          : typeof performance !== 'undefined'
            ? performance.now()
            : Date.now();
      ctx = {
        fingerDetected,
        upstreamSqi: undefined,
      };
    }

    const boosted = this.boostSignal(filteredValue);
    const out = this.engine.process(boosted, ts, ctx);
    this.lastProcessResult = out;

    if (out.isPeak && !this.engine.isWarmup()) {
      void this.playHeartSound(1.0, this.isArrhythmiaDetected);
    }

    return {
      ...out,
      arrhythmiaCount: 0,
      signalQuality: out.sqi,
    };
  }

  private boostSignal(value: number): number {
    this.recentForBoost[this.boostIdx % this.BOOST_WIN] = value;
    this.boostIdx++;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < Math.min(this.boostIdx, this.BOOST_WIN); i++) {
      sum += this.recentForBoost[i];
      n++;
    }
    const avg = n > 0 ? sum / n : value;
    const centered = value - avg;
    return avg + centered * this.SIGNAL_BOOST_FACTOR;
  }

  private async playHeartSound(volume: number, playArrhythmiaTone: boolean): Promise<void> {
    if (!this.audioContext || this.engine.isWarmup()) return;
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastBeepTime < this.MIN_BEEP_INTERVAL_MS) return;

    try {
      if (navigator.vibrate) navigator.vibrate(this.VIBRATION_PATTERN);

      const currentTime = this.audioContext.currentTime;
      const o1 = this.audioContext.createOscillator();
      const g1 = this.audioContext.createGain();
      o1.type = 'sine';
      o1.frequency.value = 150;
      g1.gain.setValueAtTime(0, currentTime);
      g1.gain.linearRampToValueAtTime(volume * 1.4, currentTime + 0.03);
      g1.gain.exponentialRampToValueAtTime(0.001, currentTime + 0.14);
      o1.connect(g1);
      g1.connect(this.audioContext.destination);
      o1.start(currentTime);
      o1.stop(currentTime + 0.18);

      const dubStart = currentTime + 0.07;
      const o2 = this.audioContext.createOscillator();
      const g2 = this.audioContext.createGain();
      o2.type = 'sine';
      o2.frequency.value = 118;
      g2.gain.setValueAtTime(0, dubStart);
      g2.gain.linearRampToValueAtTime(volume * 1.35, dubStart + 0.03);
      g2.gain.exponentialRampToValueAtTime(0.001, dubStart + 0.14);
      o2.connect(g2);
      g2.connect(this.audioContext.destination);
      o2.start(dubStart);
      o2.stop(dubStart + 0.18);

      if (playArrhythmiaTone) {
        const o3 = this.audioContext.createOscillator();
        const g3 = this.audioContext.createGain();
        o3.type = 'sine';
        o3.frequency.value = 430;
        const t0 = dubStart + 0.04;
        g3.gain.setValueAtTime(0, t0);
        g3.gain.linearRampToValueAtTime(volume * 0.55, t0 + 0.02);
        g3.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
        o3.connect(g3);
        g3.connect(this.audioContext.destination);
        o3.start(t0);
        o3.stop(t0 + 0.14);
        this.isArrhythmiaDetected = false;
      }
      this.lastBeepTime = now;
    } catch {
      /* noop */
    }
  }

  setArrhythmiaDetected(isDetected: boolean): void {
    this.isArrhythmiaDetected = isDetected;
  }

  getSmoothBPM(): number {
    const v = this.engine.getFusedBpm();
    return v > 0 ? Math.round(v) : this.lastProcessResult?.bpm ?? 0;
  }

  getFinalBPM(): number {
    return this.getSmoothBPM();
  }

  getSignalQuality(): number {
    return this.lastProcessResult?.sqi ?? 0;
  }

  getRRIntervals(): { intervals: number[]; lastPeakTime: number | null } {
    return {
      intervals: this.engine.getIntervalMsList(),
      lastPeakTime: this.engine.getLastAcceptedTimestamp(),
    };
  }

  getLastProcessOutput(): HeartBeatProcessOutput | null {
    return this.lastProcessResult;
  }

  getTechnicalDebug(filteredValue: number, ctx: HeartBeatProcessContext): HeartBeatDebugSnapshot {
    return this.engine.peekLastDebug(filteredValue, ctx);
  }

  reset(): void {
    this.engine.reset();
    this.boostIdx = 0;
    this.recentForBoost.fill(0);
    this.lastBeepTime = 0;
    this.lastProcessResult = null;
  }
}
