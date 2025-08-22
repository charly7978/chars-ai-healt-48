/**
 * Sistema de logging optimizado para rendimiento
 * Elimina todos los logs en producción y permite niveles de logging
 */

export enum LogLevel {
  NONE = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
  VERBOSE = 5
}

class PerformanceLogger {
  private static instance: PerformanceLogger;
  private logLevel: LogLevel;
  private isProduction: boolean;
  private logBuffer: string[] = [];
  private bufferSize = 100;
  private flushInterval: number | null = null;

  private constructor() {
    this.isProduction = import.meta.env.MODE === 'production';
    this.logLevel = this.isProduction ? LogLevel.NONE : LogLevel.INFO;
    
    // En desarrollo, flush logs cada segundo para no bloquear el thread principal
    if (!this.isProduction) {
      this.flushInterval = window.setInterval(() => this.flush(), 1000);
    }
  }

  static getInstance(): PerformanceLogger {
    if (!PerformanceLogger.instance) {
      PerformanceLogger.instance = new PerformanceLogger();
    }
    return PerformanceLogger.instance;
  }

  setLevel(level: LogLevel) {
    this.logLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return !this.isProduction && level <= this.logLevel;
  }

  private addToBuffer(message: string) {
    this.logBuffer.push(message);
    if (this.logBuffer.length >= this.bufferSize) {
      this.flush();
    }
  }

  private flush() {
    if (this.logBuffer.length === 0) return;
    
    // Usar requestIdleCallback para no bloquear el thread principal
    if ('requestIdleCallback' in window) {
      requestIdleCallback(() => {
        console.log(this.logBuffer.join('\n'));
        this.logBuffer = [];
      });
    } else {
      console.log(this.logBuffer.join('\n'));
      this.logBuffer = [];
    }
  }

  error(...args: any[]) {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(...args);
    }
  }

  warn(...args: any[]) {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(...args);
    }
  }

  info(...args: any[]) {
    if (this.shouldLog(LogLevel.INFO)) {
      const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      this.addToBuffer(`[INFO] ${message}`);
    }
  }

  debug(...args: any[]) {
    if (this.shouldLog(LogLevel.DEBUG)) {
      const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      this.addToBuffer(`[DEBUG] ${message}`);
    }
  }

  verbose(...args: any[]) {
    if (this.shouldLog(LogLevel.VERBOSE)) {
      const message = args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      this.addToBuffer(`[VERBOSE] ${message}`);
    }
  }

  // Método especial para logs de rendimiento
  performance(label: string, fn: () => void) {
    if (!this.shouldLog(LogLevel.DEBUG)) {
      fn();
      return;
    }

    const start = performance.now();
    fn();
    const end = performance.now();
    const duration = end - start;
    
    if (duration > 16) { // Solo loguear si toma más de un frame (16ms)
      this.warn(`Performance: ${label} took ${duration.toFixed(2)}ms`);
    }
  }

  cleanup() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flush();
  }
}

// Exportar singleton
export const logger = PerformanceLogger.getInstance();

// Exportar funciones convenientes
export const logError = (...args: any[]) => logger.error(...args);
export const logWarn = (...args: any[]) => logger.warn(...args);
export const logInfo = (...args: any[]) => logger.info(...args);
export const logDebug = (...args: any[]) => logger.debug(...args);
export const logVerbose = (...args: any[]) => logger.verbose(...args);
export const logPerformance = (label: string, fn: () => void) => logger.performance(label, fn);