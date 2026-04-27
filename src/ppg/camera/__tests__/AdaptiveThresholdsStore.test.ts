import { describe, expect, it, beforeEach } from "vitest";
import {
  AdaptiveAcquisitionThresholds,
  ADAPTIVE_SAFETY_FLOOR,
} from "../AdaptiveAcquisitionThresholds";
import {
  buildAdaptiveKey,
  clearAdaptiveStore,
  loadAdaptiveRecord,
  saveAdaptiveRecord,
} from "../AdaptiveThresholdsStore";

// Polyfill a minimal in-memory localStorage for the node test env so the
// store exercises its real persistence path.
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = { localStorage: ls };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = ls;
}

beforeEach(() => {
  installMemoryLocalStorage();
  clearAdaptiveStore();
});

describe("AdaptiveThresholdsStore", () => {
  it("round-trips a record clamped to safety floor", () => {
    const key = buildAdaptiveKey({ deviceId: "cam-A", cameraLabel: "Back camera" });
    saveAdaptiveRecord({
      key,
      deviceId: "cam-A",
      cameraLabel: "Back camera",
      thresholds: {
        // Try to relax — must be clamped back to floor.
        minMeasuredFps: 5,
        maxJitterMs: 99,
        minFpsQuality: 10,
        maxDroppedRatio: 0.9,
        minContactScore: 0.1,
        minPerfusionIndex: 0.001,
        minBandPowerRatio: 0.05,
        minTotalQualityScore: 10,
      },
      observed: { sensorNoiseDb: -30, p10MeasuredFps: 25, p90JitterMs: 6 },
      acquisitionMethod: "requestVideoFrameCallback",
      torchApplied: true,
    });
    const got = loadAdaptiveRecord(key);
    expect(got).not.toBeNull();
    expect(got!.thresholds.minMeasuredFps).toBe(ADAPTIVE_SAFETY_FLOOR.minMeasuredFps);
    expect(got!.thresholds.maxJitterMs).toBe(ADAPTIVE_SAFETY_FLOOR.maxJitterMs);
    expect(got!.thresholds.minPerfusionIndex).toBe(ADAPTIVE_SAFETY_FLOOR.minPerfusionIndex);
  });

  it("returns null for unknown keys", () => {
    expect(loadAdaptiveRecord("nonexistent")).toBeNull();
  });

  it("hot-starts the engine without losing the safety floor", () => {
    const engine = new AdaptiveAcquisitionThresholds();
    engine.hydrate({
      thresholds: {
        ...ADAPTIVE_SAFETY_FLOOR,
        minMeasuredFps: 22,        // tighter than floor
        minPerfusionIndex: 0.04,   // tighter than floor
      },
      sensorNoiseDb: -28,
      p10MeasuredFps: 24,
      p90JitterMs: 5,
      torchApplied: true,
    });
    const t = engine.getThresholds();
    expect(t.minMeasuredFps).toBeGreaterThanOrEqual(22);
    expect(t.minPerfusionIndex).toBeGreaterThanOrEqual(0.04);
    expect(t.maxJitterMs).toBeLessThanOrEqual(ADAPTIVE_SAFETY_FLOOR.maxJitterMs);
    expect(engine.snapshot().active).toBe(true);
  });
});
