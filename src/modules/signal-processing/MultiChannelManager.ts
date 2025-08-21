
/**
 * Manager multicanal avanzado (6 canales por defecto)
 * - Crea canales con pequeñas variantes iniciales (diversidad)
 * - Alimenta con entrada base (por ejemplo, G channel o ratio G/(R+G+B))
 * - Gestiona detección de dedo robusta: requiere debounce y consenso entre canales
 * - Feedback adaptativo: ajuste tipo PID leve sobre gain por canal
 * - Produce MultiChannelResult con BPM agregado y quality agregada
 */

import PPGChannel from './PPGChannel';
import { ChannelResult, MultiChannelResult } from '@/types';

export default class MultiChannelManager {
  private channels: PPGChannel[] = [];
  private n: number;
  private windowSec: number;
  private lastTimestamp = Date.now();
  // debounce y consenso
  private fingerState = false;
  private fingerStableCount = 0;
  private fingerUnstableCount = 0;
  private fingerEnableFramesToConfirm = 3; // EQUILIBRADO: frames consecutivos con dedo para confirmar
  private fingerDisableFramesToConfirm = 5; // frames consecutivos sin dedo para desconfirmar

  constructor(n = 6, windowSec = 8) {
    this.n = n;
    this.windowSec = windowSec;
    for (let i = 0; i < n; i++) {
      // pequeñas diferencias en gain inicial para diversidad
      const initGain = 1 + (i - Math.floor(n/2)) * 0.03;
      this.channels.push(new PPGChannel(i, windowSec, initGain));
    }
  }

  pushSample(rawValue: number, timestampMs: number) {
    this.lastTimestamp = timestampMs;
    // alimentar todos los canales
    for (const ch of this.channels) ch.pushSample(rawValue, timestampMs);
  }

  analyzeAll(globalCoverageRatio = 0.0, globalFrameDiff = 0.0): MultiChannelResult {
    const res: ChannelResult[] = [];
    let nFinger = 0;
    for (const ch of this.channels) {
      const out = ch.analyze();
      if (out.isFingerDetected) nFinger++;
      res.push({
        channelId: ch['channelId'],
        calibratedSignal: out.calibratedSignal,
        bpm: out.bpm,
        rrIntervals: out.rrIntervals,
        snr: out.snr,
        quality: Math.round(out.quality),
        isFingerDetected: out.isFingerDetected,
        gain: ch.getGain()
      } as any);
    }

    // DEBUG: Log cada 10 análisis
    if (Date.now() % 10000 < 100) {
      console.log('🔍 MultiChannel:', {
        fingerDetected: nFinger,
        coverageRatio: (globalCoverageRatio * 100).toFixed(1) + '%',
        frameDiff: globalFrameDiff.toFixed(1),
        bestQuality: Math.max(...res.map(c => c.quality))
      });
    }

    // consenso: requerir que >= mitad de canales detecten dedo y cobertura adecuada
    const majority = Math.ceil(this.n / 2);
    const coverageOk = globalCoverageRatio > 0.05; // EQUILIBRADO: al menos ~5% píxeles cubiertos
    const motionOk = globalFrameDiff < 20; // EQUILIBRADO: tolerancia moderada al movimiento
    const channelConsensus = nFinger >= majority;

    // Actualizar debounce
    if (channelConsensus && coverageOk && motionOk) {
      this.fingerStableCount++;
      this.fingerUnstableCount = 0;
      if (this.fingerStableCount >= this.fingerEnableFramesToConfirm) this.fingerState = true;
    } else {
      this.fingerUnstableCount++;
      if (this.fingerUnstableCount >= this.fingerDisableFramesToConfirm) {
        this.fingerState = false;
        this.fingerStableCount = 0;
      }
    }

    // Feedback adaptativo: ajustar gains según quality
    for (const r of res) {
      const ch = this.channels[r.channelId];
      if (r.isFingerDetected && r.quality < 50) {
        ch.adjustGainRel(0.02); // +2%
      }
      if (!r.isFingerDetected && r.gain > 1.5) ch.adjustGainRel(-0.02);
    }

    // agregación BPM: escoger valores de canales con quality >= threshold
    const good = res.filter(c => c.bpm && c.quality >= 50).map(c => ({bpm: c.bpm as number, q: c.quality}));
    let aggregatedBPM: number | null = null;
    if (good.length) {
      // voto ponderado por quality
      const sumQ = good.reduce((s, x) => s + x.q, 0) || 1;
      const avg = good.reduce((s, x) => s + x.bpm * (x.q / sumQ), 0);
      aggregatedBPM = Math.round(avg);
    } else {
      // fallback: usar cualquier bpm disponible promediado
      const any = res.filter(c => c.bpm);
      if (any.length) aggregatedBPM = Math.round(any.reduce((s,c)=>s + (c.bpm||0),0)/any.length);
    }

    const aggregatedQuality = Math.round(res.reduce((s,c)=>s + c.quality,0)/Math.max(1,res.length));

    return {
      timestamp: this.lastTimestamp,
      channels: res,
      aggregatedBPM,
      aggregatedQuality,
      fingerDetected: this.fingerState
    };
  }

  adjustChannelGain(channelId: number, deltaRel: number) {
    if (channelId < 0 || channelId >= this.channels.length) return;
    this.channels[channelId].adjustGainRel(deltaRel);
  }

  getGains() { return this.channels.map(c=>c.getGain()); }
}
