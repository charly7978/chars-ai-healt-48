/**
 * RoiTracker.ts
 * ----------------------------------------------------------------------------
 * Tracker de ROI con histéresis temporal.
 * 
 * Evita saltos erráticos de ROI entre frames.
 * Mantiene ROI estable mientras el score sea aceptable.
 * Cambia de ROI solo si hay mejora significativa (>20%) en candidato alternativo.
 */

import type { RoiRect, RoiEvidence, RoiState } from "../signal/PpgTypes";
import type { RoiCandidate } from "./RoiScanner";

const SCORE_HYSTERESIS = 0.15;  // Debe superar en 15% para cambiar
const MIN_SCORE_TO_ACCEPT = 0.35;
const STABILITY_THRESHOLD_MS = 500;  // 500ms de estabilidad para validar

interface TrackedRoi {
  rect: RoiRect;
  score: number;
  selectedAt: number;
  framesStable: number;
}

export class RoiTracker {
  private currentRoi: TrackedRoi | null = null;
  private candidateHistory: Array<{
    timestamp: number;
    candidates: RoiCandidate[];
  }> = [];
  private readonly maxHistory = 10;

  /**
   * Actualizar tracker con nuevos candidatos del frame actual.
   * Retorna el ROI seleccionado (puede ser el mismo si no hay mejora significativa).
   */
  update(candidates: RoiCandidate[], timestamp: number): RoiEvidence {
    // Guardar historial
    this.candidateHistory.push({ timestamp, candidates });
    if (this.candidateHistory.length > this.maxHistory) {
      this.candidateHistory.shift();
    }

    // Ordenar candidatos por score
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    const best = sorted[0];

    // No hay candidatos válidos
    if (!best || best.score < MIN_SCORE_TO_ACCEPT) {
      this.currentRoi = null;
      return this.createRoiEvidence(null, timestamp, "NO_PPG_SIGNAL");
    }

    // Primer ROI o re-selección
    if (!this.currentRoi) {
      this.currentRoi = {
        rect: best.rect,
        score: best.score,
        selectedAt: timestamp,
        framesStable: 1,
      };
      return this.createRoiEvidence(best, timestamp, "OPTICAL_CONTACT_CANDIDATE");
    }

    // Verificar si el mejor candidato es significativamente mejor
    const scoreImprovement = best.score - this.currentRoi.score;
    const relativeImprovement = this.currentRoi.score > 0 
      ? scoreImprovement / this.currentRoi.score 
      : 0;

    // Cambiar solo si hay mejora > hysteresis
    if (relativeImprovement > SCORE_HYSTERESIS) {
      this.currentRoi = {
        rect: best.rect,
        score: best.score,
        selectedAt: timestamp,
        framesStable: 1,
      };
    } else {
      // Mantener ROI actual, incrementar estabilidad
      this.currentRoi.framesStable++;
    }

    // Determinar estado según estabilidad
    const stabilityMs = timestamp - this.currentRoi.selectedAt;
    const state = this.determineState(stabilityMs, best);

    return this.createRoiEvidence(best, timestamp, state);
  }

  /**
   * Forzar ROI específico (para testing o modo manual).
   */
  setManualRoi(rect: RoiRect): void {
    this.currentRoi = {
      rect,
      score: 1.0,
      selectedAt: performance.now(),
      framesStable: 100,  // Forzar estable
    };
  }

  /**
   * Resetear tracker.
   */
  reset(): void {
    this.currentRoi = null;
    this.candidateHistory = [];
  }

  /**
   * Obtener ROI actual.
   */
  getCurrentRoi(): RoiRect | null {
    return this.currentRoi?.rect ?? null;
  }

  /**
   * Verificar si el ROI ha sido estable por suficiente tiempo.
   */
  isStable(minFrames: number = 5): boolean {
    return (this.currentRoi?.framesStable ?? 0) >= minFrames;
  }

  // =============================================================================
  // PRIVATE
  // =============================================================================

  private determineState(stabilityMs: number, candidate: RoiCandidate): RoiState {
    // Saturación siempre tiene prioridad
    if (candidate.saturationRatio > 0.45) {
      return "SATURATED";
    }
    
    // Frame oscuro
    if (candidate.darkRatio > 0.40) {
      return "DARK_FRAME";
    }
    
    // Sin suficiente evidencia óptica
    if (candidate.validPixelRatio < 0.70) {
      return "NO_PPG_SIGNAL";
    }
    
    // Sin firma de hemoglobina
    if (candidate.redDominance < 0.5) {
      return "NO_PPG_SIGNAL";
    }
    
    // Tenemos evidencia óptica pero aún no estabilidad temporal
    if (stabilityMs < STABILITY_THRESHOLD_MS) {
      return "OPTICAL_CONTACT_CANDIDATE";
    }
    
    // Estable pero baja perfusión
    if (candidate.perfusionProxy < 0.01) {
      return "LOW_PERFUSION";
    }
    
    // Todo OK - candidato PPG
    return "PPG_CANDIDATE";
  }

  private createRoiEvidence(
    candidate: RoiCandidate | null,
    _timestamp: number,
    state: RoiState
  ): RoiEvidence {
    if (!candidate) {
      return {
        rect: this.currentRoi?.rect ?? { x: 0, y: 0, width: 0, height: 0 },
        state,
        validPixelRatio: 0,
        saturationRatio: 0,
        darkRatio: 0,
        meanR: 0,
        meanG: 0,
        meanB: 0,
        redDominance: 0,
        temporalVariance: 0,
        perfusionProxy: 0,
        motionProxy: 0,
        spectralPeakHz: null,
        spectralPeakRatio: null,
        roiScore: 0,
        reasons: ["NO_CANDIDATE"],
      };
    }

    return {
      rect: candidate.rect,
      state,
      validPixelRatio: candidate.validPixelRatio,
      saturationRatio: candidate.saturationRatio,
      darkRatio: candidate.darkRatio,
      meanR: 0,
      meanG: 0,
      meanB: 0,
      redDominance: candidate.redDominance,
      temporalVariance: candidate.temporalVariance,
      perfusionProxy: candidate.perfusionProxy,
      motionProxy: 0,  // Se calcula en analizador de movimiento
      spectralPeakHz: null,  // Se calcula en analizador espectral
      spectralPeakRatio: null,
      roiScore: candidate.score,
      reasons: [],
    };
  }
}
