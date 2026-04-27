/**
 * RoiScanner.ts
 * ----------------------------------------------------------------------------
 * Escaneo de ROIs candidatas en frame.
 * 
 * Principio: NO detectar "dedo sí/no". 
 * Buscar zonas con evidencia óptica útil para PPG:
 * - Valid pixel ratio > 0.70
 * - Saturación controlada
 * - Varianza temporal (pulsátilidad)
 * - Dominancia roja compatible con tejido perfundido
 */

import type { RoiRect, RoiState } from "../signal/PpgTypes";
import { processImageData } from "../radiometry/SrgbLinearizer";
import type { RgbLinear } from "../radiometry/SrgbLinearizer";

const GRID_SIZE = 8;  // Grilla 8x8 para escaneo
const MIN_VALID_PIXEL_RATIO = 0.70;
const MAX_SATURATION_RATIO = 0.45;
const MAX_DARK_RATIO = 0.40;
const MIN_RED_DOMINANCE = 0.5;  // R/(G+B) > 0.5 indica tejido perfundido

export interface RoiCandidate {
  rect: RoiRect;
  score: number;
  validPixelRatio: number;
  saturationRatio: number;
  darkRatio: number;
  redDominance: number;
  temporalVariance: number;
  perfusionProxy: number;
}

export class RoiScanner {
  private frameHistory: Array<{
    timestamp: number;
    meanRgb: RgbLinear;
  }> = [];
  private readonly maxHistorySize = 30;  // ~1 segundo a 30fps

  /**
   * Escanear frame completo y retornar candidatos ordenados por score.
   */
  scan(
    imageData: ImageData,
    previousRoi: RoiRect | null = null
  ): RoiCandidate[] {
    const width = imageData.width;
    const height = imageData.height;
    
    // Calcular tamaño de celda de grilla
    const cellWidth = Math.floor(width / GRID_SIZE);
    const cellHeight = Math.floor(height / GRID_SIZE);
    
    // ROI base: 40-70% del ancho útil
    const roiWidth = Math.floor(width * 0.5);
    const roiHeight = Math.floor(height * 0.5);
    
    const candidates: RoiCandidate[] = [];
    
    // Explorar grilla, evitando bordes extremos
    for (let gy = 1; gy < GRID_SIZE - 1; gy++) {
      for (let gx = 1; gx < GRID_SIZE - 1; gx++) {
        const cx = Math.floor(gx * cellWidth);
        const cy = Math.floor(gy * cellHeight);
        
        const rect: RoiRect = {
          x: Math.max(0, cx - Math.floor(roiWidth / 2)),
          y: Math.max(0, cy - Math.floor(roiHeight / 2)),
          width: Math.min(roiWidth, width - cx),
          height: Math.min(roiHeight, height - cy),
        };
        
        const candidate = this.evaluateRoi(imageData, rect);
        if (candidate && candidate.score > 0.3) {
          candidates.push(candidate);
        }
      }
    }
    
    // Si hay ROI previo, boostear candidatos cercanos
    if (previousRoi) {
      candidates.forEach(c => {
        const distance = this.roiDistance(c.rect, previousRoi);
        if (distance < 0.2) {
          c.score *= 1.2;  // Boost 20% por proximidad temporal
        }
      });
    }
    
    // Ordenar por score descendente
    return candidates.sort((a, b) => b.score - a.score);
  }

  /**
   * Actualizar historial temporal para análisis de varianza.
   */
  updateHistory(timestamp: number, meanRgb: RgbLinear): void {
    this.frameHistory.push({ timestamp, meanRgb });
    
    if (this.frameHistory.length > this.maxHistorySize) {
      this.frameHistory.shift();
    }
  }

  /**
   * Calcular varianza temporal del canal verde en historial reciente.
   */
  getTemporalVariance(): number {
    if (this.frameHistory.length < 5) return 0;
    
    const gValues = this.frameHistory.map(h => h.meanRgb.g);
    const mean = gValues.reduce((a, v) => a + v, 0) / gValues.length;
    const variance = gValues.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / gValues.length;
    
    return Math.sqrt(variance);  // Desviación estándar
  }

  resetHistory(): void {
    this.frameHistory = [];
  }

  // =============================================================================
  // PRIVATE
  // =============================================================================

  private evaluateRoi(imageData: ImageData, rect: RoiRect): RoiCandidate | null {
    const stats = processImageData(imageData, { roi: rect, sampleStep: 2 });
    
    // Calcular perfusion proxy (variación relativa)
    const temporalVariance = this.getTemporalVariance();
    const perfusionProxy = stats.means.g > 0 
      ? temporalVariance / stats.means.g 
      : 0;
    
    // Score compuesto
    const score = this.calculateScore(stats, perfusionProxy);
    
    return {
      rect,
      score,
      validPixelRatio: stats.validPixelRatio,
      saturationRatio: stats.saturationRatio,
      darkRatio: stats.darkRatio,
      redDominance: stats.redDominance,
      temporalVariance,
      perfusionProxy,
    };
  }

  private calculateScore(
    stats: ReturnType<typeof processImageData>,
    perfusionProxy: number
  ): number {
    // Penalizaciones hard
    if (stats.validPixelRatio < MIN_VALID_PIXEL_RATIO) return 0;
    if (stats.saturationRatio > MAX_SATURATION_RATIO) return 0;
    if (stats.darkRatio > MAX_DARK_RATIO) return 0;
    if (stats.redDominance < MIN_RED_DOMINANCE) return 0;
    
    // Score ponderado
    let score = 0;
    
    // Valid pixels (0-0.5)
    score += stats.validPixelRatio * 0.5;
    
    // No saturación (0-0.2)
    score += (1 - stats.saturationRatio / MAX_SATURATION_RATIO) * 0.2;
    
    // No oscuridad (0-0.1)
    score += (1 - stats.darkRatio / MAX_DARK_RATIO) * 0.1;
    
    // Red dominance compatible (0-0.1)
    const rdScore = Math.min(1, (stats.redDominance - MIN_RED_DOMINANCE) / 0.5);
    score += rdScore * 0.1;
    
    // Perfusión sugerida (0-0.1)
    const perfScore = Math.min(1, perfusionProxy * 10);  // Normalizar
    score += perfScore * 0.1;
    
    return Math.max(0, Math.min(1, score));
  }

  private roiDistance(a: RoiRect, b: RoiRect): number {
    const centerA = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    const centerB = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    
    const dx = centerA.x - centerB.x;
    const dy = centerA.y - centerB.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    // Normalizar por tamaño promedio
    const avgSize = (a.width + a.height + b.width + b.height) / 4;
    return dist / avgSize;
  }
}

/**
 * Determinar estado del ROI según evidencia.
 */
export function determineRoiState(
  candidate: RoiCandidate | null,
  temporalVariance: number,
  spectralPeakHz: number | null
): { state: RoiState; reasons: string[] } {
  if (!candidate) {
    return { state: "NO_PPG_SIGNAL", reasons: ["NO_VALID_ROI_CANDIDATE"] };
  }
  
  // Saturación destructiva
  if (candidate.saturationRatio > MAX_SATURATION_RATIO) {
    return { state: "SATURATED", reasons: ["EXCESSIVE_SATURATION"] };
  }
  
  // Frame muy oscuro
  if (candidate.darkRatio > MAX_DARK_RATIO) {
    return { state: "DARK_FRAME", reasons: ["INSUFFICIENT_LIGHT"] };
  }
  
  // Insuficientes píxeles válidos
  if (candidate.validPixelRatio < MIN_VALID_PIXEL_RATIO) {
    return { state: "NO_PPG_SIGNAL", reasons: ["INSUFFICIENT_VALID_PIXELS"] };
  }
  
  // Sin dominancia roja (probablemente no es tejido perfundido)
  if (candidate.redDominance < MIN_RED_DOMINANCE) {
    return { state: "NO_PPG_SIGNAL", reasons: ["HEMOGLOBIN_SIGNATURE_ABSENT"] };
  }
  
  // Tenemos contacto óptico candidato
  if (temporalVariance < 0.001) {
    return { state: "OPTICAL_CONTACT_CANDIDATE", reasons: ["LOW_TEMPORAL_VARIANCE"] };
  }
  
  // Pulsátilidad detectada - candidato PPG
  if (spectralPeakHz && spectralPeakHz > 0.7 && spectralPeakHz < 4.0) {
    return { state: "PPG_CANDIDATE", reasons: [] };
  }
  
  if (candidate.perfusionProxy > 0.02) {
    return { state: "PPG_CANDIDATE", reasons: [] };
  }
  
  return { state: "SEARCHING_SIGNAL", reasons: ["EVALUATING_TEMPORAL_CHARACTERISTICS"] };
}
