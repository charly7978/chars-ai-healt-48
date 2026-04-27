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
  const quality = measurement.quality ?? measurement.published.quality;
  const evidence = measurement.published.evidence;
  const roi = evidence.roi;
  const oxygen = measurement.published.oxygen;
  const camera = measurement.camera;
  const cameraSettings = camera.settings;
  const cameraCapabilities = camera.capabilities as DebugCapabilities | null;
  const debug = measurement.debug;
  const reasons = measurement.published.quality.reasons;
  const frameStats = measurement.frameStats;

  // Determine status color
  const isAccepted = roi.accepted;
  const statusColor = isAccepted ? "text-emerald-400" : "text-amber-400";

  return (
    <div className="max-h-[70vh] w-[min(92vw,520px)] overflow-y-auto rounded-md border border-emerald-400/20 bg-black/88 p-3 font-mono text-[11px] leading-relaxed text-emerald-100 shadow-2xl backdrop-blur-md">
      <div className="mb-2 flex items-center justify-between border-b border-white/10 pb-2 text-white">
        <span className="font-semibold">PPG FORENSIC DEBUG</span>
        <span className={statusColor}>{isAccepted ? "ACCEPTED" : "REJECTED"}</span>
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
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-white/55">beats accepted / rejected</span>
          <span>
            {measurement.beats.beats.length} / {measurement.beats.rejectedCandidates}
          </span>
          <span className="text-white/55">BPM (peaks)</span>
          <span className={measurement.beats.bpm !== null ? "text-emerald-400" : "text-red-400"}>
            {fmt(measurement.beats.bpm, 1)}
          </span>
          <span className="text-white/55">BPM (FFT)</span>
          <span className={measurement.beats.fftBpm !== null ? "text-emerald-400" : "text-red-400"}>
            {fmt(measurement.beats.fftBpm, 1)}
          </span>
          <span className="text-white/55">BPM (autocorr)</span>
          <span className={measurement.beats.autocorrBpm !== null ? "text-emerald-400" : "text-red-400"}>
            {fmt(measurement.beats.autocorrBpm, 1)}
          </span>
          <span className="text-white/55">estimator agreement</span>
          <span className={measurement.beats.estimatorAgreementBpm !== undefined && measurement.beats.estimatorAgreementBpm <= 5 ? "text-emerald-400" : "text-red-400"}>
            {fmt(measurement.beats.estimatorAgreementBpm, 1)} BPM
          </span>
          <span className="text-white/55">RR consistency</span>
          <span>{fmt(quality.rrConsistency, 2)}</span>
          <span className="text-white/55">RR intervals (last 5)</span>
          <span className="text-[9px]">
            {measurement.beats.rrIntervalsMs.slice(-5).map((rr, i) => `${fmt(rr, 0)}ms`).join(", ") || "--"}
          </span>
        </div>
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
