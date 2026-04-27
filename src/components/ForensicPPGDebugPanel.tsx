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
        </div>
      </div>

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

      {/* SAMPLER SECTION */}
      <div className="mb-3 border-l-2 border-blue-500/50 pl-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-blue-300">Sampler</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-white/55">measured FPS</span>
          <span>{fmt(frameStats.measuredFps, 1)} fps</span>
          <span className="text-white/55">frame interval</span>
          <span>
            {fmt(debug.frameIntervalMs, 1)} ± {fmt(debug.frameIntervalStdMs, 1)} ms
          </span>
          <span className="text-white/55">frames / dropped</span>
          <span>
            {frameStats.frameCount} / {frameStats.droppedFrames}
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
        </div>
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
                  (expected {beats.beats.length - 1}). Some beats were dropped from the RR series — RR consistency is waiting for a contiguous run.
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
