/**
 * High-performance ring buffer backed by Float32Array for hot-path PPG processing.
 * No allocations after construction. O(1) push, O(1) random access.
 */
export class RingBuffer {
  private data: Float32Array;
  private head: number = 0;
  private count: number = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity);
  }

  push(value: number): void {
    this.data[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Get value at logical index (0 = oldest). */
  get(index: number): number {
    if (index < 0 || index >= this.count) return 0;
    const realIdx = (this.head - this.count + index + this.capacity) % this.capacity;
    return this.data[realIdx];
  }

  /** Most recent value. */
  last(): number {
    if (this.count === 0) return 0;
    return this.data[(this.head - 1 + this.capacity) % this.capacity];
  }

  get length(): number { return this.count; }
  get isFull(): boolean { return this.count === this.capacity; }

  /** Copy last N values into a plain array (for analysis). Allocates. */
  toArray(lastN?: number): number[] {
    const n = Math.min(lastN ?? this.count, this.count);
    const out: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.get(this.count - n + i);
    }
    return out;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Stats without allocation. */
  stats(): { mean: number; min: number; max: number; variance: number } {
    if (this.count === 0) return { mean: 0, min: 0, max: 0, variance: 0 };
    let sum = 0, mn = Infinity, mx = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const v = this.get(i);
      sum += v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const mean = sum / this.count;
    let varSum = 0;
    for (let i = 0; i < this.count; i++) {
      const d = this.get(i) - mean;
      varSum += d * d;
    }
    return { mean, min: mn, max: mx, variance: varSum / this.count };
  }
}
