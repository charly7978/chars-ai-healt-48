import FullScreenCardiacMonitor from "@/components/FullScreenCardiacMonitor";
import { usePPGMeasurement } from "@/ppg/usePPGMeasurement";

const Index = () => {
  const measurement = usePPGMeasurement();
  return <FullScreenCardiacMonitor measurement={measurement} />;
};

export default Index;
