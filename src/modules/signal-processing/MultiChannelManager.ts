
/**
 * MultiChannelManager COMPLETAMENTE OPTIMIZADO:
 * - Lógica de consenso arreglada y balanceada
 * - Umbrales realistas para detección robusta de dedo  
 * - Feedback adaptativo inteligente
 * - Agregación de BPM más precisa con ponderación
 * - Sistema de debounce mejorado
 */

import PPGChannel from './PPGChannel';
import { ChannelResult, MultiChannelResult } from '@/types';

export default class MultiChannelManager {
  private channels: PPGChannel[] = [];
  private n: number;
  private windowSec: number;
  private lastTimestamp = Date.now();
  
  // Estado de detección con debounce MEJORADO
  private fingerState = false;
  private fingerStableCount = 0;
  private fingerUnstableCount = 0;
  private lastGlobalToggle = 0;
  private readonly GLOBAL_HOLD_MS = 100; // Reducido para respuesta inmediata
  private coverageEma: number | null = null;
  private motionEma: number | null = null;
  
  // PARÁMETROS DE CONSENSO OPTIMIZADOS Y BALANCEADOS
  private readonly FRAMES_TO_CONFIRM_FINGER = 7;    // robusto para confirmar
  private readonly FRAMES_TO_LOSE_FINGER = 30;      // perder dedo sólo tras ~1.5s inestable (más tolerancia)
  private readonly MIN_COVERAGE_RATIO = 0.14;       // permitir luz más baja
  private readonly MAX_FRAME_DIFF = 28;             // tolerar más autoexposición/micro-mov
  private readonly MIN_CONSENSUS_RATIO = 0.32;      // igual
  private readonly MIN_QUALITY_THRESHOLD = 20;      // más permisivo para estabilidad

  constructor(n = 6, windowSec = 8) {
    this.n = n;
    this.windowSec = windowSec;
    
    console.log('🏭 MultiChannelManager INICIALIZADO:', {
      channels: n,
      windowSec,
      framesToConfirm: this.FRAMES_TO_CONFIRM_FINGER,
      framesToLose: this.FRAMES_TO_LOSE_FINGER,
      minCoverage: (this.MIN_COVERAGE_RATIO * 100) + '%',
      maxFrameDiff: this.MAX_FRAME_DIFF,
      minConsensus: (this.MIN_CONSENSUS_RATIO * 100) + '%'
    });
    
    // Crear canales con variaciones para diversidad
    for (let i = 0; i < n; i++) {
      const gainVariation = 1 + (i - Math.floor(n/2)) * 0.08; // ±8% variación (era 5%)
      this.channels.push(new PPGChannel(i, windowSec, gainVariation));
    }
  }

  pushSample(rawValue: number, timestampMs: number) {
    this.lastTimestamp = timestampMs;
    
    // Alimentar todos los canales con el mismo valor base
    for (const channel of this.channels) {
      channel.pushSample(rawValue, timestampMs);
    }
    
    // DEBUG: Log si hay un salto de tiempo sospechoso
    if (this.lastAnalyzeTimestamp && timestampMs - this.lastAnalyzeTimestamp > 100) {
      console.warn('⚠️ SALTO DE TIEMPO DETECTADO en pushSample:', {
        salto: (timestampMs - this.lastAnalyzeTimestamp) + 'ms',
        timestamp: new Date(timestampMs).toISOString()
      });
    }
  }

  private lastAnalyzeTimestamp: number = 0;
  
  analyzeAll(globalCoverageRatio = 0.0, globalFrameDiff = 0.0): MultiChannelResult {
    // DEBUG: Detectar saltos de tiempo en análisis
    const now = Date.now();
    if (this.lastAnalyzeTimestamp && now - this.lastAnalyzeTimestamp > 100) {
      console.warn('⚠️ SALTO DE TIEMPO EN ANALYZE:', {
        salto: (now - this.lastAnalyzeTimestamp) + 'ms',
        fingerState: this.fingerState,
        timestamp: new Date(now).toISOString()
      });
    }
    this.lastAnalyzeTimestamp = now;
    
    // Suavizados de cobertura y movimiento - más suave para evitar fluctuaciones
    const alphaCov = 0.15; // Reducido de 0.3 para mayor estabilidad
    const alphaMot = 0.15; // Reducido de 0.3 para mayor estabilidad
    this.coverageEma = this.coverageEma == null ? globalCoverageRatio : this.coverageEma * (1 - alphaCov) + globalCoverageRatio * alphaCov;
    this.motionEma = this.motionEma == null ? globalFrameDiff : this.motionEma * (1 - alphaMot) + globalFrameDiff * alphaMot;
    const cov = this.coverageEma;
    const mot = this.motionEma;
    // ELIMINADO: El check de timestamp stale estaba causando pérdidas falsas
    // El sistema ahora confiará en los mecanismos de detección de los canales
    // y no forzará pérdidas basadas solo en timing

    // Analizar todos los canales
    const channelResults: ChannelResult[] = [];
    let detectedChannels = 0;
    let totalQuality = 0;
    let validBPMs: number[] = [];
    
    for (const channel of this.channels) {
      const result = channel.analyze();
      
      if (result.isFingerDetected) {
        detectedChannels++;
        totalQuality += result.quality;
        
        // Recopilar BPMs válidos para agregación
        if (result.bpm && result.bpm >= 50 && result.bpm <= 160 && result.quality >= this.MIN_QUALITY_THRESHOLD) {
          validBPMs.push(result.bpm);
        }
      }
      
      channelResults.push({
        channelId: channel['channelId'],
        calibratedSignal: result.calibratedSignal,
        bpm: result.bpm,
        rrIntervals: result.rrIntervals,
        snr: result.snr,
        quality: result.quality,
        isFingerDetected: result.isFingerDetected,
        gain: result.gain
      } as any);
    }

    // CRITERIOS DE CONSENSO CORREGIDOS Y BALANCEADOS
    const coverageOk = (cov ?? globalCoverageRatio) >= this.MIN_COVERAGE_RATIO;
    const motionOk = (mot ?? globalFrameDiff) <= this.MAX_FRAME_DIFF;
    const consensusOk = detectedChannels >= Math.ceil(this.n * this.MIN_CONSENSUS_RATIO);
    const avgQuality = detectedChannels > 0 ? (totalQuality / detectedChannels) : 0;
    const qualityOk = detectedChannels > 0 && avgQuality >= this.MIN_QUALITY_THRESHOLD;
    const strongDetection = consensusOk && qualityOk && coverageOk && motionOk;
    
    // Condición global mejorada: todos los criterios principales + calidad
    const globalCondition = strongDetection;
    // Condición de pre-detección basada solo en cobertura y movimiento estables
    const preCondition = coverageOk && motionOk;

    // Debug logging cada ~4 segundos con información detallada (aumentado de 2)
    if (Date.now() % 4000 < 100) {
      console.log('🏭 MultiChannelManager Estado Detallado:', {
        detectedChannels: `${detectedChannels}/${this.n}`,
        coverageRatio: (globalCoverageRatio * 100).toFixed(1) + '%',
        frameDiff: globalFrameDiff.toFixed(1),
        avgQuality: detectedChannels > 0 ? (totalQuality / detectedChannels).toFixed(1) : '0',
        validBPMs: validBPMs.length,
        
        // Criterios individuales
        coverageOk: `${coverageOk} (≥${(this.MIN_COVERAGE_RATIO*100).toFixed(0)}%)`,
        motionOk: `${motionOk} (≤${this.MAX_FRAME_DIFF})`,
        consensusOk: `${consensusOk} (≥${Math.ceil(this.n * this.MIN_CONSENSUS_RATIO)})`,
        qualityOk: `${qualityOk} (≥${this.MIN_QUALITY_THRESHOLD})`,
        
        globalCondition,
        fingerState: this.fingerState,
        stableCount: this.fingerStableCount,
        unstableCount: this.fingerUnstableCount
      });
    }

    // Actualizar estado con debounce MEJORADO
    const now2 = Date.now();
    if (globalCondition) {
      this.fingerStableCount++;
      this.fingerUnstableCount = 0;
      
      if (this.fingerStableCount >= this.FRAMES_TO_CONFIRM_FINGER) {
        if (!this.fingerState) {
          console.log('✅ DEDO DETECTADO CONFIRMADO - Estado: FALSE → TRUE');
          console.log('📊 Métricas en el momento de detección:', {
            detectedChannels,
            avgQuality: (totalQuality / Math.max(1, detectedChannels)).toFixed(1),
            coverage: ((cov ?? globalCoverageRatio) * 100).toFixed(1) + '%',
            frameDiff: (mot ?? globalFrameDiff).toFixed(1),
            validBPMs
          });
        }
        this.fingerState = true;
        this.lastGlobalToggle = now2;
      }
    } else if (preCondition) {
      // Pre-detección: cobertura y estabilidad suficientes, aún sin consenso/BPM
      this.fingerStableCount++;
      this.fingerUnstableCount = 0;
      if (this.fingerStableCount >= this.FRAMES_TO_CONFIRM_FINGER + 3) {
        if (!this.fingerState) {
          console.log('✅ DEDO PRESENTE (PRE-DETECCIÓN) - cobertura y estabilidad OK');
        }
        this.fingerState = true;
        this.lastGlobalToggle = now2;
      }
    } else {
      this.fingerUnstableCount++;
      // Solo resetear contador estable si llevamos varios frames inestables
      if (this.fingerUnstableCount > 3) {
        this.fingerStableCount = Math.max(0, this.fingerStableCount - 1);
      }
      
      if (this.fingerUnstableCount >= this.FRAMES_TO_LOSE_FINGER) {
        if (this.fingerState) {
          console.log('❌ DEDO PERDIDO CONFIRMADO - Estado: TRUE → FALSE');
          console.log('📊 Razones de pérdida:', {
            coverageOk,
            motionOk,
            consensusOk,
            qualityOk,
            detectedChannels,
            unstableFrames: this.fingerUnstableCount
          });
        }
        this.fingerState = false;
        this.fingerStableCount = 0;
        this.lastGlobalToggle = now2;
      }
    }

    // Feedback adaptativo INTELIGENTE
    this.applyAdaptiveFeedback(channelResults, globalCondition);

    // Agregación de BPM MEJORADA con análisis estadístico
    const aggregatedBPM = this.aggregateBPMAdvanced(channelResults, validBPMs);
    const aggregatedQuality = this.aggregateQualityAdvanced(channelResults, detectedChannels);

    return {
      timestamp: this.lastTimestamp,
      channels: channelResults,
      aggregatedBPM,
      aggregatedQuality,
      fingerDetected: this.fingerState
    };
  }

  private applyAdaptiveFeedback(results: ChannelResult[], globalCondition: boolean) {
    for (const result of results) {
      const channel = this.channels[result.channelId];
      
      if (result.isFingerDetected && globalCondition) {
        // Si detecta dedo y condición global OK
        if (result.quality < 30) {
          // Calidad baja: aumentar ganancia moderadamente
          channel.adjustGainRel(0.05); // +5%
        } else if (result.quality > 95) {
          // Calidad excesiva: reducir ligeramente para evitar saturación
          channel.adjustGainRel(-0.02); // -2%
        }
        // Si calidad entre 30-95: mantener ganancia
      } else if (!result.isFingerDetected) {
        // Si no detecta dedo
        if (result.gain > 3.0) {
          // Ganancia muy alta sin detección: reducir
          channel.adjustGainRel(-0.08); // -8%
        } else if (result.gain < 0.5 && result.quality > 0) {
          // Ganancia muy baja con algo de señal: aumentar
          channel.adjustGainRel(0.10); // +10%
        }
      }
    }
  }

  private aggregateBPMAdvanced(results: ChannelResult[], validBPMs: number[]): number | null {
    if (validBPMs.length === 0) {
      // Fallback: usar cualquier BPM razonable disponible
      const fallbackBPMs = results
        .filter(r => r.bpm && r.bpm >= 50 && r.bpm <= 160)
        .map(r => r.bpm!);
      
      if (fallbackBPMs.length === 0) return null;
      
      // Promedio simple si no hay BPMs de alta calidad
      return Math.round(fallbackBPMs.reduce((sum, bpm) => sum + bpm, 0) / fallbackBPMs.length);
    }

    // Análisis estadístico avanzado
    if (validBPMs.length === 1) {
      return validBPMs[0];
    }

    // Eliminar outliers usando IQR
    validBPMs.sort((a, b) => a - b);
    const q1Index = Math.floor(validBPMs.length * 0.25);
    const q3Index = Math.floor(validBPMs.length * 0.75);
    const q1 = validBPMs[q1Index];
    const q3 = validBPMs[q3Index];
    const iqr = q3 - q1;
    
    const filtered = validBPMs.filter(bpm => 
      bpm >= (q1 - 1.5 * iqr) && bpm <= (q3 + 1.5 * iqr)
    );

    if (filtered.length === 0) {
      // Si todos son outliers, usar mediana original
      const medianIndex = Math.floor(validBPMs.length / 2);
      return validBPMs[medianIndex];
    }

    // Promedio ponderado por calidad de los canales correspondientes
    const qualityWeightedBPMs = results
      .filter(r => r.isFingerDetected && r.bpm && filtered.includes(r.bpm) && r.quality >= this.MIN_QUALITY_THRESHOLD)
      .map(r => ({ bpm: r.bpm!, quality: r.quality }));

    if (qualityWeightedBPMs.length > 0) {
      const totalQuality = qualityWeightedBPMs.reduce((sum, item) => sum + item.quality, 0);
      const weightedSum = qualityWeightedBPMs.reduce((sum, item) => 
        sum + item.bpm * (item.quality / totalQuality), 0);
      
      return Math.round(weightedSum);
    }

    // Fallback: promedio de filtered
    return Math.round(filtered.reduce((sum, bpm) => sum + bpm, 0) / filtered.length);
  }

  private aggregateQualityAdvanced(results: ChannelResult[], detectedChannels: number): number {
    if (results.length === 0) return 0;
    
    // Calidad base: promedio ponderado
    const totalQuality = results.reduce((sum, r) => sum + r.quality, 0);
    const avgQuality = totalQuality / results.length;
    
    // Bonus por detección múltiple (hasta +20 puntos)
    const detectionBonus = Math.min(20, detectedChannels * 4);
    
    // Bonus por estabilidad de estado (hasta +10 puntos)
    const stabilityBonus = this.fingerState && this.fingerStableCount >= this.FRAMES_TO_CONFIRM_FINGER ? 10 : 0;
    
    // Penalty por inestabilidad (hasta -15 puntos)
    const instabilityPenalty = this.fingerUnstableCount > this.FRAMES_TO_LOSE_FINGER / 2 ? 
      Math.min(15, this.fingerUnstableCount * 2) : 0;
    
    const finalQuality = avgQuality + detectionBonus + stabilityBonus - instabilityPenalty;
    
    return Math.round(Math.min(100, Math.max(0, finalQuality)));
  }

  adjustChannelGain(channelId: number, deltaRel: number) {
    if (channelId >= 0 && channelId < this.channels.length) {
      this.channels[channelId].adjustGainRel(deltaRel);
    }
  }

  getGains() {
    return this.channels.map(ch => ch.getGain());
  }

  reset() {
    console.log('🔄 MultiChannelManager RESET COMPLETO');
    
    this.fingerState = false;
    this.fingerStableCount = 0;
    this.fingerUnstableCount = 0;
    
    // Reset individual channels
    for (const channel of this.channels) {
      channel.setGain(1.0);
    }
  }

  // Método para obtener estadísticas del sistema
  getSystemStats() {
    return {
      fingerState: this.fingerState,
      stableCount: this.fingerStableCount,
      unstableCount: this.fingerUnstableCount,
      channelGains: this.getGains(),
      totalChannels: this.n,
      windowSec: this.windowSec
    };
  }
}
