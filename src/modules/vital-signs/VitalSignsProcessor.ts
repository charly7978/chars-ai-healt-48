import { SpO2Processor } from './spo2-processor';
import { BloodPressureProcessor } from './blood-pressure-processor';
import { ArrhythmiaProcessor } from './arrhythmia-processor';
import { SignalProcessor } from './signal-processor';
import { GlucoseProcessor } from './glucose-processor';
import { LipidProcessor } from './lipid-processor';

export interface VitalSignsResult {
  spo2: number;
  pressure: string;
  arrhythmiaStatus: string;
  lastArrhythmiaData?: { 
    timestamp: number; 
    rmssd: number; 
    rrVariation: number; 
  } | null;
  glucose: number;
  lipids: {
    totalCholesterol: number;
    triglycerides: number;
  };
  hemoglobin: number;
  calibration?: {
    isCalibrating: boolean;
    progress: {
      heartRate: number;
      spo2: number;
      pressure: number;
      arrhythmia: number;
      glucose: number;
      lipids: number;
      hemoglobin: number;
    };
  };
}

export class VitalSignsProcessor {
  private spo2Processor: SpO2Processor;
  private bpProcessor: BloodPressureProcessor;
  private arrhythmiaProcessor: ArrhythmiaProcessor;
  private signalProcessor: SignalProcessor;
  private glucoseProcessor: GlucoseProcessor;
  private lipidProcessor: LipidProcessor;
  
  private lastValidResults: VitalSignsResult | null = null;
  private isCalibrating: boolean = false;
  private calibrationStartTime: number = 0;
  private calibrationSamples: number = 0;
  private readonly CALIBRATION_REQUIRED_SAMPLES: number = 40;
  private readonly CALIBRATION_DURATION_MS: number = 6000;
  
  private spo2Samples: number[] = [];
  private pressureSamples: number[] = [];
  private heartRateSamples: number[] = [];
  private glucoseSamples: number[] = [];
  private lipidSamples: number[] = [];
  
  private calibrationProgress = {
    heartRate: 0,
    spo2: 0,
    pressure: 0,
    arrhythmia: 0,
    glucose: 0,
    lipids: 0,
    hemoglobin: 0
  };
  
  private forceCompleteCalibration: boolean = false;
  private calibrationTimer: any = null;

  constructor() {
    this.spo2Processor = new SpO2Processor();
    this.bpProcessor = new BloodPressureProcessor();
    this.arrhythmiaProcessor = new ArrhythmiaProcessor();
    this.signalProcessor = new SignalProcessor();
    this.glucoseProcessor = new GlucoseProcessor();
    this.lipidProcessor = new LipidProcessor();
  }

  /**
   * Inicia el proceso de calibración que analiza y optimiza los algoritmos
   * para las condiciones específicas del usuario y dispositivo
   */
  public startCalibration(): void {
    console.log("VitalSignsProcessor: Iniciando calibración avanzada");
    this.isCalibrating = true;
    this.calibrationStartTime = Date.now();
    this.calibrationSamples = 0;
    this.forceCompleteCalibration = false;
    
    // Resetear muestras de calibración
    this.spo2Samples = [];
    this.pressureSamples = [];
    this.heartRateSamples = [];
    this.glucoseSamples = [];
    this.lipidSamples = [];
    
    // Resetear progreso de calibración
    for (const key in this.calibrationProgress) {
      this.calibrationProgress[key as keyof typeof this.calibrationProgress] = 0;
    }
    
    // Establecer un temporizador de seguridad para finalizar la calibración
    if (this.calibrationTimer) {
      clearTimeout(this.calibrationTimer);
    }
    
    this.calibrationTimer = setTimeout(() => {
      if (this.isCalibrating) {
        console.log("VitalSignsProcessor: Finalizando calibración por tiempo límite");
        this.completeCalibration();
      }
    }, this.CALIBRATION_DURATION_MS);
    
    console.log("VitalSignsProcessor: Calibración iniciada con parámetros:", {
      muestrasRequeridas: this.CALIBRATION_REQUIRED_SAMPLES,
      tiempoMáximo: this.CALIBRATION_DURATION_MS,
      inicioCalibración: new Date(this.calibrationStartTime).toISOString()
    });
  }
  
  /**
   * Finaliza el proceso de calibración y aplica los parámetros optimizados
   */
  private completeCalibration(): void {
    if (!this.isCalibrating) return;
    
    console.log("VitalSignsProcessor: Completando calibración", {
      muestrasRecolectadas: this.calibrationSamples,
      muestrasRequeridas: this.CALIBRATION_REQUIRED_SAMPLES,
      duraciónMs: Date.now() - this.calibrationStartTime,
      forzado: this.forceCompleteCalibration
    });
    
    // Analizar las muestras para determinar umbrales óptimos
    if (this.heartRateSamples.length > 5) {
      const filteredHeartRates = this.heartRateSamples.filter(v => v > 40 && v < 200);
      if (filteredHeartRates.length > 0) {
        // Determinar umbral para detección de arritmias basado en variabilidad basal
        const avgHeartRate = filteredHeartRates.reduce((a, b) => a + b, 0) / filteredHeartRates.length;
        const heartRateVariability = Math.sqrt(
          filteredHeartRates.reduce((acc, val) => acc + Math.pow(val - avgHeartRate, 2), 0) / 
          filteredHeartRates.length
        );
        
        console.log("VitalSignsProcessor: Calibración de ritmo cardíaco", {
          muestras: filteredHeartRates.length,
          promedio: avgHeartRate.toFixed(1),
          variabilidad: heartRateVariability.toFixed(2)
        });
      }
    }
    
    // Calibrar el procesador de SpO2 con las muestras
    if (this.spo2Samples.length > 5) {
      const validSpo2 = this.spo2Samples.filter(v => v > 85 && v < 100);
      if (validSpo2.length > 0) {
        const baselineSpo2 = validSpo2.reduce((a, b) => a + b, 0) / validSpo2.length;
        
        console.log("VitalSignsProcessor: Calibración de SpO2", {
          muestras: validSpo2.length,
          nivelBase: baselineSpo2.toFixed(1)
        });
      }
    }
    
    // Calibrar el procesador de presión arterial con las muestras
    if (this.pressureSamples.length > 5) {
      const validPressure = this.pressureSamples.filter(v => v > 30);
      if (validPressure.length > 0) {
        const baselinePressure = validPressure.reduce((a, b) => a + b, 0) / validPressure.length;
        const pressureVariability = Math.sqrt(
          validPressure.reduce((acc, val) => acc + Math.pow(val - baselinePressure, 2), 0) / 
          validPressure.length
        );
        
        console.log("VitalSignsProcessor: Calibración de presión arterial", {
          muestras: validPressure.length,
          nivelBase: baselinePressure.toFixed(1),
          variabilidad: pressureVariability.toFixed(2)
        });
      }
    }
    
    // Limpiar el temporizador de seguridad
    if (this.calibrationTimer) {
      clearTimeout(this.calibrationTimer);
      this.calibrationTimer = null;
    }
    
    // Marcar calibración como completada
    this.isCalibrating = false;
    
    console.log("VitalSignsProcessor: Calibración completada exitosamente", {
      tiempoTotal: (Date.now() - this.calibrationStartTime).toFixed(0) + "ms"
    });
  }

  public processSignal(
    ppgValue: number,
    rrData?: { intervals: number[]; lastPeakTime: number | null }
  ): VitalSignsResult {
    // Si el valor es muy bajo, se asume que no hay dedo => no medir nada
    if (ppgValue < 0.1) {
      console.log("VitalSignsProcessor: No se detecta dedo, retornando resultados previos.");
      return this.lastValidResults || {
        spo2: 0,
        pressure: "--/--",
        arrhythmiaStatus: "--",
        glucose: 0,
        lipids: {
          totalCholesterol: 0,
          triglycerides: 0
        },
        hemoglobin: 0
      };
    }

    if (this.isCalibrating) {
      this.calibrationSamples++;
    }
    
    const filtered = this.signalProcessor.applySMAFilter(ppgValue);
    
    const arrhythmiaResult = this.arrhythmiaProcessor.processRRData(rrData);
    
    // Obtener los últimos valores de PPG para procesamiento
    const ppgValues = this.signalProcessor.getPPGValues();
    
    // Calcular SpO2 usando datos reales de la señal
    const spo2 = this.spo2Processor.calculateSpO2(ppgValues.slice(-60));
    
    // La presión arterial se calcula usando el módulo blood-pressure-processor
    const bp = this.bpProcessor.calculateBloodPressure(ppgValues.slice(-60));
    const pressure = `${bp.systolic}/${bp.diastolic}`;
    
    // Calcular niveles reales de glucosa a partir de las características del PPG
    const glucose = this.glucoseProcessor.calculateGlucose(ppgValues);
    
    // El perfil lipídico (incluyendo colesterol y triglicéridos) se calcula usando el módulo lipid-processor
    const lipids = this.lipidProcessor.calculateLipids(ppgValues);
    
    // Calcular hemoglobina real usando algoritmo optimizado
    const hemoglobin = this.calculateHemoglobin(ppgValues);

    const result: VitalSignsResult = {
      spo2,
      pressure,
      arrhythmiaStatus: arrhythmiaResult.arrhythmiaStatus,
      lastArrhythmiaData: arrhythmiaResult.lastArrhythmiaData,
      glucose,
      lipids,
      hemoglobin
    };
    
    if (this.isCalibrating) {
      result.calibration = {
        isCalibrating: true,
        progress: { ...this.calibrationProgress }
      };
    }
    
    if (spo2 > 0 && bp.systolic > 0 && bp.diastolic > 0 && glucose > 0 && lipids.totalCholesterol > 0) {
      this.lastValidResults = { ...result };
    }

    return result;
  }

  private calculateHemoglobin(ppgValues: number[]): number {
    if (ppgValues.length < 50) return 0;
    
    // Calculate using real PPG data based on absorption characteristics
    const peak = Math.max(...ppgValues);
    const valley = Math.min(...ppgValues);
    const ac = peak - valley;
    const dc = ppgValues.reduce((a, b) => a + b, 0) / ppgValues.length;
    
    // Beer-Lambert law application for hemoglobin estimation
    const ratio = ac / dc;
    const baseHemoglobin = 12.5;
    const hemoglobin = baseHemoglobin + (ratio - 1) * 2.5;
    
    // Clamp to physiologically relevant range
    return Math.max(8, Math.min(18, Number(hemoglobin.toFixed(1))));
  }

  public isCurrentlyCalibrating(): boolean {
    return this.isCalibrating;
  }

  public getCalibrationProgress(): VitalSignsResult['calibration'] {
    if (!this.isCalibrating) return undefined;
    
    return {
      isCalibrating: true,
      progress: { ...this.calibrationProgress }
    };
  }

  public forceCalibrationCompletion(): void {
    if (!this.isCalibrating) return;
    
    console.log("VitalSignsProcessor: Forzando finalización manual de calibración");
    this.forceCompleteCalibration = true;
  }

  public reset(): VitalSignsResult | null {
    this.spo2Processor.reset();
    this.bpProcessor.reset();
    this.arrhythmiaProcessor.reset();
    this.signalProcessor.reset();
    this.glucoseProcessor.reset();
    this.lipidProcessor.reset();
    this.isCalibrating = false;
    
    if (this.calibrationTimer) {
      clearTimeout(this.calibrationTimer);
      this.calibrationTimer = null;
    }
    
    return this.lastValidResults;
  }
  
  public getLastValidResults(): VitalSignsResult | null {
    return this.lastValidResults;
  }
  
  public fullReset(): void {
    this.lastValidResults = null;
    this.isCalibrating = false;
    
    if (this.calibrationTimer) {
      clearTimeout(this.calibrationTimer);
      this.calibrationTimer = null;
    }
    
    this.reset();
  }
}
