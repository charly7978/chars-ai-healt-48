/**
 * ArrhythmiaDetector - Detección de arritmias basada en papers validados
 * Implementa las mejores prácticas de literatura para detección de arritmias desde PPG
 * 
 * Referencias:
 * - McManus et al. (2013): "A Novel Method for the Detection of Atrial Fibrillation"
 * - Tison et al. (2018): "Deep learning for cardiac arrhythmia detection"
 * - Task Force of the European Society of Cardiology (1996): HRV standards
 * - Brennan et al. (2001): Poincaré plot for HRV analysis
 */

export type ArrhythmiaType = 
  | 'NORMAL'
  | 'AFIB'           // Fibrilación auricular
  | 'BRADYCARDIA'    // Bradicardia
  | 'TACHYCARDIA'    // Taquicardia
  | 'PREMATURE'      // Latidos prematuros (PVC/PAC)
  | 'IRREGULAR'      // Arritmia irregular no específica
  | 'PAUSE'          // Pausas sinusales
  | 'UNKNOWN';

export interface HRVMetrics {
  rmssd: number;           // Root Mean Square of Successive Differences (ms)
  sdnn: number;            // Standard Deviation of NN intervals (ms)
  nn50: number;            // Número de intervalos RR con diferencia > 50ms
  pnn50: number;           // Porcentaje de NN50
  cv: number;              // Coeficiente de variación
  meanRR: number;          // Promedio de intervalos RR (ms)
  medianRR: number;        // Mediana de intervalos RR (ms)
  shannonEntropy: number;  // Entropía de Shannon de intervalos RR
}

export interface PoincaréMetrics {
  sd1: number;             // Desviación estándar a lo largo de la identidad (ms)
  sd2: number;             // Desviación estándar perpendicular (ms)
  sd1Sd2Ratio: number;     // Ratio SD1/SD2
  area: number;            // Área de la elipse Poincaré
}

export interface ArrhythmiaResult {
  type: ArrhythmiaType;
  confidence: number;
  hrvMetrics: HRVMetrics;
  poincaréMetrics: PoincaréMetrics;
  isIrregular: boolean;
  afibProbability: number;
  guidance: string;
}

export interface ArrhythmiaDetectorConfig {
  minRRIntervals: number;  // Mínimo de intervalos RR requeridos
  afibThreshold: number;   // Umbral de probabilidad para AF
  bradycardiaThreshold: number;  // BPM
  tachycardiaThreshold: number;  // BPM
  pauseThreshold: number;  // ms
}

const DEFAULT_CONFIG: ArrhythmiaDetectorConfig = {
  minRRIntervals: 20,
  afibThreshold: 0.65,
  bradycardiaThreshold: 50,
  tachycardiaThreshold: 110,
  pauseThreshold: 2000
};

export class ArrhythmiaDetector {
  private config: ArrhythmiaDetectorConfig;
  private rrIntervals: number[] = [];
  private maxBufferSize: number = 60; // ~60 segundos a 1 Hz

  constructor(config?: Partial<ArrhythmiaDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Agrega un intervalo RR nuevo
   */
  addRRInterval(rrMs: number): void {
    if (rrMs < 200 || rrMs > 3000) return; // Filtro fisiológico

    this.rrIntervals.push(rrMs);
    if (this.rrIntervals.length > this.maxBufferSize) {
      this.rrIntervals.shift();
    }
  }

  /**
   * Analiza los intervalos RR y detecta arritmias
   */
  analyze(): ArrhythmiaResult {
    if (this.rrIntervals.length < this.config.minRRIntervals) {
      return this.getEmptyResult();
    }

    const hrv = this.calculateHRVMetrics();
    const poincaré = this.calculatePoincaréMetrics();
    const afibProb = this.calculateAFibProbability(hrv, poincaré);

    const type = this.classifyArrhythmia(hrv, poincaré, afibProb);
    const confidence = this.calculateConfidence(hrv, poincaré, type);
    const guidance = this.getGuidance(type, hrv, poincaré);

    return {
      type,
      confidence,
      hrvMetrics: hrv,
      poincaréMetrics: poincaré,
      isIrregular: this.isIrregular(hrv, poincaré),
      afibProbability: afibProb,
      guidance
    };
  }

  /**
   * Calcula métricas de HRV según Task Force (1996)
   */
  private calculateHRVMetrics(): HRVMetrics {
    const rr = this.rrIntervals;
    const n = rr.length;

    // Promedio y mediana
    const sum = rr.reduce((a, b) => a + b, 0);
    const meanRR = sum / n;
    const sorted = [...rr].sort((a, b) => a - b);
    const medianRR = sorted[Math.floor(n / 2)];

    // SDNN - Standard Deviation of NN intervals
    const variance = rr.reduce((acc, val) => acc + Math.pow(val - meanRR, 2), 0) / n;
    const sdnn = Math.sqrt(variance);

    // RMSSD - Root Mean Square of Successive Differences
    let sumDiffSq = 0;
    for (let i = 1; i < n; i++) {
      const diff = rr[i] - rr[i - 1];
      sumDiffSq += diff * diff;
    }
    const rmssd = Math.sqrt(sumDiffSq / (n - 1));

    // NN50 - Número de intervalos con diferencia > 50ms
    let nn50 = 0;
    for (let i = 1; i < n; i++) {
      if (Math.abs(rr[i] - rr[i - 1]) > 50) nn50++;
    }
    const pnn50 = (nn50 / (n - 1)) * 100;

    // Coeficiente de variación
    const cv = (sdnn / meanRR) * 100;

    // Entropía de Shannon de intervalos RR (McManus et al.)
    const entropy = this.calculateShannonEntropy(rr);

    return {
      rmssd,
      sdnn,
      nn50,
      pnn50,
      cv,
      meanRR,
      medianRR,
      shannonEntropy: entropy
    };
  }

  /**
   * Calcula métricas de Poincaré plot (Brennan et al. 2001)
   */
  private calculatePoincaréMetrics(): PoincaréMetrics {
    const rr = this.rrIntervals;
    const n = rr.length;

    if (n < 2) {
      return { sd1: 0, sd2: 0, sd1Sd2Ratio: 0, area: 0 };
    }

    // Crear pares (RR[n], RR[n+1])
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      x.push(rr[i]);
      y.push(rr[i + 1]);
    }

    // SD1 - desviación estándar a lo largo de la identidad (variabilidad a corto plazo)
    let sumDiff = 0;
    for (let i = 0; i < x.length; i++) {
      const diff = y[i] - x[i];
      sumDiff += diff * diff;
    }
    const sd1 = Math.sqrt(sumDiff / (2 * x.length));

    // SD2 - desviación estándar perpendicular (variabilidad a largo plazo)
    const meanX = x.reduce((a, b) => a + b, 0) / x.length;
    const meanY = y.reduce((a, b) => a + b, 0) / y.length;
    let sumLong = 0;
    for (let i = 0; i < x.length; i++) {
      const val = (x[i] - meanX + y[i] - meanY) / Math.sqrt(2);
      sumLong += val * val;
    }
    const sd2 = Math.sqrt(sumLong / x.length);

    // Ratio SD1/SD2 - indicador de irregularidad
    const sd1Sd2Ratio = sd1 / (sd2 + 1e-6);

    // Área de la elipse Poincaré
    const area = Math.PI * sd1 * sd2;

    return {
      sd1,
      sd2,
      sd1Sd2Ratio,
      area
    };
  }

  /**
   * Calcula entropía de Shannon de intervalos RR
   * McManus et al. (2013) usa esto para detección de AF
   */
  private calculateShannonEntropy(rr: number[]): number {
    // Normalizar y discretizar en bins
    const min = Math.min(...rr);
    const max = Math.max(...rr);
    const binCount = 10;
    const binSize = (max - min) / binCount;
    
    const bins = new Array(binCount).fill(0);
    for (const val of rr) {
      const binIdx = Math.min(Math.floor((val - min) / binSize), binCount - 1);
      bins[binIdx]++;
    }

    // Calcular entropía
    let entropy = 0;
    const total = rr.length;
    for (const count of bins) {
      if (count > 0) {
        const p = count / total;
        entropy -= p * Math.log2(p);
      }
    }

    // Normalizar al rango [0, 1]
    const maxEntropy = Math.log2(binCount);
    return entropy / maxEntropy;
  }

  /**
   * Calcula probabilidad de fibrilación auricular
   * Basado en McManus et al. (2013) y otros papers
   */
  private calculateAFibProbability(hrv: HRVMetrics, poincaré: PoincaréMetrics): number {
    let probability = 0;

    // Entropía alta indica irregularidad (AF)
    if (hrv.shannonEntropy > 0.7) {
      probability += 0.35;
    } else if (hrv.shannonEntropy > 0.5) {
      probability += 0.2;
    }

    // RMSSD elevado indica variabilidad a corto plazo
    if (hrv.rmssd > 80) {
      probability += 0.25;
    } else if (hrv.rmssd > 50) {
      probability += 0.15;
    }

    // SD1/SD2 ratio alto indica irregularidad
    if (poincaré.sd1Sd2Ratio > 0.8) {
      probability += 0.25;
    } else if (poincaré.sd1Sd2Ratio > 0.6) {
      probability += 0.15;
    }

    // pNN50 alto indica variabilidad
    if (hrv.pnn50 > 30) {
      probability += 0.15;
    }

    return Math.min(probability, 1);
  }

  /**
   * Clasifica el tipo de arritmia
   */
  private classifyArrhythmia(
    hrv: HRVMetrics,
    poincaré: PoincaréMetrics,
    afibProb: number
  ): ArrhythmiaType {
    const meanBPM = 60000 / hrv.meanRR;
    const medianBPM = 60000 / hrv.medianRR;

    // Detección de pausas sinusales
    const maxRR = Math.max(...this.rrIntervals);
    if (maxRR > this.config.pauseThreshold) {
      return 'PAUSE';
    }

    // Bradicardia
    if (medianBPM < this.config.bradycardiaThreshold) {
      return 'BRADYCARDIA';
    }

    // Taquicardia
    if (medianBPM > this.config.tachycardiaThreshold) {
      return 'TACHYCARDIA';
    }

    // Fibrilación auricular (alta probabilidad)
    if (afibProb > this.config.afibThreshold) {
      return 'AFIB';
    }

    // Arritmia irregular (no AF específico)
    if (this.isIrregular(hrv, poincaré)) {
      return 'IRREGULAR';
    }

    // Latidos prematuros (alto NN50)
    if (hrv.pnn50 > 20) {
      return 'PREMATURE';
    }

    return 'NORMAL';
  }

  /**
   * Determina si el ritmo es irregular
   */
  private isIrregular(hrv: HRVMetrics, poincaré: PoincaréMetrics): boolean {
    // Múltiples criterios de irregularidad
    const criteria = [
      hrv.cv > 10,                    // CV > 10%
      hrv.pnn50 > 15,                 // pNN50 > 15%
      poincaré.sd1Sd2Ratio > 0.5,     // SD1/SD2 > 0.5
      hrv.shannonEntropy > 0.4        // Entropía > 0.4
    ];

    // Requiere al menos 2 criterios positivos
    const positiveCount = criteria.filter(c => c).length;
    return positiveCount >= 2;
  }

  /**
   * Calcula confianza en la detección
   */
  private calculateConfidence(
    hrv: HRVMetrics,
    poincaré: PoincaréMetrics,
    type: ArrhythmiaType
  ): number {
    let confidence = 0.5;

    // Más intervalos = más confianza
    const intervalScore = Math.min(this.rrIntervals.length / 30, 1);
    confidence += intervalScore * 0.25;

    // Calidad de las métricas
    if (type === 'NORMAL') {
      confidence += 0.2;
    } else if (type === 'AFIB') {
      confidence += poincaré.sd1Sd2Ratio * 0.15;
    }

    return Math.min(confidence, 1);
  }

  /**
   * Genera mensaje de guía para el usuario
   */
  private getGuidance(
    type: ArrhythmiaType,
    hrv: HRVMetrics,
    poincaré: PoincaréMetrics
  ): string {
    switch (type) {
      case 'NORMAL':
        return 'Ritmo cardíaco normal';
      case 'AFIB':
        return 'Posible fibrilación auricular detectada - ritmo irregular';
      case 'BRADYCARDIA':
        return 'Bradicardia - ritmo cardíaco lento';
      case 'TACHYCARDIA':
        return 'Taquicardia - ritmo cardíaco rápido';
      case 'PREMATURE':
        return 'Latidos prematuros detectados';
      case 'IRREGULAR':
        return 'Ritmo irregular detectado';
      case 'PAUSE':
        return 'Pausa sinusal detectada';
      default:
        return 'Análisis de ritmo en progreso';
    }
  }

  /**
   * Resultado vacío cuando no hay suficientes datos
   */
  private getEmptyResult(): ArrhythmiaResult {
    return {
      type: 'UNKNOWN',
      confidence: 0,
      hrvMetrics: {
        rmssd: 0,
        sdnn: 0,
        nn50: 0,
        pnn50: 0,
        cv: 0,
        meanRR: 0,
        medianRR: 0,
        shannonEntropy: 0
      },
      poincaréMetrics: {
        sd1: 0,
        sd2: 0,
        sd1Sd2Ratio: 0,
        area: 0
      },
      isIrregular: false,
      afibProbability: 0,
      guidance: 'Acumulando datos para análisis de ritmo...'
    };
  }

  /**
   * Reinicia el detector
   */
  reset(): void {
    this.rrIntervals = [];
  }

  /**
   * Obtiene número de intervalos almacenados
   */
  getIntervalCount(): number {
    return this.rrIntervals.length;
  }
}
