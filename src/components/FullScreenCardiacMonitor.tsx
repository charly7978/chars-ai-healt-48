import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bug,
  Camera,
  CheckCircle,
  Flashlight,
  Play,
  RadioTower,
  Square,
  XCircle,
} from "lucide-react";
import type { UsePPGMeasurementResult } from "@/ppg/usePPGMeasurement";
import ForensicPPGDebugPanel from "./ForensicPPGDebugPanel";

interface FullScreenCardiacMonitorProps {
  measurement: UsePPGMeasurementResult;
}

type TracePoint = { t: number; value: number };

function percentile(values: number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function normalizeY(values: number[], top: number, height: number): number[] {
  if (values.length === 0) return [];
  const p05 = percentile(values, 0.05);
  const p95 = percentile(values, 0.95);
  const mid = (p05 + p95) / 2;
  const span = Math.max(0.25, p95 - p05);
  return values.map((value) => top + height / 2 - ((value - mid) / span) * height * 0.82);
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, dpr: number): void {
  ctx.fillStyle = "#020506";
  ctx.fillRect(0, 0, width, height);

  const minorX = 38 * dpr;
  const minorY = 30 * dpr;
  ctx.lineWidth = 1 * dpr;
  ctx.strokeStyle = "rgba(26, 232, 184, 0.055)";
  ctx.beginPath();
  for (let x = 0; x <= width; x += minorX) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += minorY) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  ctx.strokeStyle = "rgba(26, 232, 184, 0.13)";
  ctx.beginPath();
  for (let x = 0; x <= width; x += minorX * 5) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += minorY * 5) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
}

function drawTrace(params: {
  ctx: CanvasRenderingContext2D;
  points: TracePoint[];
  top: number;
  height: number;
  width: number;
  color: string;
  lineWidth: number;
  dpr: number;
  glow?: string;
  label?: string;
}): void {
  const { ctx, points, top, height, width, color, lineWidth, dpr, glow, label } = params;

  ctx.strokeStyle = "rgba(255,255,255,0.10)";
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(0, top + height / 2);
  ctx.lineTo(width, top + height / 2);
  ctx.stroke();

  if (label) {
    ctx.fillStyle = "rgba(214, 255, 242, 0.46)";
    ctx.font = `${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillText(label, 14 * dpr, top + 15 * dpr);
  }

  if (points.length < 2) return;
  const y = normalizeY(points.map((point) => point.value), top, height);
  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const spanT = Math.max(1, maxT - minT);

  ctx.save();
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = 10 * dpr;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth * dpr;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();

  let drawing = false;
  for (let i = 0; i < points.length; i += 1) {
    // Skip NaN values (gaps)
    if (Number.isNaN(points[i].value)) {
      drawing = false;
      continue;
    }

    const x = ((points[i].t - minT) / spanT) * width;
    if (!drawing) {
      ctx.moveTo(x, y[i]);
      drawing = true;
    } else {
      ctx.lineTo(x, y[i]);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawBeatMarkers(
  ctx: CanvasRenderingContext2D,
  beatMarkers: Array<{ t: number; confidence: number; onsetT?: number | null; troughT?: number | null }>,
  withheldMarkers: Array<{ t: number; reason: string }>,
  tracePoints: TracePoint[],
  width: number,
  top: number,
  height: number,
  dpr: number,
): void {
  if (tracePoints.length < 2) return;
  const minT = tracePoints[0].t;
  const maxT = tracePoints[tracePoints.length - 1].t;
  const spanT = Math.max(1, maxT - minT);
  const xOf = (t: number) => ((t - minT) / spanT) * width;

  for (const beat of beatMarkers) {
    if (beat.t < minT || beat.t > maxT) continue;
    const x = xOf(beat.t);
    // Peak marker (vertical line + dot)
    ctx.strokeStyle = `rgba(255,255,255,${0.22 + beat.confidence * 0.42})`;
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    ctx.moveTo(x, top + height * 0.1);
    ctx.lineTo(x, top + height * 0.9);
    ctx.stroke();
    ctx.fillStyle = "#eafff4";
    ctx.beginPath();
    ctx.arc(x, top + height * 0.15, 3.2 * dpr, 0, Math.PI * 2);
    ctx.fill();
    // Onset marker (small upward triangle, cyan)
    if (beat.onsetT != null && beat.onsetT >= minT && beat.onsetT <= maxT) {
      const ox = xOf(beat.onsetT);
      ctx.fillStyle = "rgba(94,234,212,0.85)";
      ctx.beginPath();
      ctx.moveTo(ox, top + height * 0.78);
      ctx.lineTo(ox - 3 * dpr, top + height * 0.86);
      ctx.lineTo(ox + 3 * dpr, top + height * 0.86);
      ctx.closePath();
      ctx.fill();
    }
    // Trough marker (small downward triangle, magenta)
    if (beat.troughT != null && beat.troughT >= minT && beat.troughT <= maxT) {
      const tx = xOf(beat.troughT);
      ctx.fillStyle = "rgba(244,114,182,0.78)";
      ctx.beginPath();
      ctx.moveTo(tx, top + height * 0.92);
      ctx.lineTo(tx - 3 * dpr, top + height * 0.84);
      ctx.lineTo(tx + 3 * dpr, top + height * 0.84);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Withheld candidates: small red 'x' high in the band, with reason text
  ctx.font = `${9 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  for (const w of withheldMarkers) {
    if (w.t < minT || w.t > maxT) continue;
    const x = xOf(w.t);
    ctx.strokeStyle = "rgba(248,113,113,0.55)";
    ctx.lineWidth = 1.1 * dpr;
    const y = top + height * 0.06;
    const r = 4 * dpr;
    ctx.beginPath();
    ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
    ctx.stroke();
    ctx.fillStyle = "rgba(248,113,113,0.6)";
    ctx.fillText(w.reason.slice(0, 6), x + 6 * dpr, y + 3 * dpr);
  }
}

function mainTrace(measurement: UsePPGMeasurementResult): TracePoint[] {
  // Use real ring buffer from channels with gap handling
  const recentChannels = measurement.channels.slice(-520);
  if (recentChannels.length < 2) return [];

  const points: TracePoint[] = [];
  const maxGapMs = 200; // Maximum gap to interpolate (200ms)

  for (let i = 0; i < recentChannels.length; i++) {
    const sample = recentChannels[i];

    // Skip zero values (no signal)
    if (sample.selected === 0 && sample.g1 === 0 && sample.g2 === 0 && sample.g3 === 0) {
      continue;
    }

    if (i > 0) {
      const prev = recentChannels[i - 1];
      const gap = sample.t - prev.t;
      if (gap > maxGapMs) {
        // Gap detected - don't interpolate, cut the line
        points.push({ t: sample.t, value: NaN }); // NaN creates a break in the line
      }
    }
    points.push({ t: sample.t, value: sample.selected });
  }

  return points;
}

function drawMonitor(canvas: HTMLCanvasElement, measurement: UsePPGMeasurementResult): void {
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

  drawGrid(ctx, width, height, dpr);

  const topReserve = 86 * dpr;
  const bottomReserve = 128 * dpr;
  const channelBand = Math.max(92 * dpr, height * 0.18);
  const mainTop = topReserve;
  const mainHeight = Math.max(200 * dpr, height - topReserve - bottomReserve - channelBand);
  const channelTop = mainTop + mainHeight + 12 * dpr;
  const trace = mainTrace(measurement);
  const official = measurement.published.waveformSource === "REAL_PPG";
  const debugTrace = measurement.published.waveformSource === "RAW_DEBUG_ONLY";
  const noSignal = measurement.published.waveformSource === "NONE";

  // Show flat baseline when no signal
  if (noSignal || trace.length === 0) {
    ctx.strokeStyle = "rgba(148,163,184,0.18)";
    ctx.lineWidth = 1.55 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, mainTop + mainHeight / 2);
    ctx.lineTo(width, mainTop + mainHeight / 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(214, 255, 242, 0.46)";
    ctx.font = `${10 * dpr}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillText("SIN SEÑAL PPG VERIFICABLE", 14 * dpr, mainTop + 15 * dpr);
  } else {
    drawTrace({
      ctx,
      points: trace,
      top: mainTop,
      height: mainHeight,
      width,
      color: official ? "#19ff88" : debugTrace ? "rgba(251,191,36,0.56)" : "rgba(148,163,184,0.18)",
      lineWidth: official ? 2.25 : 1.55,
      glow: official ? "rgba(25,255,136,0.58)" : undefined,
      label: official ? "REAL PPG LOCKED" : debugTrace ? "RAW DEBUG - NOT A VITAL WAVEFORM" : "NO VERIFIED PPG",
      dpr,
    });
  }

  if (official) {
    drawBeatMarkers(ctx, measurement.published.beatMarkers, trace, width, mainTop, mainHeight, dpr);
  }

  const recentChannels = measurement.channels.slice(-260);
  const laneHeight = channelBand / 3;
  drawTrace({
    ctx,
    points: recentChannels.map((sample) => ({ t: sample.t, value: sample.g1 })),
    top: channelTop,
    height: laneHeight,
    width,
    color: "rgba(45,212,191,0.74)",
    lineWidth: 1.1,
    label: "G1 GREEN OD",
    dpr,
  });
  drawTrace({
    ctx,
    points: recentChannels.map((sample) => ({ t: sample.t, value: sample.g2 })),
    top: channelTop + laneHeight,
    height: laneHeight,
    width,
    color: "rgba(96,165,250,0.68)",
    lineWidth: 1,
    label: "G2 CHROM OD",
    dpr,
  });
  drawTrace({
    ctx,
    points: recentChannels.map((sample) => ({ t: sample.t, value: sample.g3 })),
    top: channelTop + laneHeight * 2,
    height: laneHeight,
    width,
    color: "rgba(244,114,182,0.62)",
    lineWidth: 1,
    label: "G3 PCA/POS",
    dpr,
  });
}

function shortReason(reasons: string[]): string {
  if (reasons.length === 0) return "OK";
  return reasons.slice(-3).join(" | ");
}

export default function FullScreenCardiacMonitor({ measurement }: FullScreenCardiacMonitorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = measurement.camera.cameraReady;
  const bpm = measurement.published.bpm;
  const oxygen = measurement.published.oxygen;
  const latestSample = measurement.rawSamples[measurement.rawSamples.length - 1];
  const latestChannel = measurement.channels[measurement.channels.length - 1];
  const reasons = measurement.published.quality.reasons;

  // Render FPS tracking
  const renderCountRef = useRef(0);
  const lastRenderTimeRef = useRef(0);
  const renderFpsRef = useRef(0);

  const sessionLabel = useMemo(() => {
    const width = measurement.camera.settings?.width ?? measurement.frameStats.width;
    const height = measurement.camera.settings?.height ?? measurement.frameStats.height;
    return `${width || 0}x${height || 0} | ACQ:${measurement.fpsStats.acquisitionFps.toFixed(1)} PROC:${measurement.fpsStats.processingFps.toFixed(1)} REND:${renderFpsRef.current.toFixed(1)}`;
  }, [measurement.camera.settings, measurement.frameStats, measurement.fpsStats]);

  useEffect(() => {
    let raf = 0;
    const render = () => {
      if (canvasRef.current) drawMonitor(canvasRef.current, measurement);

      // Track render FPS
      renderCountRef.current++;
      const now = performance.now();
      if (now - lastRenderTimeRef.current >= 1000) {
        renderFpsRef.current = renderCountRef.current;
        renderCountRef.current = 0;
        lastRenderTimeRef.current = now;
      }

      raf = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(raf);
  }, [measurement]);

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
    <main className="fixed inset-0 h-[100svh] w-screen overflow-hidden bg-[#020506] text-slate-100">
      <video
        ref={measurement.videoRef}
        className="pointer-events-none fixed left-0 top-0 h-16 w-16 opacity-50 border border-red-500 z-50"
        autoPlay
        muted
        playsInline
      />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-[76px] items-center justify-between border-b border-emerald-300/10 bg-black/55 px-3 backdrop-blur-md">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-200/86">
            <RadioTower className="h-3.5 w-3.5" />
            FORENSIC PPG ACQUISITION
          </div>
          <div className="mt-1 truncate font-mono text-[11px] text-slate-300/70">
            CAMERA FRAME REAL - RGB LINEAR - OD - G1/G2/G3 - SQI - PUBLICATION GATE
          </div>
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide">
          <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.045] px-2 py-1 text-slate-200">
            <Camera className="h-3.5 w-3.5 text-cyan-300" />
            {active ? "CAM LIVE" : "CAM OFF"}
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.045] px-2 py-1 text-slate-200">
            <Flashlight className="h-3.5 w-3.5 text-amber-300" />
            {measurement.camera.torchAvailable
              ? measurement.camera.torchEnabled
                ? "TORCH ON"
                : "TORCH OFF"
              : "TORCH N/A"}
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.045] px-2 py-1 text-slate-200">
            {measurement.published.evidence.roi.accepted ? (
              <CheckCircle className="h-3.5 w-3.5 text-emerald-300" />
            ) : (
              <XCircle className="h-3.5 w-3.5 text-red-400" />
            )}
            ROI
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.045] px-2 py-1 text-slate-200">
            {measurement.published.waveformSource === "REAL_PPG" ? (
              <CheckCircle className="h-3.5 w-3.5 text-emerald-300" />
            ) : (
              <XCircle className="h-3.5 w-3.5 text-red-400" />
            )}
            SIGNAL
          </span>
          <span className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.045] px-2 py-1 text-slate-200">
            {measurement.published.canPublishVitals ? (
              <CheckCircle className="h-3.5 w-3.5 text-emerald-300" />
            ) : (
              <XCircle className="h-3.5 w-3.5 text-red-400" />
            )}
            PUB
          </span>
          {measurement.published.quality.saturationPenalty > 0.45 && (
            <span className="inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-300">
              <AlertTriangle className="h-3.5 w-3.5" />
              SAT
            </span>
          )}
          {measurement.published.evidence.roi.motionRisk > 0.3 && (
            <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" />
              MOTION
            </span>
          )}
          <span className="rounded border border-white/10 bg-white/[0.045] px-2 py-1 text-slate-200">
            {sessionLabel}
          </span>
        </div>
      </header>

      <aside className="pointer-events-none absolute right-3 top-[86px] z-20 w-[min(38vw,350px)] space-y-2">
        <div className="rounded border border-emerald-300/14 bg-black/62 p-3 backdrop-blur-md">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.22em] text-slate-400">
            <span>HEART RATE</span>
            <span>{measurement.published.state}</span>
          </div>
          <div className="flex items-end justify-between">
            <div className="font-mono text-[clamp(56px,10vw,104px)] font-semibold leading-none text-emerald-300">
              {measurement.published.canPublishVitals && bpm !== null ? bpm : "--"}
            </div>
            <div className="pb-2 text-right">
              <div className="text-lg font-semibold text-slate-200">BPM</div>
              <div className="font-mono text-xs text-slate-400">
                CONF {(measurement.published.bpmConfidence * 100).toFixed(0)}%
              </div>
            </div>
          </div>
        </div>

        <div className="rounded border border-cyan-300/14 bg-black/62 p-3 backdrop-blur-md">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-[0.22em] text-slate-400">
            <span>OXYGEN</span>
            <span>{oxygen.method}</span>
          </div>
          <div className="flex items-end justify-between">
            <div className="font-mono text-[clamp(42px,7vw,72px)] font-semibold leading-none text-cyan-200">
              {oxygen.canPublish && oxygen.spo2 !== null ? oxygen.spo2 : "--"}
            </div>
            <div className="pb-1 text-right">
              <div className="text-lg font-semibold text-slate-200">SpO2 %</div>
              <div className="font-mono text-xs text-slate-400">
                CONF {(oxygen.confidence * 100).toFixed(0)}%
              </div>
            </div>
          </div>
        </div>
      </aside>

      <section className="pointer-events-none absolute bottom-0 left-0 right-0 z-20 border-t border-emerald-300/10 bg-black/70 px-3 py-2 backdrop-blur-md">
        <div className="grid grid-cols-2 gap-2 text-[10px] uppercase tracking-wide text-slate-300 sm:grid-cols-4 lg:grid-cols-8">
          <div>
            <div className="text-slate-500">SQI</div>
            <div className="font-mono text-emerald-200">
              {measurement.published.quality.totalScore.toFixed(0)} / {measurement.published.quality.grade}
            </div>
          </div>
          <div>
            <div className="text-slate-500">SELECTED</div>
            <div className="truncate font-mono text-cyan-200">{latestChannel?.selectedName ?? "--"}</div>
          </div>
          <div>
            <div className="text-slate-500">CONTACT</div>
            <div className="font-mono text-slate-100">
              {(measurement.published.evidence.roi.contactScore * 100).toFixed(0)}%
            </div>
          </div>
          <div>
            <div className="text-slate-500">PERFUSION</div>
            <div className="font-mono text-slate-100">
              {measurement.published.quality.acDcPerfusionIndex.toFixed(3)}
            </div>
          </div>
          <div>
            <div className="text-slate-500">RGB RAW</div>
            <div className="font-mono text-slate-100">
              {latestSample
                ? `${latestSample.raw.r.toFixed(0)},${latestSample.raw.g.toFixed(0)},${latestSample.raw.b.toFixed(0)}`
                : "--"}
            </div>
          </div>
          <div>
            <div className="text-slate-500">OD RGB</div>
            <div className="font-mono text-slate-100">
              {latestSample
                ? `${latestSample.od.r.toFixed(3)},${latestSample.od.g.toFixed(3)},${latestSample.od.b.toFixed(3)}`
                : "--"}
            </div>
          </div>
          <div>
            <div className="text-slate-500">AGREEMENT</div>
            <div className="font-mono text-slate-100">
              {measurement.published.quality.estimatorAgreementBpm.toFixed(1)} BPM
            </div>
          </div>
          <div>
            <div className="text-slate-500">REJECT</div>
            <div className="truncate font-mono text-amber-200">{shortReason(reasons)}</div>
          </div>
        </div>
      </section>

      <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 text-emerald-500/[0.035]">
        <Activity className="h-[42vh] w-[42vh]" strokeWidth={0.5} />
      </div>

      <div className="absolute bottom-[74px] right-3 z-30 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setDebugOpen((open) => !open)}
          className="inline-flex h-11 w-11 items-center justify-center rounded border border-white/12 bg-black/72 text-white/90 backdrop-blur-md transition hover:bg-white/12"
          aria-label="Debug"
        >
          <Bug className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={toggle}
          disabled={busy}
          className="inline-flex h-11 items-center gap-2 rounded border border-emerald-300/20 bg-emerald-400/14 px-4 text-sm font-semibold uppercase tracking-wide text-white backdrop-blur-md transition hover:bg-emerald-400/24 disabled:opacity-55"
        >
          {active ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {active ? "Stop" : "Start"}
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-[82px] left-3 z-20 max-w-[calc(100vw-180px)] rounded border border-white/10 bg-black/64 px-3 py-2 font-mono text-xs uppercase tracking-wide text-slate-200 backdrop-blur-md">
        {measurement.published.message}
      </div>

      {debugOpen && (
        <div className="absolute bottom-[132px] right-3 z-40">
          <ForensicPPGDebugPanel measurement={measurement} />
        </div>
      )}
    </main>
  );
}
