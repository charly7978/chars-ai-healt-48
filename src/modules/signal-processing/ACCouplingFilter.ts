/**
 * Eliminación de deriva DC + realce de componente pulsátil (PPG "pro" para visualización y picos).
 */
export class ACCouplingFilter {
  private slow = 0;
  /** Constante de tiempo ~0.7 s a 30 fps */
  private readonly alphaSlow = 0.952;
  private initialized = false;

  filter(x: number): { ac: number; dcEstimate: number } {
    if (!this.initialized) {
      this.slow = x;
      this.initialized = true;
      return { ac: 0, dcEstimate: x };
    }
    this.slow = this.alphaSlow * this.slow + (1 - this.alphaSlow) * x;
    return { ac: x - this.slow, dcEstimate: this.slow };
  }

  reset(): void {
    this.slow = 0;
    this.initialized = false;
  }
}
