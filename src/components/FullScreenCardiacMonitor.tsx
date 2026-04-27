import { useEffect, useRef, useState } from "react";
import { Activity, Bug, Play, Square } from "lucide-react";
import type { UsePPGMeasurementResult } from "@/ppg/usePPGMeasurement";
import ForensicPPGDebugPanel from "./ForensicPPGDebugPanel";

interface FullScreenCardiacMonitorProps {
  measurement: UsePPGMeasurementResult;
}

function normalizeWaveform(values: number[], height: number): number[] {
  if (values.length === 0) return [];
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const p10 = sorted[Math.floor((sorted.length - 1) * 0.1)];
  const p90 = sorted[Math.floor((sorted.length - 1) * 0.9)];
  const mid = (p10 + p90) / 2;
  const range = Math.max(0.25, p90 - p10);
  const usable = height * 0.72;
  return values.map((value) => height / 2 - ((value - mid) / range) * usable);
}

function drawMonitor(
  canvas: HTMLCanvasElement,
  published: UsePPGMeasurementResult["published"],
): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return;

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(20, 184, 166, 0.10)";
  ctx.lineWidth = Math.max(1, dpr);
  const gridX = Math.max(44 * dpr, width / 24);
  const gridY = Math.max(36 * dpr, height / 14);
  ctx.beginPath();
  for (let x = 0; x <= width; x += gridX) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += gridY) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  if (published.waveform.length < 2) return;

  const yValues = normalizeWaveform(published.waveform, height);
  const xStep = width / Math.max(1, yValues.length - 1);
  ctx.beginPath();
  for (let i = 0; i < yValues.length; i += 1) {
    const x = i * xStep;
    const y = yValues[i];
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  if (published.waveformSource === "REAL_PPG") {
    ctx.shadowColor = "rgba(16, 255, 122, 0.60)";
    ctx.shadowBlur = 10 * dpr;
    ctx.strokeStyle = "#10ff7a";
    ctx.lineWidth = 2.4 * dpr;
  } else {
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(250, 204, 21, 0.34)";
    ctx.lineWidth = 1.4 * dpr;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (published.waveformSource === "RAW_DEBUG_ONLY") {
    ctx.fillStyle = "rgba(250, 204, 21, 0.42)";
    ctx.font = `${12 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillText("RAW DEBUG", 18 * dpr, 34 * dpr);
  }
}

export default function FullScreenCardiacMonitor({
  measurement,
}: FullScreenCardiacMonitorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = measurement.camera.cameraReady;
  const bpm = measurement.published.bpm;

  useEffect(() => {
    let raf = 0;
    const render = () => {
      if (canvasRef.current) drawMonitor(canvasRef.current, measurement.published);
      raf = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(raf);
  }, [measurement.published]);

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (active) await measurement.stop();
      else await measurement.start();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="fixed inset-0 h-[100svh] w-screen overflow-hidden bg-black text-white">
      <video
        ref={measurement.videoRef}
        className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
        autoPlay
        muted
        playsInline
      />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[56vw] flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-white/82">
        <span className="rounded bg-black/42 px-2 py-1 backdrop-blur-sm">
          CAM {measurement.camera.cameraReady ? "READY" : "OFF"}
        </span>
        <span className="rounded bg-black/42 px-2 py-1 backdrop-blur-sm">
          TORCH{" "}
          {measurement.camera.torchAvailable
            ? measurement.camera.torchEnabled
              ? "ON"
              : "OFF"
            : "N/A"}
        </span>
        <span className="rounded bg-black/42 px-2 py-1 backdrop-blur-sm">
          {measurement.frameStats.measuredFps.toFixed(1)} FPS
        </span>
        <span className="rounded bg-black/42 px-2 py-1 backdrop-blur-sm">
          {measurement.frameStats.width}x{measurement.frameStats.height}
        </span>
      </div>

      <div className="pointer-events-none absolute right-4 top-3 z-10 text-right">
        {measurement.published.canPublishVitals && bpm !== null ? (
          <div>
            <div className="text-[clamp(44px,12vw,92px)] font-semibold leading-none text-emerald-300">
              {bpm}
            </div>
            <div className="text-sm font-medium uppercase tracking-[0.24em] text-white/72">
              BPM
            </div>
          </div>
        ) : (
          <div className="rounded bg-black/42 px-2 py-1 text-xs uppercase tracking-wide text-white/54 backdrop-blur-sm">
            BPM --
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 z-10 max-w-[58vw] rounded bg-black/42 px-2 py-1 text-[11px] uppercase tracking-wide text-white/80 backdrop-blur-sm">
        SQI {measurement.published.quality.totalScore.toFixed(0)} /{" "}
        {measurement.published.quality.grade} | {measurement.published.state}
      </div>

      <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 max-w-[72vw] -translate-x-1/2 rounded bg-black/42 px-3 py-1 text-center text-xs font-semibold uppercase tracking-wide text-white/82 backdrop-blur-sm">
        {measurement.published.message}
      </div>

      <div className="absolute bottom-3 right-3 z-20 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setDebugOpen((open) => !open)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/12 bg-black/55 text-white/86 backdrop-blur-sm transition hover:bg-white/12"
          aria-label="Debug"
        >
          <Bug className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          className="inline-flex h-10 items-center gap-2 rounded-md border border-white/12 bg-emerald-500/18 px-3 text-sm font-semibold text-white backdrop-blur-sm transition hover:bg-emerald-500/28 disabled:opacity-55"
        >
          {active ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {active ? "Stop" : "Start"}
        </button>
      </div>

      <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 text-emerald-500/10">
        <Activity className="h-[34vh] w-[34vh]" strokeWidth={0.6} />
      </div>

      {debugOpen && (
        <div className="absolute bottom-16 right-3 z-30">
          <ForensicPPGDebugPanel measurement={measurement} />
        </div>
      )}
    </main>
  );
}
