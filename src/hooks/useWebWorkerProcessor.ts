/**
 * Hook para gestionar el procesamiento de señales en Web Worker
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { logDebug, logError } from '@/utils/performance-logger';

interface WorkerResult {
  bpm: number | null;
  quality: number;
  snr: number;
  peaks: number[];
  rrIntervals: number[];
}

export function useWebWorkerProcessor() {
  const workerRef = useRef<Worker | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [lastResult, setLastResult] = useState<WorkerResult | null>(null);
  const pendingCallbackRef = useRef<((result: WorkerResult) => void) | null>(null);

  useEffect(() => {
    // Crear worker
    try {
      workerRef.current = new Worker(
        new URL('../workers/signal-processor.worker.ts', import.meta.url),
        { type: 'module' }
      );

      workerRef.current.onmessage = (event) => {
        if (event.data.type === 'SIGNAL_PROCESSED') {
          const result = event.data.data;
          setLastResult(result);
          
          if (pendingCallbackRef.current) {
            pendingCallbackRef.current(result);
            pendingCallbackRef.current = null;
          }
        } else if (event.data.type === 'ERROR') {
          logError('Worker error:', event.data.data.error);
        }
      };

      workerRef.current.onerror = (error) => {
        logError('Worker error:', error);
      };

      setIsReady(true);
      logDebug('Web Worker de procesamiento inicializado');
    } catch (error) {
      logError('Error creando Web Worker:', error);
    }

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      setIsReady(false);
    };
  }, []);

  const processSignal = useCallback((
    samples: number[],
    sampleRate: number,
    callback?: (result: WorkerResult) => void
  ) => {
    if (!workerRef.current || !isReady) {
      logError('Worker no está listo');
      return;
    }

    if (callback) {
      pendingCallbackRef.current = callback;
    }

    workerRef.current.postMessage({
      type: 'PROCESS_SIGNAL',
      data: {
        samples,
        sampleRate,
        windowSize: samples.length
      }
    });
  }, [isReady]);

  return {
    processSignal,
    lastResult,
    isReady
  };
}