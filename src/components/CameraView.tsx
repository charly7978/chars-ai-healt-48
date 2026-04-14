
import React, { useRef, useEffect, useState, forwardRef, useImperativeHandle } from 'react';
import { toast } from "@/components/ui/use-toast";

export interface CameraDiagnostics {
  hasTorch: boolean;
  torchActive: boolean;
  exposureLocked: boolean;
  focusLocked: boolean;
  whiteBalanceLocked: boolean;
  actualFrameRate: number;
  resolution: { w: number; h: number };
  constraintsApplied: string[];
  constraintsFailed: string[];
  exposureMode?: string;
  focusMode?: string;
  whiteBalanceMode?: string;
}

export interface CameraViewRef {
  videoRef: React.RefObject<HTMLVideoElement>;
  getStream: () => MediaStream | null;
  toggleTorch: (enabled: boolean) => Promise<boolean>;
}

interface CameraViewProps {
  onStreamReady?: (stream: MediaStream) => void;
  onDiagnostics?: (diag: CameraDiagnostics) => void;
  isMonitoring: boolean;
  isFingerDetected?: boolean;
  signalQuality?: number;
}

/**
 * CameraView V3 — Centralized camera control, exposed videoRef, PPG-oriented configuration
 */
const CameraView = forwardRef<CameraViewRef, CameraViewProps>(({ 
  onStreamReady, 
  onDiagnostics,
  isMonitoring, 
  isFingerDetected = false, 
  signalQuality = 0,
}, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [deviceSupportsTorch, setDeviceSupportsTorch] = useState(false);
  const cameraInitialized = useRef(false);
  const sessionIdRef = useRef("");
  const stabilizationTimerRef = useRef<number | null>(null);
  const diagRef = useRef<CameraDiagnostics>({
    hasTorch: false, torchActive: false, exposureLocked: false,
    focusLocked: false, whiteBalanceLocked: false, actualFrameRate: 0,
    resolution: { w: 0, h: 0 }, constraintsApplied: [], constraintsFailed: []
  });

  // Expose videoRef and control methods to parent
  useImperativeHandle(ref, () => ({
    videoRef,
    getStream: () => stream,
    toggleTorch: async (enabled: boolean) => {
      if (!stream || !deviceSupportsTorch) return false;
      try {
        const track = stream.getVideoTracks()[0];
        await track.applyConstraints({ advanced: [{ torch: enabled } as any] });
        setTorchEnabled(enabled);
        diagRef.current.torchActive = enabled;
        onDiagnostics?.({ ...diagRef.current });
        return true;
      } catch {
        return false;
      }
    }
  }), [stream, deviceSupportsTorch, onDiagnostics]);

  useEffect(() => {
    sessionIdRef.current = `cam_${Date.now().toString(36)}`;
  }, []);

  const stopCamera = async () => {
    if (stabilizationTimerRef.current) {
      clearTimeout(stabilizationTimerRef.current);
      stabilizationTimerRef.current = null;
    }

    if (!stream) return;
    stream.getTracks().forEach(track => {
      if (track.kind === 'video') {
        try {
          const caps = track.getCapabilities() as any;
          if (caps?.torch) {
            track.applyConstraints({ advanced: [{ torch: false } as any] }).catch(() => {});
          }
        } catch {}
      }
      track.stop();
    });
    if (videoRef.current) videoRef.current.srcObject = null;
    setStream(null);
    setTorchEnabled(false);
    cameraInitialized.current = false;
  };

  const startCamera = async () => {
    if (stream || cameraInitialized.current) return;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("getUserMedia no soportado");
      }

      const applied: string[] = [];
      const failed: string[] = [];

      // ═══ PHASE 1: Get rear camera stream with PPG-optimized constraints ═══
      const baseConstraints: MediaTrackConstraints = {
        facingMode: { exact: 'environment' },
        width: { ideal: 1280, min: 640 },
        height: { ideal: 720, min: 480 },
        frameRate: { ideal: 30, min: 15 }
      };

      let newStream: MediaStream | null = null;
      const attempts: MediaStreamConstraints[] = [
        { video: baseConstraints, audio: false },
        { video: { ...baseConstraints, facingMode: { ideal: 'environment' } }, audio: false },
        { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false },
        { video: { facingMode: 'environment' }, audio: false },
        { video: true, audio: false }
      ];

      for (const attempt of attempts) {
        try {
          newStream = await navigator.mediaDevices.getUserMedia(attempt);
          applied.push('rearCamera');
          break;
        } catch (e) {
          continue;
        }
      }
      if (!newStream) throw new Error('No camera stream available');

      const videoTrack = newStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('No video track');

      // ═══ PHASE 2: Read capabilities & settings ═══
      const caps = videoTrack.getCapabilities() as any;
      const settings = videoTrack.getSettings() as any;
      
      diagRef.current.resolution = {
        w: settings.width || 0,
        h: settings.height || 0
      };
      diagRef.current.actualFrameRate = settings.frameRate || 0;

      // ═══ PHASE 3: Torch ON ═══
      if (caps.torch) {
        diagRef.current.hasTorch = true;
        setDeviceSupportsTorch(true);
        try {
          await videoTrack.applyConstraints({ advanced: [{ torch: true } as any] });
          setTorchEnabled(true);
          diagRef.current.torchActive = true;
          applied.push('torch');
        } catch {
          failed.push('torch');
        }
      }

      // ═══ PHASE 4: Stabilization window (800-1500ms) before fine locks ═══
      await new Promise(resolve => {
        stabilizationTimerRef.current = window.setTimeout(resolve, 1000);
      });

      // ═══ PHASE 5: Fine locks with PPG-oriented settings (each individually, fail gracefully) ═══
      const fineConstraints: Array<{ name: string; constraint: any; diagKey?: keyof CameraDiagnostics }> = [
        // Try to lock exposure to prevent pumping
        { name: 'exposureMode', constraint: { exposureMode: 'manual' }, diagKey: 'exposureLocked' },
        // Continuous focus is better than auto for PPG
        { name: 'focusMode', constraint: { focusMode: 'continuous' }, diagKey: 'focusLocked' },
        // Continuous white balance
        { name: 'whiteBalanceMode', constraint: { whiteBalanceMode: 'continuous' }, diagKey: 'whiteBalanceLocked' },
      ];

      // Try to set exposure compensation to reasonable value for PPG
      if (caps.exposureCompensation) {
        const range = caps.exposureCompensation;
 const midValue = range.min !== undefined && range.max !== undefined 
          ? (range.min + range.max) / 2 
          : 0;
        fineConstraints.push({
          name: 'exposureCompensation',
          constraint: { exposureCompensation: midValue }
        });
      }

      for (const fc of fineConstraints) {
        if (caps[fc.name] !== undefined) {
          try {
            await videoTrack.applyConstraints({ advanced: [fc.constraint] });
            applied.push(fc.name);
            if (fc.diagKey) (diagRef.current as any)[fc.diagKey] = true;
            // Store actual mode in diagnostics
            if (fc.name === 'exposureMode') diagRef.current.exposureMode = 'manual';
            if (fc.name === 'focusMode') diagRef.current.focusMode = 'continuous';
            if (fc.name === 'whiteBalanceMode') diagRef.current.whiteBalanceMode = 'continuous';
          } catch {
            failed.push(fc.name);
          }
        }
      }

      diagRef.current.constraintsApplied = applied;
      diagRef.current.constraintsFailed = failed;

      console.log(`📹 Camera V2 initialized:`, {
        applied, failed,
        resolution: diagRef.current.resolution,
        fps: diagRef.current.actualFrameRate,
        torch: diagRef.current.torchActive
      });

      // Assign to video element
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
        const isAndroid = /android/i.test(navigator.userAgent);
        if (isAndroid) {
          videoRef.current.style.willChange = 'transform';
          videoRef.current.style.transform = 'translateZ(0)';
        }
      }

      setStream(newStream);
      cameraInitialized.current = true;

      onStreamReady?.(newStream);
      onDiagnostics?.({ ...diagRef.current });

    } catch (err) {
      console.error("❌ Camera init error:", err);
      cameraInitialized.current = false;
      toast({
        title: "Error de Cámara",
        description: `${err}`,
        variant: "destructive",
        duration: 5000
      });
    }
  };

  // Lifecycle
  useEffect(() => {
    if (isMonitoring && !stream && !cameraInitialized.current) {
      startCamera();
    } else if (!isMonitoring && stream) {
      stopCamera();
    }
    return () => { stopCamera(); };
  }, [isMonitoring]);

  // Torch maintenance
  useEffect(() => {
    if (!stream || !deviceSupportsTorch || !isMonitoring) return;

    const maintain = async () => {
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      try {
        const s = track.getSettings() as any;
        if (!s?.torch) {
          await track.applyConstraints({ advanced: [{ torch: true } as any] });
          setTorchEnabled(true);
          diagRef.current.torchActive = true;
        }
      } catch {}
    };

    maintain();
    const id = setInterval(maintain, 3000);
    return () => clearInterval(id);
  }, [stream, isMonitoring, deviceSupportsTorch]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      className="absolute top-0 left-0 min-w-full min-h-full w-auto h-auto z-0 object-cover"
      style={{
        willChange: 'transform',
        transform: 'translateZ(0)',
        backfaceVisibility: 'hidden'
      }}
    />
  );
});

CameraView.displayName = 'CameraView';

export default CameraView;
