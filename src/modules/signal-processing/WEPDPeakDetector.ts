/**
 * @file WEPDPeakDetector.ts
 * @description Waveform Envelope Peak Detection (WEPD) Algorithm
 * Implementación del algoritmo de Han et al. 2022 para detección precisa de picos PPG
 * Incluye: moving average triple, first difference, standardization, envelope analysis
 * Refractory period de 300ms para evitar detección de notch dicrotico
 * 
 * Referencia: "A Real-Time PPG Peak Detection Method for Accurate Determination 
 * of Heart Rate during Sinus Rhythm and Cardiac Arrhythmia" (PMC8869811)
 */

export interface PeakDetectionResult {
  isPeak: boolean;
  peakIndex: number;
  timestamp: number;
  amplitude: number;
  confidence: number;        // 0-1 basada en prominencia respecto a envolvente
  prominence: number;        // Diferencia entre pico y envolvente
  isDicroticNotch: boolean; // Flag si fue identificado como notch dicrotico
}

export interface WEPDConfig {
  samplingRate: number;
  refractoryPeriodMs: number;    // 300ms default
  minBPM: number;                // 35 BPM
  maxBPM: number;                // 220 BPM
  envelopeWindowFactor: number;  // 1.5 * samplingRate (N-tap Hilbert)
}

export class WEPDPeakDetector {
  private config: WEPDConfig;
  private signalBuffer: Float64Array;
  private processedBuffer: Float64Array;
  private envelopeBuffer: Float64Array;
  private lastPeakTime: number = 0;
  private lastConfirmedPeak: PeakDetectionResult | null = null;
  private bufferIndex: number = 0;
  private readonly bufferSize: number = 512;
  
  // Buffers para filtros MA
  private maBuffer1: number[] = [];
  private maBuffer2: number[] = [];
  private maBuffer3: number[] = [];
  
  // Estados de procesamiento
  private signalMean: number = 0;
  private signalStd: number = 1;
  private currentPeakCandidate: { index: number; value: number; timestamp: number } | null = null;
  
  // Contadores de calidad
  private totalPeaksDetected: number = 0;
  private falsePositivesFiltered: number = 0;

  constructor(config?: Partial<WEPDConfig>) {
    this.config = {
      samplingRate: config?.samplingRate || 30,
      refractoryPeriodMs: config?.refractoryPeriodMs || 300,
      minBPM: config?.minBPM || 35,
      maxBPM: config?.maxBPM || 220,
      envelopeWindowFactor: config?.envelopeWindowFactor || 1.5
    };
    
    this.signalBuffer = new Float64Array(this.bufferSize);
    this.processedBuffer = new Float64Array(this.bufferSize);
    this.envelopeBuffer = new Float64Array(this.bufferSize);
    
    // Inicializar buffers MA con ceros
    const m1 = Math.round(this.config.samplingRate / 10);
    const m2 = Math.round(this.config.samplingRate / 9);
    this.maBuffer1 = new Array(m1).fill(0);
    this.maBuffer2 = new Array(m2).fill(0);
    this.maBuffer3 = new Array(m2).fill(0);
  }

  /**
   * Procesar nueva muestra y detectar picos
   * Pipeline completo: Preproceso → Detección → Validación
   */
  processSample(value: number, timestamp: number): PeakDetectionResult {
    // Guardar en buffer circular
    this.bufferIndex = (this.bufferIndex + 1) % this.bufferSize;
    this.signalBuffer[this.bufferIndex] = value;
    
    // PASO 1: Preprocesamiento completo
    const preprocessed = this.preprocessSignal(value);
    this.processedBuffer[this.bufferIndex] = preprocessed;
    
    // PASO 2: Calcular envolvente (solo con suficientes muestras)
    this.updateEnvelope();
    
    // PASO 3: Detección de picos
    const peakResult = this.detectPeak(preprocessed, timestamp);
    
    // PASO 4: Validación con envolvente (WEPD)
    if (peakResult.isPeak) {
      const validatedResult = this.validateWithEnvelope(peakResult, timestamp);
      
      if (validatedResult.isPeak) {
        this.lastPeakTime = timestamp;
        this.totalPeaksDetected++;
        this.lastConfirmedPeak = validatedResult;
        return validatedResult;
      } else {
        this.falsePositivesFiltered++;
      }
    }
    
    return peakResult;
  }

  /**
   * Preprocesamiento completo:
   * 1. Bandpass filter 0.5-5Hz (asumido ya aplicado externamente)
   * 2. Triple Moving Average
   * 3. First difference
   * 4. Standardization (z-score)
   */
  private preprocessSignal(value: number): number {
    // 1. Triple Moving Average
    const m1 = this.maBuffer1.length;
    const m2 = this.maBuffer2.length;
    
    // Primer MA (M = fs/10)
    this.maBuffer1.push(value);
    if (this.maBuffer1.length > m1) this.maBuffer1.shift();
    const ma1 = this.maBuffer1.reduce((a, b) => a + b, 0) / this.maBuffer1.length;
    
    // Segundo MA (M = fs/9)
    this.maBuffer2.push(ma1);
    if (this.maBuffer2.length > m2) this.maBuffer2.shift();
    const ma2 = this.maBuffer2.reduce((a, b) => a + b, 0) / this.maBuffer2.length;
    
    // Tercer MA (M = fs/9)
    this.maBuffer3.push(ma2);
    if (this.maBuffer3.length > m2) this.maBuffer3.shift();
    const ma3 = this.maBuffer3.reduce((a, b) => a + b, 0) / this.maBuffer3.length;
    
    // 2. First difference: acentuar fluctuaciones en plateau del pulso
    const diff = this.maBuffer3.length >= 2 
      ? ma3 - this.maBuffer3[this.maBuffer3.length - 2]
      : 0;
    
    // 3. Standardization (calculo adaptativo de media/std)
    this.updateStatistics(diff);
    const standardized = this.signalStd > 0 
      ? (diff - this.signalMean) / this.signalStd 
      : 0;
    
    return standardized;
  }

  /**
   * Actualizar estadísticas para standardization adaptativo
   */
  private updateStatistics(value: number): void {
    // Media móvil exponencial
    const alpha = 0.02; // Ventana efectiva ~50 muestras
    this.signalMean = this.signalMean * (1 - alpha) + value * alpha;
    
    // Varianza móvil
    const diff = value - this.signalMean;
    const variance = this.signalStd * this.signalStd * (1 - alpha) + (diff * diff) * alpha;
    this.signalStd = Math.sqrt(variance);
    
    // Evitar std muy pequeño
    if (this.signalStd < 0.001) this.signalStd = 0.001;
  }

  /**
   * Actualizar cálculo de envolvente usando interpolación spline de mínimos
   */
  private updateEnvelope(): void {
    // Obtener ventana de señal procesada reciente
    const windowSize = Math.min(64, this.bufferSize);
    const windowStart = (this.bufferIndex - windowSize + this.bufferSize) % this.bufferSize;
    
    // Encontrar mínimos locales en la ventana
    const localMinima: { index: number; value: number }[] = [];
    
    for (let i = 2; i < windowSize - 2; i++) {
      const idx = (windowStart + i) % this.bufferSize;
      const prev = (windowStart + i - 1) % this.bufferSize;
      const next = (windowStart + i + 1) % this.bufferSize;
      
      if (this.processedBuffer[idx] < this.processedBuffer[prev] && 
          this.processedBuffer[idx] < this.processedBuffer[next]) {
        localMinima.push({ index: idx, value: this.processedBuffer[idx] });
      }
    }
    
    // Interpolar envolvente inferior con spline cúbico simplificado
    if (localMinima.length >= 3) {
      for (let i = windowStart; i < windowStart + windowSize; i++) {
        const idx = i % this.bufferSize;
        
        // Encontrar mínimos anterior y posterior
        let prevMin = localMinima[0];
        let nextMin = localMinima[localMinima.length - 1];
        
        for (const min of localMinima) {
          if (min.index <= idx && min.index > prevMin.index) prevMin = min;
          if (min.index >= idx && min.index < nextMin.index) nextMin = min;
        }
        
        // Interpolación lineal (simplificación de spline cúbico para velocidad)
        if (nextMin.index !== prevMin.index) {
          const t = (idx - prevMin.index) / (nextMin.index - prevMin.index);
          this.envelopeBuffer[idx] = prevMin.value + t * (nextMin.value - prevMin.value);
        }
      }
    }
  }

  /**
   * Detección inicial de picos usando análisis de pendiente
   * Selecciona lado más "sharp" (top o bottom) de la onda PPG
   */
  private detectPeak(processedValue: number, timestamp: number): PeakDetectionResult {
    const defaultResult: PeakDetectionResult = {
      isPeak: false,
      peakIndex: this.bufferIndex,
      timestamp,
      amplitude: processedValue,
      confidence: 0,
      prominence: 0,
      isDicroticNotch: false
    };
    
    // Verificar período refractario
    const timeSinceLastPeak = timestamp - this.lastPeakTime;
    if (timeSinceLastPeak < this.config.refractoryPeriodMs) {
      return defaultResult;
    }
    
    // Calcular rango BPM válido en ms
    const minInterval = (60 / this.config.maxBPM) * 1000;
    const maxInterval = (60 / this.config.minBPM) * 1000;
    
    if (timeSinceLastPeak < minInterval) {
      return defaultResult; // Demasiado rápido
    }
    
    // Análisis de gradiente alrededor del punto actual
    const windowSize = 5;
    const gradients: number[] = [];
    
    for (let i = -windowSize; i < windowSize; i++) {
      const idx1 = (this.bufferIndex + i + this.bufferSize) % this.bufferSize;
      const idx2 = (this.bufferIndex + i + 1 + this.bufferSize) % this.bufferSize;
      gradients.push(this.processedBuffer[idx2] - this.processedBuffer[idx1]);
    }
    
    // Calcular cambio de pendiente (segunda derivada aproximada)
    const meanGradient = gradients.reduce((a, b) => a + b, 0) / gradients.length;
    const gradientChange = gradients[windowSize] - gradients[windowSize - 1];
    
    // Detectar pico: cambio de pendiente positivo a negativo (máximo local)
    const isPeak = processedValue > 0.5 && // Amplitud mínima
                   meanGradient > 0 &&       // Pendiente positiva media
                   gradientChange < -0.1;    // Cambio brusco a negativo
    
    if (isPeak) {
      // Calcular prominencia respecto a envolvente
      const envelopeValue = this.envelopeBuffer[this.bufferIndex];
      const prominence = processedValue - envelopeValue;
      
      // Calcular confianza basada en prominencia y forma
      const prominenceScore = Math.min(1.0, prominence / 1.5);
      const gradientScore = Math.min(1.0, Math.abs(meanGradient) * 5);
      const confidence = 0.6 * prominenceScore + 0.4 * gradientScore;
      
      return {
        isPeak: true,
        peakIndex: this.bufferIndex,
        timestamp,
        amplitude: processedValue,
        confidence,
        prominence,
        isDicroticNotch: false // Se determina en validación
      };
    }
    
    return defaultResult;
  }

  /**
   * Validación con envolvente (core del algoritmo WEPD)
   * Elimina falsos positivos causados por notch dicrotico
   */
  private validateWithEnvelope(peak: PeakDetectionResult, timestamp: number): PeakDetectionResult {
    const envelopeValue = this.envelopeBuffer[peak.peakIndex];
    const signalValue = this.processedBuffer[peak.peakIndex];
    
    // Calcular intersecciones entre señal y envolvente
    const intersectionAmplitude = Math.min(signalValue, envelopeValue);
    
    // Si hay múltiples picos candidatos en esta área, retener el de menor amplitud
    // (el pico real es típicamente más bajo que el notch dicrotico)
    
    // Detectar si es notch dicrotico:
    // El notch típicamente tiene menor prominencia respecto a envolvente
    const isDicroticNotch = peak.prominence < 0.3 && peak.amplitude > envelopeValue;
    
    if (isDicroticNotch && this.lastConfirmedPeak) {
      // Verificar si está lo suficientemente cerca del pico anterior (150-300ms)
      const timeFromLastPeak = timestamp - this.lastConfirmedPeak.timestamp;
      if (timeFromLastPeak > 150 && timeFromLastPeak < 300) {
        // Probable notch dicrotico del latido anterior
        return {
          ...peak,
          isPeak: false,
          isDicroticNotch: true
        };
      }
    }
    
    // Ajustar confianza basada en prominencia respecto a envolvente
    const adjustedConfidence = Math.min(1.0, peak.confidence * (1 + peak.prominence * 0.5));
    
    return {
      ...peak,
      confidence: adjustedConfidence,
      isDicroticNotch
    };
  }

  /**
   * Determinar si usar picos superiores o inferiores de la onda PPG
   * El lado con "sharper peaks" (mayor gradiente medio) es más confiable
   */
  private selectTopOrBottom(signalWindow: Float64Array): { useTop: boolean; sharpness: number } {
    const n = signalWindow.length;
    
    // Detectar picos en porción superior
    let topPeaks = 0;
    let topSharpness = 0;
    
    // Detectar picos en porción inferior (invertida)
    let bottomPeaks = 0;
    let bottomSharpness = 0;
    
    for (let i = 2; i < n - 2; i++) {
      // Top detection
      if (signalWindow[i] > signalWindow[i-1] && signalWindow[i] > signalWindow[i+1]) {
        topPeaks++;
        const gradient = Math.abs(signalWindow[i+1] - signalWindow[i-1]);
        topSharpness += gradient;
      }
      
      // Bottom detection (invertido)
      const inverted = -signalWindow[i];
      const invPrev = -signalWindow[i-1];
      const invNext = -signalWindow[i+1];
      if (inverted > invPrev && inverted > invNext) {
        bottomPeaks++;
        const gradient = Math.abs(invNext - invPrev);
        bottomSharpness += gradient;
      }
    }
    
    // Normalizar sharpness
    if (topPeaks > 0) topSharpness /= topPeaks;
    if (bottomPeaks > 0) bottomSharpness /= bottomPeaks;
    
    // Validar rangos de BPM
    const topBPM = (topPeaks / n) * this.config.samplingRate * 60;
    const bottomBPM = (bottomPeaks / n) * this.config.samplingRate * 60;
    
    let useTop = true;
    
    // Descartar lado con BPM imposible
    if (topBPM > this.config.maxBPM || topBPM < this.config.minBPM) {
      useTop = false;
    } else if (bottomBPM > this.config.maxBPM || bottomBPM < this.config.minBPM) {
      useTop = true;
    } else {
      // Ambos válidos: elegir lado con mayor sharpness
      useTop = topSharpness >= bottomSharpness;
    }
    
    return { 
      useTop, 
      sharpness: useTop ? topSharpness : bottomSharpness 
    };
  }

  /**
   * Reset completo del detector
   */
  reset(): void {
    this.signalBuffer.fill(0);
    this.processedBuffer.fill(0);
    this.envelopeBuffer.fill(0);
    this.lastPeakTime = 0;
    this.lastConfirmedPeak = null;
    this.bufferIndex = 0;
    this.signalMean = 0;
    this.signalStd = 1;
    this.currentPeakCandidate = null;
    this.totalPeaksDetected = 0;
    this.falsePositivesFiltered = 0;
    
    // Reset MA buffers
    this.maBuffer1.fill(0);
    this.maBuffer2.fill(0);
    this.maBuffer3.fill(0);
  }

  /**
   * Obtener estadísticas de detección
   */
  getStats(): {
    totalPeaks: number;
    falsePositivesFiltered: number;
    precision: number;
  } {
    const total = this.totalPeaksDetected + this.falsePositivesFiltered;
    return {
      totalPeaks: this.totalPeaksDetected,
      falsePositivesFiltered: this.falsePositivesFiltered,
      precision: total > 0 ? this.totalPeaksDetected / total : 0
    };
  }
}
