/**
 * AdaptiveThresholdsStore
 * -----------------------------------------------------------------------------
 * LocalStorage persistence for AdaptiveThresholds derived per (deviceId, label).
 *
 * Forensic policy:
 *  - We store ONLY the derived thresholds + provenance metadata that came from
 *    REAL telemetry (sensor noise, p10 fps, p90 jitter, torch readback,
 *    acquisition method). We never persist raw frames, no sample arrays, no
 *    user data.
 *  - Persisted thresholds are treated as a HOT-START HINT, not a substitute
 *    for live observation. The runtime engine continues to observe real frames
 *    and converges to live values via EMA. Persisted values just bootstrap the
 *    floor so the gate can open in seconds instead of minutes on a known phone.
 *  - We always re-clamp restored values to be >= SAFETY_FLOOR. A corrupt or
 *    tampered localStorage entry can never relax the gate.
 *  - Entries older than `MAX_AGE_MS` (14 days) are ignored — camera firmware
 *    or browser updates may change real telemetry, so we re-profile.
 *  - Schema is versioned; on mismatch the entry is dropped and re-derived.
 */

import {
  ADAPTIVE_SAFETY_FLOOR,
  type AdaptiveThresholds,
} from "./AdaptiveAcquisitionThresholds";
import type { AcquisitionMethod } from "./FrameSampler";

const STORAGE_KEY = "ppg.adaptive-thresholds.v1";
const SCHEMA_VERSION = 1;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 8;

export interface AdaptiveThresholdsRecord {
  schemaVersion: number;
  /** SHA-style key built from deviceId + camera label + UA family. */
  key: string;
  deviceId: string | null;
  cameraLabel: string;
  uaFamily: string;
  thresholds: AdaptiveThresholds;
  observed: {
    sensorNoiseDb: number;
    p10MeasuredFps: number;
    p90JitterMs: number;
  };
  acquisitionMethod: AcquisitionMethod | "none";
  torchApplied: boolean | null;
  /** Number of independent sessions that contributed to this record. */
  sessions: number;
  createdAt: number;
  updatedAt: number;
}

interface StoredFile {
  schemaVersion: number;
  records: AdaptiveThresholdsRecord[];
}

function detectUaFamily(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) return "ios";
  if (ua.includes("android")) return "android";
  return "desktop";
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    // Probe to detect Safari private mode quota errors.
    const probeKey = "__ppg_probe__";
    window.localStorage.setItem(probeKey, "1");
    window.localStorage.removeItem(probeKey);
    return window.localStorage;
  } catch {
    return null;
  }
}

export function buildAdaptiveKey(params: {
  deviceId: string | null;
  cameraLabel: string;
}): string {
  const id = (params.deviceId ?? "no-device").slice(0, 64);
  const label = (params.cameraLabel ?? "no-label").slice(0, 64);
  const ua = detectUaFamily();
  return `${ua}::${id}::${label}`;
}

function readFile(): StoredFile {
  const storage = safeStorage();
  if (!storage) return { schemaVersion: SCHEMA_VERSION, records: [] };
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return { schemaVersion: SCHEMA_VERSION, records: [] };
  try {
    const parsed = JSON.parse(raw) as StoredFile;
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.records)) {
      return { schemaVersion: SCHEMA_VERSION, records: [] };
    }
    return parsed;
  } catch {
    return { schemaVersion: SCHEMA_VERSION, records: [] };
  }
}

function writeFile(file: StoredFile): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(file));
  } catch {
    // Quota / private mode — we accept loss; runtime always works without.
  }
}

/** Clamp to safety floor. Restored values can NEVER relax the gate. */
function clampToFloor(t: AdaptiveThresholds): AdaptiveThresholds {
  const f = ADAPTIVE_SAFETY_FLOOR;
  return {
    minMeasuredFps: Math.max(f.minMeasuredFps, t.minMeasuredFps),
    maxJitterMs: Math.min(f.maxJitterMs, t.maxJitterMs),
    minFpsQuality: Math.max(f.minFpsQuality, t.minFpsQuality),
    maxDroppedRatio: Math.min(f.maxDroppedRatio, t.maxDroppedRatio),
    minContactScore: Math.max(f.minContactScore, t.minContactScore),
    minPerfusionIndex: Math.max(f.minPerfusionIndex, t.minPerfusionIndex),
    minBandPowerRatio: Math.max(f.minBandPowerRatio, t.minBandPowerRatio),
    minTotalQualityScore: Math.max(f.minTotalQualityScore, t.minTotalQualityScore),
  };
}

export function loadAdaptiveRecord(
  key: string,
): AdaptiveThresholdsRecord | null {
  const file = readFile();
  const now = Date.now();
  const record = file.records.find((r) => r.key === key);
  if (!record) return null;
  if (now - record.updatedAt > MAX_AGE_MS) return null;
  return {
    ...record,
    thresholds: clampToFloor(record.thresholds),
  };
}

export function saveAdaptiveRecord(input: {
  key: string;
  deviceId: string | null;
  cameraLabel: string;
  thresholds: AdaptiveThresholds;
  observed: AdaptiveThresholdsRecord["observed"];
  acquisitionMethod: AcquisitionMethod | "none";
  torchApplied: boolean | null;
}): void {
  const file = readFile();
  const now = Date.now();
  const existing = file.records.find((r) => r.key === input.key);
  const record: AdaptiveThresholdsRecord = {
    schemaVersion: SCHEMA_VERSION,
    key: input.key,
    deviceId: input.deviceId,
    cameraLabel: input.cameraLabel,
    uaFamily: detectUaFamily(),
    thresholds: clampToFloor(input.thresholds),
    observed: input.observed,
    acquisitionMethod: input.acquisitionMethod,
    torchApplied: input.torchApplied,
    sessions: (existing?.sessions ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const others = file.records.filter((r) => r.key !== input.key);
  const merged = [record, ...others]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ENTRIES);
  writeFile({ schemaVersion: SCHEMA_VERSION, records: merged });
}

export function listAdaptiveRecords(): AdaptiveThresholdsRecord[] {
  return readFile().records.map((r) => ({
    ...r,
    thresholds: clampToFloor(r.thresholds),
  }));
}

export function clearAdaptiveStore(): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
