/**
 * @file MultiChannelRGBFusion.ts
 * @description Sistema de fusión multi-canal RGB para extracción óptima de señal PPG
 * Combinación inteligente de canales R, G, B con pesos adaptativos por SNR
 * 
 * Modelo físico:
 * - R: penetración profunda, volumen sanguíneo (primary PPG)
 * - G: penetración media, información oxigenación (secondary)
 * - B: penetración superficial, detector de artefactos (noise reference)
 * 
 * Referencia: "Photoplethysmography Signal Analysis for Optimal Region-of-Interest" (MDPI 2017)
 */

export interface RGBChannels {
  r: number;
  g: number;
  b: number;
}

export interface ChannelAnalysis {
  raw: number;
  filtered: number;
  snr: number;           // Signal-to-noise ratio en dB
  acComponent: number;  // Componente AC (pulsátil)
  dcComponent: number; // Componente DC (baseline)
  perfusionIndex: number; // AC/DC ratio
  reliability: number;   // 0-1 confiabilidad del canal
}

export interface FusedPPGResult {
  value: number;           // Señal PPG fusionada final
  spo2Proxy: number;       // Estimación SpO2 (70-100%)
  channelWeights: {        // Pesos usados para fusión
    r: number;
    g: number;
    b: number;
  };
  channelAnalysis: {       // Análisis completo por canal
    r: ChannelAnalysis;
    g: ChannelAnalysis;
    b: ChannelAnalysis;
  };
  quality: number;         // Calidad global 0-100
  isMotionArtifact: boolean; // Flag de detección de movimiento
  motionCorrelation: number; // Correlación R-B (indicador de movimiento)
}

export class MultiChannelRGBFusion {
  private readonly samplingRate: number = 30;
  private readonly analysisWindow: number = 90; // 3 segundos a 30fps
  private readonly motionWindow: number = 30;   // 1 segundo para detección de movimiento
  
  // Buffers circulares para cada canal
  private rBuffer: Float64Array;
  private gBuffer: Float64Array;
  private bBuffer: Float64Array;
  private bufferIndex: number = 0;
  private bufferFull: boolean = false;
  
  // Buffers para análisis de movimiento
  private rMotionBuffer: number[] = [];
  private bMotionBuffer: number[] = [];
  
  // Estado de canales
  private lastDC: RGBChannels = { r: 0, g: 0, b: 0 };
  private channelSNR: RGBChannels = { r: 0, g: 0, b: 0 };
  
  // Filtros individuales para cada canal
  private rFilter: LowPassFilter;
  private gFilter: LowPassFilter;
  private bFilter: LowPassFilter;

  constructor(samplingRate: number = 30) {
    this.samplingRate = samplingRate;
    this.analysisWindow = samplingRate * 3;
    this.motionWindow = samplingRate * 1;
    
    this.rBuffer = new Float64Array(this.analysisWindow);
    this.gBuffer = new Float64Array(this.analysisWindow);
    this.bBuffer = new Float64Array(this.analysisWindow);
    
    // Filtros pasa-bajo para extraer componente DC suavemente
    const cutoffHz = 0.5; // Frecuencia de corte para DC (debajo de HR mínimo)
    this.rFilter = new LowPassFilter(cutoffHz, samplingRate);
    this.gFilter = new LowPassFilter(cutoffHz, samplingRate);
    this.bFilter = new LowPassFilter(cutoffHz, samplingRate);
  }

  /**
   * Procesar nueva muestra RGB y retornar señal PPG fusionada óptima
   */
  processSample(rgb: RGBChannels): FusedPPGResult {
    // Guardar en buffers
    this.bufferIndex = (this.bufferIndex + 1) % this.analysisWindow;
    this.rBuffer[this.bufferIndex] = rgb.r;
    this.gBuffer[this.bufferIndex] = rgb.g;
    this.bBuffer[this.bufferIndex] = rgb.b;
    
    if (this.bufferIndex === 0) this.bufferFull = true;
    
    // Actualizar buffers de movimiento
    this.rMotionBuffer.push(rgb.r);
    this.bMotionBuffer.push(rgb.b);
    if (this.rMotionBuffer.length > this.motionWindow) {
      this.rMotionBuffer.shift();
      this.bMotionBuffer.shift();
    }
    
    // PASO 1: Análisis individual de cada canal
    const rAnalysis = this.analyzeChannel('r', rgb.r, this.rBuffer, this.rFilter);
    const gAnalysis = this.analyzeChannel('g', rgb.g, this.gBuffer, this.gFilter);
    const bAnalysis = this.analyzeChannel('b', rgb.b, this.bBuffer, this.bFilter);
    
    // PASO 2: Detección de artefactos de movimiento
    const motionDetection = this.detectMotionArtifacts();
    
    // PASO 3: Calcular pesos adaptativos
    const weights = this.calculateAdaptiveWeights(
      { r: rAnalysis, g: gAnalysis, b: bAnalysis },
      motionDetection
    );
    
    // PASO 4: Fusión de canales
    const fusedValue = this.fuseChannels(
      { r: rAnalysis.filtered, g: gAnalysis.filtered, b: bAnalysis.filtered },
      weights
    );
    
    // PASO 5: Estimar SpO2 proxy
    const spo2Proxy = this.estimateSpO2Proxy(rAnalysis, gAnalysis);
    
    // PASO 6: Calcular calidad global
    const quality = this.calculateGlobalQuality(
      { r: rAnalysis, g: gAnalysis, b: bAnalysis },
      weights,
      motionDetection
    );
    
    return {
      value: fusedValue,
      spo2Proxy,
      channelWeights: weights,
      channelAnalysis: {
        r: rAnalysis,
        g: gAnalysis,
        b: bAnalysis
      },
      quality,
      isMotionArtifact: motionDetection.isArtifact,
      motionCorrelation: motionDetection.correlation
    };
  }

  /**
   * Análisis completo de un canal individual
   */
  private analyzeChannel(
    channel: 'r' | 'g' | 'b',
    rawValue: number,
    buffer: Float64Array,
    filter: LowPassFilter
  ): ChannelAnalysis {
    // Extraer componente DC con filtro pasa-bajo
    const dcComponent = filter.filter(rawValue);
    
    // Componente AC = señal - DC
    const acComponent = rawValue - dcComponent;
    
    // Calcular SNR solo si tenemos suficientes muestras
    let snr = 0;
    let reliability = 0;
    
    if (this.bufferFull || this.bufferIndex > 30) {
      snr = this.calculateSNR(buffer, dcComponent, acComponent);
      reliability = this.calculateReliability(channel, snr, dcComponent, acComponent);
    }
    
    // Perfusion Index = AC/DC ratio
    const perfusionIndex = dcComponent > 0 ? Math.abs(acComponent) / dcComponent : 0;
    
    // Valor filtrado = AC (eliminamos drift DC)
    const filtered = acComponent;
    
    return {
      raw: rawValue,
      filtered,
      snr,
      acComponent,
      dcComponent,
      perfusionIndex,
      reliability
    };
  }

  /**
   * Calcular SNR de canal en banda cardíaca (0.5-4 Hz)
   */
  private calculateSNR(
    buffer: Float64Array,
    dcComponent: number,
    acComponent: number
  ): number {
    // Obtener ventana de muestras AC recientes
    const windowSize = Math.min(60, buffer.length); // 2 segundos a 30fps
    const acValues: number[] = [];
    
    for (let i = 0; i < windowSize; i++) {
      const idx = (this.bufferIndex - i + buffer.length) % buffer.length;
      acValues.push(buffer[idx] - dcComponent);
    }
    
    // Calcular potencia de señal (varianza de AC)
    const signalPower = this.calculateVariance(acValues);
    
    // Estimar potencia de ruido (componentes fuera de banda cardíaca)
    // Usamos diferencias de segundo orden para estimar ruido de alta frecuencia
    let noisePower = 0;
    for (let i = 2; i < acValues.length; i++) {
      const secondDiff = acValues[i] - 2 * acValues[i-1] + acValues[i-2];
      noisePower += secondDiff * secondDiff;
    }
    noisePower /= (acValues.length - 2);
    
    // Evitar división por cero
    if (noisePower < 1e-10) noisePower = 1e-10;
    
    // SNR en dB
    const snrLinear = signalPower / noisePower;
    const snrDb = 10 * Math.log10(snrLinear);
    
    return Math.max(-20, Math.min(40, snrDb)); // Clamp a rango razonable
  }

  /**
   * Calcular confiabilidad de canal (0-1)
   * Canal R típicamente más confiable para PPG, pero consideramos SNR
   */
  private calculateReliability(
    channel: 'r' | 'g' | 'b',
    snr: number,
    dc: number,
    ac: number
  ): number {
    // Base reliability según canal (modelo físico de absorción hemoglobina)
    let baseReliability: number;
    switch (channel) {
      case 'r':
        baseReliability = 0.9;  // R es el más confiable para PPG
        break;
      case 'g':
        baseReliability = 0.7;  // G tiene absorción máxima de hemoglobina pero saturación rápida
        break;
      case 'b':
        baseReliability = 0.3;  // B solo para detección de movimiento
        break;
    }
    
    // Ajustar por SNR
    const snrFactor = Math.max(0, Math.min(1, (snr + 10) / 30)); // Normalizar: -10dB→0, 20dB→1
    
    // Ajustar por nivel óptimo (DC debe estar en rango válido)
    const dcFactor = dc > 20 && dc < 200 ? 1.0 : 0.5;
    
    // Ajustar por amplitud AC (debe tener componente pulsátil)
    const acFactor = Math.abs(ac) > 1 ? 1.0 : 0.6;
    
    return baseReliability * snrFactor * dcFactor * acFactor;
  }

  /**
   * Detectar artefactos de movimiento usando correlación R-B
   * En condiciones normales, R tiene PPG pero B no (penetración superficial)
   * Si R y B están correlacionados, probablemente es movimiento/artefacto
   */
  private detectMotionArtifacts(): { isArtifact: boolean; correlation: number } {
    if (this.rMotionBuffer.length < 10) {
      return { isArtifact: false, correlation: 0 };
    }
    
    // Calcular correlación Pearson entre R y B
    const correlation = this.calculatePearsonCorrelation(
      this.rMotionBuffer,
      this.bMotionBuffer
    );
    
    // Alta correlación R-B indica movimiento (ambos canales afectados igual)
    // Valor típico: > 0.6 indica probable artefacto de movimiento
    const isArtifact = correlation > 0.6;
    
    return { isArtifact, correlation };
  }

  /**
   * Calcular correlación de Pearson entre dos arrays
   */
  private calculatePearsonCorrelation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n < 2) return 0;
    
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXY += x[i] * y[i];
      sumX2 += x[i] * x[i];
      sumY2 += y[i] * y[i];
    }
    
    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    
    if (denominator === 0) return 0;
    
    return numerator / denominator;
  }

  /**
   * Calcular pesos adaptativos para fusión de canales
   */
  private calculateAdaptiveWeights(
    analysis: { r: ChannelAnalysis; g: ChannelAnalysis; b: ChannelAnalysis },
    motionDetection: { isArtifact: boolean; correlation: number }
  ): { r: number; g: number; b: number } {
    // Pesos base según confiabilidad
    let wR = analysis.r.reliability;
    let wG = analysis.g.reliability;
    let wB = 0; // B no se usa para PPG (solo detección de movimiento)
    
    // Penalizar canales según correlación de movimiento
    if (motionDetection.isArtifact) {
      // Reducir pesos proporcionalmente a la correlación de movimiento
      const motionPenalty = motionDetection.correlation;
      wR *= (1 - motionPenalty * 0.5); // Penalizar R menos (más robusto)
      wG *= (1 - motionPenalty * 0.7); // Penalizar G más
    }
    
    // Penalizar por SNR bajo
    const minSNR = 5; // dB
    if (analysis.r.snr < minSNR) wR *= 0.5;
    if (analysis.g.snr < minSNR) wG *= 0.5;
    
    // Normalizar pesos
    const totalWeight = wR + wG + wB;
    if (totalWeight > 0) {
      wR /= totalWeight;
      wG /= totalWeight;
      wB /= totalWeight;
    } else {
      // Fallback: confiar solo en R
      wR = 1.0;
      wG = 0;
      wB = 0;
    }
    
    return { r: wR, g: wG, b: wB };
  }

  /**
   * Fusión ponderada de canales
   */
  private fuseChannels(
    filtered: RGBChannels,
    weights: { r: number; g: number; b: number }
  ): number {
    return weights.r * filtered.r + weights.g * filtered.g + weights.b * filtered.b;
  }

  /**
   * Estimar SpO2 proxy usando ratio de ratios simplificado
   * Fórmula: SpO2 = 110 - 25 * ((ACr/DCr) / (ACg/DCg))
   * Nota: Esto es una aproximación que requiere calibración para precisión médica
   */
  private estimateSpO2Proxy(rAnalysis: ChannelAnalysis, gAnalysis: ChannelAnalysis): number {
    // Calcular ratios AC/DC para R y G
    const rRatio = rAnalysis.dcComponent > 0 ? 
      rAnalysis.acComponent / rAnalysis.dcComponent : 0;
    const gRatio = gAnalysis.dcComponent > 0 ? 
      gAnalysis.acComponent / gAnalysis.dcComponent : 0;
    
    if (Math.abs(gRatio) < 1e-6) return 0;
    
    // Ratio de ratios (RMS)
    const ratioOfRatios = rRatio / gRatio;
    
    // Aproximación lineal calibrada (necesita ajuste por dispositivo)
    // Valores típicos: ratio=1.0 → SpO2=97%, ratio=0.7 → SpO2=100%
    let spo2 = 110 - 25 * ratioOfRatios;
    
    // Clamp a rango fisiológico
    return Math.max(70, Math.min(100, spo2));
  }

  /**
   * Calcular calidad global de la señal PPG (0-100)
   */
  private calculateGlobalQuality(
    analysis: { r: ChannelAnalysis; g: ChannelAnalysis; b: ChannelAnalysis },
    weights: { r: number; g: number; b: number },
    motionDetection: { isArtifact: boolean; correlation: number }
  ): number {
    // Peso por calidad de canales principales
    const rQuality = Math.min(50, Math.max(0, analysis.r.snr + 10) * 1.5);
    const gQuality = Math.min(30, Math.max(0, analysis.g.snr + 10) * 1.0);
    
    // Penalización por movimiento
    const motionPenalty = motionDetection.isArtifact ? 20 : 0;
    
    // Bonus por perfusion index adecuado (1-5% típico)
    const rPerfBonus = analysis.r.perfusionIndex > 0.01 && analysis.r.perfusionIndex < 0.2 ? 10 : 0;
    
    const totalQuality = rQuality * weights.r + gQuality * weights.g - motionPenalty + rPerfBonus;
    
    return Math.max(0, Math.min(100, Math.round(totalQuality)));
  }

  /**
   * Utilidad: calcular varianza
   */
  private calculateVariance(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + (val - mean) ** 2, 0) / values.length;
    return variance;
  }

  /**
   * Reset completo
   */
  reset(): void {
    this.rBuffer.fill(0);
    this.gBuffer.fill(0);
    this.bBuffer.fill(0);
    this.bufferIndex = 0;
    this.bufferFull = false;
    this.rMotionBuffer = [];
    this.bMotionBuffer = [];
    this.lastDC = { r: 0, g: 0, b: 0 };
    this.channelSNR = { r: 0, g: 0, b: 0 };
    this.rFilter.reset();
    this.gFilter.reset();
    this.bFilter.reset();
  }
}

/**
 * Filtro pasa-bajo simple para extracción de componente DC
 * Implementación IIR de primer orden (exponencial)
 */
class LowPassFilter {
  private alpha: number;
  private lastOutput: number = 0;
  private initialized: boolean = false;

  constructor(cutoffHz: number, samplingRate: number) {
    // Calcular alpha para respuesta exponencial
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const dt = 1 / samplingRate;
    this.alpha = dt / (rc + dt);
  }

  filter(input: number): number {
    if (!this.initialized) {
      this.lastOutput = input;
      this.initialized = true;
      return input;
    }
    
    this.lastOutput = this.alpha * input + (1 - this.alpha) * this.lastOutput;
    return this.lastOutput;
  }

  reset(): void {
    this.lastOutput = 0;
    this.initialized = false;
  }
}
