
/**
 * Implementación de Filtro Kalman para procesamiento de señal
 */
export class KalmanFilter {
  private R: number = 0.018; // Ruido de medición (PPG cámara: ligeramente mayor = más suave)
  private Q: number = 0.06;  // Variación lenta del proceso (deriva térmica)
  private P: number = 1;    // Covarianza del error estimado
  private X: number = 0;    // Estado estimado
  private K: number = 0;    // Ganancia de Kalman
  private initialized = false;

  filter(measurement: number): number {
    if (!this.initialized) {
      this.X = measurement;
      this.initialized = true;
      return measurement;
    }
    // Predicción
    this.P = this.P + this.Q;
    
    // Actualización
    this.K = this.P / (this.P + this.R);
    this.X = this.X + this.K * (measurement - this.X);
    this.P = (1 - this.K) * this.P;
    
    return this.X;
  }

  reset() {
    this.X = 0;
    this.P = 1;
    this.initialized = false;
  }
}
