/**
 * OpticalDensity.ts
 * ----------------------------------------------------------------------------
 * Cálculo de densidad óptica (OD) para señal PPG.
 * 
 * OD = -log((I + eps) / (I0 + eps))
 * 
 * donde:
 * - I = intensidad transmitida (señal AC + DC)
 * - I0 = intensidad incidente (solo DC, baseline)
 * - eps = pequeño valor para evitar log(0)
 * 
 * Zero simulación. Calcula OD real de frames reales.
 */

import type { RgbLinear } from "./SrgbLinearizer";

const EPSILON = 1e-6;

export interface OpticalDensity {
  r: number;
  g: number;
  b: number;
}

export interface PpgChannels {
  g1: number;  // Raw green (linear mean)
  g2: number;  // Detrended OD green
  g3: number;  // Filtered OD green (para display/beat detection)
  od: OpticalDensity;
  dc: RgbLinear;  // Baseline DC
}

/**
 * Calcula OD de una muestra dado su DC baseline.
 */
export function calculateOD(
  current: RgbLinear,
  baseline: RgbLinear
): OpticalDensity {
  return {
    r: -Math.log((current.r + EPSILON) / (baseline.r + EPSILON)),
    g: -Math.log((current.g + EPSILON) / (baseline.g + EPSILON)),
    b: -Math.log((current.b + EPSILON) / (baseline.b + EPSILON)),
  };
}

/**
 * Calcula DC baseline usando mediana móvil.
 * Window en segundos, sampleRate en Hz.
 */
export function calculateDCBaseline(
  samples: RgbLinear[],
  windowSeconds: number = 2,
  sampleRate: number = 30
): RgbLinear {
  const windowSize = Math.floor(windowSeconds * sampleRate);
  
  if (samples.length === 0) {
    return { r: 0.5, g: 0.5, b: 0.5 };
  }
  
  // Tomar últimas muestras dentro de la ventana
  const recent = samples.slice(-windowSize);
  
  return {
    r: median(recent.map(s => s.r)),
    g: median(recent.map(s => s.g)),
    b: median(recent.map(s => s.b)),
  };
}

/**
 * Calcula el índice de perfusión AC/DC.
 * Valores típicos: 0.02-0.2 (2%-20%)
 */
export function calculatePerfusionIndex(
  odSamples: OpticalDensity[],
  channel: "r" | "g" | "b" = "g"
): number {
  if (odSamples.length === 0) return 0;
  
  const values = odSamples.map(o => o[channel]);
  const ac = peakToPeak(values);
  const dc = mean(values);
  
  if (dc === 0) return 0;
  return ac / Math.abs(dc);
}

/**
 * Calcula razón de ratios para SpO2 (estructura técnica, no fórmula genérica).
 * Solo válido con calibración específica por dispositivo.
 */
export function calculateRatioOfRatios(
  odSamples: OpticalDensity[],
  dcBaseline: RgbLinear
): { rRatio: number | null; gRatio: number | null; bRatio: number | null } {
  if (odSamples.length < 10) {
    return { rRatio: null, gRatio: null, bRatio: null };
  }
  
  // AC por canal
  const rValues = odSamples.map(o => o.r);
  const gValues = odSamples.map(o => o.g);
  const bValues = odSamples.map(o => o.b);
  
  const acR = peakToPeak(rValues);
  const acG = peakToPeak(gValues);
  const acB = peakToPeak(bValues);
  
  // Ratios AC/DC
  const rRatio = dcBaseline.r > 0 ? acR / dcBaseline.r : null;
  const gRatio = dcBaseline.g > 0 ? acG / dcBaseline.g : null;
  const bRatio = dcBaseline.b > 0 ? acB / dcBaseline.b : null;
  
  return { rRatio, gRatio, bRatio };
}

/**
 * Ring buffer para mantener historial de DC baselines.
 */
export class DCBaselineTracker {
  private samples: RgbLinear[] = [];
  private readonly maxSize: number;

  constructor(windowSeconds: number, sampleRate: number) {
    this.maxSize = Math.ceil(windowSeconds * sampleRate);
  }

  push(sample: RgbLinear): void {
    this.samples.push(sample);
    if (this.samples.length > this.maxSize) {
      this.samples.shift();
    }
  }

  getBaseline(): RgbLinear {
    return calculateDCBaseline(this.samples, 0.5, 30);
  }

  reset(): void {
    this.samples = [];
  }

  get size(): number {
    return this.samples.length;
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, v) => a + v, 0) / values.length;
}

function peakToPeak(values: number[]): number {
  if (values.length === 0) return 0;
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}
