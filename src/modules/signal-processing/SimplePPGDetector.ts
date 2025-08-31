/**
 * Detector SIMPLE y EFECTIVO de latidos PPG
 * Basado en métodos probados de la literatura
 */

export interface SimplePeakResult {
  peaks: number[];
  bpm: number | null;
  amplitude: number;
  isValid: boolean;
}

export class SimplePPGDetector {
  // Parámetros fijos y probados
  private readonly WINDOW_SIZE = 0.75; // 750ms - ventana típica de latido
  private readonly MIN_PEAK_DISTANCE = 0.4; // 400ms - máximo 150 BPM
  private readonly MAX_PEAK_DISTANCE = 1.5; // 1500ms - mínimo 40 BPM
  
  // Buffers internos
  private movingAverage: number[] = [];
  private movingStd: number[] = [];
  private lastPeaks: number[] = [];
  
  /**
   * Detecta picos en señal PPG usando método simple pero robusto
   */
  detectPeaks(signal: number[], fs: number): SimplePeakResult {
    if (signal.length < fs) {
      return { peaks: [], bpm: null, amplitude: 0, isValid: false };
    }

    // 1. Normalizar señal
    const normalized = this.normalize(signal);
    
    // 2. Calcular media móvil
    const windowSamples = Math.floor(this.WINDOW_SIZE * fs);
    const movingAvg = this.calculateMovingAverage(normalized, windowSamples);
    
    // 3. Señal diferencial (AC component)
    const acSignal = normalized.map((val, i) => val - movingAvg[i]);
    
    // 4. Encontrar picos usando umbral dinámico
    const peaks = this.findPeaksWithDynamicThreshold(acSignal, fs);
    
    // 5. Validar y calcular BPM
    const validPeaks = this.validatePeaks(peaks, fs);
    const bpm = this.calculateBPM(validPeaks, fs);
    
    // 6. Calcular amplitud promedio
    const amplitude = this.calculateAmplitude(acSignal, validPeaks);
    
    // Log para debugging
    if (validPeaks.length > 0) {
      console.log('🎯 SimplePPG - Latidos detectados:', {
        numPeaks: validPeaks.length,
        bpm,
        amplitude: amplitude.toFixed(3),
        peakPositions: validPeaks.slice(0, 5).map(p => (p/fs).toFixed(2) + 's')
      });
    }
    
    return {
      peaks: validPeaks,
      bpm,
      amplitude,
      isValid: validPeaks.length >= 3 && bpm !== null
    };
  }

  /**
   * Normalización simple y robusta
   */
  private normalize(signal: number[]): number[] {
    // Encontrar rango usando percentiles para robustez
    const sorted = [...signal].sort((a, b) => a - b);
    const p5 = sorted[Math.floor(signal.length * 0.05)];
    const p95 = sorted[Math.floor(signal.length * 0.95)];
    const range = p95 - p5;
    
    if (range < 0.1) return signal.map(() => 0);
    
    // Normalizar a [-1, 1]
    return signal.map(x => (2 * (x - p5) / range) - 1);
  }

  /**
   * Media móvil simple
   */
  private calculateMovingAverage(signal: number[], windowSize: number): number[] {
    const result = new Array(signal.length);
    const halfWindow = Math.floor(windowSize / 2);
    
    for (let i = 0; i < signal.length; i++) {
      let sum = 0;
      let count = 0;
      
      for (let j = Math.max(0, i - halfWindow); j <= Math.min(signal.length - 1, i + halfWindow); j++) {
        sum += signal[j];
        count++;
      }
      
      result[i] = sum / count;
    }
    
    return result;
  }

  /**
   * Encuentra picos con umbral dinámico
   */
  private findPeaksWithDynamicThreshold(signal: number[], fs: number): number[] {
    const peaks: number[] = [];
    const minDistance = Math.floor(this.MIN_PEAK_DISTANCE * fs);
    
    // Calcular umbral dinámico basado en desviación estándar local
    const windowSize = Math.floor(fs * 2); // ventana de 2 segundos
    
    for (let i = 1; i < signal.length - 1; i++) {
      // Es un máximo local?
      if (signal[i] > signal[i-1] && signal[i] > signal[i+1]) {
        // Calcular umbral local
        const start = Math.max(0, i - windowSize/2);
        const end = Math.min(signal.length, i + windowSize/2);
        const localSegment = signal.slice(start, end);
        
        const mean = this.mean(localSegment);
        const std = this.std(localSegment, mean);
        const threshold = mean + 0.5 * std; // umbral conservador
        
        // Verificar si supera el umbral y está suficientemente lejos del último pico
        if (signal[i] > threshold) {
          if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minDistance) {
            peaks.push(i);
          } else if (signal[i] > signal[peaks[peaks.length - 1]]) {
            // Si está muy cerca pero es más alto, reemplazar
            peaks[peaks.length - 1] = i;
          }
        }
      }
    }
    
    return peaks;
  }

  /**
   * Valida picos basándose en intervalos fisiológicos
   */
  private validatePeaks(peaks: number[], fs: number): number[] {
    if (peaks.length < 2) return peaks;
    
    const validated: number[] = [peaks[0]];
    const minSamples = Math.floor(this.MIN_PEAK_DISTANCE * fs);
    const maxSamples = Math.floor(this.MAX_PEAK_DISTANCE * fs);
    
    for (let i = 1; i < peaks.length; i++) {
      const interval = peaks[i] - validated[validated.length - 1];
      
      // Verificar intervalo fisiológico
      if (interval >= minSamples && interval <= maxSamples) {
        validated.push(peaks[i]);
      }
      // Si es muy cercano, quedarse con el más prominente
      else if (interval < minSamples && i < peaks.length - 1) {
        continue; // Saltar este pico
      }
    }
    
    return validated;
  }

  /**
   * Calcula BPM de manera robusta
   */
  private calculateBPM(peaks: number[], fs: number): number | null {
    if (peaks.length < 3) return null;
    
    // Calcular intervalos RR
    const intervals: number[] = [];
    for (let i = 1; i < peaks.length; i++) {
      const intervalMs = (peaks[i] - peaks[i-1]) / fs * 1000;
      intervals.push(intervalMs);
    }
    
    // Filtrar outliers simples
    const mean = this.mean(intervals);
    const std = this.std(intervals, mean);
    const filtered = intervals.filter(x => Math.abs(x - mean) <= 2 * std);
    
    if (filtered.length === 0) return null;
    
    // BPM promedio
    const avgInterval = this.mean(filtered);
    const bpm = Math.round(60000 / avgInterval);
    
    // Validar rango
    return (bpm >= 40 && bpm <= 180) ? bpm : null;
  }

  /**
   * Calcula amplitud promedio de los picos
   */
  private calculateAmplitude(signal: number[], peaks: number[]): number {
    if (peaks.length === 0) return 0;
    
    let sumAmplitude = 0;
    const windowSize = 10; // ventana pequeña alrededor del pico
    
    for (const peak of peaks) {
      // Encontrar el valle más cercano antes del pico
      let valley = signal[peak];
      for (let i = Math.max(0, peak - windowSize); i < peak; i++) {
        valley = Math.min(valley, signal[i]);
      }
      
      sumAmplitude += signal[peak] - valley;
    }
    
    return sumAmplitude / peaks.length;
  }

  // Utilidades estadísticas
  private mean(arr: number[]): number {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  private std(arr: number[], mean?: number): number {
    const m = mean ?? this.mean(arr);
    const variance = arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  }
}

// Función helper para uso directo
export function detectSimplePPG(signal: number[], fs: number): SimplePeakResult {
  const detector = new SimplePPGDetector();
  return detector.detectPeaks(signal, fs);
}