# DETECCIÓN DE LATIDOS SIMPLE Y REAL

## CAMBIOS IMPLEMENTADOS

### 1. DETECTOR SIMPLE Y EFECTIVO (`SimplePPGDetector.ts`)

**Características:**
- Algoritmo probado basado en literatura científica
- Media móvil de 750ms (tamaño típico de latido)
- Umbral dinámico: media + 0.5 * desviación estándar
- Validación de intervalos: 400-1500ms (40-150 BPM)
- Sin filtros complejos que puedan eliminar la señal

### 2. SIMPLIFICACIÓN RADICAL

**Eliminado:**
- ❌ Filtros Butterworth complejos
- ❌ Transformadas Wavelet
- ❌ Múltiples métodos de detección
- ❌ Procesamiento excesivo

**Mantenido:**
- ✅ Señal directa del canal rojo
- ✅ Suavizado mínimo (ventana de 5)
- ✅ Detección de máximos locales
- ✅ Validación fisiológica simple

### 3. UMBRALES MÁS PERMISIVOS

```typescript
minRMeanForFinger = 50      // (era 60)
minVarianceForPulse = 0.5   // (era 2.5)
minSNRForFinger = 0.8       // (era 1.8)
minStdSmoothForPulse = 0.05 // (era 0.25)
maxRRCoeffVar = 0.30        // (era 0.15)
```

### 4. DEBUGGING MEJORADO

- Logs cada 30 muestras cuando hay señal
- Muestra: número de picos, BPM, amplitud
- Visualización de primeros intervalos RR
- Estados de detección en tiempo real

## CÓMO FUNCIONA AHORA

1. **Captura**: Canal rojo directo de la cámara
2. **Normalización**: Usando percentiles 5-95%
3. **Media móvil**: Ventana de 750ms
4. **Señal AC**: Resta de media móvil
5. **Detección**: Máximos locales > umbral dinámico
6. **Validación**: Intervalos entre 400-1500ms
7. **BPM**: Promedio sin outliers

## RESULTADO ESPERADO

✅ Detección más sensible a latidos débiles
✅ Menos pérdida de señal por filtrado excesivo
✅ Respuesta más rápida
✅ Logs claros para debugging

## PARA VERIFICAR

En la consola deberías ver:

```
💓 Muestra de cámara: {
  rMean: "145.2",
  coverageRatio: "65%",
  fingerConfidence: "82%"
}

🎯 SimplePPG - Latidos detectados: {
  numPeaks: 8,
  bpm: 72,
  amplitude: "0.245",
  peakPositions: ["1.2s", "2.0s", "2.8s", "3.6s", "4.5s"]
}

🔍 Canal 0 - Detección detallada: {
  numPicos: 8,
  bpm: 72,
  amplitud: "0.245",
  señalVálida: true,
  intervalosRR: ["833ms", "817ms", "845ms"]
}
```

Si no ves estos logs o los latidos no se detectan:
1. Verificar que el dedo esté bien colocado
2. Asegurar buena iluminación (flash activado)
3. Mantener el dedo quieto
4. El área roja debe cubrir >50% del ROI