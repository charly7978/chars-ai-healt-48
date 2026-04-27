Entiendo la corrección: no voy a quitar complejidad ni relajar todo como parche. El problema real es que la ruta activa actual (`src/ppg/*`) no contiene ni usa los módulos avanzados previos de `src/modules/*`; además, el pipeline actual descarta frames antes de conservar evidencia diagnóstica, exige condiciones demasiado rígidas para publicar, y la UI/debug puede quedar mostrando “nada” aunque haya cámara y señal cruda parcial.

Plan de implementación directa:

1. Restaurar observabilidad real del pipeline, sin inventar datos
   - Hacer que `RadiometricPPGExtractor` siempre conserve la última evidencia ROI aunque el frame sea rechazado.
   - Exponer en `usePPGMeasurement.debug` el motivo exacto de bloqueo: cámara, sampler, ROI, extractor, canal, beat detector, quality gate o publication gate.
   - Evitar que `rawSamples`, `beats` y `published.evidence.roi` queden congelados en estado vacío cuando el extractor rechaza frames.

2. Corregir detección de dedo sin bajar el estándar médico
   - Separar “finger evidence” de “PPG-valid evidence”: aceptar contacto óptico cuando hay patrón de dedo real, pero marcar aparte si todavía no hay señal publicable.
   - Recalibrar criterios de ROI para smartphone con dedo+flash: usar red dominance, cobertura, clipping, estabilidad DC y presión como componentes separados, no como rechazo único prematuro.
   - Mantener rechazos duros solo para casos físicamente inválidos: cámara oscura, saturación destructiva extrema, muy pocos píxeles válidos o ausencia clara de dedo.

3. Reparar extracción cruda PPG y acumulación de buffer
   - No cortar la cadena completa en `processFrame` solo porque una subcondición de ROI falla; conservar muestras de diagnóstico cuando existe contacto óptico suficiente, y bloquear publicación si la calidad no alcanza.
   - Ajustar baseline robusto para arranque: evitar que el OD sea casi cero por baseline igual al frame actual durante demasiados segundos.
   - Reducir uso de `shift()` en hot paths donde sea viable sin refactor cosmético, para no degradar FPS móvil.

4. Recuperar peak detection robusta en la ruta que realmente se ejecuta
   - Reemplazar el detector simple de `src/ppg/signal/BeatDetector.ts` por un detector multi-evidencia real:
     - picos sistólicos,
     - soporte por derivada/upstroke,
     - soporte por envolvente/prominencia,
     - refractory hard/soft/recovery dependiente de expectedRR,
     - supresión explícita de doble pico,
     - candidatos rechazados con reason y scores.
   - Añadir `detectorAgreement` y `beatSQI` por beat/candidato, sin mocks.

5. Reparar BPM fusion sin exigir triple coincidencia absoluta para “medir nada”
   - Mantener FFT/autocorr/peaks como hipótesis separadas.
   - Fusionar por pesos dinámicos usando SQI, acuerdo temporal, autocorr y estabilidad RR.
   - No publicar BPM si no hay evidencia suficiente, pero sí permitir estado “validating” con hipótesis y razones visibles en debug.
   - Añadir inferencia de missed-beat cuando RR sea anormalmente largo y mostrar qué hipótesis corrigió la línea temporal.

6. Hacer que el gate publique de forma estricta pero alcanzable
   - Mantener `canPublishVitals=false` si no hay evidencia real.
   - Cambiar el gate de “todo o nada con 3 estimadores perfectos <=5 BPM” a “calidad ponderada + coherencia mínima + estabilidad temporal”.
   - Separar claramente:
     - `waveformSource=RAW_DEBUG_ONLY` para señal real no publicable,
     - `waveformSource=REAL_PPG` solo para señal validada,
     - BPM visible solo cuando `canPublishVitals` sea verdadero.

7. Ampliar HUD forense para que diga exactamente por qué no mide
   - Mostrar última evidencia ROI aunque no haya sample aceptado.
   - Mostrar métricas por canal: SNR, bandPowerRatio, autocorrPeakStrength, score final.
   - Mostrar candidatos de beats, detectorAgreement breakdown, refractory windows, missed-beat inference y consistencia beatSQI.
   - Mostrar bloqueo principal ordenado por etapa, no solo una lista larga de reasons.

8. Validación técnica
   - Ejecutar TypeScript/build.
   - Revisar que no se introduzcan mocks, `Math.random()` ni valores vitales inventados.
   - Entregar resumen preciso de archivos cambiados y qué mejora cada cambio en detección de dedo, señal cruda, peaks, BPM fusion, SQI y performance.