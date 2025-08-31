import React, { useEffect, useRef } from 'react';

interface SignalDebuggerProps {
  signal: number[];
  peaks?: number[];
  width?: number;
  height?: number;
}

export const SignalDebugger: React.FC<SignalDebuggerProps> = ({ 
  signal, 
  peaks = [], 
  width = 400, 
  height = 200 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || signal.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    // Find signal range
    const min = Math.min(...signal);
    const max = Math.max(...signal);
    const range = max - min || 1;

    // Draw grid
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = (height / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Draw signal
    ctx.strokeStyle = '#0f0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    
    for (let i = 0; i < signal.length; i++) {
      const x = (i / signal.length) * width;
      const y = height - ((signal[i] - min) / range) * height;
      
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Draw peaks
    ctx.fillStyle = '#f00';
    for (const peak of peaks) {
      if (peak < signal.length) {
        const x = (peak / signal.length) * width;
        const y = height - ((signal[peak] - min) / range) * height;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

    // Draw info
    ctx.fillStyle = '#fff';
    ctx.font = '10px monospace';
    ctx.fillText(`Peaks: ${peaks.length}`, 5, 15);
    ctx.fillText(`Range: ${min.toFixed(1)} - ${max.toFixed(1)}`, 5, 30);
    
  }, [signal, peaks, width, height]);

  return (
    <div className="signal-debugger" style={{ 
      position: 'fixed', 
      bottom: 10, 
      right: 10, 
      background: 'rgba(0,0,0,0.8)', 
      padding: 10,
      borderRadius: 5,
      zIndex: 1000
    }}>
      <canvas 
        ref={canvasRef} 
        width={width} 
        height={height}
        style={{ display: 'block' }}
      />
    </div>
  );
};