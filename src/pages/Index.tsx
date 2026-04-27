import { usePpgEngine, CardiacMonitorCanvas, FloatingVitalsOverlay } from "@/ppg";

const Index = () => {
  const { videoRef, state, start, stop } = usePpgEngine();

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-900">
      {/* Monitor cardiaco fullscreen */}
      <CardiacMonitorCanvas state={state} />
      
      {/* Video element (hidden, managed by hook) */}
      <video
        ref={videoRef}
        className="hidden"
        playsInline
        muted
        autoPlay
      />
      
      {/* Overlay flotante con vitales */}
      <FloatingVitalsOverlay
        state={state}
        onStart={start}
        onStop={stop}
      />
    </div>
  );
};

export default Index;
