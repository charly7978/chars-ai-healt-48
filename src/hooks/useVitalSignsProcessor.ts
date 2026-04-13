
import { useState, useCallback, useRef, useEffect } from 'react';
import { VitalSignsProcessor, VitalSignsResult, type RgbSample } from '../modules/vital-signs/VitalSignsProcessor';
import type { MultiChannelOutputs } from '../types/multichannel';

/**
 * HOOK ÚNICO DE SIGNOS VITALES - ELIMINADAS TODAS LAS DUPLICIDADES
 */
export const useVitalSignsProcessor = () => {
  const [processor] = useState(() => new VitalSignsProcessor());
  const [lastValidResults, setLastValidResults] = useState<VitalSignsResult | null>(null);
  const sessionId = useRef<string>((() => {
    const t = Date.now().toString(36);
    const p = (performance.now() | 0).toString(36);
    return `${t}${p}`;
  })());
  const processedSignals = useRef<number>(0);
  
  useEffect(() => {
    console.log("🏥 useVitalSignsProcessor: Sistema ÚNICO inicializado", {
      sessionId: sessionId.current,
      timestamp: new Date().toISOString()
    });
    
    return () => {
      console.log("🏥 useVitalSignsProcessor: Sistema ÚNICO destruido", {
        sessionId: sessionId.current,
        señalesProcesadas: processedSignals.current,
        timestamp: new Date().toISOString()
      });
    };
  }, []);
  
  const startCalibration = useCallback(() => {
    console.log("🔧 useVitalSignsProcessor: Iniciando calibración ÚNICA", {
      timestamp: new Date().toISOString(),
      sessionId: sessionId.current
    });
    
    processor.startCalibration();
  }, [processor]);
  
  const forceCalibrationCompletion = useCallback(() => {
    console.log("⚡ useVitalSignsProcessor: Forzando finalización ÚNICA", {
      timestamp: new Date().toISOString(),
      sessionId: sessionId.current
    });
    
    processor.forceCalibrationCompletion();
  }, [processor]);
  
  const processSignal = useCallback((value: number, rrData?: { intervals: number[], lastPeakTime: number | null }, rgb?: RgbSample) => {
    processedSignals.current++;
    
    console.log("🔬 useVitalSignsProcessor: Procesando señal ÚNICA", {
      valorEntrada: value.toFixed(3),
      rrDataPresente: !!rrData,
      intervalosRR: rrData?.intervals.length || 0,
      señalNúmero: processedSignals.current,
      sessionId: sessionId.current
    });
    
    // Procesamiento ÚNICO sin duplicaciones
    const result = processor.processSignal(value, rrData, rgb);
    
    // Guardar resultados válidos (no negativos, no cero)
    if (result.spo2 > 0 && result.glucose > 0) {
      console.log("✅ useVitalSignsProcessor: Resultado válido ÚNICO", {
        spo2: result.spo2,
        presión: `${result.pressure.systolic}/${result.pressure.diastolic}`,
        glucosa: result.glucose,
        arritmias: result.arrhythmiaCount,
        timestamp: new Date().toISOString()
      });
      
      setLastValidResults(result);
    }
    
    return result;
  }, [processor]);

  const processChannels = useCallback((channels: MultiChannelOutputs, rrData?: { intervals: number[], lastPeakTime: number | null }, rgb?: RgbSample) => {
    processedSignals.current++;
    const result = processor.processChannels(channels, rrData, rgb);
    if (result.spo2 > 0 && result.glucose > 0) {
      setLastValidResults(result);
    }
    return result;
  }, [processor]);

  const reset = useCallback(() => {
    console.log("🔄 useVitalSignsProcessor: Reset ÚNICO", {
      timestamp: new Date().toISOString()
    });
    
    const savedResults = processor.reset();
    if (savedResults) {
      setLastValidResults(savedResults);
    }
    
    return savedResults;
  }, [processor]);
  
  const fullReset = useCallback(() => {
    console.log("🗑️ useVitalSignsProcessor: Reset completo ÚNICO", {
      timestamp: new Date().toISOString()
    });
    
    processor.fullReset();
    setLastValidResults(null);
    processedSignals.current = 0;
  }, [processor]);

  return {
    processSignal,
    processChannels,
    reset,
    fullReset,
    startCalibration,
    forceCalibrationCompletion,
    lastValidResults,
    getCalibrationProgress: useCallback(() => processor.getCalibrationProgress(), [processor]),
    debugInfo: {
      processedSignals: processedSignals.current,
      sessionId: sessionId.current
    },
  };
};
