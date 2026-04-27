/**
 * CardiacMonitorCanvas.tsx
 * ----------------------------------------------------------------------------
 * Monitor cardiaco fullscreen con canvas.
 * 
 * Ocupa 100% de la pantalla.
 * Dibuja onda PPG (G3) en tiempo real.
 * High-DPI aware.
 * No tapa con overlays opacos.
 */

import { useEffect, useRef } from "react";
import type { PpgEngineState as EngineState } from "../hooks/usePpgEngine";

interface CardiacMonitorCanvasProps {
  state: EngineState;
}

export function CardiacMonitorCanvas({ state }: CardiacMonitorCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const waveformRef = useRef<number[]>([]);
  const engineStateRef = useRef(state.engineState);
  const beatsRef = useRef(state.beats.beats);

  // Actualizar waveform ref cuando cambia el estado
  useEffect(() => {
    waveformRef.current = state.waveform;
  }, [state.waveform]);

  useEffect(() => {
    engineStateRef.current = state.engineState;
    beatsRef.current = state.beats.beats;
  }, [state.beats.beats, state.engineState]);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Setup high-DPI
    const setupCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      
      ctx.scale(dpr, dpr);
      
      return { width: rect.width, height: rect.height };
    };

    let { width, height } = setupCanvas();

    // Handle resize
    const handleResize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      
      canvas.width = width * window.devicePixelRatio;
      canvas.height = height * window.devicePixelRatio;
      ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    };

    window.addEventListener("resize", handleResize);

    // Animation loop
    let animationId: number;
    
    const render = () => {
      // Clear
      ctx.fillStyle = "#0f172a";  // slate-900
      ctx.fillRect(0, 0, width, height);

      // Draw grid (subtle)
      ctx.strokeStyle = "rgba(148, 163, 184, 0.1)";  // slate-400 @ 10%
      ctx.lineWidth = 1;
      
      const gridSize = 50;
      for (let x = 0; x < width; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y < height; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Draw waveform
      const waveform = waveformRef.current;
      if (waveform.length > 1) {
        ctx.strokeStyle = engineStateRef.current === "ppg_valid" ? "#22d3ee" : "#64748b";  // cyan-400 vs slate-500
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        
        ctx.beginPath();
        
        // Normalize waveform to fit canvas
        const minVal = Math.min(...waveform);
        const maxVal = Math.max(...waveform);
        const range = maxVal - minVal || 1;
        
        const pointsToDraw = Math.min(waveform.length, Math.floor(width / 2));  // 1 punto cada 2 pixels
        const step = Math.max(1, Math.floor(waveform.length / pointsToDraw));
        
        for (let i = 0; i < pointsToDraw; i++) {
          const idx = waveform.length - 1 - (i * step);
          if (idx < 0) break;
          
          const value = waveform[idx];
          const normalized = (value - minVal) / range;
          const y = height * 0.5 + (normalized - 0.5) * (height * 0.6);
          const x = width - (i * 2);
          
          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        
        ctx.stroke();
      }

      // Draw beat markers
      const beats = beatsRef.current;
      if (beats.length > 0) {
        ctx.fillStyle = "#10b981";  // emerald-500
        
        beats.forEach((beat) => {
          // Solo dibujar si está en el rango visible
          const age = Date.now() - beat.t;
          if (age < 1000) {  // Último segundo
            const x = width - (age / 1000) * (width * 0.3);
            const y = height * 0.1;
            
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
          }
        });
      }

      animationId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 w-full h-full"
      style={{ 
        width: "100vw", 
        height: "100dvh",
        background: "#0f172a"
      }}
    />
  );
}
