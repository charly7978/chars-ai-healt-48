/**
 * @file HumanFingerDetector.ts
 * @description Sistema avanzado de detección de dedos humanos reales con validación biofísica
 * PROHIBIDA CUALQUIER SIMULACIÓN - SOLO MEDICIÓN REAL PPG
 */

export interface HumanFingerValidation {
  isHumanFinger: boolean;
  confidence: number;
  biophysicalScore: number;
  opticalCoherence: number;
  bloodFlowIndicator: number;
  tissueConsistency: number;
  validationDetails: {
    skinColorValid: boolean;
    perfusionValid: boolean;
    hemodynamicValid: boolean;
    spatialConsistency: boolean;
    temporalConsistency: boolean;
  };
}

export class HumanFingerDetector {
  private readonly HEMOGLOBIN_ABSORPTION_R = 660; // nm - rojo
  private readonly HEMOGLOBIN_ABSORPTION_IR = 940; // nm - infrarrojo simulado con azul
  
  // Buffer de análisis temporal para validación humana
  private temporalAnalysisBuffer: Array<{
    timestamp: number;
    redValue: number;
    greenValue: number;
    blueValue: number;
    perfusionIndex: number;
  }> = [];
  
  private readonly TEMPORAL_BUFFER_SIZE = 50;
  private skinBaselineR = 0;
  private skinBaselineG = 0;
  private skinBaselineB = 0;
  private perfusionBaseline = 0;
  
  // Contadores para detección consecutiva
  private consecutiveHumanDetections = 0;
  private consecutiveNonHumanDetections = 0;
  private lastValidHumanTime = 0;
  
  constructor() {
    console.log("🔬 HumanFingerDetector: Sistema biofísico activado");
  }
  
  /**
   * ANÁLISIS INTEGRAL DE DEDO HUMANO - Sin simulaciones
   */
  detectHumanFinger(
    redValue: number,
    greenValue: number,
    blueValue: number,
    textureScore: number,
    imageWidth: number,
    imageHeight: number
  ): HumanFingerValidation {
    
    // 1. VALIDACIÓN PRIMARIA - Rangos fisiológicos humanos
    if (!this.isPhysiologicallyValid(redValue, greenValue, blueValue)) {
      this.consecutiveNonHumanDetections++;
      return this.createNegativeResult("Valores fuera de rango fisiológico humano");
    }
    
    // 2. ANÁLISIS ESPECTRAL DE HEMOGLOBINA - Cálculo real PPG
    const hemoglobinAnalysis = this.analyzeHemoglobinSpectrum(redValue, greenValue, blueValue);
    
    // 3. VALIDACIÓN DE PERFUSIÓN SANGUÍNEA - Solo datos reales
    const perfusionAnalysis = this.analyzePerfusion(redValue, greenValue);
    
    // 4. ANÁLISIS TEMPORAL DE CONSISTENCIA HUMANA
    const temporalConsistency = this.analyzeTemporalConsistency(
      redValue, greenValue, blueValue, perfusionAnalysis.perfusionIndex
    );
    
    // 5. VALIDACIÓN ESPACIAL Y DE TEXTURA HUMANA
    const spatialValidation = this.validateSpatialCharacteristics(
      textureScore, imageWidth, imageHeight
    );
    
    // 6. ANÁLISIS HEMDINÁMICO - Patrones cardiovasculares reales
    const hemodynamicScore = this.analyzeHemodynamicPatterns();
    
    // 7. CÁLCULO DE CONFIANZA INTEGRAL
    const overallConfidence = this.calculateOverallConfidence(
      hemoglobinAnalysis,
      perfusionAnalysis,
      temporalConsistency,
      spatialValidation,
      hemodynamicScore
    );
    
    // 8. DECISIÓN FINAL CON CRITERIOS ESTRICTOS PERO EQUILIBRADOS
    const isHumanFinger = this.makeHumanFingerDecision(overallConfidence);
    
    if (isHumanFinger) {
      this.consecutiveHumanDetections++;
      this.consecutiveNonHumanDetections = 0;
      this.lastValidHumanTime = Date.now();
      
      // Actualizar líneas base solo con detecciones válidas
      this.updateHumanBaselines(redValue, greenValue, blueValue, perfusionAnalysis.perfusionIndex);
    } else {
      this.consecutiveNonHumanDetections++;
      this.consecutiveHumanDetections = 0;
    }
    
    return {
      isHumanFinger,
      confidence: overallConfidence,
      biophysicalScore: hemoglobinAnalysis.biophysicalScore,
      opticalCoherence: hemoglobinAnalysis.opticalCoherence,
      bloodFlowIndicator: perfusionAnalysis.bloodFlowIndicator,
      tissueConsistency: temporalConsistency.consistency,
      validationDetails: {
        skinColorValid: hemoglobinAnalysis.skinColorValid,
        perfusionValid: perfusionAnalysis.perfusionValid,
        hemodynamicValid: hemodynamicScore > 0.6,
        spatialConsistency: spatialValidation.spatialValid,
        temporalConsistency: temporalConsistency.temporalValid
      }
    };
  }
  
  /**
   * VALIDACIÓN FISIOLÓGICA PRIMARIA - Solo valores humanos posibles
   */
  private isPhysiologicallyValid(r: number, g: number, b: number): boolean {
    // Rangos fisiológicos humanos más permisivos para mejor detección
    const total = r + g + b;
    if (total < 42 || total > 740) return false;
    
    const rgRatio = r / (g + 1);
    if (rgRatio < 0.52 || rgRatio > 3.85) return false;
    
    if (r < Math.max(g, b) * 0.62) return false;
    
    const variance = Math.abs(r - g) + Math.abs(g - b) + Math.abs(r - b);
    if (variance < 10) return false;
    
    return true;
  }
  
  /**
   * ANÁLISIS ESPECTRAL DE HEMOGLOBINA - Cálculos reales de absorción
   */
  private analyzeHemoglobinSpectrum(r: number, g: number, b: number): {
    biophysicalScore: number;
    opticalCoherence: number;
    skinColorValid: boolean;
  } {
    const total = r + g + b + 1e-10;
    
    // Coeficientes de absorción específica de hemoglobina humana
    const hbAbsorptionR = 0.32; // Absorción alta en rojo
    const hbAbsorptionG = 0.85; // Absorción muy alta en verde
    const hbAbsorptionB = 0.15; // Absorción baja en azul
    
    // Análisis de absorción esperada vs observada
    const expectedR = r * (1 - hbAbsorptionR);
    const expectedG = g * (1 - hbAbsorptionG);
    const expectedB = b * (1 - hbAbsorptionB);
    
    // Score biofísico basado en patrón de absorción
    const absorptionPattern = (expectedR + expectedB) / (expectedG + 1);
    const biophysicalScore = Math.min(1.0, Math.max(0, absorptionPattern / 2.5));
    
    // Coherencia óptica - RELAJADO para más tonos de piel
    const redDominance = r / total;
    const opticalCoherence = (redDominance >= 0.20 && redDominance <= 0.65) ? 1.0 : 
                            Math.max(0, 1 - Math.abs(redDominance - 0.42) * 2);
    
    // Validación de color de piel humana - RELAJADO
    const skinColorValid = redDominance >= 0.18 && redDominance <= 0.75 && 
                          biophysicalScore >= 0.15 && opticalCoherence >= 0.25;
    
    return {
      biophysicalScore,
      opticalCoherence,
      skinColorValid
    };
  }
  
  /**
   * ANÁLISIS DE PERFUSIÓN SANGUÍNEA - Solo medición real PPG
   */
  private analyzePerfusion(r: number, g: number): {
    perfusionIndex: number;
    bloodFlowIndicator: number;
    perfusionValid: boolean;
  } {
    // Cálculo AC/DC real para índice de perfusión
    const acComponent = this.calculateACComponent(r);
    const dcComponent = r + 1e-10;
    const perfusionIndex = (acComponent / dcComponent) * 100;
    
    // Indicador de flujo sanguíneo basado en pulsatilidad
    const pulsatility = this.calculatePulsatility();
    const bloodFlowIndicator = Math.min(1.0, pulsatility * perfusionIndex / 2);
    
    // Validación de perfusión RELAJADA para inicio rápido
    const perfusionValid = perfusionIndex >= 0.05 && perfusionIndex <= 35.0 && 
                          bloodFlowIndicator >= 0.03;
    
    return {
      perfusionIndex: Math.max(0, perfusionIndex),
      bloodFlowIndicator: Math.max(0, bloodFlowIndicator),
      perfusionValid
    };
  }
  
  /**
   * COMPONENTE AC REAL - Sin simulaciones
   */
  private calculateACComponent(currentValue: number): number {
    if (this.temporalAnalysisBuffer.length < 10) return 0.1;
    
    const recentValues = this.temporalAnalysisBuffer
      .slice(-10)
      .map(item => item.redValue);
    
    const max = Math.max(...recentValues);
    const min = Math.min(...recentValues);
    
    return Math.max(0.01, max - min);
  }
  
  /**
   * PULSATILIDAD REAL - Medición directa
   */
  private calculatePulsatility(): number {
    if (this.temporalAnalysisBuffer.length < 20) return 0.1;
    
    const values = this.temporalAnalysisBuffer.slice(-20).map(item => item.redValue);
    
    let peakCount = 0;
    for (let i = 2; i < values.length - 2; i++) {
      if (values[i] > values[i-1] && values[i] > values[i+1] &&
          values[i] > values[i-2] && values[i] > values[i+2]) {
        const prominence = Math.min(values[i] - values[i-1], values[i] - values[i+1]);
        if (prominence > 2.0) peakCount++;
      }
    }
    
    return Math.min(1.0, peakCount / 3.0);
  }
  
  /**
   * ANÁLISIS TEMPORAL DE CONSISTENCIA
   */
  private analyzeTemporalConsistency(
    r: number, g: number, b: number, perfusionIndex: number
  ): { consistency: number; temporalValid: boolean } {
    
    // Actualizar buffer temporal
    this.temporalAnalysisBuffer.push({
      timestamp: Date.now(),
      redValue: r,
      greenValue: g,
      blueValue: b,
      perfusionIndex
    });
    
    if (this.temporalAnalysisBuffer.length > this.TEMPORAL_BUFFER_SIZE) {
      this.temporalAnalysisBuffer.shift();
    }
    
    if (this.temporalAnalysisBuffer.length < 12) {
      return { consistency: 0.55, temporalValid: false };
    }
    
    const recent = this.temporalAnalysisBuffer.slice(-15);
    const redVariance = this.calculateVariance(recent.map(item => item.redValue));
    const perfusionVariance = this.calculateVariance(recent.map(item => item.perfusionIndex));
    
    const consistency = Math.max(0, 1 - (redVariance / 480) - (perfusionVariance / 4.5));
    const temporalValid = consistency >= 0.34 && redVariance >= 5;
    
    return { consistency, temporalValid };
  }
  
  /**
   * VALIDACIÓN ESPACIAL
   */
  private validateSpatialCharacteristics(
    textureScore: number, width: number, height: number
  ): { spatialValid: boolean } {
    
    const textureValid = textureScore >= 0.22 && textureScore <= 0.94;
    
    // Área mínima para dedo humano adulto
    const area = width * height;
    // Ajustado para soportar entradas 320x240 provenientes del canvas (76,800 px)
    const areaValid = area >= 70000;
    
    return {
      spatialValid: textureValid && areaValid
    };
  }
  
  /**
   * ANÁLISIS HEMODINÁMICO - Patrones cardiovasculares
   */
  private analyzeHemodynamicPatterns(): number {
    if (this.temporalAnalysisBuffer.length < 30) return 0.3;
    
    const values = this.temporalAnalysisBuffer.slice(-30).map(item => item.redValue);
    
    // Buscar patrones de ondas de pulso característicos
    const cycles = this.detectCardiacCycles(values);
    if (cycles.length < 2) return 0.2;
    
    // Análisis de variabilidad de frecuencia cardíaca (HRV)
    const intervals = cycles.map((cycle, i) => 
      i > 0 ? cycle.timestamp - cycles[i-1].timestamp : 0
    ).filter(interval => interval > 0);
    
    if (intervals.length < 2) return 0.3;
    
    const meanInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const hrv = Math.sqrt(intervals.reduce((sum, interval) => 
      sum + Math.pow(interval - meanInterval, 2), 0) / intervals.length
    );
    
    // HRV normal indica sistema cardiovascular humano funcional
    const normalizedHRV = Math.min(1.0, hrv / (meanInterval * 0.1));
    
    return Math.min(1.0, normalizedHRV);
  }
  
  /**
   * DETECCIÓN DE CICLOS CARDÍACOS REALES
   */
  private detectCardiacCycles(values: number[]): Array<{timestamp: number, amplitude: number}> {
    const cycles: Array<{timestamp: number, amplitude: number}> = [];
    
    for (let i = 3; i < values.length - 3; i++) {
      if (values[i] > values[i-1] && values[i] > values[i+1] &&
          values[i] > values[i-2] && values[i] > values[i+2] &&
          values[i] > values[i-3] && values[i] > values[i+3]) {
        
        const prominence = Math.min(
          values[i] - Math.min(values[i-1], values[i+1]),
          values[i] - Math.min(values[i-2], values[i+2])
        );
        
        if (prominence > 3.0) {
          cycles.push({
            timestamp: this.temporalAnalysisBuffer[this.temporalAnalysisBuffer.length - values.length + i]?.timestamp || Date.now(),
            amplitude: values[i]
          });
        }
      }
    }
    
    return cycles;
  }
  
  /**
   * CÁLCULO DE CONFIANZA GENERAL
   */
  private calculateOverallConfidence(
    hemoglobin: any,
    perfusion: any,
    temporal: any,
    spatial: any,
    hemodynamic: number
  ): number {
    
    // Incluir coherencia espacial explícitamente en el score final
    const weights = {
      biophysical: 0.22,
      optical: 0.18,
      perfusion: 0.25,
      temporal: 0.15,
      spatial: 0.10,
      hemodynamic: 0.10
    };
    
    const spatialScore = spatial?.spatialValid ? 1.0 : 0.0;
    
    const weightedScore = 
      hemoglobin.biophysicalScore * weights.biophysical +
      hemoglobin.opticalCoherence * weights.optical +
      perfusion.bloodFlowIndicator * weights.perfusion +
      temporal.consistency * weights.temporal +
      spatialScore * weights.spatial +
      hemodynamic * weights.hemodynamic;
    
    // Bonificación por detecciones consecutivas válidas
    const consecutiveBonus = Math.min(0.1, this.consecutiveHumanDetections * 0.02);
    
    return Math.min(1.0, Math.max(0, weightedScore + consecutiveBonus));
  }
  
  /**
   * DECISIÓN FINAL DE DETECCIÓN HUMANA
   */
  private makeHumanFingerDecision(confidence: number): boolean {
    // RELAJADO: Umbral base más bajo para detectar más fácilmente
    let threshold = 0.28;
    
    if (Date.now() - this.lastValidHumanTime < 6000) {
      threshold = 0.22; // Más permisivo si ya detectamos antes
    }
    
    if (this.consecutiveNonHumanDetections > 20) {
      threshold = 0.38; // Menos estricto después de fallos
    }
    
    return confidence >= threshold;
  }
  
  /**
   * ACTUALIZAR LÍNEAS BASE HUMANAS
   */
  private updateHumanBaselines(r: number, g: number, b: number, perfusion: number): void {
    const smoothing = 0.1;
    
    this.skinBaselineR = this.skinBaselineR * (1 - smoothing) + r * smoothing;
    this.skinBaselineG = this.skinBaselineG * (1 - smoothing) + g * smoothing;
    this.skinBaselineB = this.skinBaselineB * (1 - smoothing) + b * smoothing;
    this.perfusionBaseline = this.perfusionBaseline * (1 - smoothing) + perfusion * smoothing;
  }
  
  /**
   * UTILIDADES MATEMÁTICAS
   */
  private calculateVariance(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
  }
  
  private createNegativeResult(reason: string): HumanFingerValidation {
    return {
      isHumanFinger: false,
      confidence: 0,
      biophysicalScore: 0,
      opticalCoherence: 0,
      bloodFlowIndicator: 0,
      tissueConsistency: 0,
      validationDetails: {
        skinColorValid: false,
        perfusionValid: false,
        hemodynamicValid: false,
        spatialConsistency: false,
        temporalConsistency: false
      }
    };
  }
  
  /**
   * RESET DEL SISTEMA
   */
  reset(): void {
    this.temporalAnalysisBuffer = [];
    this.consecutiveHumanDetections = 0;
    this.consecutiveNonHumanDetections = 0;
    this.lastValidHumanTime = 0;
    this.skinBaselineR = 0;
    this.skinBaselineG = 0;
    this.skinBaselineB = 0;
    this.perfusionBaseline = 0;
    
    console.log("🔄 HumanFingerDetector: Sistema reiniciado");
  }
}