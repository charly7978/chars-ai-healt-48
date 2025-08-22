/**
 * Gestor de memoria para prevenir fugas y optimizar el uso
 */

import { logWarn, logError } from './performance-logger';

interface MemoryPool<T> {
  available: T[];
  inUse: Set<T>;
  createFn: () => T;
  resetFn: (item: T) => void;
  maxSize: number;
}

class MemoryManager {
  private static instance: MemoryManager;
  private pools = new Map<string, MemoryPool<any>>();
  private cleanupInterval: number | null = null;
  private weakRefs = new Map<string, WeakRef<any>>();

  private constructor() {
    // Limpieza automática cada 30 segundos
    this.cleanupInterval = window.setInterval(() => {
      this.cleanup();
    }, 30000);

    // Escuchar eventos de memoria baja
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      this.monitorMemory();
    }
  }

  static getInstance(): MemoryManager {
    if (!MemoryManager.instance) {
      MemoryManager.instance = new MemoryManager();
    }
    return MemoryManager.instance;
  }

  /**
   * Crear un pool de objetos reutilizables
   */
  createPool<T>(
    name: string,
    createFn: () => T,
    resetFn: (item: T) => void,
    initialSize = 10,
    maxSize = 100
  ): void {
    if (this.pools.has(name)) {
      logWarn(`Pool ${name} ya existe`);
      return;
    }

    const pool: MemoryPool<T> = {
      available: [],
      inUse: new Set(),
      createFn,
      resetFn,
      maxSize
    };

    // Pre-llenar el pool
    for (let i = 0; i < initialSize; i++) {
      pool.available.push(createFn());
    }

    this.pools.set(name, pool);
  }

  /**
   * Obtener objeto del pool
   */
  acquire<T>(poolName: string): T | null {
    const pool = this.pools.get(poolName);
    if (!pool) {
      logError(`Pool ${poolName} no existe`);
      return null;
    }

    let item: T;

    if (pool.available.length > 0) {
      item = pool.available.pop()!;
    } else if (pool.inUse.size < pool.maxSize) {
      item = pool.createFn();
    } else {
      logWarn(`Pool ${poolName} agotado`);
      return null;
    }

    pool.inUse.add(item);
    return item;
  }

  /**
   * Devolver objeto al pool
   */
  release<T>(poolName: string, item: T): void {
    const pool = this.pools.get(poolName);
    if (!pool || !pool.inUse.has(item)) {
      return;
    }

    pool.inUse.delete(item);
    pool.resetFn(item);
    pool.available.push(item);
  }

  /**
   * Registrar referencia débil
   */
  registerWeakRef(key: string, obj: any): void {
    this.weakRefs.set(key, new WeakRef(obj));
  }

  /**
   * Obtener referencia débil
   */
  getWeakRef(key: string): any | undefined {
    const ref = this.weakRefs.get(key);
    return ref?.deref();
  }

  /**
   * Limpiar pools no utilizados
   */
  private cleanup(): void {
    // Limpiar referencias débiles muertas
    const deadRefs: string[] = [];
    for (const [key, ref] of this.weakRefs) {
      if (ref.deref() === undefined) {
        deadRefs.push(key);
      }
    }
    deadRefs.forEach(key => this.weakRefs.delete(key));

    // Reducir pools sobredimensionados
    for (const [name, pool] of this.pools) {
      const totalSize = pool.available.length + pool.inUse.size;
      if (pool.available.length > 20 && totalSize > pool.maxSize * 0.5) {
        // Eliminar exceso de objetos disponibles
        const toRemove = Math.floor(pool.available.length * 0.3);
        pool.available.splice(0, toRemove);
      }
    }
  }

  /**
   * Monitorear uso de memoria
   */
  private async monitorMemory(): Promise<void> {
    if (!navigator.storage || !navigator.storage.estimate) return;

    try {
      const estimate = await navigator.storage.estimate();
      const usage = estimate.usage || 0;
      const quota = estimate.quota || 0;
      const percentUsed = (usage / quota) * 100;

      if (percentUsed > 80) {
        logWarn(`Uso de almacenamiento alto: ${percentUsed.toFixed(1)}%`);
        this.forceCleanup();
      }
    } catch (error) {
      logError('Error monitoreando memoria:', error);
    }

    // Revisar nuevamente en 10 segundos
    setTimeout(() => this.monitorMemory(), 10000);
  }

  /**
   * Limpieza forzada de memoria
   */
  forceCleanup(): void {
    // Limpiar todos los pools
    for (const [name, pool] of this.pools) {
      const toRemove = Math.floor(pool.available.length * 0.5);
      if (toRemove > 0) {
        pool.available.splice(0, toRemove);
        logWarn(`Limpiando ${toRemove} objetos del pool ${name}`);
      }
    }

    // Solicitar garbage collection si está disponible
    if ('gc' in window) {
      (window as any).gc();
    }
  }

  /**
   * Obtener estadísticas de memoria
   */
  getStats() {
    const stats: Record<string, any> = {
      pools: {},
      weakRefs: this.weakRefs.size
    };

    for (const [name, pool] of this.pools) {
      stats.pools[name] = {
        available: pool.available.length,
        inUse: pool.inUse.size,
        total: pool.available.length + pool.inUse.size,
        maxSize: pool.maxSize
      };
    }

    return stats;
  }

  /**
   * Destruir el gestor
   */
  destroy(): void {
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    this.pools.clear();
    this.weakRefs.clear();
  }
}

// Exportar instancia singleton
export const memoryManager = MemoryManager.getInstance();

/**
 * Pool predefinido para arrays de números
 */
export function createArrayPool(name: string, arraySize: number, initialCount = 10) {
  memoryManager.createPool(
    name,
    () => new Float32Array(arraySize),
    (arr) => arr.fill(0),
    initialCount,
    50
  );
}

/**
 * Pool predefinido para objetos
 */
export function createObjectPool<T>(
  name: string,
  createFn: () => T,
  resetFn: (obj: T) => void,
  initialCount = 10
) {
  memoryManager.createPool(name, createFn, resetFn, initialCount, 100);
}

/**
 * Decorador para limpiar automáticamente recursos
 */
export function AutoCleanup(target: any, propertyKey: string, descriptor: PropertyDescriptor) {
  const originalMethod = descriptor.value;

  descriptor.value = async function(...args: any[]) {
    const resources: (() => void)[] = [];
    
    // Contexto para registrar recursos
    const context = {
      addCleanup: (fn: () => void) => resources.push(fn)
    };

    try {
      // Ejecutar método original con contexto
      const result = await originalMethod.apply(this, [...args, context]);
      return result;
    } finally {
      // Limpiar todos los recursos registrados
      for (const cleanup of resources) {
        try {
          cleanup();
        } catch (error) {
          logError('Error en limpieza automática:', error);
        }
      }
    }
  };

  return descriptor;
}