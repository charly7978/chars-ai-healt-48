
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { CameraSample } from '@/types';
import { logDebug, logInfo, logError } from '@/utils/performance-logger';
import { timeThrottle } from '@/utils/performance-utils';

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
  const frameProcessingRef = useRef<boolean>(false);
  const lastFrameTimeRef = useRef<number>(0);

  useEffect(() => {
    let mounted = true;

    const startCam = async () => {
      try {
        logInfo('🎥 INICIANDO SISTEMA CÁMARA COMPLETO...');
        
        // CRÍTICO: Constraints optimizadas para PPG
        const constraints: MediaStreamConstraints = {
          video: {
            facingMode: 'environment', // Cámara trasera SIEMPRE
            width: { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 },
            frameRate: { ideal: targetFps, min: 20 },
            // Configuración PPG específica
            exposureMode: 'manual',
            whiteBalanceMode: 'manual',
            focusMode: 'manual'
          },
          audio: false
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        if (!mounted) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }

        streamRef.current = stream;
        logDebug('✅ Stream obtenido correctamente');

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
          logDebug('✅ Video agregado al DOM exitosamente');
        }

        // Asignar stream
        video.srcObject = stream;

        // CREAR CANVAS PARA PROCESAMIENTO
        const canvas = document.createElement('canvas');
        canvas.style.display = 'none';
        canvasRef.current = canvas;

        // CONFIGURAR LINTERNA INMEDIATAMENTE
        if (enableTorch) {
          try {
            const [videoTrack] = stream.getVideoTracks();
            const capabilities = (videoTrack as any).getCapabilities?.();
            
            logDebug('📱 Capacidades:', capabilities);
            
            if (capabilities?.torch) {
              await (videoTrack as any).applyConstraints({
                advanced: [{ 
                  torch: true,
                  exposureMode: 'manual',
                  exposureTime: 33000, // Optimizado para PPG
                  whiteBalanceMode: 'manual'
                }]
              });
              setTorchEnabled(true);
              console.log('🔦 ✅ LINTERNA ACTIVADA - PPG OPTIMIZADA');
            } else {
              console.log('🔦 ❌ Sin soporte de linterna');
            }
          } catch (torchError) {
            console.error('🔦 Error linterna:', torchError);
          }
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
        logError('❌ ERROR CRÍTICO CÁMARA:', err);
        setError(err.message || 'Error desconocido');
        setIsStreamActive(false);
      }
    };

    // Optimizar el procesamiento con throttle
    const throttledOnSample = useCallback(
      timeThrottle((sample: CameraSample) => {
        if (onSample) {
          onSample(sample);
        }
      }, Math.floor(1000 / targetFps)),
      [onSample, targetFps]
    );

    const startFrameCapture = () => {
      if (!mounted || !isMonitoring) return;
      
      logInfo('🎬 INICIANDO CAPTURA DE FRAMES PPG...');
      
      const frameInterval = 1000 / targetFps;
      let lastFrameTime = 0;
      
      const captureLoop = (currentTime: number) => {
        if (!mounted || !isMonitoring || !videoRef.current || !canvasRef.current) {
          return;
        }
        
        // Control de FPS preciso
        if (currentTime - lastFrameTime >= frameInterval) {
          lastFrameTime = currentTime;
          
          try {
            const sample = captureOptimizedFrame();
            if (sample) {
              throttledOnSample(sample);
            }
          } catch (captureError) {
            logError('Error en captura:', captureError);
          }
        }
        
        // Siguiente frame
        rafRef.current = requestAnimationFrame(captureLoop);
      };
      
      rafRef.current = requestAnimationFrame(captureLoop);
    };

    const captureOptimizedFrame = useCallback((): CameraSample | null => {
      // Prevenir procesamiento concurrente
      if (frameProcessingRef.current) return null;
      
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      if (!video || !canvas || !video.videoWidth || !video.videoHeight) {
        return null;
      }

      frameProcessingRef.current = true;

      try {
        // ROI CENTRADA Y OPTIMIZADA
        const centerX = video.videoWidth / 2;
        const centerY = video.videoHeight / 2;
        const roiW = Math.min(roiSize, video.videoWidth * 0.3);
        const roiH = Math.min(roiSize, video.videoHeight * 0.3);
        const sx = centerX - roiW / 2;
        const sy = centerY - roiH / 2;

        canvas.width = roiW;
        canvas.height = roiH;
        
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return null;
        
        // Optimizaciones de contexto
        ctx.imageSmoothingEnabled = false;
        
        // CAPTURAR ROI ESPECÍFICA
        ctx.drawImage(video, sx, sy, roiW, roiH, 0, 0, roiW, roiH);
        const imageData = ctx.getImageData(0, 0, roiW, roiH);
        const data = imageData.data;

        // PROCESAMIENTO PPG OPTIMIZADO con unrolling de bucle
        let rSum = 0, gSum = 0, bSum = 0;
        let rSum2 = 0, gSum2 = 0, bSum2 = 0;
        let brightSum = 0;
        let brightPixels = 0;
        const threshold = coverageThresholdPixelBrightness;

        const totalPixels = data.length / 4;
        const dataLength = data.length;

        // Procesar de 8 en 8 pixeles para mejor rendimiento
        let i = 0;
        for (; i < dataLength - 32; i += 32) {
          // Pixel 1
          const r1 = data[i], g1 = data[i + 1], b1 = data[i + 2];
          const brightness1 = (r1 + g1 + b1) / 3;
          
          // Pixel 2
          const r2 = data[i + 4], g2 = data[i + 5], b2 = data[i + 6];
          const brightness2 = (r2 + g2 + b2) / 3;
          
          // Pixel 3
          const r3 = data[i + 8], g3 = data[i + 9], b3 = data[i + 10];
          const brightness3 = (r3 + g3 + b3) / 3;
          
          // Pixel 4
          const r4 = data[i + 12], g4 = data[i + 13], b4 = data[i + 14];
          const brightness4 = (r4 + g4 + b4) / 3;
          
          // Pixel 5
          const r5 = data[i + 16], g5 = data[i + 17], b5 = data[i + 18];
          const brightness5 = (r5 + g5 + b5) / 3;
          
          // Pixel 6
          const r6 = data[i + 20], g6 = data[i + 21], b6 = data[i + 22];
          const brightness6 = (r6 + g6 + b6) / 3;
          
          // Pixel 7
          const r7 = data[i + 24], g7 = data[i + 25], b7 = data[i + 26];
          const brightness7 = (r7 + g7 + b7) / 3;
          
          // Pixel 8
          const r8 = data[i + 28], g8 = data[i + 29], b8 = data[i + 30];
          const brightness8 = (r8 + g8 + b8) / 3;
          
          // Acumular sumas
          rSum += r1 + r2 + r3 + r4 + r5 + r6 + r7 + r8;
          gSum += g1 + g2 + g3 + g4 + g5 + g6 + g7 + g8;
          bSum += b1 + b2 + b3 + b4 + b5 + b6 + b7 + b8;
          
          rSum2 += r1*r1 + r2*r2 + r3*r3 + r4*r4 + r5*r5 + r6*r6 + r7*r7 + r8*r8;
          gSum2 += g1*g1 + g2*g2 + g3*g3 + g4*g4 + g5*g5 + g6*g6 + g7*g7 + g8*g8;
          bSum2 += b1*b1 + b2*b2 + b3*b3 + b4*b4 + b5*b5 + b6*b6 + b7*b7 + b8*b8;
          
          brightSum += brightness1 + brightness2 + brightness3 + brightness4 + 
                       brightness5 + brightness6 + brightness7 + brightness8;
          
          if (brightness1 >= threshold) brightPixels++;
          if (brightness2 >= threshold) brightPixels++;
          if (brightness3 >= threshold) brightPixels++;
          if (brightness4 >= threshold) brightPixels++;
          if (brightness5 >= threshold) brightPixels++;
          if (brightness6 >= threshold) brightPixels++;
          if (brightness7 >= threshold) brightPixels++;
          if (brightness8 >= threshold) brightPixels++;
        }
        
        // Procesar pixeles restantes
        for (; i < dataLength; i += 4) {
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
      } finally {
        frameProcessingRef.current = false;
      }
    }, [roiSize, coverageThresholdPixelBrightness]);

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
