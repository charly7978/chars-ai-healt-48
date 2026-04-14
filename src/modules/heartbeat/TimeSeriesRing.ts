/**
 * Serie temporal O(1) sin shift: timestamps + valores alineados.
 */
export class TimeSeriesRing {
  private readonly cap: number;
  private readonly t: Float64Array;
  private readonly v: Float32Array;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    this.cap = capacity;
    this.t = new Float64Array(capacity);
    this.v = new Float32Array(capacity);
  }

  push(timestamp: number, value: number): void {
    this.t[this.head] = timestamp;
    this.v[this.head] = value;
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
  }

  get length(): number {
    return this.count;
  }

  timeAt(index: number): number {
    if (index < 0 || index >= this.count) return 0;
    const real = (this.head - this.count + index + this.cap) % this.cap;
    return this.t[real];
  }

  valueAt(index: number): number {
    if (index < 0 || index >= this.count) return 0;
    const real = (this.head - this.count + index + this.cap) % this.cap;
    return this.v[real];
  }

  lastTime(): number {
    if (this.count === 0) return 0;
    const real = (this.head - 1 + this.cap) % this.cap;
    return this.t[real];
  }

  lastValue(): number {
    if (this.count === 0) return 0;
    const real = (this.head - 1 + this.cap) % this.cap;
    return this.v[real];
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Copia ventana [start, end) a arrays preasignados (sin alloc si ya existen). */
  copyRange(start: number, end: number, outT: Float64Array, outV: Float32Array, maxLen: number): number {
    const n = Math.min(end - start, maxLen, this.count - start);
    if (n <= 0) return 0;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      outT[i] = this.timeAt(idx);
      outV[i] = this.valueAt(idx);
    }
    return n;
  }
}
