/**
 * Estima Pulse Transit Time (ms) entre envolvente de audio (proxy mecánico/fonocardiográfico)
 * y picos PPG periféricos. Pensado para smartphone: micrófono + dedo sobre cámara.
 */

export class PulseTransitTimeEstimator {
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private floatBuffer: Float32Array | null = null;

  private audioPeakTimes: number[] = [];
  private ppgPeakTimes: number[] = [];
  private readonly maxPeaks = 24;

  private lastRms = 0;
  private rmsHistory: { t: number; rms: number }[] = [];
  private readonly rmsHistoryMs = 3500;
  private lastAudioPeakAt = 0;
  private readonly minAudioPeakGapMs = 260;

  private attached = false;

  /**
   * Conecta la pista de audio del mismo MediaStream que el video (getUserMedia video+audio).
   */
  attachStream(stream: MediaStream): void {
    this.detach();

    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== 'live') {
      return;
    }

    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;

      this.audioContext = new Ctx();
      this.sourceNode = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.35;
      this.floatBuffer = new Float32Array(this.analyser.fftSize);
      this.sourceNode.connect(this.analyser);
      void this.audioContext.resume();
      this.attached = true;
    } catch {
      this.detach();
    }
  }

  detach(): void {
    try {
      this.sourceNode?.disconnect();
    } catch {
      /* noop */
    }
    this.sourceNode = null;
    this.analyser = null;
    this.floatBuffer = null;
    if (this.audioContext) {
      void this.audioContext.close();
    }
    this.audioContext = null;
    this.audioPeakTimes = [];
    this.ppgPeakTimes = [];
    this.rmsHistory = [];
    this.lastRms = 0;
    this.lastAudioPeakAt = 0;
    this.attached = false;
  }

  isReady(): boolean {
    return this.attached && this.analyser !== null;
  }

  /** Llamar a ~30–60 Hz desde el bucle principal */
  sampleAudio(nowMs: number = Date.now()): void {
    if (!this.analyser || !this.floatBuffer) return;

    this.analyser.getFloatTimeDomainData(this.floatBuffer);
    let sum = 0;
    for (let i = 0; i < this.floatBuffer.length; i++) {
      const x = this.floatBuffer[i];
      sum += x * x;
    }
    const rms = Math.sqrt(sum / this.floatBuffer.length);

    this.rmsHistory.push({ t: nowMs, rms });
    const cutoff = nowMs - this.rmsHistoryMs;
    while (this.rmsHistory.length > 0 && this.rmsHistory[0].t < cutoff) {
      this.rmsHistory.shift();
    }

    // Pico local en envolvente: subida brusca respecto a ventana corta
    const prev = this.lastRms;
    this.lastRms = rms;
    if (this.rmsHistory.length < 5) return;

    const recent = this.rmsHistory.slice(-8);
    const baseline = recent.reduce((s, x) => s + x.rms, 0) / recent.length;
    const delta = rms - baseline;
    const strong = delta > 0.012 && rms > prev && nowMs - this.lastAudioPeakAt >= this.minAudioPeakGapMs;

    if (strong) {
      this.lastAudioPeakAt = nowMs;
      this.audioPeakTimes.push(nowMs);
      if (this.audioPeakTimes.length > this.maxPeaks) this.audioPeakTimes.shift();
    }
  }

  /** Un latido confirmado en PPG (mismo reloj que sampleAudio / Date.now) */
  onPpgPeak(nowMs: number = Date.now()): void {
    this.ppgPeakTimes.push(nowMs);
    if (this.ppgPeakTimes.length > this.maxPeaks) this.ppgPeakTimes.shift();
  }

  /**
   * Mediana de PTT = t_PPG - t_audio en ventana fisiológica [40, 420] ms.
   * Si no hay suficientes pares, devuelve null.
   */
  getMedianPttMs(): number | null {
    if (this.ppgPeakTimes.length < 3 || this.audioPeakTimes.length < 2) return null;

    const deltas: number[] = [];
    const ppgs = this.ppgPeakTimes.slice(-12);

    for (const tPpg of ppgs) {
      const windowStart = tPpg - 450;
      const windowEnd = tPpg - 35;
      const candidates = this.audioPeakTimes.filter((a) => a > windowStart && a < windowEnd);
      if (candidates.length === 0) continue;

      let best = candidates[0];
      let bestScore = Number.POSITIVE_INFINITY;
      const target = 155;
      for (const a of candidates) {
        const d = tPpg - a;
        if (d < 40 || d > 420) continue;
        const score = Math.abs(d - target);
        if (score < bestScore) {
          bestScore = score;
          best = a;
        }
      }
      const d = tPpg - best;
      if (d >= 40 && d <= 420) deltas.push(d);
    }

    if (deltas.length < 2) return null;

    const sorted = [...deltas].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  resetPeaks(): void {
    this.audioPeakTimes = [];
    this.ppgPeakTimes = [];
    this.rmsHistory = [];
    this.lastRms = 0;
    this.lastAudioPeakAt = 0;
  }
}
