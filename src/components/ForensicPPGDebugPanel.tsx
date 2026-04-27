import { useRef, useState } from "react";
import type { UsePPGMeasurementResult } from "@/ppg/usePPGMeasurement";

interface ForensicPPGDebugPanelProps {
  measurement: UsePPGMeasurementResult;
}

function fmt(value: unknown, digits = 3): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "--";
    return value.toFixed(digits);
  }
  if (value === null || value === undefined || value === "") return "--";
  return String(value);
}

function rgb(value?: { r: number; g: number; b: number }): string {
  if (!value) return "--";
  return `${fmt(value.r, 1)}, ${fmt(value.g, 1)}, ${fmt(value.b, 1)}`;
}

type DebugCapabilities = MediaTrackCapabilities & {
  torch?: boolean;
  frameRate?: { max?: number };
};

export default function ForensicPPGDebugPanel({ measurement }: ForensicPPGDebugPanelProps) {
  const latestSample = measurement.rawSamples[measurement.rawSamples.length - 1];
  const latestChannels = measurement.channels[measurement.channels.length - 1];
  const quality = measurement.quality;
  const evidence = measurement.published.evidence;
  const roi = evidence.roi;
  const oxygen = measurement.published.oxygen;
  const camera = measurement.camera;
  const cameraSettings = camera.settings;
  const cameraCapabilities = camera.capabilities as DebugCapabilities | null;
  const debug = measurement.debug;
  const reasons = measurement.published.quality.reasons;
  const frameStats = measurement.frameStats;
  const beats = measurement.beats;

  // Track RR consistency history for trend arrow (with timestamps for auditability).
  const rrConsistencyHistoryRef = useRef<{ value: number; timestamp: number }[]>([]);
  const rrCount = beats.rrIntervalsMs.length;
  if (rrCount >= 2 && Number.isFinite(quality.rrConsistency)) {
    const hist = rrConsistencyHistoryRef.current;
    const last = hist[hist.length - 1];
    if (last === undefined || Math.abs(last.value - quality.rrConsistency) > 1e-6) {
      hist.push({ value: quality.rrConsistency, timestamp: Date.now() });
      if (hist.length > 5) hist.shift();
    }
  }
  const rrHistory = rrConsistencyHistoryRef.current;
  const rrTrend: "up" | "down" | "flat" | null = (() => {
    if (rrHistory.length < 2) return null;
    const delta = rrHistory[rrHistory.length - 1].value - rrHistory[0].value;
    if (delta > 0.02) return "up";
    if (delta < -0.02) return "down";
    return "flat";
  })();
  const fmtClock = (ts: number) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  };

  // Shared explanatory text reused by tooltip and the inline "Why am I waiting?" panel.
  const rrConsistencyExplanation =
    "RR consistency: 1 − normalized stdev of consecutive RR intervals (1.0 = perfectly regular).\n" +
    "Requires ≥2 accepted beats so at least one RR interval exists; ≥4 RR intervals recommended for a stable estimate.\n\n" +
    "Trend arrows compare the oldest vs. newest value in the last 5 updates:\n" +
    "  ▲ improving  (delta > +0.02)\n" +
    "  ▼ degrading  (delta < −0.02)\n" +
    "  ▬ stable     (|delta| ≤ 0.02)\n\n" +
    `Trend window (${rrHistory.length}/5): ` +
    (rrHistory.length === 0
      ? "empty"
      : rrHistory.map((h) => `${h.value.toFixed(2)}@${fmtClock(h.timestamp)}`).join(" → ")) +
    (rrHistory.length >= 2
      ? `\nDelta: ${(rrHistory[rrHistory.length - 1].value - rrHistory[0].value).toFixed(3)}`
      : "");

  const [rrExplanationOpen, setRrExplanationOpen] = useState(false);

  // Imported evidence (loaded from a previously exported JSON file). When set, the
  // diagnostics section renders this snapshot in a read-only "IMPORTED" mode so the
  // user can audit a past session with the same forensic view.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [importedEvidence, setImportedEvidence] = useState<any | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [exportWarnings, setExportWarnings] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Validate that the camera evidence payload has the required forensic fields populated.
  // Returns the list of human-readable warnings (empty array means "ok to download").
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const validateEvidencePayload = (payload: any): string[] => {
    const warnings: string[] = [];
    const diag = payload?.cameraDiagnostics;
    if (!diag) {
      warnings.push("cameraDiagnostics is missing/null");
    } else {
      if (!diag.selectedDevice) warnings.push("cameraDiagnostics.selectedDevice is null");
      if (!Array.isArray(diag.enumeratedDevices) || diag.enumeratedDevices.length === 0)
        warnings.push("cameraDiagnostics.enumeratedDevices is empty");
      if (!Array.isArray(diag.attempts) || diag.attempts.length === 0)
        warnings.push("cameraDiagnostics.attempts is empty (no constraint attempts logged)");
      if (!diag.torchStatus) warnings.push("cameraDiagnostics.torchStatus is missing");
      if (!diag.calibration) warnings.push("cameraDiagnostics.calibration is missing");
    }
    const sp = payload?.spo2;
    if (!sp) {
      warnings.push("spo2 block is missing");
    } else {
      if (sp.calibrationBadge === null || sp.calibrationBadge === undefined)
        warnings.push("spo2.calibrationBadge is null");
      if (!sp.calibrationProfile) warnings.push("spo2.calibrationProfile is null");
    }
    return warnings;
  };

  const exportJson = () => {
    const auditData = {
      timestamp: new Date().toISOString(),
      fpsStats: measurement.fpsStats,
      frameStats,
      camera: {
        streamActive: camera.streamActive,
        cameraReady: camera.cameraReady,
        torchEnabled: camera.torchEnabled,
        settings: cameraSettings,
      },
      roi: {
        accepted: roi.accepted,
        contactScore: roi.contactScore,
        illuminationScore: roi.illuminationScore,
        motionRisk: roi.motionRisk,
        pressureRisk: roi.pressureRisk,
        saturationPenalty: quality.saturationPenalty,
      },
      beats: {
        bpm: beats.bpm,
        fftBpm: beats.fftBpm,
        autocorrBpm: beats.autocorrBpm,
        estimatorAgreementBpm: beats.estimatorAgreementBpm,
        acceptedCount: beats.beats.length,
        rejectedCount: beats.rejectedCandidates,
        rrIntervalsMs: beats.rrIntervalsMs.slice(-10),
      },
      quality: {
        totalScore: quality.totalScore,
        grade: quality.grade,
        bandPowerRatio: quality.bandPowerRatio,
        snrDb: quality.snrDb,
        rrConsistency: quality.rrConsistency,
      },
      publication: {
        state: measurement.published.state,
        canPublishVitals: measurement.published.canPublishVitals,
        bpm: measurement.published.bpm,
        goodWindowStreak: measurement.published.goodWindowStreak,
        lastValidTimestamp: measurement.published.lastValidTimestamp,
      },
      oxygen: {
        spo2: oxygen.spo2,
        confidence: oxygen.confidence,
        canPublish: oxygen.canPublish,
      },
      rawSamplesLast30s: measurement.rawSamples.slice(-Math.floor(30 * frameStats.measuredFps)),
      channelsLast30s: measurement.channels.slice(-Math.floor(30 * frameStats.measuredFps)),
    };

    const blob = new Blob([JSON.stringify(auditData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ppg-audit-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCameraEvidence = (opts: { force?: boolean } = {}) => {
    const diag = camera.diagnostics;
    const exportedAtMs = Date.now();
    const exportedAtIso = new Date(exportedAtMs).toISOString();

    // Annotate every applied/attempted setting with its timestamp so the consumer can
    // correlate exactly when each constraint, torch readback or fps measurement happened.
    // We preserve any pre-existing `timestamp`/`appliedAt` on the source records and
    // fall back to the export timestamp only when the upstream did not record one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotateTs = (item: any) => {
      if (!item || typeof item !== "object") return item;
      const ts = item.timestamp ?? item.appliedAt ?? item.at ?? exportedAtMs;
      const tsIso = (() => {
        try {
          return new Date(ts).toISOString();
        } catch {
          return exportedAtIso;
        }
      })();
      return { ...item, timestamp: ts, timestampIso: tsIso };
    };

    const annotatedDiag = diag
      ? {
          ...diag,
          attempts: Array.isArray(diag.attempts) ? diag.attempts.map(annotateTs) : diag.attempts,
          fineConstraints: Array.isArray(diag.fineConstraints)
            ? diag.fineConstraints.map(annotateTs)
            : diag.fineConstraints,
          torchStatus: annotateTs(diag.torchStatus),
          fpsSample: {
            target: diag.fpsTarget,
            measured: diag.fpsMeasured,
            timestamp: exportedAtMs,
            timestampIso: exportedAtIso,
          },
        }
      : null;

    const evidencePayload = {
      timestamp: exportedAtIso,
      exportedAtMs,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      cameraDiagnostics: annotatedDiag,
      cameraStateSummary: {
        cameraReady: camera.cameraReady,
        streamActive: camera.streamActive,
        selectedDeviceId: camera.selectedDeviceId,
        torchAvailable: camera.torchAvailable,
        torchEnabled: camera.torchEnabled,
        torchApplied: camera.torchApplied,
        measuredFps: camera.measuredFps,
        measuredFpsAt: exportedAtMs,
        measuredFpsAtIso: exportedAtIso,
        width: camera.width,
        height: camera.height,
        error: camera.error,
        lastError: camera.lastError,
      },
      spo2: {
        calibrationBadge: oxygen.calibrationBadge,
        canPublish: oxygen.canPublish,
        spo2: oxygen.spo2,
        confidence: oxygen.confidence,
        method: oxygen.method,
        reasons: oxygen.reasons,
        calibrationProfile: diag?.calibration ?? null,
      },
      evidenceSchemaVersion: 2,
    };

    const warnings = validateEvidencePayload(evidencePayload);
    setExportWarnings(warnings);
    if (warnings.length > 0 && !opts.force) {
      // Block the download until the user confirms via the "Download anyway" button.
      return;
    }

    const blob = new Blob([JSON.stringify(evidencePayload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ppg-camera-evidence-${exportedAtMs}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Current schema version produced by exportCameraEvidence(). When this is
  // bumped, add a new step to `migrateEvidence` below — never break old files.
  const CURRENT_EVIDENCE_SCHEMA = 2;

  /**
   * Forward-migrate an imported evidence payload to the current schema so the
   * forensic view can render it without conditional checks everywhere.
   *
   * Migration ladder (each step is additive and idempotent):
   *   pre-v1 (no `evidenceSchemaVersion`) → v1
   *     - wrap legacy shapes; ensure `cameraDiagnostics`/`spo2` keys exist;
   *       infer `timestamp` from `exportedAtMs` or file mtime fallback.
   *   v1 → v2
   *     - per-record `timestamp` + `timestampIso` on `attempts`,
   *       `fineConstraints`, `torchStatus`;
   *     - synthesize `cameraDiagnostics.fpsSample` from `fpsTarget`/`fpsMeasured`;
   *     - add `cameraStateSummary.measuredFpsAt`/`measuredFpsAtIso`.
   *
   * Returns `{ migrated, fromVersion, appliedSteps, warnings }` so the UI can
   * show exactly what was upgraded.
   */
  const migrateEvidence = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: any,
  ): {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    migrated: any;
    fromVersion: number | "pre-v1";
    appliedSteps: string[];
    warnings: string[];
  } => {
    const warnings: string[] = [];
    const appliedSteps: string[] = [];
    // Shallow clone — we never mutate the caller's object.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evidence: any = { ...raw };

    const detectedVersion: number | "pre-v1" =
      typeof evidence.evidenceSchemaVersion === "number"
        ? evidence.evidenceSchemaVersion
        : "pre-v1";

    const fallbackTs =
      typeof evidence.exportedAtMs === "number"
        ? evidence.exportedAtMs
        : typeof evidence.timestamp === "string"
          ? Date.parse(evidence.timestamp) || Date.now()
          : Date.now();
    const fallbackIso = (() => {
      try {
        return new Date(fallbackTs).toISOString();
      } catch {
        return new Date().toISOString();
      }
    })();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const annotateTs = (item: any) => {
      if (!item || typeof item !== "object") return item;
      if (typeof item.timestamp === "number" && typeof item.timestampIso === "string") {
        return item;
      }
      const ts =
        typeof item.timestamp === "number"
          ? item.timestamp
          : typeof item.appliedAt === "number"
            ? item.appliedAt
            : typeof item.at === "number"
              ? item.at
              : fallbackTs;
      let iso = fallbackIso;
      try {
        iso = new Date(ts).toISOString();
      } catch {
        iso = fallbackIso;
      }
      return { ...item, timestamp: ts, timestampIso: iso };
    };

    // ── Step: pre-v1 → v1 ──────────────────────────────────────────────────
    if (detectedVersion === "pre-v1") {
      appliedSteps.push("pre-v1 → v1: normalize root shape");
      if (!evidence.timestamp) evidence.timestamp = fallbackIso;
      if (typeof evidence.exportedAtMs !== "number") evidence.exportedAtMs = fallbackTs;
      if (!("cameraDiagnostics" in evidence) && evidence.diagnostics) {
        // Some very early dumps used a different key.
        evidence.cameraDiagnostics = evidence.diagnostics;
        warnings.push("renamed legacy `diagnostics` → `cameraDiagnostics`");
      }
      if (!("spo2" in evidence) && evidence.oxygen) {
        evidence.spo2 = evidence.oxygen;
        warnings.push("renamed legacy `oxygen` → `spo2`");
      }
      if (!evidence.cameraDiagnostics) {
        warnings.push("cameraDiagnostics missing in source — diagnostics view will be empty");
      }
      if (!evidence.spo2) {
        warnings.push("spo2 block missing in source — SpO2 fields will be empty");
      }
      if (!evidence.cameraStateSummary) {
        evidence.cameraStateSummary = {};
        warnings.push("cameraStateSummary missing — backfilled with empty object");
      }
      evidence.evidenceSchemaVersion = 1;
    }

    // ── Step: v1 → v2 ──────────────────────────────────────────────────────
    if (evidence.evidenceSchemaVersion === 1) {
      appliedSteps.push("v1 → v2: backfill timestamps on attempts/fineConstraints/torchStatus");
      const diag = evidence.cameraDiagnostics;
      if (diag && typeof diag === "object") {
        const upgradedDiag = { ...diag };
        if (Array.isArray(diag.attempts)) {
          upgradedDiag.attempts = diag.attempts.map(annotateTs);
        }
        if (Array.isArray(diag.fineConstraints)) {
          upgradedDiag.fineConstraints = diag.fineConstraints.map(annotateTs);
        }
        if (diag.torchStatus) {
          upgradedDiag.torchStatus = annotateTs(diag.torchStatus);
        }
        if (!diag.fpsSample && (diag.fpsTarget !== undefined || diag.fpsMeasured !== undefined)) {
          upgradedDiag.fpsSample = {
            target: diag.fpsTarget ?? null,
            measured: diag.fpsMeasured ?? null,
            timestamp: fallbackTs,
            timestampIso: fallbackIso,
          };
        }
        evidence.cameraDiagnostics = upgradedDiag;
      }
      const summary = evidence.cameraStateSummary;
      if (summary && typeof summary === "object" && summary.measuredFpsAt === undefined) {
        evidence.cameraStateSummary = {
          ...summary,
          measuredFpsAt: fallbackTs,
          measuredFpsAtIso: fallbackIso,
        };
      }
      evidence.evidenceSchemaVersion = 2;
    }

    // Future: if (evidence.evidenceSchemaVersion === 2) { ... → 3 ... }

    if (evidence.evidenceSchemaVersion > CURRENT_EVIDENCE_SCHEMA) {
      warnings.push(
        `Evidence schema v${evidence.evidenceSchemaVersion} is newer than this build (v${CURRENT_EVIDENCE_SCHEMA}). Some fields may not render.`,
      );
    }

    return { migrated: evidence, fromVersion: detectedVersion, appliedSteps, warnings };
  };

  const handleImportEvidenceClick = () => {
    setImportError(null);
    fileInputRef.current?.click();
  };

  const handleImportEvidenceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") {
        throw new Error("File is not a JSON object");
      }
      if (!("cameraDiagnostics" in parsed) && !("spo2" in parsed) && !("diagnostics" in parsed) && !("oxygen" in parsed)) {
        throw new Error("Missing cameraDiagnostics/spo2 — not a PPG evidence file");
      }
      const { migrated, fromVersion, appliedSteps, warnings } = migrateEvidence(parsed);
      // Stash migration metadata on the imported object so the UI banner can
      // expose exactly what was upgraded (and any data-loss warnings).
      migrated.__migration = { fromVersion, appliedSteps, warnings };
      setImportedEvidence(migrated);
      setImportError(null);
    } catch (err) {
      setImportedEvidence(null);
      setImportError(err instanceof Error ? err.message : "Failed to parse file");
    }
  };

  // Determine status color
  const isAccepted = roi.accepted;
  const statusColor = isAccepted ? "text-emerald-400" : "text-amber-400";

  return (
    <div className="max-h-[70vh] w-[min(92vw,520px)] overflow-y-auto rounded-md border border-emerald-400/20 bg-black/88 p-3 font-mono text-[11px] leading-relaxed text-emerald-100 shadow-2xl backdrop-blur-md">
      <div className="mb-2 flex items-center justify-between border-b border-white/10 pb-2 text-white">
        <span className="font-semibold">PPG FORENSIC DEBUG</span>
        <div className="flex items-center gap-2">
          <span className={statusColor}>{isAccepted ? "ACCEPTED" : "REJECTED"}</span>
          <button
            type="button"
            onClick={exportJson}
            className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300 hover:bg-emerald-500/20"
          >
            EXPORT JSON
          </button>
          <button
            type="button"
            onClick={() => exportCameraEvidence()}
            title="Download camera diagnostics + SpO2 calibration/badge as a single JSON evidence file"
            className="inline-flex items-center gap-1 rounded border border-fuchsia-500/30 bg-fuchsia-500/10 px-2 py-1 text-[10px] text-fuchsia-200 hover:bg-fuchsia-500/20"
          >
            EXPORT CAM EVIDENCE
          </button>
          <button
            type="button"
            onClick={handleImportEvidenceClick}
            title="Load a previously exported evidence JSON and render it in this panel"
            className="inline-flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[10px] text-sky-200 hover:bg-sky-500/20"
          >
            IMPORT EVIDENCE
          </button>
          {importedEvidence && (
            <button
              type="button"
              onClick={() => {
                setImportedEvidence(null);
                setImportError(null);
              }}
              title="Stop showing imported snapshot and return to live diagnostics"
              className="inline-flex items-center gap-1 rounded border border-white/20 bg-white/5 px-2 py-1 text-[10px] text-white/70 hover:bg-white/10"
            >
              CLEAR IMPORT
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImportEvidenceFile}
          />
        </div>
      </div>

      {(exportWarnings.length > 0 || importError || importedEvidence) && (
        <div className="mb-3 space-y-1">
          {exportWarnings.length > 0 && (
            <div className="rounded border border-amber-400/40 bg-amber-500/10 p-2 text-[10px] text-amber-200">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-semibold uppercase tracking-wider">
                  Export validation: {exportWarnings.length} warning{exportWarnings.length === 1 ? "" : "s"}
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => exportCameraEvidence({ force: true })}
                    className="rounded border border-amber-300/40 bg-amber-400/10 px-1.5 py-0.5 hover:bg-amber-400/20"
                  >
                    Download anyway
                  </button>
                  <button
                    type="button"
                    onClick={() => setExportWarnings([])}
                    className="rounded border border-white/20 bg-white/5 px-1.5 py-0.5 hover:bg-white/10"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
              <ul className="list-disc pl-4">
                {exportWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {importError && (
            <div className="rounded border border-red-400/40 bg-red-500/10 p-2 text-[10px] text-red-200">
              Import error: {importError}
            </div>
          )}
          {importedEvidence && (
            <div className="rounded border border-sky-400/40 bg-sky-500/10 p-2 text-[10px] text-sky-200">
              Showing IMPORTED evidence from{" "}
              <span className="font-semibold">{importedEvidence.timestamp ?? "unknown time"}</span>{" "}
              (schema v{importedEvidence.evidenceSchemaVersion ?? "?"}). Live diagnostics paused
              below.
            </div>
          )}
        </div>
      )}

      {/* CAMERA SECTION */}
      <div className="mb-3 border-l-2 border-cyan-500/50 pl-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-cyan-300">Camera</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-white/55">stream active</span>
          <span className={camera.streamActive ? "text-emerald-400" : "text-red-400"}>
            {String(camera.streamActive)}
          </span>
          <span className="text-white/55">device id</span>
          <span className="truncate" title={camera.selectedDeviceId ?? ""}>
            {(camera.selectedDeviceId ?? "--").slice(0, 12)}...
          </span>
          <span className="text-white/55">resolution</span>
          <span>
            {fmt(cameraSettings?.width, 0)}x{fmt(cameraSettings?.height, 0)}
          </span>
          <span className="text-white/55">frameRate</span>
          <span>{fmt(cameraSettings?.frameRate, 1)} fps</span>
          <span className="text-white/55">torch</span>
          <span>
            avail:{String(camera.torchAvailable)} en:{String(camera.torchEnabled)} appl:{String(camera.torchApplied)}
          </span>
        </div>
      </div>

      {/* DIAGNOSTICS & CALIBRATION */}
      {(() => {
        const diag = (importedEvidence?.cameraDiagnostics ?? camera.diagnostics) as typeof camera.diagnostics | null;
        if (!diag) return null;
        const calib = diag.calibration;
        const calibColor =
          calib.status === "calibrated"
            ? "text-emerald-400"
            : calib.status === "partial"
              ? "text-amber-300"
              : "text-red-400";
        const sel = diag.selectedDevice;
        return (
          <div className="mb-3 border-l-2 border-fuchsia-500/50 pl-2">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-fuchsia-300">
              Diagnostics &amp; Calibration
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <span className="text-white/55">selected device</span>
              <span className="truncate" title={sel?.label ?? ""}>
                {sel?.label || "--"}
              </span>
              <span className="text-white/55">selected reason</span>
              <span className="text-cyan-300">{sel?.selectedReason ?? "--"}</span>
              <span className="text-white/55">facing / score</span>
              <span>
                {sel?.facingModeDetected ?? "--"} / {fmt(sel?.score ?? 0, 0)}
              </span>
              <span className="text-white/55">enumerated devices</span>
              <span>{diag.enumeratedDevices.length}</span>
              <span className="text-white/55">attempts ok / fail</span>
              <span>
                {diag.attempts.filter((a) => a.outcome === "success").length} /{" "}
                {diag.attempts.filter((a) => a.outcome === "failure").length}
              </span>
              <span className="text-white/55">failed constraints</span>
              <span className={diag.failedConstraints.length ? "text-red-400" : "text-emerald-400"}>
                {diag.failedConstraints.length === 0 ? "none" : diag.failedConstraints.join(", ")}
              </span>
              <span className="text-white/55">fine constraints</span>
              <span className="text-[9px]">
                {diag.fineConstraints
                  .map(
                    (c) =>
                      `${c.key}:${c.status === "applied" ? "✓" : c.status === "unsupported" ? "—" : "✗"}`,
                  )
                  .join(" ")}
              </span>
              <span className="text-white/55">torch readback</span>
              <span className={diag.torchStatus.appliedReadback ? "text-emerald-400" : "text-amber-400"}>
                avail:{String(diag.torchStatus.available)} req:
                {String(diag.torchStatus.requested)} on:
                {String(diag.torchStatus.appliedReadback)}
              </span>
              <span className="text-white/55">fps target / measured</span>
              <span>
                {diag.fpsTarget} / {fmt(diag.fpsMeasured, 1)}
              </span>
              <span className="text-white/55">calibration status</span>
              <span className={calibColor} title={calib.reason}>
                {calib.status.toUpperCase()}
                {calib.profileKey ? ` (${calib.profileKey})` : ""}
              </span>
              <span className="text-white/55">SpO2 publishable</span>
              <span className={calib.canPublishSpO2 ? "text-emerald-400" : "text-red-400"}>
                {String(calib.canPublishSpO2)}
              </span>
            </div>
            {diag.enumeratedDevices.length > 1 && (
              <details className="mt-1 text-[10px]">
                <summary className="cursor-pointer text-white/55 hover:text-white/80">
                  candidates &amp; rejection reasons ({diag.enumeratedDevices.length})
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {diag.enumeratedDevices.map((d) => {
                    const isSelected = d.deviceId === diag.selectedDevice?.deviceId;
                    return (
                      <li
                        key={d.deviceId || d.label}
                        className={
                          "rounded px-1 py-0.5 " +
                          (isSelected
                            ? "bg-emerald-400/10 text-emerald-200"
                            : "bg-white/5 text-white/70")
                        }
                      >
                        <span className="font-semibold">
                          [{fmt(d.score, 0)}] {d.label || "(empty label)"}
                        </span>
                        <span className="ml-1 text-white/40">
                          {d.facingModeDetected}
                        </span>
                        {isSelected ? (
                          <span className="ml-1 text-emerald-300">
                            ✓ {d.selectedReason ?? "selected"}
                          </span>
                        ) : d.rejectedReasons.length > 0 ? (
                          <span className="ml-1 text-amber-300">
                            ✗ {d.rejectedReasons.join(", ")}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
          </div>
        );
      })()}

      {/* SAMPLER SECTION */}
      <div className="mb-3 border-l-2 border-blue-500/50 pl-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-blue-300">Sampler</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-white/55">acquisition method</span>
          <span
            className={
              frameStats.acquisitionMethod === "requestVideoFrameCallback"
                ? "text-emerald-400"
                : frameStats.acquisitionMethod === "requestAnimationFrame"
                  ? "text-amber-300"
                  : "text-red-400"
            }
            title="rVFC = decoupled from render; rAF = coupled; intervalFallback = degraded"
          >
            {frameStats.acquisitionMethod}
          </span>
          <span className="text-white/55">target / measured / median fps</span>
          <span>
            {frameStats.targetFps} / {fmt(frameStats.measuredFps, 1)} / {fmt(frameStats.fpsMedian, 1)}
          </span>
          <span className="text-white/55">fps instant</span>
          <span>{fmt(frameStats.fpsInstant, 1)}</span>
          <span className="text-white/55">fps quality</span>
          <span
            className={
              frameStats.fpsQuality >= 70
                ? "text-emerald-400"
                : frameStats.fpsQuality >= 40
                  ? "text-amber-300"
                  : "text-red-400"
            }
            title="0..100. <40 blocks BPM publication."
          >
            {frameStats.fpsQuality}
          </span>
          <span className="text-white/55">jitter (MAD)</span>
          <span
            className={
              frameStats.jitterMs < 4 ? "text-emerald-400" : frameStats.jitterMs < 10 ? "text-amber-300" : "text-red-400"
            }
          >
            {fmt(frameStats.jitterMs, 2)} ms
          </span>
          <span className="text-white/55">frame interval</span>
          <span>
            {fmt(debug.frameIntervalMs, 1)} ± {fmt(debug.frameIntervalStdMs, 1)} ms
          </span>
          <span className="text-white/55">frames / dropped (total)</span>
          <span>
            {frameStats.frameCount} / {frameStats.droppedFrames}
          </span>
          <span className="text-white/55">dropped this frame</span>
          <span className={frameStats.droppedFrameEstimate > 0 ? "text-red-400" : ""}>
            {frameStats.droppedFrameEstimate}
          </span>
          <span className="text-white/55">analysis resolution</span>
          <span>
            {frameStats.width}x{frameStats.height}
          </span>
        </div>
      </div>

      {/* ROI SECTION */}
      <div className="mb-3 border-l-2 border-purple-500/50 pl-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-purple-300">ROI Analysis</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-white/55">ROI position</span>
          <span>
            {roi.roi.x},{roi.roi.y} {roi.roi.width}x{roi.roi.height}
          </span>
          <span className="text-white/55">contact score</span>
          <span className={roi.contactScore > 0.5 ? "text-emerald-400" : "text-amber-400"}>
            {fmt(roi.contactScore, 2)}
          </span>
          <span className="text-white/55">illumination</span>
          <span className={roi.illuminationScore > 0.5 ? "text-emerald-400" : "text-amber-400"}>
            {fmt(roi.illuminationScore, 2)}
          </span>
          <span className="text-white/55">coverage</span>
          <span>{fmt(roi.coverageScore, 2)}</span>
          <span className="text-white/55">DC stability</span>
          <span className={roi.dcStability > 0.5 ? "text-emerald-400" : "text-amber-400"}>
            {fmt(roi.dcStability, 2)}
          </span>
          <span className="text-white/55">DC trend</span>
          <span>{fmt(roi.dcTrend, 2)}</span>
          <span className="text-white/55">motion risk</span>
          <span className={roi.motionRisk < 0.3 ? "text-emerald-400" : "text-red-400"}>
            {fmt(roi.motionRisk, 2)}
          </span>
          <span className="text-white/55">pressure risk</span>
          <span className={roi.pressureRisk < 0.3 ? "text-emerald-400" : "text-red-400"}>
            {fmt(roi.pressureRisk, 2)}
          </span>
          <span className="text-white/55">red dominance</span>
          <span>{fmt(roi.redDominance, 2)}</span>
          <span className="text-white/55">green pulse avail</span>
          <span>{fmt(roi.greenPulseAvailability, 2)}</span>
          <span className="text-white/55">contact state</span>
          <span
            className={
              roi.contactState === "stable"
                ? "text-emerald-400"
                : roi.contactState === "partial"
                  ? "text-amber-300"
                  : roi.contactState === "absent" || roi.contactState === "searching"
                    ? "text-white/60"
                    : "text-red-400"
            }
            title={`Reasons: ${roi.reason.join(", ") || "none"}`}
          >
            {roi.contactState.toUpperCase()}
          </span>
          <span className="text-white/55">usable tiles</span>
          <span
            className={
              roi.usableTileCount >= 12
                ? "text-emerald-400"
                : roi.usableTileCount >= 6
                  ? "text-amber-300"
                  : "text-red-400"
            }
          >
            {roi.usableTileCount} / {roi.tileCount}
          </span>
          <span className="text-white/55">ROI stability</span>
          <span className={roi.roiStabilityScore >= 0.6 ? "text-emerald-400" : roi.roiStabilityScore >= 0.4 ? "text-amber-300" : "text-red-400"}>
            {fmt(roi.roiStabilityScore, 2)}
          </span>
          <span className="text-white/55">channel usable R/G/B</span>
          <span>
            <span className={roi.channelUsable.r ? "text-emerald-400" : "text-red-400"}>R</span>{" "}
            <span className={roi.channelUsable.g ? "text-emerald-400" : "text-red-400"}>G</span>{" "}
            <span className={roi.channelUsable.b ? "text-emerald-400" : "text-red-400"}>B</span>
          </span>
        </div>
        {/* Tile heatmap (5x5). Green = usable, amber = marginal, red = clipped. */}
        {roi.tiles.length > 0 && (
          <div className="mt-2">
            <div className="mb-1 text-[9px] uppercase tracking-wider text-white/40">
              tile heatmap (pulsatile candidate · ✓ = usable)
            </div>
            <div
              className="grid gap-[2px]"
              style={{ gridTemplateColumns: `repeat(5, 1fr)` }}
            >
              {roi.tiles.map((t) => {
                const bad = t.highClip > 0.25 || t.lowClip > 0.25;
                const score = Math.max(0, Math.min(1, t.pulsatileCandidateScore));
                const bg = bad
                  ? `rgba(239,68,68,${0.25 + score * 0.5})`
                  : t.usable
                    ? `rgba(16,185,129,${0.2 + score * 0.6})`
                    : `rgba(245,158,11,${0.15 + score * 0.5})`;
                return (
                  <div
                    key={t.index}
                    className="flex aspect-square items-center justify-center rounded-sm text-[8px] font-mono text-white/85"
                    style={{ backgroundColor: bg }}
                    title={`tile ${t.index}\nmean R/G/B: ${t.meanRgb.r.toFixed(0)}/${t.meanRgb.g.toFixed(0)}/${t.meanRgb.b.toFixed(0)}\nhigh-clip: ${(t.highClip * 100).toFixed(0)}%  low-clip: ${(t.lowClip * 100).toFixed(0)}%\ncandidate: ${score.toFixed(2)}\nusable: ${t.usable}`}
                  >
                    {t.usable ? "✓" : bad ? "✗" : "·"}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* SATURATION SECTION */}
      <div className="mb-3 border-l-2 border-amber-500/50 pl-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-amber-300">Saturation</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-white/55">high saturation</span>
          <span className={Math.max(roi.highSaturation.r, roi.highSaturation.g, roi.highSaturation.b) < 0.15 ? "text-emerald-400" : "text-red-400"}>
            {fmt(roi.highSaturation.r)}/{fmt(roi.highSaturation.g)}/{fmt(roi.highSaturation.b)}
          </span>
          <span className="text-white/55">low saturation</span>
          <span>
            {fmt(roi.lowSaturation.r)}/{fmt(roi.lowSaturation.g)}/{fmt(roi.lowSaturation.b)}
          </span>
          <span className="text-white/55">spatial variance</span>
          <span>{fmt(roi.spatialVariance, 4)}</span>
        </div>
      </div>

      {/* OPTICAL SECTION */}
      <div className="mb-3 border-l-2 border-pink-500/50 pl-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-pink-300">Optical</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-white/55">mean RGB</span>
          <span>{rgb(roi.meanRgb)}</span>
          <span className="text-white/55">linear RGB</span>
          <span>{rgb(roi.linearMean)}</span>
          <span className="text-white/55">optical density</span>
          <span>{rgb(roi.opticalDensity)}</span>
          <span className="text-white/55">median RGB</span>
          <span>{rgb(roi.medianRgb)}</span>
        </div>
      </div>

      {/* SAMPLER SECTION - Fs info */}
      <div className="mb-3 border-l-2 border-blue-500/50 pl-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-blue-300">Sampling</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-white/55">measured FPS</span>
          <span>{fmt(debug.measuredFps, 1)} fps</span>
          <span className="text-white/55">target Fs</span>
          <span>{debug.targetFs} Hz</span>
          <span className="text-white/55">frame interval</span>
          <span>
            {fmt(debug.frameIntervalMs, 1)} ± {fmt(debug.frameIntervalStdMs, 1)} ms
          </span>
        </div>
      </div>

      {/* SIGNAL SECTION */}
      <div className="mb-3 border-l-2 border-emerald-500/50 pl-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-emerald-300">Signal</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-white/55">G1/G2/G3</span>
          <span>
            {fmt(latestChannels?.g1, 3)} / {fmt(latestChannels?.g2, 3)} / {fmt(latestChannels?.g3, 3)}
          </span>
          <span className="text-white/55">selected channel</span>
          <span className="text-cyan-300">{latestChannels?.selectedName ?? "--"}</span>
          <span className="text-white/55">selection reason</span>
          <span className="truncate text-[9px]" title={debug.channelSelectionReason}>
            {debug.channelSelectionReason}
          </span>
          <span className="text-white/55">band power</span>
          <span>{fmt(quality.bandPowerRatio, 3)}</span>
          <span className="text-white/55">SNR</span>
          <span>{fmt(quality.snrDb, 1)} dB</span>
          <span className="text-white/55">SQI score / grade</span>
          <span className={quality.totalScore > 70 ? "text-emerald-400" : quality.totalScore > 45 ? "text-amber-400" : "text-red-400"}>
            {fmt(quality.totalScore, 1)} / {quality.grade}
          </span>
        </div>
      </div>

      {/* BEAT DETECTION SECTION */}
      <div className="mb-3 border-l-2 border-orange-500/50 pl-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-orange-300">Beat Detection</div>
        {(() => {
          const noBeatsYet =
            beats.beats.length === 0 &&
            beats.rejectedCandidates === 0 &&
            beats.bpm === null &&
            (beats.fftBpm ?? null) === null &&
            (beats.autocorrBpm ?? null) === null;

          // Diagnose why the detector hasn't produced beats yet.
          const sampleCount = measurement.channels.length;
          const fps = frameStats.measuredFps || 0;
          const windowSec = fps > 0 ? sampleCount / fps : 0;
          const reasons: string[] = [];
          if (!camera.streamActive) reasons.push("camera not streaming");
          else if (!roi.accepted) reasons.push(`ROI rejected (${roi.reason[0] ?? "no contact"})`);
          else if (sampleCount < 40) reasons.push(`window not filled (${sampleCount}/40 samples)`);
          else if (windowSec < 3.5) reasons.push(`window too short (${windowSec.toFixed(1)}s/3.5s)`);
          else if (Number.isFinite(quality.snrDb) && quality.snrDb < 0) reasons.push(`SNR too low (${quality.snrDb.toFixed(1)} dB)`);
          else if (quality.bandPowerRatio < 0.15) reasons.push(`band power weak (${quality.bandPowerRatio.toFixed(2)})`);
          else if (quality.totalScore < 30) reasons.push(`SQI below threshold (${quality.totalScore.toFixed(0)})`);
          else reasons.push("threshold not reached — peak prominence insufficient");

          const statusLine = (
            <div className="mb-1 text-[10px] text-white/55">
              <span className="text-white/40">status:</span>{" "}
              <span className={noBeatsYet ? "text-amber-300" : "text-emerald-300"}>
                {noBeatsYet ? reasons[0] : "detecting beats"}
              </span>
            </div>
          );

          if (noBeatsYet) {
            return (
              <>
                {statusLine}
                <div className="text-[10px] italic text-white/40">
                  awaiting first beat — detector idle
                </div>
              </>
            );
          }

          const fmtBpm = (v: number | null | undefined) =>
            v === null || v === undefined ? "awaiting…" : fmt(v, 1);
          return (
            <>
              {statusLine}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <span className="text-white/55">beats accepted / rejected</span>
              <span>
                {beats.beats.length} / {beats.rejectedCandidates}
              </span>
              <span className="text-white/55">BPM (peaks)</span>
              <span className={beats.bpm !== null ? "text-emerald-400" : "text-white/40"}>
                {fmtBpm(beats.bpm)}
              </span>
              <span className="text-white/55">BPM (FFT)</span>
              <span className={(beats.fftBpm ?? null) !== null ? "text-emerald-400" : "text-white/40"}>
                {fmtBpm(beats.fftBpm)}
              </span>
              <span className="text-white/55">BPM (autocorr)</span>
              <span className={(beats.autocorrBpm ?? null) !== null ? "text-emerald-400" : "text-white/40"}>
                {fmtBpm(beats.autocorrBpm)}
              </span>
              <span className="text-white/55">estimator agreement</span>
              <span className={beats.estimatorAgreementBpm !== undefined && beats.estimatorAgreementBpm <= 5 ? "text-emerald-400" : "text-white/40"}>
                {beats.estimatorAgreementBpm === undefined ? "awaiting…" : `${fmt(beats.estimatorAgreementBpm, 1)} BPM`}
              </span>
              <span
                className="cursor-help text-white/55 underline decoration-dotted decoration-white/30 underline-offset-2"
                title={rrConsistencyExplanation}
                onClick={() => setRrExplanationOpen((v) => !v)}
              >
                RR consistency ⓘ
              </span>
              <span
                key={`rr-${rrCount}`}
                className={
                  rrCount < 2
                    ? "animate-fade-in italic text-white/40"
                    : "animate-scale-in rounded px-1 ring-1 ring-emerald-300/40 bg-emerald-300/10"
                }
              >
                {rrCount < 2 ? (
                  `need ≥2 beats (have ${beats.beats.length} beats / ${rrCount} RRs)`
                ) : (
                  <>
                    {fmt(quality.rrConsistency, 2)}
                    {rrTrend === "up" && <span className="ml-1 text-emerald-400">▲</span>}
                    {rrTrend === "down" && <span className="ml-1 text-red-400">▼</span>}
                    {rrTrend === "flat" && <span className="ml-1 text-white/40">▬</span>}
                    <span className="ml-1 text-[9px] text-white/40">
                      ({beats.beats.length} beats / using {rrCount} RR{rrCount === 1 ? "" : "s"})
                    </span>
                    {rrHistory.length >= 2 && (
                      <span
                        className="ml-1 text-[9px] text-white/50"
                        title="First → last value of the trend window used for the ▲/▼/▬ arrow"
                      >
                        [trend: {rrHistory[0].value.toFixed(2)}@{fmtClock(rrHistory[0].timestamp)} →{" "}
                        {rrHistory[rrHistory.length - 1].value.toFixed(2)}@
                        {fmtClock(rrHistory[rrHistory.length - 1].timestamp)}]
                      </span>
                    )}
                  </>
                )}
              </span>
              <span className="text-white/55">RR intervals (last 5)</span>
              <span
                key={beats.rrIntervalsMs.length < 2 ? "rri-empty" : "rri-value"}
                className={
                  beats.rrIntervalsMs.length < 2
                    ? "animate-fade-in text-[10px] italic text-white/40"
                    : "animate-fade-in text-[9px]"
                }
              >
                {beats.rrIntervalsMs.length < 2
                  ? `need ≥2 beats (have ${beats.beats.length})`
                  : beats.rrIntervalsMs.slice(-5).map((rr) => `${fmt(rr, 0)}ms`).join(", ")}
              </span>
              {beats.beats.length >= 2 && rrCount < beats.beats.length - 1 && (
                <div className="col-span-2 mt-1 rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-1 text-[10px] text-amber-300">
                  ⚠ beat/RR mismatch: {beats.beats.length} beats but only {rrCount} RR interval{rrCount === 1 ? "" : "s"}{" "}
                  (expected {beats.beats.length - 1}). Some beats were dropped from the RR series — RR consistency is waiting for a contiguous run.{" "}
                  <button
                    type="button"
                    onClick={() => setRrExplanationOpen((v) => !v)}
                    className="ml-1 underline decoration-dotted underline-offset-2 hover:text-amber-200"
                    aria-expanded={rrExplanationOpen}
                  >
                    {rrExplanationOpen ? "Hide details" : "Why am I waiting?"}
                  </button>
                </div>
              )}
              {rrExplanationOpen && (
                <div className="col-span-2 mt-1 animate-fade-in whitespace-pre-wrap rounded border border-emerald-400/30 bg-emerald-400/5 px-1.5 py-1 text-[10px] text-emerald-100">
                  {rrConsistencyExplanation}
                </div>
              )}
              </div>
            </>
          );
        })()}
      </div>

      {/* OUTPUT SECTION */}
      <div className="mb-3 border-l-2 border-yellow-500/50 pl-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-yellow-300">Output</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-white/55">state</span>
          <span>{measurement.published.state}</span>
          <span className="text-white/55">BPM / confidence</span>
          <span>
            {fmt(measurement.published.bpm, 0)} / {fmt(measurement.published.bpmConfidence * 100, 0)}%
          </span>
          <span className="text-white/55">SpO2 / confidence</span>
          <span>
            {fmt(oxygen.spo2, 0)}% / {fmt(oxygen.confidence * 100, 0)}%
            <span
              className={
                "ml-1 rounded px-1 text-[9px] " +
                (oxygen.calibrationBadge === "calibrated"
                  ? "bg-emerald-400/20 text-emerald-300"
                  : oxygen.calibrationBadge === "partial"
                    ? "bg-amber-400/20 text-amber-300"
                    : "bg-red-400/20 text-red-300")
              }
              title={`SpO2 calibration badge: ${oxygen.calibrationBadge}. Partial = generic-fallback gains, no clinical fit.`}
            >
              {oxygen.calibrationBadge}
            </span>
          </span>
          <span className="text-white/55">can publish</span>
          <span className={measurement.published.canPublishVitals ? "text-emerald-400" : "text-amber-400"}>
            {String(measurement.published.canPublishVitals)}
          </span>
          <span className="text-white/55">good window streak</span>
          <span className={measurement.published.goodWindowStreak >= 3 ? "text-emerald-400" : "text-amber-400"}>
            {measurement.published.goodWindowStreak}
          </span>
          <span className="text-white/55">last valid timestamp</span>
          <span>
            {measurement.published.lastValidTimestamp ? fmt((Date.now() - measurement.published.lastValidTimestamp) / 1000, 1) + "s ago" : "--"}
          </span>
        </div>
      </div>

      {/* PIPELINE STAGE BLOCK */}
      <div className="mb-3 border-l-2 border-rose-500/50 pl-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-rose-300">Pipeline stage</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-white/55">camera</span>
          <span className={camera.cameraReady ? "text-emerald-400" : "text-red-400"}>
            {camera.cameraReady ? "READY" : "NOT_READY"}
          </span>
          <span className="text-white/55">finger acquisition</span>
          <span className={measurement.rawSamples.length > 0 ? "text-emerald-400" : "text-red-400"}>
            {measurement.rawSamples.length > 0 ? `${measurement.rawSamples.length} samples` : "NO_SAMPLE"}
          </span>
          <span className="text-white/55">selected channel</span>
          <span>{latestChannels?.selectedName ?? "--"}</span>
          <span className="text-white/55">beats accepted</span>
          <span>{beats.beats.length}</span>
          <span className="text-white/55">publication state</span>
          <span>{measurement.published.state}</span>
        </div>
        <div className="mt-2 text-[10px] text-rose-200">
          {measurement.published.message}
        </div>
      </div>

      {/* REJECTION REASONS */}
      <div className="mt-3 border-t border-red-500/30 pt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-white/70">rejection reasons</span>
          <span className="text-[10px] text-white/50">({reasons.length})</span>
        </div>
        <div className="whitespace-pre-wrap break-words font-mono text-[10px]">
          {reasons.length ? (
            reasons.map((r, i) => (
              <span key={i} className="mr-2 inline-block rounded bg-red-500/20 px-1.5 py-0.5 text-red-300">
                {r}
              </span>
            ))
          ) : (
            <span className="text-emerald-400">-- NONE --</span>
          )}
        </div>
      </div>
    </div>
  );
}
