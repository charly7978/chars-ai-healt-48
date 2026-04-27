/**
 * Cámara PPG
 * ----------------------------------------------------------------------------
 * Control de cámara y captura de frames.
 */

export {
  PpgCameraController,
  type CameraCallbacks,
  type CameraConfig,
} from "./PpgCameraController";

export {
  TorchController,
  type TorchStatus as TorchControllerStatus,
} from "./TorchController";

export {
  FrameSampler,
  type RealFrame,
  type FrameSamplerStats,
  type AcquisitionMethod,
} from "./FrameSampler";
