/**
 * Escala del ratio equivalente multicanal → curva SpO2 (calibración por dispositivo).
 * Persistencia opcional: localStorage `spo2_ratio_scale` en [0.35, 0.75].
 */
const DEFAULT_SCALE = 0.52;
const STORAGE_KEY = 'spo2_ratio_scale';

export function getSpO2EquivalentRatioScale(): number {
  if (typeof window === 'undefined') return DEFAULT_SCALE;
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === '') return DEFAULT_SCALE;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return DEFAULT_SCALE;
    return Math.max(0.35, Math.min(0.75, n));
  } catch {
    return DEFAULT_SCALE;
  }
}

export function setSpO2EquivalentRatioScale(scale: number): void {
  if (typeof window === 'undefined') return;
  const s = Math.max(0.35, Math.min(0.75, scale));
  try {
    window.localStorage?.setItem(STORAGE_KEY, String(s));
  } catch {
    /* noop */
  }
}
