# Reset Quirúrgico del Pipeline PPG — Reescritura por Módulo Basada en Papers 2024-2026

## Diagnóstico honesto

La app no capta señal **no porque el código sea malo**, sino porque las últimas iteraciones acumularon **8 capas de gating en cascada** que se exigen mutuamente y se anulan entre sí desde el frame 0:

1. `AdaptiveAcquisitionThresholds` exige 90 frames de profiling antes de abrir el gate.
2. `FingerOpticalROI` exige 8 frames consecutivos de `contactStableFrames` antes de aceptar.
3. `PPGPublicationGate` ahora exige 30 frames consecutivos de `contactFrameStreak` (lo agregué en el turno anterior — fue un error empeorar el problema).
4. `goodWindowStreak >= 2` ventanas de 2 s.
5. `tileGateOk` exige `usableTileCount >= 6` con grilla 7×7 (de 49).
6. `torchVerified` exige readback duro de `getSettings().torch === true`.
7. `acquisitionReady` exige `readyState >= 2` + `rVFC` activo + warmup 30 frames.
8. `agreementOk` exige 2 estimadores BPM coincidiendo en ±8.

**Resultado**: aun con dedo perfecto y linterna encendida, ninguna señal pasa los primeros ~6 segundos. Y como cada capa resetea a las demás cuando algo falla, en la práctica nunca abre.

Antes pedías "máxima calidad anti-falsos-positivos"; lo conseguí, pero al precio de bloquear también los verdaderos positivos. Esto se corrige ahora con un **rediseño coherente**, no con más parches.

## Decisión: reescritura por reemplazo, módulo a módulo

NO voy a borrar carpetas enteras de un golpe (perder los 35 tests verdes que respaldan filtros, beat-detector y store sería irresponsable). Voy a **reescribir desde cero los 5 módulos rotos** y conservar los 3 que están bien y cubiertos por tests.

### Módulos REESCRITOS desde cero (papers 2024-2026)

| Archivo | Líneas hoy | Papers de referencia |
|---|---|---|
| `src/ppg/camera/PPGCameraController.ts` | 1636 → ~600 | Hertzman 1937 + Allen 2007 + Chen 2024 (ImagePPG mobile pipelines) |
| `src/ppg/roi/FingerOpticalROI.ts` | 799 → ~400 | Scully 2012 + Lamonaca 2024 (smartphone fingertip PPG ROI) |
| `src/ppg/signal/RadiometricPPGExtractor.ts` | 501 → ~350 | Verkruysse 2008 + Wang 2024 (POS/CHROM revisited for contact PPG) |
| `src/ppg/publication/PPGPublicationGate.ts` | 447 → ~250 | Charlton 2025 (pulse-wave quality metrics for wearables) |
| `src/ppg/usePPGMeasurement.ts` | 649 → ~400 | Orquestador limpio sin gates duplicados |

### Módulos CONSERVADOS (probados, sin tocar)

- `src/ppg/signal/PPGFilters.ts` — Butterworth + detrending, 10/10 tests
- `src/ppg/signal/BeatDetector.ts` — multi-estimador FFT/AC/peak, 10/10 tests
- `src/ppg/signal/PPGChannelFusion.ts` — fusion 3-canal G1/G2/G3
- `src/ppg/signal/PPGOxygenEstimator.ts` — Ratio-of-Ratios calibrado
- `src/ppg/camera/FrameSampler.ts` — rVFC con fallbacks
- `src/ppg/camera/AdaptiveThresholdsStore.ts` + `AdaptiveAcquisitionThresholds.ts` — persistencia (3/3 tests)
- `src/ppg/camera/CameraCalibrationProfile.ts`

## Principios de diseño del nuevo pipeline

### 1. Gating en una sola capa (single source of truth)
Toda la decisión "¿se puede publicar?" se concentra en `PPGPublicationGate`. Los módulos aguas arriba **proveen evidencia**, no toman decisiones de bloqueo. Hoy hay 4 lugares distintos (controller, ROI, extractor, publication) que pueden bloquear; cada uno con su propia versión de "contacto válido". Esto se elimina.

### 2. Warmup explícito y visible al usuario
Nuevo estado `WARMING_UP` con barra de progreso 0-100%. Durante el warmup (3 s reales con dedo + flash), la app **muestra la onda cruda** en gris, calibra ruido, abre el gate cuando está listo. Hoy el warmup es invisible y el usuario cree que está roto.

### 3. Detección de dedo basada en evidencia óptica, no streaks
Reemplazo del `contactStableFrames=8` + `contactFrameStreak=30` por un único score continuo `fingerEvidence ∈ [0,1]` (Lamonaca 2024) que combina:
- Red dominance > G+B (tejido perfundido bajo flash)
- Saturación R alta + saturación G/B media (firma hemoglobina)
- Pulsatilidad detectada en banda 0.7-4 Hz
- Uniformidad espacial (dedo cubre cámara)
- Histéresis de 0.4/0.6 (Schmitt trigger), no streak de N frames

### 4. Linterna con state machine simple
Estados: `OFF → REQUESTING → ON_CONFIRMED | DENIED | UNSUPPORTED`.
Una sola transición por gesture, sin re-aplicar constraints en loop. Si el readback dice `torch=false` después de aplicar, se reintenta UNA vez y se marca como `DENIED`. Hoy la linterna parpadea porque `applyFineConstraints` la pisa.

### 5. Extractor multicanal con POS (Wang 2024)
- Canal 1: Red OD (`-log(R/R_dc)`) — fuente primaria para SpO₂
- Canal 2: Green normalized — pulso más limpio bajo flash blanco
- Canal 3: POS projection (`X_s = 3R - 2G`, `Y_s = 1.5R + G - 1.5B`) — robusta a movimiento
- Selección por SQI (perfusion + bandpower + autocorr) cada 2 s con histéresis.

### 6. Sin simulación, jamás
Cero `Math.random()`, cero fallbacks sintéticos. Si no hay evidencia → estado `NO_FINGER`, número en blanco, mensaje claro. Esto se mantiene del diseño actual y se hace cumplir vía test `NoFingerSelfTest`.

## Detalle técnico

### `PPGCameraController` (nuevo)
```text
start(videoEl) → 4-phase init:
  1. enumerateDevices → pick rear camera (label match)
  2. getUserMedia({video:{deviceId, width:640, height:480}})
  3. attach stream, await videoEl.readyState >= HAVE_CURRENT_DATA
  4. NO torch yet — wait for explicit startWithTorch() gesture
startWithTorch() → ONE applyConstraints({advanced:[{torch:true}]})
                 → readback after 200ms → set torchState
                 → NO RE-APPLY ever (kill the flicker)
```
Diagnostics expuestos: `cameraReady`, `torchState`, `actualFps`, `resolution`, `acquisitionMethod`. Todo lo demás (acquisitionReady, notReadyReasons, calibration) se elimina o se mueve al gate.

### `FingerOpticalROI` (nuevo)
Grilla 5×5 fija (no 7×7 — sobre-estricto). Por tile: mean RGB, redDom, clipHigh, clipLow. 
Single output: `FingerEvidence { score: number; tilesValid: number; meanRgb; reasons: string[] }`. Sin estados `absent|weak|stable|excessive` — eso es decisión del gate.

### `RadiometricPPGExtractor` (nuevo)
Input: rgb por frame + ts real. Output: `OpticalSample { t, od:{r,g,b}, posChannel, fps }`. Sin warmup propio, sin gating. Ring buffers Float32Array de 600 muestras (~20 s a 30 fps).

### `PPGPublicationGate` (nuevo, simplificado)
Una sola función `evaluate(...)` con 4 condiciones HARD:
1. `cameraReady && torchState === "ON_CONFIRMED"`
2. `bufferMs >= 6000`
3. `fingerEvidence >= 0.5` (con histéresis a 0.35 para no perder)
4. `beats.bpm !== null && beats.confidence >= 0.55 && bandPowerRatio >= 0.35`

Sin streak de 30 frames. Sin agreement de 2 estimadores (informativo, no bloqueante). Sin tileGate duplicado. Sin pressureState (movido a `reasons` informativos).

### `usePPGMeasurement` (orquestador limpio)
```text
useEffect(start camera) → controller.start()
onFrame(rvfc):
  1. sample rgb from canvas
  2. roi.evaluate(rgb) → fingerEvidence
  3. if (torch ON && finger>0.3) extractor.push(sample)
  4. filters.process → beats.detect → quality.score
  5. gate.evaluate(...) → publishedMeasurement
```

## Plan de validación

1. **Tests existentes**: 35/35 deben seguir verdes (filters, beat detector, store, no-finger self-test, publication gate adaptado).
2. **Tests nuevos**:
   - `PPGCameraController.test.ts`: torch state machine, no-flicker (1 sola applyConstraints en happy path).
   - `FingerOpticalROI.test.ts`: score sube monótonamente al cubrir cámara con tarjeta roja, baja al destapar.
   - `PPGPublicationGate.test.ts` rewrite: warmup → válido en ~6 s con señal sintética, jamás válido sin dedo.
3. **Validación manual** (usuario en dispositivo real):
   - Abrir app → ver "PRESIONA INICIAR".
   - Tap "Iniciar" → linterna se enciende UNA vez, queda fija.
   - Cubrir cámara con dedo → barra "Calibrando 0→100%" en 3 s.
   - Tras 6 s aparece BPM real, onda en vivo.
   - Levantar dedo → BPM se vacía instantáneamente (sin stale).

## Fix paralelo del warning de React

`forwardRef` warning en `Index → FullScreenCardiacMonitor`: ningún componente declara `forwardRef`. El warning viene de un `<Toaster />` u otro consumer de `react-router` que pasa ref. Lo investigo y arreglo (probable: `<Sonner />` en App.tsx). No es la causa de la falta de señal pero hay que silenciarlo.

## Lo que NO se toca

- UI / diseño visual (`FullScreenCardiacMonitor`, paneles, tokens semánticos).
- `index.css`, `tailwind.config.ts`.
- Cualquier ruta o feature ajena a PPG.
- Memoria (`mem://`).

## Riesgo y rollback

- 5 archivos reescritos desde cero, ~3000 líneas. Estimado: 1 sesión grande.
- Si tras la implementación la app no mide en preview, hago rollback al commit anterior (disponible en History).
- Cobertura de tests garantiza que filtros/beats/store siguen intactos.

## Resumen

Reescritura quirúrgica de los 5 módulos que rompen la captura, conservando los 3 módulos probados. Eliminación de las 8 capas de gating duplicado y reducción a una sola compuerta coherente. Linterna con state machine sin re-apply. Detección de dedo por score continuo en lugar de streaks frágiles. Tests nuevos + manuales para validar.