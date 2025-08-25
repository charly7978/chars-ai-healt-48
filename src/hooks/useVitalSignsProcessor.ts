
import { useState, useCallback, useRef, useEffect } from 'react';
import { VitalSignsProcessor, VitalSignsResult } from '../modules/vital-signs/VitalSignsProcessor';

/**
 * HOOK ÚNICO DE SIGNOS VITALES - ELIMINADAS TODAS LAS DUPLICIDADES
 */
export const useVitalSignsProcessor = () => {
  const [processor] = useState(() => new VitalSignsProcessor());
  const [lastValidResults, setLastValidResults] = useState<VitalSignsResult | null>(null);
  const sessionId = useRef<string>((() => {
    const randomBytes = new Uint32Array(2);
    crypto.getRandomValues(randomBytes);
    return randomBytes[0].toString(36) + randomBytes[1].toString(36);
  })());
  const processedSignals = useRef<number>(0);
  
  useEffect(() => {
    // Sistema inicializado
    
    return () => {
      // Sistema destruido
    };
  }, []);
  
  const startCalibration = useCallback(() => {
    // Iniciando calibración
    
    processor.startCalibration();
  }, [processor]);
  
  const forceCalibrationCompletion = useCallback(() => {
    // Forzando finalización
    
    processor.forceCalibrationCompletion();
  }, [processor]);
  
  const processSignal = useCallback((value: number, rrData?: { intervals: number[], lastPeakTime: number | null }) => {
    processedSignals.current++;
    
    // Log reducido - solo cada 1000 señales
    if (processedSignals.current % 1000 === 0) {
      console.log("🔬 Procesando señal:", processedSignals.current);
    }
    
    // Procesamiento ÚNICO sin duplicaciones
    const result = processor.processSignal(value, rrData);
    
    // Guardar resultados válidos (no negativos, no cero)
    if (result.spo2 > 0 && result.glucose > 0) {
      // Log eliminado para mejorar rendimiento
      
      setLastValidResults(result);
    }
    
    return result;
  }, [processor]);

  const reset = useCallback(() => {
    // Reset del procesador
    
    const savedResults = processor.reset();
    if (savedResults) {
      setLastValidResults(savedResults);
    }
    
    return savedResults;
  }, [processor]);
  
  const fullReset = useCallback(() => {
    // Reset completo
    
    processor.fullReset();
    setLastValidResults(null);
    processedSignals.current = 0;
  }, [processor]);

  return {
    processSignal,
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
