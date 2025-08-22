/**
 * Web Worker para procesamiento de señales PPG
 * Mueve el procesamiento pesado fuera del thread principal
 */

import { goertzelPower } from '../modules/signal-processing/Goertzel';
import { savitzkyGolay } from '../modules/signal-processing/SavitzkyGolayFilter';
import { detectPeaks } from '../modules/signal-processing/TimeDomainPeak';

interface ProcessSignalMessage {
  type: 'PROCESS_SIGNAL';
  data: {
    samples: number[];
    sampleRate: number;
    windowSize: number;
  };
}

interface ProcessResultMessage {
  type: 'SIGNAL_PROCESSED';
  data: {
    bpm: number | null;
    quality: number;
    snr: number;
    peaks: number[];
    rrIntervals: number[];
  };
}

// Procesamiento optimizado de señal
function processSignal(samples: number[], sampleRate: number): ProcessResultMessage['data'] {
  const N = samples.length;
  
  // Estadísticas básicas
  const mean = samples.reduce((a, b) => a + b, 0) / N;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / N;
  const std = Math.sqrt(variance);
  
  if (std < 0.5) {
    return {
      bpm: null,
      quality: 0,
      snr: 0,
      peaks: [],
      rrIntervals: []
    };
  }
  
  // Normalización
  const normalized = samples.map(x => (x - mean) / std);
  
  // Filtrado Savitzky-Golay
  const smooth = savitzkyGolay(normalized, 15);
  
  // Análisis espectral con Goertzel (optimizado)
  const freqStart = 0.8;
  const freqEnd = 4.0;
  const freqStep = 0.05;
  const numFreqs = Math.floor((freqEnd - freqStart) / freqStep);
  
  let maxPower = 0;
  let peakFreq = 0;
  
  for (let i = 0; i < numFreqs; i++) {
    const freq = freqStart + i * freqStep;
    const power = goertzelPower(smooth, sampleRate, freq);
    
    if (power > maxPower) {
      maxPower = power;
      peakFreq = freq;
    }
  }
  
  // Calcular SNR
  const noiseSamples: number[] = [];
  for (let i = 0; i < numFreqs; i++) {
    const freq = freqStart + i * freqStep;
    if (Math.abs(freq - peakFreq) > 0.5) {
      const power = goertzelPower(smooth, sampleRate, freq);
      noiseSamples.push(power);
    }
  }
  
  const noisePower = noiseSamples.length > 0 ? 
    noiseSamples.reduce((a, b) => a + b, 0) / noiseSamples.length : 
    1e-6;
  
  const snr = maxPower / Math.max(1e-6, noisePower);
  
  // Detección de picos
  const { peaks, peakTimesMs, rr } = detectPeaks(smooth, sampleRate, 400, 0.12);
  
  // Calcular BPM
  let bpm: number | null = null;
  if (maxPower > 1e-5) {
    bpm = Math.round(peakFreq * 60);
  }
  
  // Calidad basada en múltiples factores
  const qualitySpectral = Math.min(40, Math.max(0, (snr - 1) * 20));
  const qualityVariance = variance > 1.5 ? 25 : 0;
  const qualityPeaks = peaks.length > 5 ? 20 : peaks.length * 4;
  const quality = qualitySpectral + qualityVariance + qualityPeaks;
  
  return {
    bpm,
    quality: Math.min(100, Math.max(0, quality)),
    snr,
    peaks,
    rrIntervals: rr
  };
}

// Manejador de mensajes
self.addEventListener('message', (event: MessageEvent<ProcessSignalMessage>) => {
  if (event.data.type === 'PROCESS_SIGNAL') {
    const { samples, sampleRate } = event.data.data;
    
    try {
      const result = processSignal(samples, sampleRate);
      
      const response: ProcessResultMessage = {
        type: 'SIGNAL_PROCESSED',
        data: result
      };
      
      self.postMessage(response);
    } catch (error) {
      self.postMessage({
        type: 'ERROR',
        data: { error: (error as Error).message }
      });
    }
  }
});

export {};