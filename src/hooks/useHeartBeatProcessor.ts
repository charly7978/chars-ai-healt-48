import { useState, useEffect, useCallback, useRef } from 'react';
import { HeartBeatProcessor } from '../modules/HeartBeatProcessor';
import type { HeartBeatProcessInputFull, HeartBeatProcessOutput } from '../modules/heartbeat/types';
import type { ProcessedSignal } from '../types/signal';

export interface HeartBeatResult extends HeartBeatProcessOutput {
  arrhythmiaCount: number;
  signalQuality: number;
}

function buildHbInputFromProcessed(signal: ProcessedSignal): HeartBeatProcessInputFull {
  return {
    filteredValue: signal.filteredValue,
    rawValue: signal.rawValue,
    timestamp: signal.timestamp,
    upstreamSqi: signal.quality,
    contactState: signal.contactState,
    fingerDetected: signal.fingerDetected,
    perfusionIndex: signal.perfusionIndex,
    pressureState: signal.pressureState,
    clipHighRatio: signal.clipHighRatio,
    clipLowRatio: signal.clipLowRatio,
    activeSource: signal.activeSource,
    motionArtifact: signal.motionArtifact,
    positionDrifting: signal.positionDrifting,
    maskStability: signal.maskStability,
  };
}

/**
 * Procesamiento cardíaco: delega en HeartBeatProcessor (fusión BPM y SQI por latido separados).
 */
export const useHeartBeatProcessor = () => {
  const processorRef = useRef<HeartBeatProcessor | null>(null);
  const [signalQuality, setSignalQuality] = useState<number>(0);
  const [lastRich, setLastRich] = useState<HeartBeatProcessOutput | null>(null);

  const sessionIdRef = useRef<string>('');
  const processingStateRef = useRef<'IDLE' | 'ACTIVE' | 'RESETTING'>('IDLE');
  const processedSignalsRef = useRef<number>(0);

  useEffect(() => {
    const t = Date.now().toString(36);
    const p = (performance.now() | 0).toString(36);
    sessionIdRef.current = `heartbeat_${t}_${p}`;

    const proc = new HeartBeatProcessor();
    processorRef.current = proc;
    processingStateRef.current = 'ACTIVE';
    if (typeof window !== 'undefined') {
      window.heartBeatProcessor = proc;
    }

    return () => {
      if (typeof window !== 'undefined') {
        delete (window as unknown as { heartBeatProcessor?: HeartBeatProcessor }).heartBeatProcessor;
      }
      processorRef.current = null;
      processingStateRef.current = 'IDLE';
    };
  }, []);

  /**
   * Forma recomendada: `processSignal(lastSignal)` con `ProcessedSignal` completo.
   * Compatibilidad: `processSignal(value, fingerDetected, timestamp)`.
   */
  const processSignal = useCallback(
    (
      signalOrValue: ProcessedSignal | number,
      fingerDetected: boolean = true,
      timestamp?: number
    ): HeartBeatResult => {
      if (!processorRef.current || processingStateRef.current !== 'ACTIVE') {
        const proc = processorRef.current;
        const fb = proc?.getSmoothBPM() ?? 0;
        return {
          bpm: fb,
          bpmConfidence: 0,
          confidence: 0,
          isPeak: false,
          filteredValue: typeof signalOrValue === 'number' ? signalOrValue : signalOrValue.filteredValue,
          sqi: 0,
          beatSQI: null,
          arrhythmiaCount: 0,
          signalQuality: 0,
          rrData: { intervals: [], lastPeakTime: null, lastIbiMs: null },
          activeHypothesis: 'medianIbi',
          detectorAgreement: 0,
          rejectionReason: 'none',
          beatFlags: [],
          lastAcceptedBeat: null,
          debug: {} as HeartBeatProcessOutput['debug'],
        };
      }

      processedSignalsRef.current++;

      let result: HeartBeatResult;

      if (typeof signalOrValue === 'object' && signalOrValue !== null && 'filteredValue' in signalOrValue) {
        const input = buildHbInputFromProcessed(signalOrValue);
        result = processorRef.current.processSignal(input) as HeartBeatResult;
      } else {
        result = processorRef.current.processSignal(
          signalOrValue as number,
          fingerDetected,
          timestamp
        ) as HeartBeatResult;
      }

      setLastRich(result);
      setSignalQuality(result.sqi ?? 0);

      if (processedSignalsRef.current % 120 === 0) {
        console.log('[HB]', result.bpm, 'bpmConf', result.bpmConfidence?.toFixed(2), 'beatSQI', result.beatSQI);
      }

      return {
        ...result,
        signalQuality: result.sqi ?? 0,
      };
    },
    []
  );

  const reset = useCallback(() => {
    if (processingStateRef.current === 'RESETTING') return;
    processingStateRef.current = 'RESETTING';
    processorRef.current?.reset();
    setSignalQuality(0);
    setLastRich(null);
    processedSignalsRef.current = 0;
    processingStateRef.current = 'ACTIVE';
  }, []);

  const setArrhythmiaState = useCallback((isArrhythmiaDetected: boolean) => {
    processorRef.current?.setArrhythmiaDetected(isArrhythmiaDetected);
  }, []);

  return {
    currentBPM: lastRich?.bpm ?? 0,
    confidence: lastRich?.bpmConfidence ?? 0,
    signalQuality,
    processSignal,
    reset,
    setArrhythmiaState,
    lastHeartBeatOutput: lastRich,
    debugInfo: {
      sessionId: sessionIdRef.current,
      processingState: processingStateRef.current,
      processedSignals: processedSignalsRef.current,
    },
  };
};
