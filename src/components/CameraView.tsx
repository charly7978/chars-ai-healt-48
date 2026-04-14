
import React, { useRef, useEffect, useState } from 'react';
import { toast } from "@/components/ui/use-toast";

interface CameraViewProps {
  onStreamReady?: (stream: MediaStream) => void;
  isMonitoring: boolean;
  isFingerDetected?: boolean;
  signalQuality?: number;
}

/**
 * COMPONENTE CÁMARA COMPLETAMENTE UNIFICADO - ELIMINADAS TODAS LAS DUPLICIDADES
 * Sistema matemático avanzado sin memory leaks ni procesamiento redundante
 */
const CameraView = ({ 
  onStreamReady, 
  isMonitoring, 
  isFingerDetected = false, 
  signalQuality = 0,
}: CameraViewProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [deviceSupportsTorch, setDeviceSupportsTorch] = useState(false);
  const cameraInitialized = useRef<boolean>(false);
  const sessionIdRef = useRef<string>("");

  // GENERAR SESSION ID ÚNICO
  useEffect(() => {
    const t = Date.now().toString(36);
    const p = (performance.now() | 0).toString(36);
    sessionIdRef.current = `camera_${t}_${p}`;
  }, []);

  // FUNCIÓN UNIFICADA DE PARADA DE CÁMARA
  const stopCamera = async () => {
    if (!stream) return;
    
    console.log(`📹 Deteniendo cámara unificada - ${sessionIdRef.current}`);
    
    stream.getTracks().forEach(track => {
      if (track.kind === 'video' && track.getCapabilities()?.torch) {
        track.applyConstraints({
          advanced: [{ torch: false }]
        }).catch(() => {});
      }
      track.stop();
    });
    
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    
    setStream(null);
    setTorchEnabled(false);
    cameraInitialized.current = false;
    
    console.log(`✅ Cámara detenida - ${sessionIdRef.current}`);
  };

  // FUNCIÓN UNIFICADA DE INICIO DE CÁMARA - ELIMINADAS DUPLICIDADES
  const startCamera = async () => {
    if (stream || cameraInitialized.current) {
      console.warn(`⚠️ Cámara ya inicializada - ${sessionIdRef.current}`);
      return;
    }
    
    try {
      console.log(`📹 Iniciando cámara unificada avanzada - ${sessionIdRef.current}`);
      
      if (!navigator.mediaDevices?.getUserMedia) {
        console.error(`❌ getUserMedia no soportado`);
        throw new Error("getUserMedia no soportado en este navegador");
      }
      
      console.log(`📹 getUserMedia disponible, solicitando acceso...`);

      // DETECCIÓN UNIFICADA DE PLATAFORMA
      const isAndroid = /android/i.test(navigator.userAgent);
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

      // CONFIGURACIÓN MATEMÁTICAMENTE OPTIMIZADA PARA PPG
      const baseVideoConstraints: MediaTrackConstraints = {
        facingMode: { exact: 'environment' },
        width: { ideal: 1280, min: 640 },
        height: { ideal: 720, min: 480 },
        frameRate: { ideal: 30, min: 15 },
        aspectRatio: { ideal: 16/9 }
      };

      // OPTIMIZACIONES ESPECÍFICAS POR PLATAFORMA
      if (isAndroid) {
        Object.assign(baseVideoConstraints, {
          resizeMode: 'crop-and-scale',
          latency: { ideal: 0.1 }
        });
      }

      const micAudio: MediaTrackConstraints = {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      };

      const constraints: MediaStreamConstraints = {
        video: baseVideoConstraints,
        audio: micAudio
      };

      // Intento principal y fallbacks controlados para asegurar cámara trasera (+ micrófono para PTT)
      let newStream: MediaStream | null = null;
      try {
        newStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (primaryErr) {
        console.warn(`⚠️ Fallback getUserMedia (ideal environment): ${primaryErr}`);
        try {
          newStream = await navigator.mediaDevices.getUserMedia({
            video: { ...baseVideoConstraints, facingMode: { ideal: 'environment' } },
            audio: micAudio
          });
        } catch (secondaryErr) {
          console.warn(`⚠️ Fallback getUserMedia (string environment): ${secondaryErr}`);
          try {
            newStream = await navigator.mediaDevices.getUserMedia({
              video: { ...baseVideoConstraints, facingMode: 'environment' as any },
              audio: micAudio
            } as any);
          } catch (tertiaryErr) {
            console.warn(`⚠️ Fallback getUserMedia (video:true, sin audio): ${tertiaryErr}`);
            try {
              newStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: micAudio });
            } catch {
              newStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
            }
          }
        }
      }
      if (!newStream) throw new Error('No fue posible obtener stream de cámara');
      const videoTrack = newStream.getVideoTracks()[0];

      if (videoTrack) {
        try {
          const capabilities = videoTrack.getCapabilities();
          const advancedConstraints: MediaTrackConstraintSet[] = [];
          
          // CONFIGURACIÓN MATEMÁTICA AVANZADA PARA MEDICIONES PPG PRECISAS
          
          // 1. Control de exposición manual para estabilidad óptica
          if (capabilities.exposureMode) {
            advancedConstraints.push({ exposureMode: 'manual' });
            if (capabilities.exposureTime) {
              const optimalExposureTime = Math.min(
                capabilities.exposureTime.max || 1000,
                800 // Tiempo óptimo para captura PPG
              );
              advancedConstraints.push({ exposureTime: optimalExposureTime });
            }
          }
          
          // 2. Configuración de ganancia automática (reemplaza ISO no estándar)
          if (capabilities.autoGainControl !== undefined) {
            advancedConstraints.push({ autoGainControl: false });
          }
          
          // 3. Enfoque continuo para mantener nitidez constante
          if (capabilities.focusMode) {
            advancedConstraints.push({ focusMode: 'continuous' });
          }
          
          // 4. Balance de blancos automático continuo
          if (capabilities.whiteBalanceMode) {
            advancedConstraints.push({ whiteBalanceMode: 'continuous' });
          }
          
          // 5. Reducción de ruido para mejorar SNR
          if (capabilities.noiseSuppression) {
            advancedConstraints.push({ noiseSuppression: true });
          }

          // APLICAR CONFIGURACIONES AVANZADAS
          if (advancedConstraints.length > 0) {
            await videoTrack.applyConstraints({
              advanced: advancedConstraints
            });
            console.log(`📹 Configuraciones avanzadas aplicadas: ${advancedConstraints.length} - ${sessionIdRef.current}`);
          }

          // CONFIGURACIÓN UNIFICADA DE LINTERNA PARA PPG
          if (capabilities.torch) {
            setDeviceSupportsTorch(true);
            try {
              await videoTrack.applyConstraints({
                advanced: [{ torch: true }]
              });
              setTorchEnabled(true);
              console.log(`🔦 Linterna PPG activada - ${sessionIdRef.current}`);
            } catch (torchErr) {
              console.error(`❌ Error activando linterna: ${torchErr} - ${sessionIdRef.current}`);
              setTorchEnabled(false);
            }
          } else {
            console.warn(`⚠️ Dispositivo sin linterna - calidad PPG puede ser inferior - ${sessionIdRef.current}`);
          }
        } catch (configErr) {
          console.log(`⚠️ Algunas configuraciones avanzadas no aplicadas: ${configErr} - ${sessionIdRef.current}`);
        }
      }

      // ASIGNACIÓN UNIFICADA DEL STREAM AL ELEMENTO VIDEO
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
        
        // OPTIMIZACIONES DE RENDIMIENTO ESPECÍFICAS
        if (isAndroid) {
          videoRef.current.style.willChange = 'transform';
          videoRef.current.style.transform = 'translateZ(0)';
          videoRef.current.style.backfaceVisibility = 'hidden';
        }
      }

      setStream(newStream);
      cameraInitialized.current = true;
      
      // CALLBACK UNIFICADO DE STREAM LISTO
      if (onStreamReady) {
        console.log(`✅ Stream PPG listo - ${sessionIdRef.current}`);
        onStreamReady(newStream);
      }
      
    } catch (err) {
      console.error(`❌ Error crítico inicializando cámara: ${err} - ${sessionIdRef.current}`);
      cameraInitialized.current = false;
      
      toast({
        title: "Error de Cámara Crítico",
        description: `No se pudo acceder a la cámara trasera: ${err}`,
        variant: "destructive",
        duration: 5000
      });
    }
  };

  // CONTROL UNIFICADO DEL CICLO DE VIDA DE LA CÁMARA
  useEffect(() => {
    console.log(`📹 CAMERA EFFECT: isMonitoring=${isMonitoring}, stream=${!!stream}, cameraInitialized=${cameraInitialized.current}`);
    if (isMonitoring && !stream && !cameraInitialized.current) {
      console.log(`📹 Iniciando cámara...`);
      startCamera();
    } else if (!isMonitoring && stream) {
      console.log(`📹 Deteniendo cámara...`);
      stopCamera();
    }
    
    return () => {
      stopCamera();
    };
  }, [isMonitoring]);

  // MANTENIMIENTO UNIFICADO DE LINTERNA - ELIMINA DUPLICIDADES
  useEffect(() => {
    if (!stream || !deviceSupportsTorch || !isMonitoring) return;
    
    const maintainTorchStability = async () => {
      if (!isMonitoring || !stream) return;

      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) return;
      
      try {
        const settings = videoTrack.getSettings && (videoTrack.getSettings() as any);
        const currentTorchState = settings?.torch;

        // VERIFICACIÓN Y CORRECCIÓN AUTOMÁTICA DEL ESTADO DE LINTERNA
        if (!currentTorchState && deviceSupportsTorch) {
          console.log(`🔦 Reactivando linterna PPG - ${sessionIdRef.current}`);
          await videoTrack.applyConstraints({
            advanced: [{ torch: true }]
          });
          setTorchEnabled(true);
        } else if (currentTorchState) {
          setTorchEnabled(true);
        }
      } catch (maintainErr) {
        console.warn(`⚠️ Error manteniendo linterna: ${maintainErr} - ${sessionIdRef.current}`);
        setTorchEnabled(false);
      }
    };
    
    // INTERVALO UNIFICADO DE MANTENIMIENTO
    maintainTorchStability(); // Ejecución inicial inmediata
    const maintenanceInterval = setInterval(maintainTorchStability, 3000);
    
    return () => clearInterval(maintenanceInterval);
  }, [stream, isMonitoring, deviceSupportsTorch]);

  // ELEMENTO VIDEO UNIFICADO CON OPTIMIZACIONES COMPLETAS
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
        backfaceVisibility: 'hidden',
        imageRendering: 'auto'
      }}
      onLoadedMetadata={() => {
        console.log(`📹 Metadatos de video cargados - ${sessionIdRef.current}`);
      }}
      onError={(err) => {
        console.error(`❌ Error en elemento video: ${err} - ${sessionIdRef.current}`);
      }}
    />
  );
};

export default CameraView;
