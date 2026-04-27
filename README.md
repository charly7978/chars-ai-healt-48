# Forensic PPG Cardiac Monitor

Aplicación biomédica profesional para adquisición de señales fotopletismográficas (PPG) mediante cámara trasera de dispositivos móviles con iluminación LED (flash/torch).

## ⚠️ Advertencias Técnicas Críticas

**PPG Óptico ≠ ECG Bioeléctrico**
- Esta aplicación mide **variaciones de luz reflejada** en tejido vascular, no actividad eléctrica cardíaca.
- El PPG es susceptible a artefactos de movimiento, presión inconsistente del dedo, y variaciones de perfusión.

**SpO2 Absoluto Requiere Calibración por Dispositivo**
- Los valores de saturación de oxígeno estimados por software sin calibración específica del hardware (LEDs, sensor CMOS, óptica) tienen **margen de error significativo**.
- No usar para diagnóstico médico sin validación clínica del dispositivo específico.

**Presión Arterial / Glucosa / Lípidos**
- Estos parámetros **NO se calculan** en esta versión. Cualquier publicación de BP, glucosa, o lípidos requiere:
  - Modelo calibrado y validado clínicamente
  - Aprobación regulatoria (FDA/CE/ANMAT)
  - Estudio de equivalencia con método estándar de referencia

## 📊 Flujo de Datos Real

```
CAMERA FRAME (Real) → FrameSampler → RadiometricPPGExtractor → PPGChannelFusion → BeatDetector → PPGSignalQuality → PPGPublicationGate → UI
                     ↓                                                      ↑
                FingerOpticalROI                                       Evidence Gate
```

El sistema solo renderiza:
- **Waveform** cuando `waveformSource === "REAL_PPG"`
- **BPM** cuando `canPublishVitals === true`
- **SpO2** cuando `oxygen.canPublish === true` (con confianza > umbral)

## 🚀 Cómo Correr

```bash
# Instalar dependencias
npm install

# Desarrollo local
npm run dev

# Build producción
npm run build

# Preview build
npm run preview
```

## 📱 Prueba en Dispositivo Real

1. Conectar dispositivo Android/iOS por USB
2. Habilitar modo desarrollador y USB debugging
3. Ejecutar: `npm run dev -- --host`
4. En el dispositivo, navegar a la IP local mostrada
5. **Requisitos críticos:**
   - Cámara trasera con flash LED
   - Dedo cubriendo completamente la lente
   - Presión suave y constante
   - Mínimo movimiento relativo

## 🐛 Panel Forense/Debug

Haz clic en el icono **Bug** (esquina inferior derecha) durante medición para ver:
- Estado de cámara y torch
- Estadísticas de muestreo de frames
- Valores RGB/OD en tiempo real
- SQI (Signal Quality Index) detallado
- Códigos de rechazo de publicación

## 🏗️ Arquitectura del Pipeline PPG

| Módulo | Descripción |
|--------|-------------|
| `PPGCameraController.ts` | Acceso MediaDevices, gestión de torch |
| `FrameSampler.ts` | Muestreo temporal de frames a 30fps objetivo |
| `RadiometricPPGExtractor.ts` | Extracción de valores ópticos densidad óptica (OD) |
| `PPGChannelFusion.ts` | Fusión multicanal G1/G2/G3 con selección adaptativa |
| `BeatDetector.ts` | Detección de picos sistólicos en señal fusionada |
| `PPGSignalQuality.ts` | Análisis SQI: perfusión, acuerdo de estimadores, bandas frecuenciales |
| `PPGPublicationGate.ts` | Gating final: solo publica si evidencia supera umbrales técnicos |
| `PPGOxygenEstimator.ts` | Estimación relativa SpO2 (no absoluta sin calibración) |

## 📝 Licencia y Uso

Esta aplicación es para **investigación y desarrollo** de algoritmos PPG. No está aprobada para diagnóstico médico sin validación regulatoria adicional.

---

**Stack Tecnológico:** React 18 + TypeScript + Vite + Tailwind CSS
