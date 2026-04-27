/**
 * FloatingVitalsOverlay.tsx
 * ----------------------------------------------------------------------------
 * Overlay flotante con vitales y controles.
 * 
 * - Posición: esquinas, flotante
 * - Fondo: semi-transparente
 * - No tapa el monitor cardiaco central
 */

import { Activity, Camera, Flashlight, Play, Square } from "lucide-react";
import type { PpgEngineState as EngineState } from "../hooks/usePpgEngine";

interface FloatingVitalsOverlayProps {
  state: EngineState;
  onStart: () => void;
  onStop: () => void;
}

export function FloatingVitalsOverlay({ state, onStart, onStop }: FloatingVitalsOverlayProps) {
  const isRunning = state.engineState !== "idle" && state.engineState !== "error";
  const isValid = state.engineState === "ppg_valid";
  
  const bpm = state.publication.canPublishBpm ? state.publication.publishedBpm : null;
  const spo2 = state.publication.canPublishSpo2 ? state.publication.publishedSpo2 : null;

  return (
    <div className="fixed inset-0 pointer-events-none">
      {/* Header - estado del sistema */}
      <div className="absolute top-4 left-4 right-4 flex justify-between items-start pointer-events-auto">
        <div className="flex items-center gap-3 bg-slate-900/80 backdrop-blur-sm px-4 py-2 rounded-lg">
          <div className={`w-2 h-2 rounded-full ${
            state.cameraStatus.ready ? "bg-emerald-500" : "bg-red-500"
          }`} />
          <span className="text-sm font-medium text-slate-200">
            {state.engineState.replace(/_/g, " ").toUpperCase()}
          </span>
          {state.debug.fps > 0 && (
            <span className="text-xs text-slate-400">
              {state.debug.fps.toFixed(0)} FPS
            </span>
          )}
        </div>

        {/* Torch status */}
        <div className="flex items-center gap-2 bg-slate-900/80 backdrop-blur-sm px-3 py-2 rounded-lg">
          {state.torchStatus.state === "ON_CONFIRMED" ? (
            <Flashlight className="w-4 h-4 text-amber-400" />
          ) : (
            <Flashlight className="w-4 h-4 text-slate-500" />
          )}
          <span className="text-xs text-slate-400">
            {state.torchStatus.state}
          </span>
        </div>
      </div>

      {/* Vitals - lado derecho */}
      <div className="absolute top-1/2 right-4 -translate-y-1/2 flex flex-col gap-3 pointer-events-auto">
        {/* BPM */}
        <div className={`p-4 rounded-xl backdrop-blur-sm ${
          isValid ? "bg-cyan-500/20" : "bg-slate-800/80"
        }`}>
          <div className="flex items-center gap-2 mb-1">
            <Activity className="w-5 h-5 text-cyan-400" />
            <span className="text-sm text-slate-400">BPM</span>
          </div>
          <div className="text-4xl font-bold text-cyan-200">
            {bpm ?? "--"}
          </div>
          {state.publication.bpmConfidence > 0 && (
            <div className="text-xs text-cyan-400/70 mt-1">
              {(state.publication.bpmConfidence * 100).toFixed(0)}%
            </div>
          )}
        </div>

        {/* SpO2 */}
        <div className={`p-4 rounded-xl backdrop-blur-sm ${
          isValid && spo2 ? "bg-blue-500/20" : "bg-slate-800/80"
        }`}>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm text-slate-400">SpO₂</span>
          </div>
          <div className="text-4xl font-bold text-blue-200">
            {spo2 ?? "--"}
          </div>
          <div className="text-xs text-slate-500 mt-1">%</div>
        </div>

        {/* ROI Score */}
        {state.roi && (
          <div className="bg-slate-800/80 backdrop-blur-sm p-3 rounded-xl">
            <div className="text-xs text-slate-400 mb-1">ROI Score</div>
            <div className="text-lg font-semibold text-slate-200">
              {(state.roi.roiScore * 100).toFixed(0)}%
            </div>
            <div className="text-xs text-slate-500">
              {state.roi.state}
            </div>
          </div>
        )}
      </div>

      {/* Controls - footer */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-4 pointer-events-auto">
        {!isRunning ? (
          <button
            onClick={onStart}
            className="flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 text-slate-900 px-6 py-3 rounded-full font-semibold transition-colors"
          >
            <Play className="w-5 h-5" />
            Iniciar Medición
          </button>
        ) : (
          <button
            onClick={onStop}
            className="flex items-center gap-2 bg-red-500/80 hover:bg-red-400 text-white px-6 py-3 rounded-full font-semibold transition-colors"
          >
            <Square className="w-5 h-5" />
            Detener
          </button>
        )}

        {/* Debug info */}
        <div className="bg-slate-900/80 backdrop-blur-sm px-4 py-2 rounded-full text-xs text-slate-400">
          <div>Buf: {state.debug.bufferSize}</div>
          <div>Proc: {state.debug.processingTimeMs.toFixed(1)}ms</div>
        </div>
      </div>

      {/* Camera preview (small) */}
      <div className="absolute bottom-8 left-8 w-40 h-30 bg-slate-800/80 backdrop-blur-sm rounded-lg overflow-hidden pointer-events-auto">
        <video
          ref={(el) => {
            if (el && state.cameraStatus.ready) {
              // Video se maneja por el hook, esto es solo visual
            }
          }}
          className="w-full h-full object-cover opacity-50"
          playsInline
          muted
        />
        <div className="absolute bottom-1 left-1 right-1 flex items-center justify-center gap-1 text-xs text-slate-400">
          <Camera className="w-3 h-3" />
          <span>{state.cameraStatus.facingMode}</span>
        </div>
      </div>
    </div>
  );
}
