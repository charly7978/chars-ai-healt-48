
import { useState, useEffect, useCallback, useRef } from 'react';
import { PPGSignalProcessor } from '../modules/signal-processing/PPGSignalProcessor';
import { ProcessedSignal, ProcessingError } from '../types/signal';

/**
 * HOOK ÚNICO Y DEFINITIVO - ELIMINADAS TODAS LAS DUPLICIDADES
 * Sistema completamente unificado con prevención absoluta de múltiples instancias
 */
export const useSignalProcessor = () => {
  const processorRef = useRef<PPGSignalProcessor | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastSignal, setLastSignal] = useState<ProcessedSignal | null>(null);
  const [error, setError] = useState<ProcessingError | null>(null);
  const [framesProcessed, setFramesProcessed] = useState(0);
  
  // CONTROL ÚNICO DE INSTANCIA - PREVENIR DUPLICIDADES ABSOLUTAMENTE
  const instanceLock = useRef<boolean>(false);
  const sessionIdRef = useRef<string>("");
  const initializationState = useRef<'IDLE' | 'INITIALIZING' | 'READY' | 'ERROR'>('IDLE');
  
  // INICIALIZACIÓN ÚNICA Y DEFINITIVA
  useEffect(() => {
    // BLOQUEO DE MÚLTIPLES INSTANCIAS
    if (instanceLock.current || initializationState.current !== 'IDLE') {
      return;
    }
    
    instanceLock.current = true;
    initializationState.current = 'INITIALIZING';
    
    // SESSION ID ÚNICO
    const t = Date.now().toString(36);
    const p = (performance.now() | 0).toString(36);
    sessionIdRef.current = `unified_${t}_${p}`;

    console.log(`🔬 INICIALIZACIÓN ÚNICA Y DEFINITIVA - ${sessionIdRef.current}`);

    // CALLBACKS ÚNICOS SIN MEMORY LEAKS
    const onSignalReady = (signal: ProcessedSignal) => {
      // DEBUG: Log cada señal importante
      if (signal.quality > 0 || signal.fingerDetected) {
        console.log(`📡 Signal recibido: quality=${signal.quality}, finger=${signal.fingerDetected}, initState=${initializationState.current}`);
      }
      
      // CORREGIDO: Siempre procesar señales válidas, no bloquear por initState
      // El initState es solo para control de setup, no para filtrar datos
      if (initializationState.current === 'ERROR') {
        console.warn(`⚠️ Ignorando señal - initState=ERROR`);
        return;
      }
      
      setLastSignal(signal);
      setError(null);
      setFramesProcessed(prev => prev + 1);
    };

    const onError = (error: ProcessingError) => {
      console.error(`❌ Error procesador único: ${error.code} - ${error.message} - ${sessionIdRef.current}`);
      setError(error);
    };

    // CREAR PROCESADOR ÚNICO
    try {
      processorRef.current = new PPGSignalProcessor(onSignalReady, onError);
      initializationState.current = 'READY';
      console.log(`✅ Procesador único inicializado - ${sessionIdRef.current}`);
    } catch (err) {
      console.error(`❌ Error creando procesador: ${err} - ${sessionIdRef.current}`);
      initializationState.current = 'ERROR';
      instanceLock.current = false;
    }
    
    return () => {
      console.log(`🔬 DESTRUYENDO PROCESADOR ÚNICO - ${sessionIdRef.current}`);
      if (processorRef.current) {
        processorRef.current.stop();
        processorRef.current = null;
      }
      initializationState.current = 'IDLE';
      instanceLock.current = false;
    };
  }, []);

  // INICIO ÚNICO SIN DUPLICIDADES
  const startProcessing = useCallback(() => {
    console.log(`🔍 START CHECK: processor=${!!processorRef.current}, initState=${initializationState.current}, isProcessing=${isProcessing}`);
    
    if (!processorRef.current || initializationState.current !== 'READY') {
      console.warn(`⚠️ Procesador no listo - Estado: ${initializationState.current}, processor=${!!processorRef.current} - ${sessionIdRef.current}`);
      return;
    }

    if (isProcessing) {
      console.warn(`⚠️ Ya procesando - ${sessionIdRef.current}`);
      return;
    }

    console.log(`🚀 INICIO ÚNICO DEFINITIVO - ${sessionIdRef.current}`);
    
    setIsProcessing(true);
    setFramesProcessed(0);
    setError(null);
    
    processorRef.current.start();
    
    console.log(`✅ Procesamiento único iniciado - ${sessionIdRef.current}`);
  }, [isProcessing]);

  // PARADA ÚNICA Y LIMPIA
  const stopProcessing = useCallback(() => {
    if (!processorRef.current || !isProcessing) {
      return;
    }

    console.log(`🛑 PARADA ÚNICA - ${sessionIdRef.current}`);
    
    setIsProcessing(false);
    processorRef.current.stop();
    
    console.log(`✅ Procesamiento detenido - ${sessionIdRef.current}`);
  }, [isProcessing]);

  // CALIBRACIÓN ÚNICA
  const calibrate = useCallback(async () => {
    if (!processorRef.current || initializationState.current !== 'READY') {
      return false;
    }

    try {
      console.log(`🎯 CALIBRACIÓN ÚNICA - ${sessionIdRef.current}`);
      const success = await processorRef.current.calibrate();
      return success;
    } catch (error) {
      console.error(`❌ Error calibración: ${error} - ${sessionIdRef.current}`);
      return false;
    }
  }, []);

  // PROCESAMIENTO DE FRAME ÚNICO
  const processFrame = useCallback((imageData: ImageData) => {
    if (!processorRef.current || initializationState.current !== 'READY' || !isProcessing) {
      // DEBUG: Log por qué no se procesa
      if (Math.floor(performance.now()) % 500 < 50) {
        console.log(`⏸️ Frame skip: processor=${!!processorRef.current}, initState=${initializationState.current}, isProcessing=${isProcessing}`);
      }
      return;
    }
    
    try {
      processorRef.current.processFrame(imageData);
    } catch (error) {
      console.error(`❌ Error procesando frame: ${error} - ${sessionIdRef.current}`);
    }
  }, [isProcessing]);

  return {
    isProcessing,
    lastSignal,
    error,
    framesProcessed,
    startProcessing,
    stopProcessing,
    calibrate,
    processFrame,
    debugInfo: {
      sessionId: sessionIdRef.current,
      initializationState: initializationState.current,
      instanceLocked: instanceLock.current
    }
  };
};
