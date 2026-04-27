interface MediaTrackCapabilities {
  torch?: boolean;
  exposureMode?: string[];
  exposureCompensation?: {
    max?: number;
    min?: number;
    step?: number;
  };
  exposureTime?: {
    max?: number;
    min?: number;
    step?: number;
  };
  iso?: {
    max?: number;
    min?: number;
    step?: number;
  };
  focusMode?: string[];
  whiteBalanceMode?: string[];
  focusDistance?: {
    max?: number;
    min?: number;
    step?: number;
  };
  zoom?: {
    max?: number;
    min?: number;
    step?: number;
  };
}

interface MediaTrackConstraintSet {
  torch?: boolean;
  exposureMode?: ConstrainDOMString;
  exposureCompensation?: ConstrainDouble;
  exposureTime?: ConstrainDouble;
  iso?: ConstrainDouble;
  focusMode?: ConstrainDOMString;
  whiteBalanceMode?: ConstrainDOMString;
  focusDistance?: ConstrainDouble;
  zoom?: ConstrainDouble;
}

interface MediaTrackSettings {
  torch?: boolean;
  exposureMode?: string;
  exposureCompensation?: number;
  exposureTime?: number;
  iso?: number;
  focusMode?: string;
  whiteBalanceMode?: string;
  focusDistance?: number;
  zoom?: number;
  fillLightMode?: string;
}

declare class ImageCapture {
  constructor(track: MediaStreamTrack);
  grabFrame(): Promise<ImageBitmap>;
  takePhoto(): Promise<Blob>;
}
