/**
 * Histéresis temporal: evita parpadeo dedo/sin dedo y da sensación "pro" y estable.
 */
export class FingerStateSmoother {
  private high = 0;
  private low = 0;
  private locked = false;

  constructor(
    private readonly framesToEngage = 5,
    private readonly framesToRelease = 8
  ) {}

  /** Entrada: detección cruda por frame; salida: estado estable */
  update(rawPositive: boolean): boolean {
    if (rawPositive) {
      this.high++;
      this.low = 0;
      if (this.high >= this.framesToEngage) {
        this.locked = true;
        this.high = this.framesToEngage;
      }
    } else {
      this.low++;
      this.high = 0;
      if (this.low >= this.framesToRelease) {
        this.locked = false;
        this.low = this.framesToRelease;
      }
    }
    return this.locked;
  }

  reset(): void {
    this.high = 0;
    this.low = 0;
    this.locked = false;
  }
}
