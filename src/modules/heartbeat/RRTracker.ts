/**
 * RRTracker - Rastrea intervalos RR desde timestamps reales de picos confirmados
 * Filtra outliers y mantiene RR crudos y limpios
 */

import type { RRData, ConfirmedBeat } from './cardiac-types';

export interface RRTrackerConfig {
  minRR: number;
  maxRR: number;
  outlierThreshold: number;
  bufferSize: number;
  filterAlpha: number;
}

const DEFAULT_CONFIG: RRTrackerConfig = {
  minRR: 200,
  maxRR: 2000,
  outlierThreshold: 2.5,
  bufferSize: 60,
  filterAlpha: 0.15,
};

export class RRTracker {
  private config: RRTrackerConfig;
  private rawRR: Float64Array;
  private filteredRR: Float64Array;
  private outliers: boolean[];
  private writeIdx: number = 0;
  private count: number = 0;
  private lastBeatTimestamp: number | null = null;

  constructor(config?: Partial<RRTrackerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.rawRR = new Float64Array(this.config.bufferSize);
    this.filteredRR = new Float64Array(this.config.bufferSize);
    this.outliers = new Array(this.config.bufferSize).fill(false);
  }

  /**
   * Agrega beat confirmado y calcula RR
   */
  addBeat(beat: ConfirmedBeat): void {
    if (this.lastBeatTimestamp === null) {
      this.lastBeatTimestamp = beat.timestamp;
      return;
    }

    const rr = beat.timestamp - this.lastBeatTimestamp;

    // Filtro fisiológico
    if (rr < this.config.minRR || rr > this.config.maxRR) {
      this.lastBeatTimestamp = beat.timestamp;
      return;
    }

    // Agregar RR crudo
    const idx = this.writeIdx % this.config.bufferSize;
    this.rawRR[idx] = rr;
    this.outliers[idx] = this.isOutlier(rr);

    // Filtrar RR (excluyendo outliers)
    const filtered = this.filterRR(rr);
    this.filteredRR[idx] = filtered;

    this.writeIdx++;
    if (this.count < this.config.bufferSize) this.count++;
    this.lastBeatTimestamp = beat.timestamp;
  }

  /**
   * Detecta outlier usando desviación estándar
   */
  private isOutlier(rr: number): boolean {
    if (this.count < 5) return false;

    const values = this.getFilteredRRValues();
    if (values.length === 0) return false;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / values.length;
    const std = Math.sqrt(variance);

    const zScore = std > 0 ? Math.abs(rr - mean) / std : 0;
    return zScore > this.config.outlierThreshold;
  }

  /**
   * Filtra RR usando media móvil adaptativa
   */
  private filterRR(newRR: number): number {
    if (this.count < 3) return newRR;

    const values = this.getFilteredRRValues();
    const mean = values.reduce((a, b) => a + b, 0) / values.length;

    if (this.isOutlier(newRR)) {
      return mean; // Reemplazar outlier con media
    }

    return mean * (1 - this.config.filterAlpha) + newRR * this.config.filterAlpha;
  }

  /**
   * Obtiene valores RR filtrados
   */
  private getFilteredRRValues(): number[] {
    const values: number[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.writeIdx - this.count + i + this.config.bufferSize) % this.config.bufferSize;
      if (!this.outliers[idx]) {
        values.push(this.filteredRR[idx]);
      }
    }
    return values;
  }

  /**
   * Obtiene datos RR completos
   */
  getRRData(): RRData {
    const rawValues: number[] = [];
    const filteredValues: number[] = [];
    const outlierFlags: boolean[] = [];

    for (let i = 0; i < this.count; i++) {
      const idx = (this.writeIdx - this.count + i + this.config.bufferSize) % this.config.bufferSize;
      rawValues.push(this.rawRR[idx]);
      filteredValues.push(this.filteredRR[idx]);
      outlierFlags.push(this.outliers[idx]);
    }

    const mean = filteredValues.length > 0 
      ? filteredValues.reduce((a, b) => a + b, 0) / filteredValues.length 
      : 0;
    
    const sorted = [...filteredValues].sort((a, b) => a - b);
    const median = sorted.length > 0 
      ? sorted[Math.floor(sorted.length / 2)] 
      : 0;

    const variance = filteredValues.length > 0
      ? filteredValues.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / filteredValues.length
      : 0;
    const std = Math.sqrt(variance);

    const outlierRatio = rawValues.length > 0 
      ? outlierFlags.filter(f => f).length / rawValues.length 
      : 0;

    return {
      raw: rawValues,
      filtered: filteredValues,
      outliers: outlierFlags,
      mean,
      median,
      std,
      outlierRatio,
    };
  }

  /**
   * Obtiene RR crudos recientes
   */
  getRecentRR(count: number = 10): number[] {
    const n = Math.min(count, this.count);
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      const idx = (this.writeIdx - i - 1 + this.config.bufferSize) % this.config.bufferSize;
      values.unshift(this.rawRR[idx]);
    }
    return values;
  }

  /**
   * Obtiene último RR
   */
  getLastRR(): number | null {
    if (this.count === 0) return null;
    const idx = (this.writeIdx - 1 + this.config.bufferSize) % this.config.bufferSize;
    return this.filteredRR[idx];
  }

  /**
   * Obtiene número de RR almacenados
   */
  getCount(): number {
    return this.count;
  }

  /**
   * Reinicia tracker
   */
  reset(): void {
    this.writeIdx = 0;
    this.count = 0;
    this.lastBeatTimestamp = null;
    this.rawRR.fill(0);
    this.filteredRR.fill(0);
    this.outliers.fill(false);
  }
}
