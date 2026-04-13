/**
 * Pasabanda aproximado: DC-blocker (1 polo) + paso bajo (1 polo) ~0.5–5 Hz a fs≈30 Hz.
 * Robusto numéricamente para PPG móvil.
 */
export class CardiacBandpassFilter {
  private xPrev = 0;
  private yHp = 0;
  private yLp = 0;
  private readonly rBlock: number;
  private readonly aLp: number;

  constructor(fs = 30) {
    const dt = 1 / fs;
    const tauLp = 1 / (2 * Math.PI * 5.2);
    this.aLp = Math.exp(-dt / tauLp);
    const tauHp = 1 / (2 * Math.PI * 0.52);
    this.rBlock = tauHp / (tauHp + dt);
  }

  process(x: number): number {
    const hp = x - this.xPrev + this.rBlock * this.yHp;
    this.xPrev = x;
    this.yHp = hp;
    this.yLp = (1 - this.aLp) * hp + this.aLp * this.yLp;
    return this.yLp;
  }

  reset(): void {
    this.xPrev = 0;
    this.yHp = 0;
    this.yLp = 0;
  }
}
