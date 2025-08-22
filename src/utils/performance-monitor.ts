/**
 * Monitor de rendimiento en tiempo real
 * Rastrea métricas clave y detecta problemas de rendimiento
 */

import { logWarn, logError } from './performance-logger';

interface PerformanceMetrics {
  fps: number;
  frameTime: number;
  memoryUsed: number;
  memoryLimit: number;
  jsHeapSize: number;
  cpuTime: number;
  longTasks: number;
  droppedFrames: number;
}

interface PerformanceThresholds {
  minFPS: number;
  maxFrameTime: number;
  maxMemoryUsage: number;
  maxLongTasks: number;
}

class PerformanceMonitor {
  private static instance: PerformanceMonitor;
  private metrics: PerformanceMetrics;
  private thresholds: PerformanceThresholds;
  private callbacks: Set<(metrics: PerformanceMetrics) => void> = new Set();
  private rafId: number | null = null;
  private lastTime = 0;
  private frameCount = 0;
  private fpsHistory: number[] = [];
  private longTaskObserver: PerformanceObserver | null = null;
  private isMonitoring = false;

  private constructor() {
    this.metrics = {
      fps: 0,
      frameTime: 0,
      memoryUsed: 0,
      memoryLimit: 0,
      jsHeapSize: 0,
      cpuTime: 0,
      longTasks: 0,
      droppedFrames: 0
    };

    this.thresholds = {
      minFPS: 24,
      maxFrameTime: 50, // 50ms = 20fps
      maxMemoryUsage: 0.9, // 90% del límite
      maxLongTasks: 5
    };

    this.setupLongTaskObserver();
  }

  static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor();
    }
    return PerformanceMonitor.instance;
  }

  /**
   * Iniciar monitoreo
   */
  start(): void {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    this.lastTime = performance.now();
    this.frameCount = 0;
    this.metrics.longTasks = 0;
    
    this.measureFrame();
  }

  /**
   * Detener monitoreo
   */
  stop(): void {
    this.isMonitoring = false;
    
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Suscribirse a actualizaciones de métricas
   */
  subscribe(callback: (metrics: PerformanceMetrics) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  /**
   * Obtener métricas actuales
   */
  getMetrics(): PerformanceMetrics {
    return { ...this.metrics };
  }

  /**
   * Configurar umbrales
   */
  setThresholds(thresholds: Partial<PerformanceThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
  }

  /**
   * Medir frame actual
   */
  private measureFrame = (): void => {
    if (!this.isMonitoring) return;

    const currentTime = performance.now();
    const deltaTime = currentTime - this.lastTime;
    
    this.frameCount++;

    // Calcular FPS cada segundo
    if (deltaTime >= 1000) {
      this.metrics.fps = Math.round((this.frameCount * 1000) / deltaTime);
      this.fpsHistory.push(this.metrics.fps);
      
      if (this.fpsHistory.length > 60) {
        this.fpsHistory.shift();
      }

      // Verificar umbrales
      this.checkThresholds();
      
      // Actualizar memoria
      this.updateMemoryMetrics();
      
      // Notificar suscriptores
      this.notifySubscribers();
      
      this.frameCount = 0;
      this.lastTime = currentTime;
    }

    // Medir tiempo de frame
    this.metrics.frameTime = deltaTime;

    this.rafId = requestAnimationFrame(this.measureFrame);
  };

  /**
   * Actualizar métricas de memoria
   */
  private updateMemoryMetrics(): void {
    if ('memory' in performance) {
      const memory = (performance as any).memory;
      this.metrics.memoryUsed = memory.usedJSHeapSize;
      this.metrics.memoryLimit = memory.jsHeapSizeLimit;
      this.metrics.jsHeapSize = memory.totalJSHeapSize;
    }
  }

  /**
   * Configurar observador de tareas largas
   */
  private setupLongTaskObserver(): void {
    if (!('PerformanceObserver' in window)) return;

    try {
      this.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) {
            this.metrics.longTasks++;
            logWarn(`Tarea larga detectada: ${entry.duration}ms`);
          }
        }
      });

      this.longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch (error) {
      logError('Error configurando observador de tareas largas:', error);
    }
  }

  /**
   * Verificar umbrales y alertar
   */
  private checkThresholds(): void {
    const warnings: string[] = [];

    if (this.metrics.fps < this.thresholds.minFPS && this.metrics.fps > 0) {
      warnings.push(`FPS bajo: ${this.metrics.fps} (mínimo: ${this.thresholds.minFPS})`);
    }

    if (this.metrics.frameTime > this.thresholds.maxFrameTime) {
      warnings.push(`Tiempo de frame alto: ${this.metrics.frameTime.toFixed(1)}ms`);
    }

    if (this.metrics.memoryLimit > 0) {
      const memoryUsageRatio = this.metrics.memoryUsed / this.metrics.memoryLimit;
      if (memoryUsageRatio > this.thresholds.maxMemoryUsage) {
        warnings.push(`Uso de memoria alto: ${(memoryUsageRatio * 100).toFixed(1)}%`);
      }
    }

    if (this.metrics.longTasks > this.thresholds.maxLongTasks) {
      warnings.push(`Demasiadas tareas largas: ${this.metrics.longTasks}`);
    }

    if (warnings.length > 0) {
      logWarn('⚠️ Problemas de rendimiento detectados:', warnings.join(', '));
    }
  }

  /**
   * Notificar a suscriptores
   */
  private notifySubscribers(): void {
    const metrics = this.getMetrics();
    this.callbacks.forEach(callback => {
      try {
        callback(metrics);
      } catch (error) {
        logError('Error en callback de monitor:', error);
      }
    });
  }

  /**
   * Obtener estadísticas de rendimiento
   */
  getStats() {
    const avgFPS = this.fpsHistory.length > 0
      ? this.fpsHistory.reduce((a, b) => a + b, 0) / this.fpsHistory.length
      : 0;

    const minFPS = this.fpsHistory.length > 0
      ? Math.min(...this.fpsHistory)
      : 0;

    const maxFPS = this.fpsHistory.length > 0
      ? Math.max(...this.fpsHistory)
      : 0;

    return {
      current: this.metrics,
      average: {
        fps: avgFPS,
        minFPS,
        maxFPS
      },
      history: {
        fps: [...this.fpsHistory]
      }
    };
  }

  /**
   * Destruir el monitor
   */
  destroy(): void {
    this.stop();
    this.callbacks.clear();
    
    if (this.longTaskObserver) {
      this.longTaskObserver.disconnect();
      this.longTaskObserver = null;
    }
  }
}

// Exportar instancia singleton
export const performanceMonitor = PerformanceMonitor.getInstance();

/**
 * Hook de React para usar el monitor
 */
import * as React from 'react';

export function usePerformanceMonitor() {
  const [metrics, setMetrics] = React.useState<PerformanceMetrics>(() => 
    performanceMonitor.getMetrics()
  );

  React.useEffect(() => {
    const unsubscribe = performanceMonitor.subscribe(setMetrics);
    performanceMonitor.start();

    return () => {
      unsubscribe();
      // No detener el monitor aquí, otros componentes pueden estar usándolo
    };
  }, []);

  return metrics;
}