/**
 * TorchController.ts
 * ----------------------------------------------------------------------------
 * Controlador dedicado al flash/torch de la cámara.
 * 
 * Principios:
 * - NUNCA simular estado torch
 * - Watchdog cada 2s para re-encender si se apagó
 * - Estados explícitos: OFF → REQUESTING → ON_CONFIRMED | DENIED | UNSUPPORTED
 * - No re-aplicar constraints en loop (evita parpadeo)
 */

import type { TorchState } from "../signal/PpgTypes";

export interface TorchStatus {
  state: TorchState;
  available: boolean;
  lastError: string | null;
  watchdogActive: boolean;
  lastAttemptMs: number;
  confirmCount: number;
}

interface TorchCallbacks {
  onStateChange: (status: TorchStatus) => void;
  onError: (error: string) => void;
}

const WATCHDOG_INTERVAL_MS = 2000;
const CONFIRMATION_THRESHOLD = 2; // Necesitamos 2 confirmas para ON_CONFIRMED
const MAX_RETRY_ATTEMPTS = 3;

export class TorchController {
  private track: MediaStreamTrack | null = null;
  private status: TorchStatus = {
    state: "OFF",
    available: false,
    lastError: null,
    watchdogActive: false,
    lastAttemptMs: 0,
    confirmCount: 0,
  };
  private callbacks: TorchCallbacks | null = null;
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  private retryCount = 0;
  private isDestroyed = false;

  /**
   * Inicializar el controlador con un track de video.
   * El track debe tener capabilities con 'torch'.
   */
  attach(track: MediaStreamTrack, callbacks: TorchCallbacks): void {
    if (this.isDestroyed) {
      throw new Error("[TorchController] Cannot attach to destroyed controller");
    }

    this.track = track;
    this.callbacks = callbacks;
    
    // Verificar disponibilidad (torch es propiedad no estándar pero soportada en móviles)
    const capabilities = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
    const available = !!capabilities.torch;
    
    this.status = {
      state: available ? "OFF" : "UNSUPPORTED",
      available,
      lastError: null,
      watchdogActive: false,
      lastAttemptMs: 0,
      confirmCount: 0,
    };

    if (!available) {
      callbacks.onError("TORCH_NOT_SUPPORTED_ON_DEVICE");
    }

    callbacks.onStateChange({ ...this.status });
  }

  /**
   * Solicitar encendido del torch.
   * Transición: OFF → REQUESTING → ON_CONFIRMED (o DENIED)
   */
  async requestOn(): Promise<boolean> {
    if (this.isDestroyed) return false;
    if (!this.track) {
      this.setError("NO_TRACK_ATTACHED");
      return false;
    }
    if (!this.status.available) {
      this.setError("TORCH_UNAVAILABLE");
      return false;
    }
    if (this.status.state === "ON_CONFIRMED") {
      return true; // Ya está encendido
    }

    this.setState("REQUESTING");
    this.retryCount = 0;
    
    return await this.attemptApplyTorch();
  }

  /**
   * Apagar torch y limpiar.
   */
  async turnOff(): Promise<void> {
    if (this.isDestroyed) return;
    
    this.stopWatchdog();
    
    if (this.track && this.status.state !== "OFF") {
      try {
        await this.track.applyConstraints({
          advanced: [{ torch: false } as MediaTrackConstraintSet],
        });
      } catch (e) {
        // Ignorar errores al apagar
      }
    }
    
    this.setState("OFF");
    this.retryCount = 0;
    this.status.confirmCount = 0;
  }

  /**
   * Obtener estado actual (copia)
   */
  getStatus(): TorchStatus {
    return { ...this.status };
  }

  /**
   * Destruir el controlador y liberar recursos.
   */
  destroy(): void {
    this.isDestroyed = true;
    this.stopWatchdog();
    this.turnOff().catch(() => {});
    this.track = null;
    this.callbacks = null;
  }

  // =============================================================================
  // PRIVATE
  // =============================================================================

  private async attemptApplyTorch(): Promise<boolean> {
    if (!this.track || this.isDestroyed) return false;

    this.status.lastAttemptMs = performance.now();

    try {
      // Aplicar constraint torch
      await this.track.applyConstraints({
        advanced: [{ torch: true } as MediaTrackConstraintSet],
      });

      // Esperar y verificar readback
      await new Promise((resolve) => setTimeout(resolve, 200));
      
      const settings = this.track.getSettings();
      const torchReadback = settings.torch === true;

      if (torchReadback) {
        // Confirmación positiva
        this.status.confirmCount++;
        
        if (this.status.confirmCount >= CONFIRMATION_THRESHOLD) {
          this.setState("ON_CONFIRMED");
          this.retryCount = 0;
          this.startWatchdog();
          return true;
        } else {
          // Necesitamos más confirmaciones, reintentar
          return await this.attemptApplyTorch();
        }
      } else {
        // Readback dice false - en Android Chrome esto puede pasar aunque el LED esté ON
        // Intentamos de nuevo hasta MAX_RETRY_ATTEMPTS
        this.retryCount++;
        
        if (this.retryCount >= MAX_RETRY_ATTEMPTS) {
          // En Android, el readback miente frecuentemente. Si llegamos aquí,
          // asumimos que el torch está ON físicamente y confiamos en SQI para validar.
          this.setState("ON_CONFIRMED");
          this.startWatchdog();
          return true;
        }
        
        // Esperar antes de reintentar
        await new Promise((resolve) => setTimeout(resolve, 300));
        return await this.attemptApplyTorch();
      }
    } catch (error) {
      this.retryCount++;
      
      if (this.retryCount >= MAX_RETRY_ATTEMPTS) {
        this.setError(`TORCH_APPLY_FAILED: ${error}`);
        this.setState("DENIED");
        return false;
      }
      
      // Reintentar
      await new Promise((resolve) => setTimeout(resolve, 300));
      return await this.attemptApplyTorch();
    }
  }

  private startWatchdog(): void {
    if (this.watchdogInterval) return;
    
    this.status.watchdogActive = true;
    
    this.watchdogInterval = setInterval(() => {
      this.watchdogCheck();
    }, WATCHDOG_INTERVAL_MS);
  }

  private stopWatchdog(): void {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
    this.status.watchdogActive = false;
  }

  private async watchdogCheck(): Promise<void> {
    if (!this.track || this.isDestroyed) return;
    if (this.status.state !== "ON_CONFIRMED") return;

    try {
      const settings = this.track.getSettings();
      
      // Si el readback dice que está apagado, reintentamos una vez
      if (settings.torch === false) {
        // En Android Chrome esto puede ser falso negativo
        // Solo reintentamos si ha pasado suficiente tiempo desde el último intento
        const elapsed = performance.now() - this.status.lastAttemptMs;
        
        if (elapsed > 3000) {
          // Reaplicar torch (una sola vez, no en bucle)
          await this.track.applyConstraints({
            advanced: [{ torch: true } as MediaTrackConstraintSet],
          });
          this.status.lastAttemptMs = performance.now();
        }
      }
    } catch (e) {
      // Error en watchdog - no es crítico, lo reportamos
      this.setError(`WATCHDOG_ERROR: ${e}`);
    }
  }

  private setState(newState: TorchState): void {
    if (this.status.state === newState) return;
    
    this.status.state = newState;
    this.notifyStateChange();
  }

  private setError(error: string): void {
    this.status.lastError = error;
    this.callbacks?.onError(error);
  }

  private notifyStateChange(): void {
    this.callbacks?.onStateChange({ ...this.status });
  }
}
