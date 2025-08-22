/**
 * Configuración centralizada de optimizaciones de rendimiento
 */

export const PERFORMANCE_CONFIG = {
  // Configuración de logging
  logging: {
    enabled: import.meta.env.MODE !== 'production',
    level: import.meta.env.MODE === 'production' ? 0 : 3, // LogLevel.INFO
    bufferSize: 100,
    flushInterval: 1000
  },

  // Configuración de procesamiento de frames
  camera: {
    targetFPS: 30,
    roiSize: 320,
    throttleMs: 33, // ~30fps
    useWebWorker: true,
    enableTorch: true,
    coverageThreshold: 15,
    // Optimizaciones de bucle
    pixelProcessingBatch: 8, // Procesar 8 pixeles por iteración
    skipFrames: 0 // Procesar todos los frames
  },

  // Configuración de procesamiento de señales
  signalProcessing: {
    windowSizeSec: 8,
    channels: 6,
    sampleRate: 30,
    // Umbrales de detección
    minVarianceForPulse: 1.5,
    minSNRForFinger: 1.1,
    minRMeanForFinger: 60,
    maxRMeanForFinger: 240,
    // Debounce
    framesToConfirmFinger: 8,
    framesToLoseFinger: 12,
    // Calidad
    minQualityThreshold: 25,
    minConsensusRatio: 0.33
  },

  // Configuración de caché
  cache: {
    enabled: true,
    maxEntries: 50,
    ttlSeconds: 300,
    cleanupInterval: 60000
  },

  // Configuración de memoria
  memory: {
    pools: {
      arrays: {
        initialSize: 10,
        maxSize: 50
      },
      objects: {
        initialSize: 20,
        maxSize: 100
      }
    },
    cleanupInterval: 30000,
    forceCleanupThreshold: 0.8 // 80% de uso
  },

  // Configuración de Web Workers
  webWorkers: {
    enabled: true,
    poolSize: 2,
    timeout: 5000
  },

  // Umbrales de rendimiento
  performance: {
    minFPS: 24,
    maxFrameTime: 50, // ms
    maxMemoryUsage: 0.9, // 90%
    maxLongTasks: 5,
    // Alertas
    enableWarnings: true,
    enableMetricsOverlay: import.meta.env.MODE !== 'production'
  },

  // Configuración de throttling y debouncing
  optimization: {
    // Throttle para operaciones frecuentes
    throttle: {
      frameProcessing: 33, // ms
      signalAnalysis: 100, // ms
      uiUpdates: 16 // ms (~60fps)
    },
    // Debounce para eventos
    debounce: {
      resize: 250, // ms
      input: 300, // ms
      search: 500 // ms
    }
  },

  // Configuración específica para móviles
  mobile: {
    reducedQuality: true,
    lowerFPS: 24,
    smallerROI: 200,
    disableEffects: true,
    aggressiveCaching: true
  }
} as const;

/**
 * Detectar si es un dispositivo móvil
 */
export function isMobile(): boolean {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  );
}

/**
 * Obtener configuración optimizada según el dispositivo
 */
export function getOptimizedConfig() {
  const baseConfig = { ...PERFORMANCE_CONFIG };
  
  if (isMobile()) {
    // Aplicar configuraciones móviles
    baseConfig.camera.targetFPS = PERFORMANCE_CONFIG.mobile.lowerFPS;
    baseConfig.camera.roiSize = PERFORMANCE_CONFIG.mobile.smallerROI;
    baseConfig.cache.enabled = PERFORMANCE_CONFIG.mobile.aggressiveCaching;
  }

  // Ajustar según capacidades del navegador
  if (!('requestIdleCallback' in window)) {
    baseConfig.logging.flushInterval = 2000; // Menos frecuente
  }

  if (!('PerformanceObserver' in window)) {
    baseConfig.performance.maxLongTasks = Infinity; // Desactivar
  }

  return baseConfig;
}

/**
 * Configuración para desarrollo vs producción
 */
export const IS_PRODUCTION = import.meta.env.MODE === 'production';
export const IS_DEVELOPMENT = import.meta.env.MODE === 'development';

/**
 * URLs y endpoints optimizados
 */
export const API_CONFIG = {
  baseURL: import.meta.env.VITE_API_URL || '',
  timeout: 30000,
  retries: 3,
  // Configuración de caché HTTP
  cacheTime: 5 * 60 * 1000, // 5 minutos
  staleTime: 2 * 60 * 1000  // 2 minutos
};