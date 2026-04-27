/**
 * PpgExtractor.ts
 * ----------------------------------------------------------------------------
 * Extractor de señal PPG multicanal.
 * 
 * Flujo por frame:
 * 1. Recibir ImageData + ROI
 * 2. Calcular estadísticas radiométricas (SrgbLinearizer)
 * 3. Actualizar DC baseline (media móvil)
 * 4. Calcular OD (OpticalDensity)
 * 5. Generar canales:
 *    - G1: green raw (linear)
 *    - G2: OD green detrended
 *    - G3: G2 filtrado (listo para display)
 *    - CHROM: señal cromática (opcional)
 *    - POS: plane orthogonal to skin (opcional)
 * 6. Almacenar en ring buffer
 * 
 * Zero simulación. Si no hay frame real, no hay muestra.
 */

import type { RealFrame, PpgSample, RoiEvidence, RoiRect } from "./PpgTypes";
import { processImageData } from "../radiometry/SrgbLinearizer";
import type { RgbLinear } from "../radiometry/SrgbLinearizer";
import { calculateOD, DCBaselineTracker } from "../radiometry/OpticalDensity";
import type { OpticalDensity } from "../radiometry/OpticalDensity";

const DEFAULT_SAMPLE_RATE = 30;
const DC_BASELINE_WINDOW_SECONDS = 2;

export interface ExtractionResult {
  sample: PpgSample;
  roi: RoiEvidence;
  quality: {
    perfusionIndex: number;
    signalToNoiseRatio: number;
    valid: boolean;
  };
}

export class PpgExtractor {
  private ringBuffer: PpgSample[] = [];
  private maxBufferSize: number;
  private dcTracker: DCBaselineTracker;
  private sampleRate: number;
  private frameId = 0;
  
  // Historial para detrending
  private odHistory: OpticalDensity[] = [];
  private maxOdHistory = 60;  // 2 segundos a 30fps

  constructor(sampleRate: number = DEFAULT_SAMPLE_RATE, bufferSeconds: number = 20) {
    this.sampleRate = sampleRate;
    this.maxBufferSize = Math.ceil(bufferSeconds * sampleRate);
    this.dcTracker = new DCBaselineTracker(DC_BASELINE_WINDOW_SECONDS, sampleRate);
  }

  /**
   * Procesar frame y extraer muestra PPG.
   * Retorna null si el frame no contiene evidencia PPG válida.
   */
  processFrame(
    frame: RealFrame,
    roi: RoiEvidence
  ): ExtractionResult | null {
    // Validar ROI
    if (!this.isValidRoi(roi)) {
      return null;
    }

    // Extraer estadísticas del frame
    const stats = this.extractFrameStats(frame.imageData, roi.rect);
    if (!stats) {
      return null;
    }

    // Actualizar DC baseline
    this.dcTracker.push(stats.linearMean);
    const dcBaseline = this.dcTracker.getBaseline();

    // Calcular OD
    const od = calculateOD(stats.linearMean, dcBaseline);
    this.odHistory.push(od);
    if (this.odHistory.length > this.maxOdHistory) {
      this.odHistory.shift();
    }

    // Calcular G1, G2, G3
    const g1 = stats.linearMean.g;
    const g2 = this.detrendOD(od.g);
    const g3 = this.filterForDisplay(g2);

    // Calcular señales alternativas
    const chrom = this.calculateChrom(stats.linearMean);
    const pos = this.calculatePOS(stats.linearMean);

    // Calcular métricas de calidad
    const perfusionIndex = this.calculatePerfusionIndex();
    const snr = this.estimateSNR();

    // Crear muestra
    this.frameId++;
    const sample: PpgSample = {
      timestampMs: frame.timestampMs,
      frameId: this.frameId,
      raw: stats.rawMean,
      linear: stats.linearMean,
      od,
      g1,
      g2,
      g3,
      chrom,
      pos,
    };

    // Almacenar en buffer
    this.pushToBuffer(sample);

    return {
      sample,
      roi: this.enrichRoiEvidence(roi, stats),
      quality: {
        perfusionIndex,
        signalToNoiseRatio: snr,
        valid: perfusionIndex > 0.01 && snr > 2,
      },
    };
  }

  /**
   * Obtener historial de muestras.
   */
  getHistory(durationSeconds: number): PpgSample[] {
    const count = Math.ceil(durationSeconds * this.sampleRate);
    return this.ringBuffer.slice(-count);
  }

  /**
   * Obtener última muestra.
   */
  getLastSample(): PpgSample | null {
    return this.ringBuffer[this.ringBuffer.length - 1] ?? null;
  }

  /**
   * Resetear extractor.
   */
  reset(): void {
    this.ringBuffer = [];
    this.odHistory = [];
    this.dcTracker.reset();
    this.frameId = 0;
  }

  // =============================================================================
  // PRIVATE
  // =============================================================================

  private isValidRoi(roi: RoiEvidence): boolean {
    // ROI debe tener dimensiones válidas
    if (roi.rect.width <= 0 || roi.rect.height <= 0) return false;
    
    // ROI debe tener evidencia óptica suficiente
    if (roi.validPixelRatio < 0.5) return false;
    
    // No saturación destructiva
    if (roi.saturationRatio > 0.5) return false;
    
    return true;
  }

  private extractFrameStats(imageData: ImageData, roiRect: RoiRect): {
    rawMean: { r: number; g: number; b: number };
    linearMean: RgbLinear;
    redDominance: number;
  } | null {
    const stats = processImageData(imageData, { roi: roiRect, sampleStep: 2 });
    
    if (stats.pixelCount === 0) {
      return null;
    }

    return {
      rawMean: {
        r: stats.means.r * 255,
        g: stats.means.g * 255,
        b: stats.means.b * 255,
      },
      linearMean: stats.means,
      redDominance: stats.redDominance,
    };
  }

  private detrendOD(odValue: number): number {
    // Detrend simple: restar media móvil de ventana corta
    if (this.odHistory.length < 10) {
      return odValue;
    }
    
    const recentOD = this.odHistory.slice(-10);
    const meanOD = recentOD.reduce((a, o) => a + o.g, 0) / recentOD.length;
    
    return odValue - meanOD;
  }

  private filterForDisplay(detrendedValue: number): number {
    // Filtro de suavizado ligero para display
    // En producción, usar filtro Butterworth real
    if (this.ringBuffer.length === 0) {
      return detrendedValue;
    }
    
    const lastG3 = this.ringBuffer[this.ringBuffer.length - 1]?.g3 ?? detrendedValue;
    const alpha = 0.3;  // Factor de suavizado
    
    return alpha * detrendedValue + (1 - alpha) * lastG3;
  }

  private calculateChrom(linear: RgbLinear): number {
    // Wang et al. CHROM: X = 3R - 2G
    const X = 3 * linear.r - 2 * linear.g;
    
    // Simplificado: retornar X como proxy de pulsátilidad
    return X;
  }

  private calculatePOS(linear: RgbLinear): number {
    // Plane Orthogonal to Skin
    // Simplificado: combinación normalizada
    const sum = linear.r + linear.g + linear.b;
    if (sum === 0) return 0;
    
    const rn = linear.r / sum;
    const gn = linear.g / sum;
    const bn = linear.b / sum;
    
    // Proyección que minimiza contribución de iluminación
    return 3 * gn - 2 * rn - bn;
  }

  private calculatePerfusionIndex(): number {
    if (this.ringBuffer.length < 30) return 0;
    
    const recent = this.ringBuffer.slice(-30);
    const g3Values = recent.map(s => s.g3);
    
    const min = Math.min(...g3Values);
    const max = Math.max(...g3Values);
    const peakToPeak = max - min;
    
    const mean = g3Values.reduce((a, v) => a + v, 0) / g3Values.length;
    
    if (mean === 0) return 0;
    return peakToPeak / Math.abs(mean);
  }

  private estimateSNR(): number {
    if (this.ringBuffer.length < 60) return 0;
    
    const recent = this.ringBuffer.slice(-60);
    const g3Values = recent.map(s => s.g3);
    
    // Estimación simple de SNR basada en varianza
    const mean = g3Values.reduce((a, v) => a + v, 0) / g3Values.length;
    const variance = g3Values.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / g3Values.length;
    const stdDev = Math.sqrt(variance);
    
    if (stdDev === 0) return 0;
    
    // Señal aproximada por rango
    const signal = Math.max(...g3Values) - Math.min(...g3Values);
    
    return signal / (stdDev + 1e-6);
  }

  private pushToBuffer(sample: PpgSample): void {
    this.ringBuffer.push(sample);
    if (this.ringBuffer.length > this.maxBufferSize) {
      this.ringBuffer.shift();
    }
  }

  private enrichRoiEvidence(roi: RoiEvidence, stats: { redDominance: number }): RoiEvidence {
    return {
      ...roi,
      meanR: stats.redDominance > 0 ? stats.redDominance * 0.5 : roi.meanR,
      redDominance: stats.redDominance,
    };
  }
}
