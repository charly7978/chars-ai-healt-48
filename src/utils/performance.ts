/**
 * @file performance.ts
 * @description Utilidades para optimización de rendimiento
 */

/**
 * Throttle function - limita la frecuencia de ejecución
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): T {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastCallTime = 0;
  
  return ((...args: Parameters<T>) => {
    const now = Date.now();
    const remaining = wait - (now - lastCallTime);
    
    if (remaining <= 0 || remaining > wait) {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      lastCallTime = now;
      return func(...args);
    }
    
    if (!timeout) {
      timeout = setTimeout(() => {
        lastCallTime = Date.now();
        timeout = null;
        func(...args);
      }, remaining);
    }
  }) as T;
}

/**
 * RequestAnimationFrame throttle para UI
 */
export function rafThrottle<T extends (...args: any[]) => any>(func: T): T {
  let rafId: number | null = null;
  let latestArgs: Parameters<T> | null = null;
  
  return ((...args: Parameters<T>) => {
    latestArgs = args;
    
    if (rafId === null) {
      rafId = requestAnimationFrame(() => {
        if (latestArgs) {
          func(...latestArgs);
          latestArgs = null;
        }
        rafId = null;
      });
    }
  }) as T;
}

/**
 * Debounce function - ejecuta después de un período de inactividad
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): T {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  
  return ((...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  }) as T;
}