/**
 * Comprehensive Signal Quality Index (SQI) estimator for PPG.
 * Combines multiple quality dimensions with strict penalties.
 */

import { PressureState } from './PressureProxyEstimator';
import { SourceType } from './SignalSourceRanker';

export interface SQIResult {
  sqiGlobal: number; // 0-100
  sqiBySource: number;
  clipHighRatio: number;
  clipLowRatio: number;
  pressureState: PressureState;
  positionQuality: number;
  roiValidPixels: number;
  activeSource: SourceType;
  perfusionIndex: number;
  coverage: number;
  maskStability: number;
  guidanceMessage: string;
}

export class SignalQualityEstimator {
  calculate(params: {
    sourceSQI: number;
    perfusionIndex: number;
    clipHighRatio: number;
    clipLowRatio: number;
    coverage: number;
    maskStability: number;
    pressureState: PressureState;
    pressureScore: number;
    activeSource: SourceType;
    validPixels: number;
    fingerDetected: boolean;
    acDcRatio: number;
  }): SQIResult {
    if (!params.fingerDetected) {
      return this.emptyResult(params, 'Coloque el dedo sobre la cámara');
    }

    let sqi = 0;
    const weights = {
      source: 0.25,
      perfusion: 0.15,
      coverage: 0.15,
      stability: 0.10,
      pressure: 0.15,
      clipping: 0.10,
      acDc: 0.10
    };

    // Source SQI
    sqi += params.sourceSQI * 100 * weights.source;

    // Perfusion index (0-10 typical)
    sqi += Math.min(1, params.perfusionIndex / 5) * 100 * weights.perfusion;

    // Coverage
    sqi += Math.min(1, params.coverage / 0.6) * 100 * weights.coverage;

    // Mask stability
    sqi += params.maskStability * 100 * weights.stability;

    // Pressure penalty
    const pressureFactor = params.pressureState === 'OPTIMAL_PRESSURE' ? 1.0
      : params.pressureState === 'HIGH_PRESSURE' ? 0.3
      : params.pressureState === 'LOW_PRESSURE' ? 0.5
      : 0.4;
    sqi += pressureFactor * 100 * weights.pressure;

    // Clipping penalty (severe)
    const clipPenalty = 1 - Math.min(1, (params.clipHighRatio + params.clipLowRatio) * 4);
    sqi += clipPenalty * 100 * weights.clipping;

    // AC/DC
    sqi += Math.min(1, params.acDcRatio * 30) * 100 * weights.acDc;

    sqi = Math.max(0, Math.min(100, sqi));

    // Guidance message
    let guidanceMessage = '';
    if (params.pressureState === 'HIGH_PRESSURE') {
      guidanceMessage = 'Reduzca la presión del dedo';
    } else if (params.pressureState === 'LOW_PRESSURE') {
      guidanceMessage = 'Presione un poco más el dedo';
    } else if (params.clipHighRatio > 0.2) {
      guidanceMessage = 'Demasiada luz - ajuste posición';
    } else if (params.coverage < 0.3) {
      guidanceMessage = 'Cubra mejor la cámara';
    } else if (sqi > 60) {
      guidanceMessage = 'Señal estable - mantenga posición';
    } else {
      guidanceMessage = 'Ajustando señal...';
    }

    return {
      sqiGlobal: Math.round(sqi),
      sqiBySource: Math.round(params.sourceSQI * 100),
      clipHighRatio: params.clipHighRatio,
      clipLowRatio: params.clipLowRatio,
      pressureState: params.pressureState,
      positionQuality: params.maskStability,
      roiValidPixels: params.validPixels,
      activeSource: params.activeSource,
      perfusionIndex: params.perfusionIndex,
      coverage: params.coverage,
      maskStability: params.maskStability,
      guidanceMessage
    };
  }

  private emptyResult(params: any, message: string): SQIResult {
    return {
      sqiGlobal: 0,
      sqiBySource: 0,
      clipHighRatio: params.clipHighRatio || 0,
      clipLowRatio: params.clipLowRatio || 0,
      pressureState: params.pressureState || 'UNKNOWN',
      positionQuality: 0,
      roiValidPixels: 0,
      activeSource: params.activeSource || 'RED_NORM',
      perfusionIndex: 0,
      coverage: 0,
      maskStability: 0,
      guidanceMessage: message
    };
  }
}
