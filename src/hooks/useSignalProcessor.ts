
import { useMemo, useRef, useState } from 'react';
import MultiChannelManager from '@/modules/signal-processing/MultiChannelManager';
import { CameraSample, MultiChannelResult } from '@/types';

/**
 * Hook CORREGIDO que maneja el flujo completo CameraView -> MultiChannelManager
 * ARREGLADO: Transporte correcto de valores, escalado adecuado, logging detallado
 */

export function useSignalProcessor(windowSec = 8, channels = 6) {
  const mgrRef = useRef<MultiChannelManager | null>(null);
  const [lastResult, setLastResult] = useState<MultiChannelResult | null>(null);
  const sampleCountRef = useRef(0);
  // Estado para preprocesamiento real por canal (R/G)
  const dcRedRef = useRef(0);
  const dcGreenRef = useRef(0);
  const lastAcRef = useRef(0);

  if (!mgrRef.current) {
    mgrRef.current = new MultiChannelManager(channels, windowSec);
    console.log('🏭 MultiChannelManager CREADO:', { channels, windowSec });
  }

  const handleSample = (s: CameraSample) => {
    sampleCountRef.current++;
    // Protección contra muestras inválidas o NaN
    if (!isFinite(s.rMean) || !isFinite(s.gMean) || !isFinite(s.bMean)) {
      return;
    }
    
    // Preprocesamiento: DC removal por canal y combinación adaptativa R/G
    const alpha = 0.97; // constante de tiempo ~1s
    dcRedRef.current = alpha * dcRedRef.current + (1 - alpha) * s.rMean;
    dcGreenRef.current = alpha * dcGreenRef.current + (1 - alpha) * s.gMean;
    let acR = s.rMean - dcRedRef.current;
    let acG = s.gMean - dcGreenRef.current;
    // Limitar derivada para suprimir artefactos bruscos por movimiento
    const maxDelta = Math.max(1.5, (s.brightnessStd ?? 6) * 0.8);
    const delta = (acR + acG) * 0.5 - lastAcRef.current;
    if (Math.abs(delta) > maxDelta) {
      const sign = delta > 0 ? 1 : -1;
      const clamped = lastAcRef.current + sign * maxDelta;
      const adjust = clamped - ((acR + acG) * 0.5);
      acR += adjust;
      acG += adjust;
    }
    lastAcRef.current = (acR + acG) * 0.5;

    // Ponderación por calidad (cobertura, movimiento, ratio piel, saturación)
    const coverage = s.coverageRatio ?? 0;
    const motion = s.frameDiff ?? 0;
    const rgRatio = s.rgRatio ?? (s.gMean > 1 ? s.rMean / s.gMean : 2);
    const saturation = s.saturationRatio ?? 0;
    const coverageW = Math.max(0, Math.min(1, (coverage - 0.12) / 0.28));
    const motionW = 1 / (1 + 0.6 * motion);
    const skinW = Math.max(0, Math.min(1, (rgRatio - 1.0) / 2.5));
    const satW = Math.max(0, 1 - saturation * 1.6);
    // R: favorecer cuando rojo domina y no satura; G: fallback con menor penalización por saturación
    const qR = coverageW * motionW * skinW * satW;
    const qG = coverageW * motionW * Math.max(0.4, 1 - Math.abs(rgRatio - 0.9));
    const denom = Math.max(1e-3, qR + qG);
    const inputSignal = (qR * acR + qG * acG) / denom;
    
    // Log detallado cada 150 muestras para debug (reducido de 30)
    if (sampleCountRef.current % 150 === 0) {
      console.log('📊 useSignalProcessor - Muestra #' + sampleCountRef.current + ':', {
        timestamp: new Date(s.timestamp).toLocaleTimeString(),
        inputSignal: inputSignal.toFixed(2),
        rMean: s.rMean.toFixed(1),
        gMean: s.gMean.toFixed(1),
        bMean: s.bMean.toFixed(1),
        rStd: s.rStd.toFixed(1),
        coverageRatio: (s.coverageRatio * 100).toFixed(1) + '%',
        frameDiff: s.frameDiff.toFixed(1),
        brightnessMean: s.brightnessMean.toFixed(1)
      });
    }

    // CRÍTICO: Enviar muestra al MultiChannelManager
    mgrRef.current!.pushSample(inputSignal, s.timestamp);
    
    // CRÍTICO: Analizar con métricas globales correctas
    // Ajuste de cobertura y movimiento usando métricas adicionales
    const adjustedCoverage = Math.min(1,
      s.coverageRatio *
      (s.redFraction > 0.42 && s.rgRatio > 1.1 && s.rgRatio < 4.0 ? 1.2 : 0.8) *
      (s.saturationRatio < 0.15 ? 1.0 : 0.7)
    );
    const adjustedMotion = s.frameDiff + (s.brightnessStd > 8 ? 6 : 0);
    const result = mgrRef.current!.analyzeAll(adjustedCoverage, adjustedMotion);
    
    // Log resultado cada 150 muestras o cuando hay detección (reducido de 50)
    if (result.fingerDetected || sampleCountRef.current % 150 === 0) {
      const activeChannels = result.channels.filter(c => c.isFingerDetected).length;
      const bestChannel = result.channels.reduce((best, current) => 
        current.quality > best.quality ? current : best, result.channels[0]);
      
      console.log('🔍 useSignalProcessor - Resultado:', {
        fingerDetected: result.fingerDetected,
        aggregatedBPM: result.aggregatedBPM,
        aggregatedQuality: result.aggregatedQuality,
        activeChannels: `${activeChannels}/${result.channels.length}`,
        bestChannelId: bestChannel.channelId,
        bestChannelQuality: bestChannel.quality.toFixed(1),
        bestChannelSNR: bestChannel.snr.toFixed(2),
        bestChannelBPM: bestChannel.bpm || 'null'
      });
    }
    
    setLastResult(result);
  };

  const adjustChannelGain = (channelId: number, deltaRel: number) => {
    if (!mgrRef.current) return;
    
    console.log(`🔧 Ajustando ganancia canal ${channelId}: ${deltaRel > 0 ? '+' : ''}${(deltaRel * 100).toFixed(1)}%`);
    
    mgrRef.current.adjustChannelGain(channelId, deltaRel);
    
    // Re-analizar después del ajuste
    const result = mgrRef.current.analyzeAll(0, 0);
    setLastResult(result);
  };

  const reset = () => {
    if (!mgrRef.current) return;
    
    console.log('🔄 useSignalProcessor - RESET completo');
    mgrRef.current.reset();
    setLastResult(null);
    sampleCountRef.current = 0;
  };

  const getStats = () => {
    if (!lastResult) return null;
    
    const activeChannels = lastResult.channels.filter(c => c.isFingerDetected).length;
    const avgSNR = lastResult.channels.reduce((sum, c) => sum + c.snr, 0) / lastResult.channels.length;
    const avgQuality = lastResult.channels.reduce((sum, c) => sum + c.quality, 0) / lastResult.channels.length;
    
    return {
      totalSamples: sampleCountRef.current,
      activeChannels,
      totalChannels: lastResult.channels.length,
      avgSNR: avgSNR.toFixed(2),
      avgQuality: avgQuality.toFixed(1),
      fingerDetected: lastResult.fingerDetected,
      aggregatedBPM: lastResult.aggregatedBPM
    };
  };

  return useMemo(() => ({ 
    handleSample, 
    lastResult, 
    adjustChannelGain,
    reset,
    getStats
  }), [lastResult]);
}
