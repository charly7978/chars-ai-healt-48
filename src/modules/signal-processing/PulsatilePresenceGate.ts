/**
 * Validación de presencia de pulso periférico en cPPG (literatura: PI + periodicidad
 * en banda cardíaca; p.ej. trabajos IEEE/cámara PPG sobre perfusión y SNR en banda).
 * Sin componente pulsátil estable → NO hay dedo válido (evita FP 24/7).
 */

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export class PulsatilePresenceGate {
  private buf: number[] = [];
  private readonly maxLen: number;
  private consecutiveHits = 0;
  private consecutiveMiss = 0;

  /** ~4 s a 30 fps — suficiente para varios ciclos cardíacos */
  constructor(
    private readonly sampleRateHz = 30,
    maxSeconds = 4
  ) {
    this.maxLen = Math.round(sampleRateHz * maxSeconds);
  }

  reset(): void {
    this.buf = [];
    this.consecutiveHits = 0;
    this.consecutiveMiss = 0;
  }

  /**
   * Señal escalar por frame (ej. R medio ROI). Devuelve true solo si hay pulsación plausible.
   */
  push(sample: number): boolean {
    if (!Number.isFinite(sample) || sample <= 0) {
      this.buf = [];
      this.consecutiveHits = 0;
      this.consecutiveMiss++;
      return this.latchedFalse();
    }

    this.buf.push(sample);
    if (this.buf.length > this.maxLen) this.buf.shift();

    const n = this.buf.length;
    // RELAJADO: ≥1.2 s a 30 fps para detección más rápida (36 samples)
    if (n < 36) {
      this.consecutiveMiss++;
      return this.latchedFalse();
    }

    const m = mean(this.buf);
    const dc = Math.max(m, 6);
    const sd = stdev(this.buf);
    const pi = sd / dc;

    // RELAJADO: Perfusion Index mínimo reducido
    if (pi < 0.002) {
      this.consecutiveMiss++;
      return this.latchedFalse();
    }

    const det = this.detrendMovingAverage(this.buf, Math.max(9, Math.round(this.sampleRateHz * 0.32)));
    const noise = stdev(det);
    // RELAJADO: Noise threshold reducido
    if (noise < 0.15) {
      this.consecutiveMiss++;
      return this.latchedFalse();
    }

    const peaks = this.findPeaks(det, Math.max(0.38 * noise, 0.18));
    // RELAJADO: Solo 2 picos necesarios para inicio rápido
    if (peaks.length < 2) {
      this.consecutiveMiss++;
      return this.latchedFalse();
    }

    const intervals: number[] = [];
    for (let i = 1; i < peaks.length; i++) {
      intervals.push(peaks[i] - peaks[i - 1]);
    }

    const medI = median(intervals);
    // RELAJADO: Rango más amplio para intervalos (30-200 BPM)
    if (medI < 6 || medI > 60) {
      this.consecutiveMiss++;
      return this.latchedFalse();
    }

    const cv = stdev(intervals) / (medI + 1e-6);
    // RELAJADO: Permitir más variabilidad (arritmias normales)
    if (cv > 0.45) {
      this.consecutiveMiss++;
      return this.latchedFalse();
    }

    this.consecutiveHits++;
    this.consecutiveMiss = 0;

    // RELAJADO: Solo 2 hits consecutivos para activar
    return this.consecutiveHits >= 2;
  }

  private latchedFalse(): boolean {
    this.consecutiveHits = 0;
    return false;
  }

  private detrendMovingAverage(x: number[], win: number): number[] {
    const half = Math.floor(win / 2);
    const out: number[] = [];
    for (let i = 0; i < x.length; i++) {
      let s = 0;
      let c = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(x.length - 1, i + half); j++) {
        s += x[j];
        c++;
      }
      out.push(x[i] - s / c);
    }
    return out;
  }

  private findPeaks(signal: number[], minProminence: number): number[] {
    const idx: number[] = [];
    for (let i = 2; i < signal.length - 2; i++) {
      const v = signal[i];
      if (
        v > signal[i - 1] &&
        v > signal[i + 1] &&
        v >= signal[i - 2] &&
        v >= signal[i + 2] &&
        v > minProminence
      ) {
        if (idx.length === 0 || i - idx[idx.length - 1] >= 7) {
          idx.push(i);
        }
      }
    }
    return idx;
  }
}
