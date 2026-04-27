/**
 * Radiometría PPG
 * ----------------------------------------------------------------------------
 * Procesamiento de intensidad lumínica desde cámara a señal PPG.
 */

export {
  srgbChannelToLinear,
  srgbToLinear,
  processImageData,
  type Rgb8,
  type RgbLinear,
} from "./SrgbLinearizer";

export {
  calculateOD,
  calculateDCBaseline,
  calculatePerfusionIndex,
  calculateRatioOfRatios,
  DCBaselineTracker,
  type OpticalDensity,
  type PpgChannels,
} from "./OpticalDensity";
