/**
 * Overlay de métricas de rendimiento
 * Muestra FPS, memoria y otras métricas en tiempo real
 */

import React from 'react';
import { usePerformanceMonitor } from '@/utils/performance-monitor';
import { cn } from '@/lib/utils';

interface PerformanceOverlayProps {
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  className?: string;
}

export function PerformanceOverlay({ 
  position = 'bottom-right',
  className 
}: PerformanceOverlayProps) {
  const metrics = usePerformanceMonitor();
  const [isVisible, setIsVisible] = React.useState(false);

  // Toggle con tecla P
  React.useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === 'p' && e.ctrlKey) {
        e.preventDefault();
        setIsVisible(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);

  if (!isVisible) return null;

  const memoryUsageMB = metrics.memoryUsed / (1024 * 1024);
  const memoryLimitMB = metrics.memoryLimit / (1024 * 1024);
  const memoryPercentage = metrics.memoryLimit > 0 
    ? (metrics.memoryUsed / metrics.memoryLimit * 100).toFixed(1)
    : 'N/A';

  const getFPSColor = (fps: number) => {
    if (fps >= 55) return 'text-green-400';
    if (fps >= 30) return 'text-yellow-400';
    return 'text-red-400';
  };

  const getMemoryColor = (percentage: number) => {
    if (percentage <= 50) return 'text-green-400';
    if (percentage <= 75) return 'text-yellow-400';
    return 'text-red-400';
  };

  const positionClasses = {
    'top-left': 'top-4 left-4',
    'top-right': 'top-4 right-4',
    'bottom-left': 'bottom-4 left-4',
    'bottom-right': 'bottom-4 right-4'
  };

  return (
    <div 
      className={cn(
        'fixed z-50 bg-black/85 backdrop-blur-sm rounded-lg p-3 font-mono text-xs',
        'border border-white/10 shadow-lg min-w-[200px]',
        positionClasses[position],
        className
      )}
    >
      <div className="space-y-1">
        {/* FPS */}
        <div className="flex justify-between items-center">
          <span className="text-white/60">FPS:</span>
          <span className={cn('font-bold', getFPSColor(metrics.fps))}>
            {metrics.fps}
          </span>
        </div>

        {/* Frame Time */}
        <div className="flex justify-between items-center">
          <span className="text-white/60">Frame:</span>
          <span className="text-white/80">
            {metrics.frameTime.toFixed(1)}ms
          </span>
        </div>

        {/* Memory */}
        <div className="flex justify-between items-center">
          <span className="text-white/60">Memory:</span>
          <span className={cn(
            'font-medium',
            getMemoryColor(parseFloat(memoryPercentage) || 0)
          )}>
            {memoryUsageMB.toFixed(0)}MB ({memoryPercentage}%)
          </span>
        </div>

        {/* Long Tasks */}
        {metrics.longTasks > 0 && (
          <div className="flex justify-between items-center">
            <span className="text-white/60">Long Tasks:</span>
            <span className="text-orange-400 font-medium">
              {metrics.longTasks}
            </span>
          </div>
        )}

        {/* Divider */}
        <div className="border-t border-white/10 pt-1 mt-1">
          <div className="text-white/40 text-center">
            Ctrl+P to toggle
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Componente simplificado solo para FPS
 */
export function FPSCounter({ className }: { className?: string }) {
  const metrics = usePerformanceMonitor();
  
  const getFPSColor = (fps: number) => {
    if (fps >= 55) return 'text-green-400';
    if (fps >= 30) return 'text-yellow-400';
    return 'text-red-400';
  };

  return (
    <div className={cn(
      'fixed top-4 left-4 z-50 bg-black/75 backdrop-blur-sm',
      'rounded px-2 py-1 font-mono text-sm',
      className
    )}>
      <span className={cn('font-bold', getFPSColor(metrics.fps))}>
        {metrics.fps} FPS
      </span>
    </div>
  );
}