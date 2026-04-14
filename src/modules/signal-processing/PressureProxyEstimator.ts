/**
 * Pressure proxy model for finger-on-camera PPG.
 * Classifies finger pressure from PPG signal characteristics.
 */

import { RingBuffer } from './RingBuffer';

export type PressureState = 'LOW_PRESSURE' | 'OPTIMAL_PRESSURE' | 'HIGH_PRESSURE' | 'UNKNOWN';

export interface PressureEstimate {
  state: PressureState;
  score: number; // 0 (very low) to 1 (very high pressure)
  confidence: number;
  details: {
    coverageRatio: number;
    saturationHigh: number;
    acDcRatio: number;
    uniformity: number;
    brightness: number;
    baselineDrift: number;
  };
}

export class PressureProxyEstimator {
  private redHistory: RingBuffer;
  private coverageHistory: RingBuffer;
  private satHighHistory: RingBuffer;
  private lastState: PressureState = 'UNKNOWN';
  private stateFrames = 0;
  private readonly HYSTERESIS_FRAMES = 8;

  constructor() {
    this.redHistory = new RingBuffer(60);
    this.coverageHistory = new RingBuffer(30);
    this.satHighHistory = new RingBuffer(30);
  }

  estimate(
    avgRed: number,
    coverage: number,
    clipHighRatio: number,
    uniformity: number, // 0-1 from tile variance (high = very uniform = suspicious)
    acComponent: number,
    dcComponent: number
  ): PressureEstimate {
    this.redHistory.push(avgRed);
    this.coverageHistory.push(coverage);
    this.satHighHistory.push(clipHighRatio);

    const brightness = avgRed / 255;
    const acDc = dcComponent > 0 ? acComponent / dcComponent : 0;

    // Baseline drift: slope of red over recent window
    let baselineDrift = 0;
    if (this.redHistory.length >= 10) {
      const recent = this.redHistory.toArray(20);
      const first5 = recent.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
      const last5 = recent.slice(-5).reduce((a, b) => a + b, 0) / 5;
      baselineDrift = Math.abs(last5 - first5) / (first5 + 1e-6);
    }

    // Pressure score: higher = more pressure
    let pressureScore = 0;

    // High brightness suggests high pressure (blood pushed out)
    pressureScore += brightness > 0.85 ? 0.3 : brightness > 0.7 ? 0.15 : 0;

    // High saturation ratio = excessive pressure
    const avgSatHigh = this.satHighHistory.length > 3
      ? this.satHighHistory.toArray().reduce((a, b) => a + b, 0) / this.satHighHistory.length
      : clipHighRatio;
    pressureScore += avgSatHigh > 0.3 ? 0.25 : avgSatHigh > 0.1 ? 0.1 : 0;

    // Very high uniformity = blood squeezed out
    pressureScore += uniformity > 0.85 ? 0.2 : uniformity > 0.7 ? 0.1 : 0;

    // Low AC/DC = pulsatility crushed by pressure
    pressureScore += acDc < 0.005 ? 0.25 : acDc < 0.01 ? 0.1 : 0;

    // Low coverage may indicate not enough contact (low pressure)
    const lowPressureSignal = coverage < 0.3 ? 0.4 : coverage < 0.5 ? 0.2 : 0;

    // Determine raw state
    let rawState: PressureState;
    if (lowPressureSignal > 0.3 && pressureScore < 0.3) {
      rawState = 'LOW_PRESSURE';
    } else if (pressureScore >= 0.5) {
      rawState = 'HIGH_PRESSURE';
    } else {
      rawState = 'OPTIMAL_PRESSURE';
    }

    // Hysteresis: require N consistent frames to change state
    if (rawState === this.lastState) {
      this.stateFrames++;
    } else {
      this.stateFrames++;
      if (this.stateFrames >= this.HYSTERESIS_FRAMES) {
        this.lastState = rawState;
        this.stateFrames = 0;
      }
    }

    // If we haven't established a state yet, use raw
    if (this.lastState === 'UNKNOWN') {
      this.lastState = rawState;
    }

    const confidence = Math.min(1, this.redHistory.length / 30);

    return {
      state: this.lastState,
      score: Math.min(1, pressureScore),
      confidence,
      details: {
        coverageRatio: coverage,
        saturationHigh: avgSatHigh,
        acDcRatio: acDc,
        uniformity,
        brightness,
        baselineDrift
      }
    };
  }

  reset(): void {
    this.redHistory.clear();
    this.coverageHistory.clear();
    this.satHighHistory.clear();
    this.lastState = 'UNKNOWN';
    this.stateFrames = 0;
  }
}
