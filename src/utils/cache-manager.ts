/**
 * Sistema de caché optimizado con LRU (Least Recently Used) y TTL (Time To Live)
 */

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  accessCount: number;
  lastAccess: number;
}

export class CacheManager<T = any> {
  private cache = new Map<string, CacheEntry<T>>();
  private accessQueue: string[] = [];
  private readonly maxSize: number;
  private readonly ttl: number; // milliseconds
  private cleanupInterval: number | null = null;

  constructor(maxSize = 100, ttlSeconds = 300) {
    this.maxSize = maxSize;
    this.ttl = ttlSeconds * 1000;
    
    // Cleanup automático cada minuto
    this.cleanupInterval = window.setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Obtener valor del caché
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return undefined;
    }

    // Verificar TTL
    if (Date.now() - entry.timestamp > this.ttl) {
      this.delete(key);
      return undefined;
    }

    // Actualizar acceso
    entry.lastAccess = Date.now();
    entry.accessCount++;
    
    // Mover al final de la cola (más reciente)
    this.updateAccessQueue(key);
    
    return entry.value;
  }

  /**
   * Guardar valor en caché
   */
  set(key: string, value: T): void {
    // Si ya existe, actualizar
    if (this.cache.has(key)) {
      const entry = this.cache.get(key)!;
      entry.value = value;
      entry.timestamp = Date.now();
      entry.lastAccess = Date.now();
      entry.accessCount++;
      this.updateAccessQueue(key);
      return;
    }

    // Si alcanzamos el límite, eliminar el menos usado
    if (this.cache.size >= this.maxSize) {
      this.evictLRU();
    }

    // Agregar nueva entrada
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      accessCount: 1,
      lastAccess: Date.now()
    });
    
    this.accessQueue.push(key);
  }

  /**
   * Eliminar del caché
   */
  delete(key: string): boolean {
    const deleted = this.cache.delete(key);
    if (deleted) {
      const index = this.accessQueue.indexOf(key);
      if (index > -1) {
        this.accessQueue.splice(index, 1);
      }
    }
    return deleted;
  }

  /**
   * Limpiar todo el caché
   */
  clear(): void {
    this.cache.clear();
    this.accessQueue = [];
  }

  /**
   * Obtener estadísticas del caché
   */
  getStats() {
    const entries = Array.from(this.cache.entries());
    const now = Date.now();
    
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl,
      entries: entries.map(([key, entry]) => ({
        key,
        age: now - entry.timestamp,
        accessCount: entry.accessCount,
        lastAccess: now - entry.lastAccess
      }))
    };
  }

  /**
   * Actualizar posición en cola de acceso
   */
  private updateAccessQueue(key: string): void {
    const index = this.accessQueue.indexOf(key);
    if (index > -1) {
      this.accessQueue.splice(index, 1);
    }
    this.accessQueue.push(key);
  }

  /**
   * Eliminar entrada menos recientemente usada
   */
  private evictLRU(): void {
    if (this.accessQueue.length === 0) return;
    
    // Encontrar el elemento menos usado
    let lruKey = this.accessQueue[0];
    let minScore = Infinity;
    
    for (const key of this.accessQueue) {
      const entry = this.cache.get(key);
      if (entry) {
        // Score basado en frecuencia y recencia
        const recencyScore = Date.now() - entry.lastAccess;
        const frequencyScore = 1 / (entry.accessCount + 1);
        const score = recencyScore * frequencyScore;
        
        if (score < minScore) {
          minScore = score;
          lruKey = key;
        }
      }
    }
    
    this.delete(lruKey);
  }

  /**
   * Limpiar entradas expiradas
   */
  private cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    for (const [key, entry] of this.cache) {
      if (now - entry.timestamp > this.ttl) {
        keysToDelete.push(key);
      }
    }
    
    for (const key of keysToDelete) {
      this.delete(key);
    }
  }

  /**
   * Destruir el caché
   */
  destroy(): void {
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.clear();
  }
}

/**
 * Caché específico para resultados de procesamiento
 */
export class ProcessingCache extends CacheManager<any> {
  constructor() {
    // 50 entradas máximo, 5 minutos TTL
    super(50, 300);
  }

  /**
   * Generar clave única para señal
   */
  generateKey(signal: number[], params: Record<string, any> = {}): string {
    // Hash simple pero eficiente
    let hash = 0;
    
    // Hash de los primeros y últimos valores
    const samplePoints = [
      ...signal.slice(0, 10),
      ...signal.slice(-10)
    ];
    
    for (const val of samplePoints) {
      hash = ((hash << 5) - hash) + val;
      hash = hash & hash; // Convert to 32bit integer
    }
    
    // Agregar parámetros al hash
    const paramStr = JSON.stringify(params);
    for (let i = 0; i < paramStr.length; i++) {
      hash = ((hash << 5) - hash) + paramStr.charCodeAt(i);
      hash = hash & hash;
    }
    
    return `${signal.length}_${hash}_${paramStr}`;
  }
}

// Singleton para caché global
export const globalCache = new ProcessingCache();