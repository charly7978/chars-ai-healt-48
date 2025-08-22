/**
 * Utilidades de rendimiento optimizadas
 */

/**
 * Throttle optimizado con requestAnimationFrame
 * Ideal para operaciones de UI/animación
 */
export function rafThrottle<T extends (...args: any[]) => any>(
  func: T,
  leadingCall = false
): (...args: Parameters<T>) => void {
  let rafId: number | null = null;
  let lastArgs: Parameters<T> | null = null;
  let isThrottled = false;

  return function throttled(...args: Parameters<T>) {
    lastArgs = args;

    if (!isThrottled) {
      if (leadingCall) {
        func(...args);
      }
      isThrottled = true;
    }

    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        if (!leadingCall && lastArgs) {
          func(...lastArgs);
        }
        isThrottled = false;
        rafId = null;
      });
    }
  };
}

/**
 * Throttle con tiempo específico
 * Ideal para operaciones de red o I/O
 */
export function timeThrottle<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: number | null = null;
  let lastRun = 0;
  let lastArgs: Parameters<T> | null = null;

  return function throttled(...args: Parameters<T>) {
    lastArgs = args;
    const now = Date.now();

    if (now - lastRun >= delay) {
      func(...args);
      lastRun = now;
    } else if (!timeoutId) {
      const remaining = delay - (now - lastRun);
      timeoutId = window.setTimeout(() => {
        if (lastArgs) {
          func(...lastArgs);
          lastRun = Date.now();
        }
        timeoutId = null;
      }, remaining);
    }
  };
}

/**
 * Debounce optimizado
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  delay: number,
  options: { leading?: boolean; trailing?: boolean } = {}
): (...args: Parameters<T>) => void {
  let timeoutId: number | null = null;
  let lastArgs: Parameters<T> | null = null;
  let lastThis: any = null;
  let lastCallTime: number | null = null;

  const { leading = false, trailing = true } = options;

  return function debounced(this: any, ...args: Parameters<T>) {
    lastArgs = args;
    lastThis = this;
    const now = Date.now();

    if (!lastCallTime && !leading) {
      lastCallTime = now;
    }

    const shouldCallNow = leading && !timeoutId;

    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      if (trailing && lastArgs) {
        func.apply(lastThis, lastArgs);
      }
      timeoutId = null;
      lastCallTime = null;
      lastArgs = null;
      lastThis = null;
    }, delay);

    if (shouldCallNow) {
      func.apply(this, args);
    }
  };
}

/**
 * Función para ejecutar operaciones pesadas en idle time
 */
export function runOnIdle<T>(
  task: () => T,
  options: { timeout?: number } = {}
): Promise<T> {
  return new Promise((resolve, reject) => {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(
        () => {
          try {
            resolve(task());
          } catch (error) {
            reject(error);
          }
        },
        options
      );
    } else {
      // Fallback para navegadores sin soporte
      setTimeout(() => {
        try {
          resolve(task());
        } catch (error) {
          reject(error);
        }
      }, 1);
    }
  });
}

/**
 * Batch processor para agrupar operaciones
 */
export class BatchProcessor<T> {
  private items: T[] = [];
  private timeoutId: number | null = null;
  private processing = false;

  constructor(
    private processor: (items: T[]) => void | Promise<void>,
    private batchSize = 10,
    private delay = 16 // ~60fps
  ) {}

  add(item: T) {
    this.items.push(item);
    this.scheduleProcess();
  }

  private scheduleProcess() {
    if (this.timeoutId !== null || this.processing) return;

    this.timeoutId = window.setTimeout(() => {
      this.process();
    }, this.delay);
  }

  private async process() {
    if (this.processing || this.items.length === 0) return;

    this.processing = true;
    this.timeoutId = null;

    const batch = this.items.splice(0, this.batchSize);
    
    try {
      await this.processor(batch);
    } catch (error) {
      console.error('Batch processing error:', error);
    } finally {
      this.processing = false;
      
      if (this.items.length > 0) {
        this.scheduleProcess();
      }
    }
  }

  flush() {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    
    if (this.items.length > 0 && !this.processing) {
      this.process();
    }
  }

  clear() {
    this.items = [];
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }
}

/**
 * Memoización con límite de caché
 */
export function memoizeWithLimit<T extends (...args: any[]) => any>(
  func: T,
  limit = 100
): T {
  const cache = new Map<string, any>();
  const keyQueue: string[] = [];

  return ((...args: Parameters<T>) => {
    const key = JSON.stringify(args);
    
    if (cache.has(key)) {
      return cache.get(key);
    }

    const result = func(...args);
    cache.set(key, result);
    keyQueue.push(key);

    if (keyQueue.length > limit) {
      const oldestKey = keyQueue.shift()!;
      cache.delete(oldestKey);
    }

    return result;
  }) as T;
}