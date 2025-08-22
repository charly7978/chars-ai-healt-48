
import React, { useEffect, useRef, useState } from 'react';
import { CameraSample } from '@/types';

// FUNCIÓN AUXILIAR PARA CONFIGURAR LINTERNA CON MÚLTIPLES ESTRATEGIAS
const setupTorchWithFallbacks = async (
  stream: MediaStream, 
  setTorchEnabled: (enabled: boolean) => void
): Promise<void> => {
  const [videoTrack] = stream.getVideoTracks();
  
  if (!videoTrack) {
    console.log('🔦 ❌ No hay video track disponible');
    return;
  }

  try {
    // ESTRATEGIA 1: Intentar con constraints avanzados (API moderna)
    const capabilities = (videoTrack as any).getCapabilities?.();
    console.log('📱 Capacidades del dispositivo:', capabilities);
    
    if (capabilities?.torch) {
      console.log('🔦 🚀 Intentando activar linterna con API moderna...');
      
      // Aplicar constraints de torch paso a paso
      await (videoTrack as any).applyConstraints({
        advanced: [{ torch: true }]
      });
      
      // Verificar que se aplicó correctamente
      const settings = (videoTrack as any).getSettings?.();
      if (settings?.torch) {
        setTorchEnabled(true);
        console.log('🔦 ✅ LINTERNA ACTIVADA CON API MODERNA');
        return;
      }
    }
    
    // ESTRATEGIA 2: Intentar con constraints básicos
    console.log('🔦 🚀 Intentando activar linterna con constraints básicos...');
    await (videoTrack as any).applyConstraints({
      torch: true
    });
    
    const settings = (videoTrack as any).getSettings?.();
    if (settings?.torch) {
      setTorchEnabled(true);
      console.log('🔦 ✅ LINTERNA ACTIVADA CON CONSTRAINTS BÁSICOS');
      return;
    }
    
    // ESTRATEGIA 3: Intentar recrear el stream con torch
    console.log('🔦 🚀 Intentando recrear stream con torch...');
    const newConstraints: MediaStreamConstraints = {
      video: {
        facingMode: { ideal: 'environment' },
        torch: true as any,
        width: { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 },
        frameRate: { ideal: 30, max: 60 }
      },
      audio: false
    };
    
    try {
      const newStream = await navigator.mediaDevices.getUserMedia(newConstraints);
      const [newVideoTrack] = newStream.getVideoTracks();
      const newSettings = (newVideoTrack as any).getSettings?.();
      
      if (newSettings?.torch) {
        // Reemplazar el track actual
        stream.removeTrack(videoTrack);
        stream.addTrack(newVideoTrack);
        setTorchEnabled(true);
        console.log('🔦 ✅ LINTERNA ACTIVADA RECREANDO STREAM');
        return;
      } else {
        // Cerrar el stream nuevo si no funcionó
        newStream.getTracks().forEach(track => track.stop());
      }
    } catch (recreateError) {
      console.log('🔦 ⚠️ No se pudo recrear stream con torch:', recreateError);
    }
    
    console.log('🔦 ❌ Sin soporte de linterna en este dispositivo');
    
  } catch (torchError) {
    console.error('🔦 ❌ Error configurando linterna:', torchError);
  }
};

interface CameraViewProps {
  onStreamReady?: (s: MediaStream) => void;
  onSample?: (s: CameraSample) => void;
  isMonitoring: boolean;
  targetFps?: number;
  roiSize?: number;
  enableTorch?: boolean;
  coverageThresholdPixelBrightness?: number;
}

const CameraView: React.FC<CameraViewProps> = ({
  onStreamReady,
  onSample,
  isMonitoring,
  targetFps = 30,
  roiSize = 200,
  enableTorch = true,
  coverageThresholdPixelBrightness = 25
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const prevBrightnessRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isStreamActive, setIsStreamActive] = useState(false);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const startCam = async () => {
      try {
        console.log('🎥 INICIANDO SISTEMA CÁMARA COMPLETO...');
        
        // CRÍTICO: Constraints optimizadas para PPG
        const constraints: MediaStreamConstraints = {
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 },
            frameRate: { ideal: 30, max: 60 },
            aspectRatio: { ideal: 16/9 }
          },
          audio: false
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        if (!mounted) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }

        streamRef.current = stream;
        console.log('✅ Stream obtenido correctamente');

        // CREAR VIDEO ELEMENT - CRÍTICO
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.style.width = '100%';
        video.style.height = '100%';
        video.style.objectFit = 'cover';
        video.style.transform = 'scaleX(-1)'; // Mirror para mejor UX
        
        videoRef.current = video;

        // CRÍTICO: AGREGAR AL DOM INMEDIATAMENTE
        if (containerRef.current) {
          // Limpiar contenedor primero
          containerRef.current.innerHTML = '';
          containerRef.current.appendChild(video);
          console.log('✅ Video agregado al DOM exitosamente');
        }

        // Asignar stream
        video.srcObject = stream;

        // CREAR CANVAS PARA PROCESAMIENTO
        const canvas = document.createElement('canvas');
        canvas.style.display = 'none';
        canvasRef.current = canvas;

        // CONFIGURAR LINTERNA CON MÚLTIPLES ESTRATEGIAS
        if (enableTorch) {
          await setupTorchWithFallbacks(stream, setTorchEnabled);
        }

        // ESPERAR VIDEO READY
        const waitForVideo = () => {
          if (video.readyState >= 2 && video.videoWidth > 0) {
            console.log('✅ Video COMPLETAMENTE listo:', {
              width: video.videoWidth,
              height: video.videoHeight,
              readyState: video.readyState
            });
            setIsStreamActive(true);
            setError(null);
            onStreamReady?.(stream);
            
            // INICIAR CAPTURA INMEDIATAMENTE
            if (isMonitoring) {
              startFrameCapture();
            }
          } else {
            setTimeout(waitForVideo, 50);
          }
        };

        video.addEventListener('loadedmetadata', waitForVideo);
        waitForVideo();

      } catch (err: any) {
        console.error('❌ ERROR CRÍTICO CÁMARA:', err);
        setError(err.message || 'Error desconocido');
        setIsStreamActive(false);
      }
    };

    const startFrameCapture = () => {
      if (!mounted || !isMonitoring) return;
      
      console.log('🎬 INICIANDO CAPTURA DE FRAMES PPG...');
      
      const captureLoop = () => {
        if (!mounted || !isMonitoring || !videoRef.current || !canvasRef.current) {
          return;
        }
        
        try {
          const sample = captureOptimizedFrame();
          if (sample && onSample) {
            onSample(sample);
          }
        } catch (captureError) {
          console.error('Error en captura:', captureError);
        }
        
        // Programar siguiente frame
        const frameDelay = 1000 / targetFps;
        const nextFrameTime = performance.now() + frameDelay;
        
        const scheduleNextFrame = () => {
          const now = performance.now();
          if (now >= nextFrameTime) {
            captureLoop();
          } else {
            rafRef.current = requestAnimationFrame(scheduleNextFrame);
          }
        };
        
        rafRef.current = requestAnimationFrame(scheduleNextFrame);
      };
      
      rafRef.current = requestAnimationFrame(captureLoop);
    };

    const captureOptimizedFrame = (): CameraSample | null => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
        return null;
      }

      // ROI CENTRADA Y OPTIMIZADA
      const centerX = video.videoWidth / 2;
      const centerY = video.videoHeight / 2;
      const roiW = Math.min(roiSize, video.videoWidth * 0.3);
      const roiH = Math.min(roiSize, video.videoHeight * 0.3);
      const sx = centerX - roiW / 2;
      const sy = centerY - roiH / 2;

      canvas.width = roiW;
      canvas.height = roiH;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      
      // CAPTURAR ROI ESPECÍFICA
      ctx.drawImage(video, sx, sy, roiW, roiH, 0, 0, roiW, roiH);
      const imageData = ctx.getImageData(0, 0, roiW, roiH);
      const data = imageData.data;

      // PROCESAMIENTO PPG OPTIMIZADO
      let rSum = 0, gSum = 0, bSum = 0;
      let rSum2 = 0, gSum2 = 0, bSum2 = 0;
      let brightSum = 0;
      let brightPixels = 0;
      const threshold = coverageThresholdPixelBrightness;

      const totalPixels = data.length / 4;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1]; 
        const b = data[i + 2];
        const brightness = (r + g + b) / 3;
        
        rSum += r;
        gSum += g;
        bSum += b;
        rSum2 += r * r;
        gSum2 += g * g;
        bSum2 += b * b;
        brightSum += brightness;
        
        if (brightness >= threshold) brightPixels++;
      }
      
      const rMean = rSum / totalPixels;
      const gMean = gSum / totalPixels;
      const bMean = bSum / totalPixels;
      const brightnessMean = brightSum / totalPixels;
      
      // VARIANZAS CORRECTAS
      const rVar = Math.max(0, rSum2/totalPixels - rMean*rMean);
      const gVar = Math.max(0, gSum2/totalPixels - gMean*gMean);
      const bVar = Math.max(0, bSum2/totalPixels - bMean*bMean);
      
      const rStd = Math.sqrt(rVar);
      const gStd = Math.sqrt(gVar);
      const bStd = Math.sqrt(bVar);
      
      // FRAME DIFF PARA MOVIMIENTO
      const prevBrightness = prevBrightnessRef.current;
      const frameDiff = prevBrightness !== null ? Math.abs(brightnessMean - prevBrightness) : 0;
      prevBrightnessRef.current = brightnessMean;
      
      const coverageRatio = brightPixels / totalPixels;

      return {
        timestamp: Date.now(),
        rMean,
        gMean,
        bMean,
        brightnessMean,
        rStd,
        gStd,
        bStd,
        frameDiff,
        coverageRatio
      };
    };

    if (isMonitoring) {
      startCam();
    }

    // CLEANUP EFFECT
    return () => {
      mounted = false;
      
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      
      if (videoRef.current) {
        videoRef.current = null;
      }
      
      if (canvasRef.current) {
        canvasRef.current = null;
      }
      
      setIsStreamActive(false);
      setTorchEnabled(false);
      setError(null);
    };
  }, [isMonitoring, targetFps, roiSize, enableTorch, coverageThresholdPixelBrightness]);

  // EFECTO PARA INICIAR CAPTURA CUANDO CAMBIA isMonitoring
  useEffect(() => {
    if (isMonitoring && isStreamActive && videoRef.current) {
      const startFrameCapture = () => {
        if (!isMonitoring) return;
        
        const captureLoop = () => {
          if (!isMonitoring || !videoRef.current || !canvasRef.current) {
            return;
          }
          
          try {
            const sample = captureOptimizedFrame();
            if (sample && onSample) {
              onSample(sample);
            }
          } catch (captureError) {
            console.error('Error en captura:', captureError);
          }
          
          rafRef.current = requestAnimationFrame(() => {
            setTimeout(captureLoop, 1000 / targetFps);
          });
        };
        
        const captureOptimizedFrame = (): CameraSample | null => {
          const video = videoRef.current;
          const canvas = canvasRef.current;
          
          if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
            return null;
          }

          const centerX = video.videoWidth / 2;
          const centerY = video.videoHeight / 2;
          const roiW = Math.min(roiSize, video.videoWidth * 0.3);
          const roiH = Math.min(roiSize, video.videoHeight * 0.3);
          const sx = centerX - roiW / 2;
          const sy = centerY - roiH / 2;

          canvas.width = roiW;
          canvas.height = roiH;
          
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          
          ctx.drawImage(video, sx, sy, roiW, roiH, 0, 0, roiW, roiH);
          const imageData = ctx.getImageData(0, 0, roiW, roiH);
          const data = imageData.data;

          let rSum = 0, gSum = 0, bSum = 0;
          let rSum2 = 0, gSum2 = 0, bSum2 = 0;
          let brightSum = 0;
          let brightPixels = 0;
          const threshold = coverageThresholdPixelBrightness;

          const totalPixels = data.length / 4;

          for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1]; 
            const b = data[i + 2];
            const brightness = (r + g + b) / 3;
            
            rSum += r;
            gSum += g;
            bSum += b;
            rSum2 += r * r;
            gSum2 += g * g;
            bSum2 += b * b;
            brightSum += brightness;
            
            if (brightness >= threshold) brightPixels++;
          }
          
          const rMean = rSum / totalPixels;
          const gMean = gSum / totalPixels;
          const bMean = bSum / totalPixels;
          const brightnessMean = brightSum / totalPixels;
          
          const rVar = Math.max(0, rSum2/totalPixels - rMean*rMean);
          const gVar = Math.max(0, gSum2/totalPixels - gMean*gMean);
          const bVar = Math.max(0, bSum2/totalPixels - bMean*bMean);
          
          const rStd = Math.sqrt(rVar);
          const gStd = Math.sqrt(gVar);
          const bStd = Math.sqrt(bVar);
          
          const prevBrightness = prevBrightnessRef.current;
          const frameDiff = prevBrightness !== null ? Math.abs(brightnessMean - prevBrightness) : 0;
          prevBrightnessRef.current = brightnessMean;
          
          const coverageRatio = brightPixels / totalPixels;

          return {
            timestamp: Date.now(),
            rMean,
            gMean,
            bMean,
            brightnessMean,
            rStd,
            gStd,
            bStd,
            frameDiff,
            coverageRatio
          };
        };
        
        rafRef.current = requestAnimationFrame(captureLoop);
      };
      
      startFrameCapture();
    } else if (!isMonitoring && rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, [isMonitoring, isStreamActive, targetFps, roiSize, coverageThresholdPixelBrightness, onSample]);

  return (
    <div className="absolute inset-0 bg-black">
      {/* CONTENEDOR PRINCIPAL PARA VIDEO */}
      <div 
        ref={containerRef}
        className="w-full h-full"
        style={{ overflow: 'hidden' }}
      />
      
      {/* OVERLAY DE ESTADOS */}
      {!isStreamActive && isMonitoring && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/90">
          <div className="text-white text-center p-6">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
            <p className="text-lg font-medium">Iniciando cámara PPG...</p>
            {enableTorch && (
              <p className="text-sm text-white/70 mt-2">Configurando linterna...</p>
            )}
            {error && (
              <p className="text-sm text-red-400 mt-2">Error: {error}</p>
            )}
          </div>
        </div>
      )}
      
      {!isMonitoring && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
          <div className="text-white text-center p-6">
            <div className="h-12 w-12 bg-gray-600 rounded-full mx-auto mb-4 flex items-center justify-center text-2xl">
              📷
            </div>
            <p className="text-lg">Sistema PPG Desactivado</p>
            <p className="text-sm text-white/60 mt-2">Presiona iniciar para comenzar</p>
          </div>
        </div>
      )}
      
      {/* INDICADORES DE ESTADO */}
      {torchEnabled && (
        <div className="absolute top-4 left-4 bg-black/70 rounded-full p-2">
          <div className="text-yellow-400 text-xl animate-pulse">🔦</div>
        </div>
      )}
      
      {isStreamActive && isMonitoring && (
        <div className="absolute bottom-4 left-4 bg-black/70 rounded-full px-3 py-1">
          <div className="text-green-400 text-sm flex items-center">
            <div className="w-2 h-2 bg-green-400 rounded-full mr-2 animate-pulse"></div>
            CAPTURANDO PPG
          </div>
        </div>
      )}
    </div>
  );
};

export default CameraView;
