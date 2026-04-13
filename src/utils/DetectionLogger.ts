/**
 * @file DetectionLogger.ts
 * @description Sistema de logging avanzado para detección de dedos humanos
 * TRANSPARENCIA COMPLETA - Muestra al usuario qué se está validando
 */

export interface DetectionLogEntry {
  timestamp: number;
  fingerDetected: boolean;
  humanValidation: {
    skinColorValid: boolean;
    perfusionValid: boolean;
    hemodynamicValid: boolean;
    spatialConsistency: boolean;
    temporalConsistency: boolean;
  };
  biometricScores: {
    biophysicalScore: number;
    opticalCoherence: number;
    bloodFlowIndicator: number;
    tissueConsistency: number;
    overallConfidence: number;
  };
  ppgSignalQuality: {
    redValue: number;
    signalStrength: number;
    noiseLevel: number;
    snrRatio: number;
  };
  validationReason?: string;
}

export class DetectionLogger {
  private logHistory: DetectionLogEntry[] = [];
  private readonly MAX_LOG_ENTRIES = 100;
  private consecutiveSuccessfulDetections = 0;
  private consecutiveFailedDetections = 0;
  
  constructor() {
    console.log("📊 DetectionLogger: Sistema de transparencia activado");
  }
  
  /**
   * LOGGING COMPLETO DE DETECCIÓN
   */
  logDetectionAttempt(
    fingerDetected: boolean,
    humanValidation: any,
    biometricScores: any,
    ppgSignalQuality: any,
    reason?: string
  ): void {
    
    const logEntry: DetectionLogEntry = {
      timestamp: Date.now(),
      fingerDetected,
      humanValidation,
      biometricScores,
      ppgSignalQuality,
      validationReason: reason
    };
    
    this.logHistory.push(logEntry);
    
    // Limpiar historial si excede el límite
    if (this.logHistory.length > this.MAX_LOG_ENTRIES) {
      this.logHistory.shift();
    }
    
    // Actualizar contadores de consecutividad
    if (fingerDetected) {
      this.consecutiveSuccessfulDetections++;
      this.consecutiveFailedDetections = 0;
    } else {
      this.consecutiveFailedDetections++;
      this.consecutiveSuccessfulDetections = 0;
    }
    
    if (this.logHistory.length % 180 === 0 && this.logHistory.length > 0) {
      this.logDetailedStatus();
    }
    
    if (this.consecutiveFailedDetections === 60) {
      console.warn("⚠️ Detección: muchos intentos fallidos — comprueba dedo sobre flash y linterna.");
    }
  }
  
  /**
   * STATUS DETALLADO PARA DEBUGGING
   */
  private logDetailedStatus(): void {
    const recent = this.logHistory.slice(-10);
    const successRate = recent.filter(entry => entry.fingerDetected).length / recent.length;
    
    const avgBiophysical = recent.reduce((sum, entry) => 
      sum + entry.biometricScores.biophysicalScore, 0) / recent.length;
    
    const avgSNR = recent.reduce((sum, entry) => 
      sum + entry.ppgSignalQuality.snrRatio, 0) / recent.length;
    
    console.log("📊 ESTADO DETECCIÓN DETALLADO:", {
      tasaÉxito: `${(successRate * 100).toFixed(1)}%`,
      scoreBiofísico: avgBiophysical.toFixed(2),
      snrPromedio: avgSNR.toFixed(1),
      entradasTotales: this.logHistory.length,
      últimasValidaciones: recent.map(entry => ({
        detectado: entry.fingerDetected,
        confianza: entry.biometricScores.overallConfidence.toFixed(2),
        razón: entry.validationReason?.substring(0, 30) || "OK"
      }))
    });
  }
  
  /**
   * ANÁLISIS DE CALIDAD PROMEDIO
   */
  private calculateAverageQuality(): number {
    if (this.logHistory.length === 0) return 0;
    
    const validEntries = this.logHistory.filter(entry => entry.fingerDetected);
    if (validEntries.length === 0) return 0;
    
    const totalQuality = validEntries.reduce((sum, entry) => 
      sum + entry.biometricScores.overallConfidence, 0);
    
    return totalQuality / validEntries.length;
  }
  
  /**
   * REPORTE DE RENDIMIENTO PARA USUARIO
   */
  generateUserReport(): {
    detectionRate: number;
    averageQuality: number;
    commonIssues: string[];
    recommendations: string[];
  } {
    const totalAttempts = this.logHistory.length;
    const successfulDetections = this.logHistory.filter(entry => entry.fingerDetected).length;
    const detectionRate = totalAttempts > 0 ? successfulDetections / totalAttempts : 0;
    
    const commonIssues: string[] = [];
    const recommendations: string[] = [];
    
    // Análisis de problemas comunes
    const failedEntries = this.logHistory.filter(entry => !entry.fingerDetected);
    
    const skinColorIssues = failedEntries.filter(entry => 
      !entry.humanValidation.skinColorValid).length;
    
    const perfusionIssues = failedEntries.filter(entry => 
      !entry.humanValidation.perfusionValid).length;
    
    const spatialIssues = failedEntries.filter(entry => 
      !entry.humanValidation.spatialConsistency).length;
    
    if (skinColorIssues > failedEntries.length * 0.3) {
      commonIssues.push("Validación de color de piel");
      recommendations.push("Asegurar buena iluminación y dedo completamente cubriendo la cámara");
    }
    
    if (perfusionIssues > failedEntries.length * 0.3) {
      commonIssues.push("Detección de flujo sanguíneo");
      recommendations.push("Presionar ligeramente el dedo y mantener quieto por 10 segundos");
    }
    
    if (spatialIssues > failedEntries.length * 0.3) {
      commonIssues.push("Consistencia espacial");
      recommendations.push("Cubrir completamente la cámara trasera con el dedo");
    }
    
    return {
      detectionRate,
      averageQuality: this.calculateAverageQuality(),
      commonIssues,
      recommendations
    };
  }
  
  /**
   * RESET COMPLETO DEL LOGGER
   */
  reset(): void {
    this.logHistory = [];
    this.consecutiveSuccessfulDetections = 0;
    this.consecutiveFailedDetections = 0;
    
    console.log("🔄 DetectionLogger: Historial limpiado");
  }
  
  /**
   * OBTENER HISTORIAL RECIENTE
   */
  getRecentHistory(count: number = 20): DetectionLogEntry[] {
    return this.logHistory.slice(-count);
  }
}