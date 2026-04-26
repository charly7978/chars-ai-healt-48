import React, { useState, useRef, useEffect } from "react";
import VitalSign from "@/components/VitalSign";
import CameraView, { CameraDiagnostics, CameraViewRef } from "@/components/CameraView";
import { useSignalProcessor } from "@/hooks/useSignalProcessor";
import { useHeartBeatProcessor } from "@/hooks/useHeartBeatProcessor";
import { useVitalSignsProcessor } from "@/hooks/useVitalSignsProcessor";
import { useMultiChannelOptimizer } from "@/hooks/useMultiChannelOptimizer";
import PPGSignalMeter from "@/components/PPGSignalMeter";
import MonitorButton from "@/components/MonitorButton";
import { VitalSignsResult } from "@/modules/vital-signs/VitalSignsProcessor";
import { toast } from "@/components/ui/use-toast";
import { PPGDiagnostics } from "@/modules/signal-processing/PPGSignalProcessor";
import { FrameCaptureEngine, CapturedFrame } from "@/modules/capture/FrameCaptureEngine";

const Index = () => {
  // ═══ STATE ═══
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [signalQuality, setSignalQuality] = useState(0);
  const [vitalSigns, setVitalSigns] = useState<VitalSignsResult>({
    spo2: Number.NaN as unknown as number,
    glucose: 0, hemoglobin: 0,
    pressure: { systolic: 0, diastolic: 0 },
    arrhythmiaCount: 0, arrhythmiaStatus: "SIN ARRITMIAS|0",
    lipids: { totalCholesterol: 0, triglycerides: 0 },
    isCalibrating: false, calibrationProgress: 0,
    lastArrhythmiaData: undefined
  });
  const [heartRate, setHeartRate] = useState(0);
  const [heartbeatSignal, setHeartbeatSignal] = useState(0);
  const [beatMarker, setBeatMarker] = useState(0);
  const [arrhythmiaCount, setArrhythmiaCount] = useState<string | number>("--");
  const [elapsedTime, setElapsedTime] = useState(0);
  const [showResults, setShowResults] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [rrIntervals, setRRIntervals] = useState<number[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [cameraDiag, setCameraDiag] = useState<CameraDiagnostics | null>(null);
  const [arrhythmiaDetected, setArrhythmiaDetected] = useState(false);

  // ═══ REFS ═══
  const measurementTimerRef = useRef<number | null>(null);
  const arrhythmiaDetectedRef = useRef(false);
  const lastArrhythmiaData = useRef<{ timestamp: number; rmssd: number; rrVariation: number } | null>(null);
  const systemState = useRef<'IDLE' | 'STARTING' | 'ACTIVE' | 'STOPPING' | 'CALIBRATING'>('IDLE');
  const sessionIdRef = useRef("");
  const initializationLock = useRef(false);
  const cameraViewRef = useRef<CameraViewRef>(null);
  const frameCaptureEngineRef = useRef<FrameCaptureEngine | null>(null);
  const prevFrameRgbRef = useRef<{ r: number; g: number; b: number } | null>(null);

  // Frame timing
  const frameTimingRef = useRef({
    lastCaptureTime: 0,
    realFps: 0,
    droppedFrames: 0,
    frameCount: 0,
    avgProcessingMs: 0
  });

  // ═══ HOOKS ═══
  const { 
    startProcessing, stopProcessing, lastSignal, processFrame, 
    isProcessing, framesProcessed, debugInfo: signalDebugInfo,
    diagnostics: ppgDiagnostics
  } = useSignalProcessor();
  
  const { 
    processSignal: processHeartBeat, setArrhythmiaState,
    reset: resetHeartBeat, debugInfo: heartDebugInfo,
    lastHeartBeatOutput, arrhythmiaResult, heartDiagnostics
  } = useHeartBeatProcessor();
  
  const { 
    processSignal: processVitalSigns, processChannels: processVitalChannels,
    reset: resetVitalSigns, fullReset: fullResetVitalSigns,
    lastValidResults, startCalibration, forceCalibrationCompletion,
    getCalibrationProgress
  } = useVitalSignsProcessor();

  const { pushRawSample, compute, pushFeedback, reset: resetOptimizer } = useMultiChannelOptimizer();

  // ═══ INIT ═══
  useEffect(() => {
    if (initializationLock.current) return;
    initializationLock.current = true;
    sessionIdRef.current = `main_${Date.now().toString(36)}`;
    
    // Initialize frame capture engine
    frameCaptureEngineRef.current = new FrameCaptureEngine({
      analysisWidth: 320,
      analysisHeight: 240,
      maxProcessingMs: 16
    });
    
    return () => { 
      initializationLock.current = false;
      frameCaptureEngineRef.current?.stop();
    };
  }, []);

  // Fullscreen
  const enterFullScreen = async () => {
    if (isFullscreen) return;
    try {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) await docEl.requestFullscreen();
      else if ((docEl as any).webkitRequestFullscreen) await (docEl as any).webkitRequestFullscreen();
      if (screen.orientation?.lock) await screen.orientation.lock('portrait').catch(() => {});
      setIsFullscreen(true);
    } catch {}
  };
  
  const exitFullScreen = () => {
    if (!isFullscreen) return;
    try {
      if (document.exitFullscreen) document.exitFullscreen();
      else if ((document as any).webkitExitFullscreen) (document as any).webkitExitFullscreen();
      screen.orientation?.unlock();
      setIsFullscreen(false);
    } catch {}
  };

  useEffect(() => {
    const timer = setTimeout(() => enterFullScreen(), 1000);
    const handler = () => setIsFullscreen(Boolean(document.fullscreenElement || (document as any).webkitFullscreenElement));
    document.addEventListener('fullscreenchange', handler);
    document.addEventListener('webkitfullscreenchange', handler);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('fullscreenchange', handler);
      document.removeEventListener('webkitfullscreenchange', handler);
      exitFullScreen();
    };
  }, []);

  // Prevent scroll
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    document.body.addEventListener('touchmove', prevent, { passive: false });
    document.body.addEventListener('scroll', prevent, { passive: false });
    return () => {
      document.body.removeEventListener('touchmove', prevent);
      document.body.removeEventListener('scroll', prevent);
    };
  }, []);

  // Sync results
  useEffect(() => {
    if (lastValidResults && !isMonitoring) {
      setVitalSigns(lastValidResults);
      setShowResults(true);
    }
  }, [lastValidResults, isMonitoring]);

  // ═══ START ═══
  const startMonitoring = () => {
    if (systemState.current !== 'IDLE') return;
    systemState.current = 'STARTING';

    if (navigator.vibrate) navigator.vibrate([200]);
    enterFullScreen();
    setIsMonitoring(true);
    setIsCameraOn(true);
    setShowResults(false);
    startProcessing();
    setElapsedTime(0);
    setVitalSigns(prev => ({ ...prev, arrhythmiaStatus: "SIN ARRITMIAS|0" }));
    startAutoCalibration();

    if (measurementTimerRef.current) clearInterval(measurementTimerRef.current);
    measurementTimerRef.current = window.setInterval(() => {
      setElapsedTime(prev => {
        if (prev + 1 >= 30) { finalizeMeasurement(); return 30; }
        return prev + 1;
      });
    }, 1000);

    systemState.current = 'ACTIVE';
  };

  const startAutoCalibration = () => {
    if (isCalibrating || systemState.current === 'CALIBRATING') return;
    systemState.current = 'CALIBRATING';
    setIsCalibrating(true);
    startCalibration();
    setTimeout(() => {
      if (systemState.current === 'CALIBRATING') systemState.current = 'ACTIVE';
    }, 3000);
  };

  // ═══ STOP ═══
  const finalizeMeasurement = () => {
    if (systemState.current === 'STOPPING' || systemState.current === 'IDLE') return;
    systemState.current = 'STOPPING';

    if (isCalibrating) forceCalibrationCompletion();
    setIsMonitoring(false);
    setIsCameraOn(false);
    setIsCalibrating(false);
    stopProcessing();

    // Stop frame capture engine
    frameCaptureEngineRef.current?.stop();

    if (measurementTimerRef.current) {
      clearInterval(measurementTimerRef.current);
      measurementTimerRef.current = null;
    }

    const saved = resetVitalSigns();
    if (saved) { setVitalSigns(saved); setShowResults(true); }

    setElapsedTime(0);
    setSignalQuality(0);
    setCalibrationProgress(0);
    systemState.current = 'IDLE';
  };

  const handleReset = () => {
    systemState.current = 'STOPPING';
    setIsMonitoring(false);
    setIsCameraOn(false);
    setShowResults(false);
    setIsCalibrating(false);
    stopProcessing();
    frameCaptureEngineRef.current?.stop();
    if (measurementTimerRef.current) {
      clearInterval(measurementTimerRef.current);
      measurementTimerRef.current = null;
    }
    fullResetVitalSigns();
    resetHeartBeat();
    setElapsedTime(0);
    setHeartRate(0);
    setHeartbeatSignal(0);
    setBeatMarker(0);
    setVitalSigns({
      spo2: Number.NaN as unknown as number,
      glucose: 0, hemoglobin: 0,
      pressure: { systolic: 0, diastolic: 0 },
      arrhythmiaCount: 0, arrhythmiaStatus: "SIN ARRITMIAS|0",
      lipids: { totalCholesterol: 0, triglycerides: 0 },
      isCalibrating: false, calibrationProgress: 0,
      lastArrhythmiaData: undefined
    });
    setArrhythmiaCount("--");
    setSignalQuality(0);
    lastArrhythmiaData.current = null;
    setCalibrationProgress(0);
    arrhythmiaDetectedRef.current = false;
    setArrhythmiaDetected(false);
    systemState.current = 'IDLE';
  };

  // ═══ STREAM READY — Setup FrameCaptureEngine with video ref ═══
  const handleStreamReady = (stream: MediaStream) => {
    if (!isMonitoring || systemState.current !== 'ACTIVE') return;

    // Get video element from CameraView ref
    const videoElement = cameraViewRef.current?.videoRef.current;
    if (!videoElement) {
      console.error('CameraView videoRef not available');
      return;
    }

    // Attach video to capture engine
    frameCaptureEngineRef.current?.attachVideo(videoElement);

    // Start frame capture
    frameCaptureEngineRef.current?.start((capturedFrame: CapturedFrame) => {
      if (!isMonitoring || systemState.current !== 'ACTIVE') return;

      // Update timing stats
      frameTimingRef.current = capturedFrame.timing;

      // Process frame through signal processor
      processFrame(capturedFrame.imageData);
    });
  };

  // ═══ SIGNAL PROCESSING ═══
  useEffect(() => {
    if (!lastSignal) return;
    setSignalQuality(lastSignal.quality);
    if (!isMonitoring || systemState.current !== 'ACTIVE') return;

    const MIN_SQ = 15;
    if (!lastSignal.fingerDetected || lastSignal.quality < MIN_SQ) {
      if (lastSignal.quality >= 10) {
        const r = processHeartBeat({
          ...lastSignal,
          filteredValue: lastSignal.filteredValue * 0.5,
          fingerDetected: false,
        });
        setHeartRate(r.bpm * 0.8);
        setHeartbeatSignal(lastSignal.filteredValue * 0.7);
        setBeatMarker(r.isPeak ? 0.5 : 0);
      } else {
        setHeartRate(0); setHeartbeatSignal(0); setBeatMarker(0);
      }
      pushRawSample(lastSignal.timestamp, lastSignal.filteredValue * 0.5, lastSignal.quality);
      return;
    }

    const hb = processHeartBeat(lastSignal);
    setHeartRate(hb.bpm);
    setHeartbeatSignal(lastSignal.filteredValue);
    setBeatMarker(hb.isPeak ? 1 : 0);
    if (hb.rrData?.intervals) setRRIntervals(hb.rrData.intervals.slice(-5));

    pushRawSample(lastSignal.timestamp, lastSignal.filteredValue, lastSignal.quality);
    const channelOutputs = compute();

    if (channelOutputs) {
      const channels: Array<'heart' | 'spo2' | 'bloodPressure' | 'hemoglobin' | 'glucose' | 'lipids'> = ['heart','spo2','bloodPressure','hemoglobin','glucose','lipids'];
      channels.forEach(ch => {
        const out = channelOutputs[ch];
        if (out && out.quality < 55) {
          pushFeedback(ch, out.feedback || { desiredGain: 1.05, confidence: 0.3 });
        }
      });
    }

    const rgb = lastSignal.rgbRaw;
    const vitals = channelOutputs
      ? processVitalChannels(channelOutputs, hb.rrData, rgb)
      : processVitalSigns(lastSignal.filteredValue, hb.rrData, rgb);

    if (vitals) {
      setVitalSigns(vitals);
      if (vitals.lastArrhythmiaData) {
        lastArrhythmiaData.current = vitals.lastArrhythmiaData;
        const [status, count] = vitals.arrhythmiaStatus.split('|');
        setArrhythmiaCount(count || "0");
        const isArr = status === "ARRITMIA DETECTADA";
        if (isArr !== arrhythmiaDetectedRef.current) {
          arrhythmiaDetectedRef.current = isArr;
          setArrhythmiaState(isArr);
          if (isArr) {
            toast({ title: "¡Arritmia detectada!", description: "Latido irregular.", variant: "destructive", duration: 3000 });
          }
        }
      }
    }

    // Update diagnostics from processor (access via the processor ref in useSignalProcessor)
    // We'll read it from the lastSignal quality as proxy for now
  }, [lastSignal, isMonitoring, processHeartBeat, processVitalSigns, processVitalChannels, setArrhythmiaState]);

  // Calibration
  useEffect(() => {
    if (!isCalibrating) return;
    const interval = setInterval(() => {
      const p = getCalibrationProgress();
      setCalibrationProgress(p);
      if (p >= 100) {
        clearInterval(interval);
        setIsCalibrating(false);
        if (navigator.vibrate) navigator.vibrate([100]);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [isCalibrating, getCalibrationProgress]);

  // Arrhythmia detection from new ArrhythmiaDetector
  useEffect(() => {
    if (!arrhythmiaResult || !lastHeartBeatOutput || lastHeartBeatOutput.bpm <= 0) return;
    
    if (arrhythmiaResult.type !== 'NORMAL' && arrhythmiaResult.confidence > 0.5) {
      setArrhythmiaDetected(true);
      if (arrhythmiaResult.type === 'AFIB' || arrhythmiaResult.type === 'IRREGULAR') {
        setArrhythmiaState(true);
      }
    } else if (arrhythmiaResult.type === 'NORMAL') {
      setArrhythmiaDetected(false);
      setArrhythmiaState(false);
    }
  }, [arrhythmiaResult, lastHeartBeatOutput, setArrhythmiaState]);

  const handleToggleMonitoring = () => {
    if (isMonitoring) finalizeMeasurement();
    else startMonitoring();
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-black" style={{ 
      height: '100svh', width: '100vw', maxWidth: '100vw', maxHeight: '100svh',
      overflow: 'hidden', touchAction: 'none', userSelect: 'none',
      WebkitTouchCallout: 'none', WebkitUserSelect: 'none'
    }}>
      {!isFullscreen && (
        <button 
          onClick={enterFullScreen}
          className="fixed inset-0 z-50 w-full h-full flex items-center justify-center bg-black/90 text-white"
        >
          <div className="text-center p-4 bg-primary/20 rounded-lg backdrop-blur-sm">
            <p className="text-lg font-semibold">Toca para modo pantalla completa</p>
          </div>
        </button>
      )}

      <div className="flex-1 relative">
        <div className="absolute inset-0">
          <CameraView 
            ref={cameraViewRef}
            onStreamReady={handleStreamReady}
            onDiagnostics={setCameraDiag}
            isMonitoring={isCameraOn}
            isFingerDetected={lastSignal?.fingerDetected}
            signalQuality={signalQuality}
          />
        </div>

        <div className="relative z-10 h-full flex flex-col">
          {/* HEADER */}
          <div className="px-4 py-2 flex justify-around items-center bg-black/30">
            <div className="text-white text-sm">
              SQI: {signalQuality}
            </div>
            <div className="text-white text-sm">
              {lastSignal?.fingerDetected ? "✅ Dedo Detectado" : "❌ Sin Dedo"}
            </div>
            <div className="text-white text-sm">
              {systemState.current}
            </div>
            <button 
              onClick={() => setShowDebug(d => !d)}
              className="text-white text-xs bg-white/10 px-2 py-1 rounded"
            >
              {showDebug ? 'Hide' : 'Debug'}
            </button>
          </div>

          {/* DEBUG OVERLAY */}
          {showDebug && (
            <div className="px-3 py-2 bg-black/80 text-green-400 text-xs font-mono space-y-0.5 max-h-[min(52vh,420px)] overflow-y-auto">
              <div>FPS: {Math.round(frameTimingRef.current.realFps)} | Frames: {framesProcessed} | Drops: {frameTimingRef.current.droppedFrames} | ProcMs: {frameTimingRef.current.avgProcessingMs.toFixed(1)}</div>
              <div>Processing: {isProcessing ? 'ON' : 'OFF'} | Calibrating: {isCalibrating ? 'YES' : 'NO'}</div>
              {cameraDiag && (
                <div>Cam: {cameraDiag.resolution.w}x{cameraDiag.resolution.h} | Torch: {cameraDiag.torchActive ? 'ON' : 'OFF'} | Applied: {cameraDiag.constraintsApplied.join(',')}</div>
              )}
              {ppgDiagnostics && (
                <>
                  <div>Raw R: {lastSignal?.rawValue.toFixed(1)} | Filtered: {lastSignal?.filteredValue.toFixed(3)} | Quality: {lastSignal?.quality}</div>
                  <div>Perfusion: {ppgDiagnostics.perfusionIndex.toFixed(2)} | SNR: {ppgDiagnostics.snr.toFixed(2)} | RGB: {lastSignal?.rgbRaw?.r.toFixed(0)},{lastSignal?.rgbRaw?.g.toFixed(0)},{lastSignal?.rgbRaw?.b.toFixed(0)}</div>
                  <div>Contact: {ppgDiagnostics.contactState} | Press: {ppgDiagnostics.pressureState} | Src: {ppgDiagnostics.activeSource}</div>
                  <div>Coverage: {(ppgDiagnostics.coverage * 100).toFixed(0)}% | Stability: {(ppgDiagnostics.maskStability * 100).toFixed(0)}% | Motion: {ppgDiagnostics.motionScore.toFixed(2)}</div>
                  <div>ClipH: {(ppgDiagnostics.clipHigh * 100).toFixed(1)}% | ClipL: {(ppgDiagnostics.clipLow * 100).toFixed(1)}% | Pressure: {ppgDiagnostics.pressureScore.toFixed(2)}</div>
                  <div>Guidance: {ppgDiagnostics.guidanceMessage}</div>
                </>
              )}
              {heartDiagnostics && (
                <div className="border-t border-cyan-500/50 pt-1 mt-1 text-cyan-400/95">
                  <div className="text-white/90 font-semibold">DIAGNÓSTICOS CARDÍACOS NUEVOS</div>
                  <div>State: {heartDiagnostics.heartState} | Source: {heartDiagnostics.activeBpmSource}</div>
                  <div>Instant: {heartDiagnostics.instantBpm.toFixed(0)} | Temporal: {heartDiagnostics.temporalBpm.toFixed(0)} | Spectral: {heartDiagnostics.spectralBpm.toFixed(0)} | Final: {heartDiagnostics.finalBpm.toFixed(0)}</div>
                  <div>Conf: {(heartDiagnostics.confidence * 100).toFixed(0)}% | TemporalSQI: {(heartDiagnostics.temporalSQI * 100).toFixed(0)}% | SpectralSQI: {(heartDiagnostics.spectralSQI * 100).toFixed(0)}% | GlobalSQI: {(heartDiagnostics.globalSQI * 100).toFixed(0)}%</div>
                  <div>DomFreq: {heartDiagnostics.dominantFrequencyHz.toFixed(2)}Hz ({heartDiagnostics.dominantFrequencyBpm.toFixed(0)}BPM)</div>
                  <div>Beats: {heartDiagnostics.acceptedBeats} acc / {heartDiagnostics.rejectedBeats} rej | RR: {heartDiagnostics.rrCount} | Mean: {heartDiagnostics.rrMean.toFixed(0)}ms | Median: {heartDiagnostics.rrMedian.toFixed(0)}ms</div>
                  <div>OutlierRatio: {(heartDiagnostics.rrOutlierRatio * 100).toFixed(1)}% | ProcTime: {heartDiagnostics.processingTimeMs.toFixed(1)}ms</div>
                </div>
              )}
              {arrhythmiaResult && (
                <div className="border-t border-red-500/50 pt-1 mt-1 text-red-400/95">
                  <div className="text-white/90 font-semibold">ARRITMIA DETECTADA</div>
                  <div>Type: {arrhythmiaResult.type} | Conf: {(arrhythmiaResult.confidence * 100).toFixed(0)}% | AFib Prob: {(arrhythmiaResult.afibProbability * 100).toFixed(0)}%</div>
                  <div>RMSSD: {arrhythmiaResult.hrvMetrics.rmssd.toFixed(1)}ms | SDNN: {arrhythmiaResult.hrvMetrics.sdnn.toFixed(1)}ms | CV: {arrhythmiaResult.hrvMetrics.cv.toFixed(1)}%</div>
                  <div>SD1: {arrhythmiaResult.poincaréMetrics.sd1.toFixed(1)}ms | SD2: {arrhythmiaResult.poincaréMetrics.sd2.toFixed(1)}ms | SD1/SD2: {arrhythmiaResult.poincaréMetrics.sd1Sd2Ratio.toFixed(2)}</div>
                  <div>Entropy: {arrhythmiaResult.hrvMetrics.shannonEntropy.toFixed(2)} | pNN50: {arrhythmiaResult.hrvMetrics.pnn50.toFixed(1)}%</div>
                  <div>Guidance: {arrhythmiaResult.guidance}</div>
                </div>
              )}
              {lastHeartBeatOutput && (
                <div className="border-t border-white/10 pt-1 mt-1 text-amber-300/95">
                  <div className="text-white/90 font-semibold">PPG heartbeat / fusión</div>
                  <div>BPM: {lastHeartBeatOutput.bpm} | bpmConf: {(lastHeartBeatOutput.bpmConfidence * 100).toFixed(0)}% | instant: {lastHeartBeatOutput.lastAcceptedBeat?.instantBpm?.toFixed(0) ?? '—'}</div>
                  <div>beatSQI: {lastHeartBeatOutput.beatSQI ?? '—'} | agr det: {(lastHeartBeatOutput.detectorAgreement * 100).toFixed(0)}%</div>
                  <div>Hyp: {lastHeartBeatOutput.activeHypothesis} | reject: {lastHeartBeatOutput.rejectionReason}</div>
                  <div>RR esp: {lastHeartBeatOutput.debug?.expectedRrMs?.toFixed(0) ?? '—'} ms | hardRef: {lastHeartBeatOutput.debug?.hardRefractoryMs?.toFixed(0) ?? '—'} | soft: {lastHeartBeatOutput.debug?.softRefractoryMs?.toFixed(0) ?? '—'}</div>
                  <div>Autocorr BPM: {lastHeartBeatOutput.debug?.fusion?.hypotheses?.find(h => h.id === 'autocorr')?.bpm?.toFixed(0) ?? '—'} | Median IBI BPM: {lastHeartBeatOutput.debug?.fusion?.hypotheses?.find(h => h.id === 'medianIbi')?.bpm?.toFixed(0) ?? '—'}</div>
                  <div>Spectral BPM: {lastHeartBeatOutput.debug?.fusion?.hypotheses?.find(h => h.id === 'spectral')?.bpm?.toFixed(0) ?? '—'} | spread: {lastHeartBeatOutput.debug?.fusion?.spread?.toFixed(1) ?? '—'}</div>
                  <div>Accepted/Rejected: {lastHeartBeatOutput.debug?.beatsAcceptedSession ?? '—'}/{lastHeartBeatOutput.debug?.beatsRejectedSession ?? '—'} | dbl/miss/susp: {lastHeartBeatOutput.debug?.doublePeakCount ?? '—'}/{lastHeartBeatOutput.debug?.missedBeatCount ?? '—'}/{lastHeartBeatOutput.debug?.suspiciousCount ?? '—'}</div>
                  <div>Template ρ: {lastHeartBeatOutput.debug?.templateCorrelationLast?.toFixed(2) ?? '—'} | morph: {lastHeartBeatOutput.debug?.morphologyScoreLast?.toFixed(2) ?? '—'} | periodicity: {lastHeartBeatOutput.debug?.periodicityScore?.toFixed(2) ?? '—'}</div>
                  <div>Fs est: {lastHeartBeatOutput.debug?.sampleRateHz?.toFixed(1) ?? '—'} Hz | flags: {lastHeartBeatOutput.beatFlags.join(',') || '—'}</div>
                </div>
              )}
            </div>
          )}

          <div className="flex-1">
            <PPGSignalMeter 
              value={beatMarker}
              quality={lastSignal?.quality || 0}
              isFingerDetected={lastSignal?.fingerDetected || false}
              onStartMeasurement={startMonitoring}
              onReset={handleReset}
              arrhythmiaStatus={vitalSigns.arrhythmiaStatus}
              rawArrhythmiaData={lastArrhythmiaData.current}
              preserveResults={showResults}
            />
          </div>

          {/* VITAL SIGNS */}
          <div className="absolute inset-x-0 top-[55%] bottom-[60px] bg-black/10 px-4 py-6">
            <div className="grid grid-cols-3 gap-4 place-items-center">
              <VitalSign label="FRECUENCIA CARDÍACA" value={heartRate || "--"} unit="BPM" highlighted={showResults} />
              <VitalSign label="SPO2" value={vitalSigns.spo2 || "--"} unit="%" highlighted={showResults} />
              <VitalSign label="PRESIÓN ARTERIAL" value={vitalSigns.pressure ? `${vitalSigns.pressure.systolic}/${vitalSigns.pressure.diastolic}` : "--/--"} unit="mmHg" highlighted={showResults} />
              <VitalSign label="HEMOGLOBINA" value={vitalSigns.hemoglobin || "--"} unit="g/dL" highlighted={showResults} />
              <VitalSign label="GLUCOSA" value={vitalSigns.glucose || "--"} unit="mg/dL" highlighted={showResults} />
              <VitalSign label="COLESTEROL/TRIGL." value={`${vitalSigns.lipids?.totalCholesterol || "--"}/${vitalSigns.lipids?.triglycerides || "--"}`} unit="mg/dL" highlighted={showResults} />
            </div>
          </div>

          {/* BUTTONS */}
          <div className="absolute inset-x-0 bottom-4 flex gap-4 px-4">
            <div className="w-1/2">
              <MonitorButton isMonitoring={isMonitoring} onToggle={handleToggleMonitoring} variant="monitor" />
            </div>
            <div className="w-1/2">
              <MonitorButton isMonitoring={isMonitoring} onToggle={handleReset} variant="reset" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Index;
