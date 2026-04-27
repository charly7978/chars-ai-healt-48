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

export default function ForensicPPGDebugPanel({ measurement }: ForensicPPGDebugPanelProps) {
  const latestSample = measurement.rawSamples[measurement.rawSamples.length - 1];
  const latestChannels = measurement.channels[measurement.channels.length - 1];
  const quality = measurement.quality ?? measurement.published.quality;
  const evidence = measurement.published.evidence;
  const cameraSettings = measurement.camera.settings;
  const cameraCapabilities = measurement.camera.capabilities as any;
  const reasons = measurement.published.quality.reasons;

  return (
    <div className="max-h-[70vh] w-[min(92vw,520px)] overflow-y-auto rounded-md border border-emerald-400/20 bg-black/88 p-3 font-mono text-[11px] leading-relaxed text-emerald-100 shadow-2xl backdrop-blur-md">
      <div className="mb-2 flex items-center justify-between border-b border-white/10 pb-2 text-white">
        <span className="font-semibold">PPG FORENSIC DEBUG</span>
        <span>{measurement.published.state}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-white/55">camera ready</span>
        <span>{String(measurement.camera.cameraReady)}</span>
        <span className="text-white/55">torch available/enabled</span>
        <span>
          {String(measurement.camera.torchAvailable)} / {String(measurement.camera.torchEnabled)}
        </span>
        <span className="text-white/55">video settings</span>
        <span>
          {fmt(cameraSettings?.width, 0)}x{fmt(cameraSettings?.height, 0)} @{" "}
          {fmt(cameraSettings?.frameRate, 1)}
        </span>
        <span className="text-white/55">cap torch/fps</span>
        <span>
          {String(Boolean(cameraCapabilities?.torch))} / {fmt(cameraCapabilities?.frameRate?.max, 1)}
        </span>
        <span className="text-white/55">sampler</span>
        <span>
          {measurement.frameStats.width}x{measurement.frameStats.height} @{" "}
          {fmt(measurement.frameStats.measuredFps, 1)} fps
        </span>
        <span className="text-white/55">frames/dropped</span>
        <span>
          {measurement.frameStats.frameCount} / {measurement.frameStats.droppedFrames}
        </span>
        <span className="text-white/55">ROI</span>
        <span>
          {evidence.roi.roi.x},{evidence.roi.roi.y} {evidence.roi.roi.width}x
          {evidence.roi.roi.height}
        </span>
        <span className="text-white/55">raw RGB</span>
        <span>{rgb(latestSample?.raw)}</span>
        <span className="text-white/55">linear RGB</span>
        <span>{rgb(latestSample?.linear)}</span>
        <span className="text-white/55">OD RGB</span>
        <span>{rgb(latestSample?.od)}</span>
        <span className="text-white/55">G1/G2/G3</span>
        <span>
          {fmt(latestChannels?.g1)} / {fmt(latestChannels?.g2)} / {fmt(latestChannels?.g3)}
        </span>
        <span className="text-white/55">selected</span>
        <span>{latestChannels?.selectedName ?? "--"}</span>
        <span className="text-white/55">saturation RGB</span>
        <span>
          {fmt(evidence.roi.highSaturation.r)} / {fmt(evidence.roi.highSaturation.g)} /{" "}
          {fmt(evidence.roi.highSaturation.b)}
        </span>
        <span className="text-white/55">perfusion RGB</span>
        <span>{rgb(latestSample?.perfusion)}</span>
        <span className="text-white/55">band power</span>
        <span>{fmt(quality.bandPowerRatio)}</span>
        <span className="text-white/55">FFT BPM</span>
        <span>{fmt(quality.fftBpm, 1)}</span>
        <span className="text-white/55">autocorr BPM</span>
        <span>{fmt(quality.autocorrBpm, 1)}</span>
        <span className="text-white/55">peak BPM</span>
        <span>{fmt(quality.peakBpm, 1)}</span>
        <span className="text-white/55">agreement</span>
        <span>{fmt(quality.estimatorAgreementBpm, 1)} BPM</span>
        <span className="text-white/55">SQI total</span>
        <span>
          {fmt(quality.totalScore, 1)} / {quality.grade}
        </span>
        <span className="text-white/55">publication</span>
        <span>{measurement.published.state}</span>
        <span className="text-white/55">can publish/vibrate</span>
        <span>
          {String(measurement.published.canPublishVitals)} /{" "}
          {String(measurement.published.canVibrateBeat)}
        </span>
      </div>

      <div className="mt-3 border-t border-white/10 pt-2">
        <div className="mb-1 text-white/70">reason codes</div>
        <div className="whitespace-pre-wrap break-words text-amber-200">
          {reasons.length ? reasons.join(", ") : "--"}
        </div>
      </div>
      <div className="mt-2 border-t border-white/10 pt-2">
        <div className="mb-1 text-white/70">last rejection</div>
        <div className="text-amber-200">{reasons[reasons.length - 1] ?? "--"}</div>
      </div>
    </div>
  );
}
