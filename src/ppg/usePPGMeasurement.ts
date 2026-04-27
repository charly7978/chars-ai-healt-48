import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import {
  PPGCameraController,
  type PPGCameraState,
} from "./camera/PPGCameraController";
import {
  FrameSampler,
  type FrameSamplerStats,
} from "./camera/FrameSampler";
import {
  createEmptyPublishedPPGMeasurement,
  PPGPublicationGate,
  type PublishedPPGMeasurement,
} from "./publication/PPGPublicationGate";
import {
  BeatDetector,
  type BeatDetectionResult,
} from "./signal/BeatDetector";
import {
  PPGChannelFusion,
  type FusedPPGChannels,
} from "./signal/PPGChannelFusion";
import {
  PPGSignalQualityAnalyzer,
  createEmptySignalQuality,
  type PPGSignalQuality,
} from "./signal/PPGSignalQuality";
import {
  RadiometricPPGExtractor,
  type PPGOpticalSample,
} from "./signal/RadiometricPPGExtractor";

export interface UsePPGMeasurementResult {
  videoRef: React.RefObject<HTMLVideoElement>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  camera: PPGCameraState;
  frameStats: {
    measuredFps: number;
    frameCount: number;
    droppedFrames: number;
    width: number;
    height: number;
  };
  rawSamples: PPGOpticalSample[];
  channels: FusedPPGChannels[];
  quality: PPGSignalQuality | null;
  beats: BeatDetectionResult | null;
  published: PublishedPPGMeasurement;
  debug: object;
}

function createEmptyCameraState(): PPGCameraState {
  return {
    stream: null,
    videoTrack: null,
    capabilities: null,
    settings: null,
    torchAvailable: false,
    torchEnabled: false,
    cameraReady: false,
    error: null,
  };
}

function createEmptyFrameStats(): FrameSamplerStats {
  return {
    measuredFps: 0,
    frameCount: 0,
    droppedFrames: 0,
    width: 0,
    height: 0,
  };
}

function emptyBeats(): BeatDetectionResult {
  return {
    beats: [],
    bpm: null,
    rrIntervalsMs: [],
    confidence: 0,
  };
}

export function usePPGMeasurement(): UsePPGMeasurementResult {
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeRef = useRef(false);
  const lastUiUpdateRef = useRef(0);
  const lastVibratedBeatRef = useRef<number | null>(null);

  const cameraControllerRef = useRef(new PPGCameraController());
  const frameSamplerRef = useRef(new FrameSampler(640));
  const extractorRef = useRef(new RadiometricPPGExtractor(30));
  const fusionRef = useRef(new PPGChannelFusion(30));
  const beatDetectorRef = useRef(new BeatDetector());
  const qualityAnalyzerRef = useRef(new PPGSignalQualityAnalyzer());
  const publicationGateRef = useRef(new PPGPublicationGate());

  const cameraRef = useRef<PPGCameraState>(createEmptyCameraState());
  const rawSamplesRef = useRef<PPGOpticalSample[]>([]);
  const channelsRef = useRef<FusedPPGChannels[]>([]);
  const qualityRef = useRef<PPGSignalQuality | null>(null);
  const beatsRef = useRef<BeatDetectionResult | null>(null);
  const publishedRef = useRef<PublishedPPGMeasurement>(
    createEmptyPublishedPPGMeasurement(cameraRef.current),
  );
  const frameStatsRef = useRef<FrameSamplerStats>(createEmptyFrameStats());

  const [camera, setCamera] = useState<PPGCameraState>(cameraRef.current);
  const [frameStats, setFrameStats] = useState<FrameSamplerStats>(frameStatsRef.current);
  const [rawSamples, setRawSamples] = useState<PPGOpticalSample[]>([]);
  const [channels, setChannels] = useState<FusedPPGChannels[]>([]);
  const [quality, setQuality] = useState<PPGSignalQuality | null>(null);
  const [beats, setBeats] = useState<BeatDetectionResult | null>(null);
  const [published, setPublished] = useState<PublishedPPGMeasurement>(publishedRef.current);
  const [debug, setDebug] = useState<object>({});

  const publishUiSnapshot = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - lastUiUpdateRef.current < 140) return;
    lastUiUpdateRef.current = now;

    setCamera(cameraRef.current);
    setFrameStats({ ...frameStatsRef.current });
    setRawSamples([...rawSamplesRef.current.slice(-360)]);
    setChannels([...channelsRef.current.slice(-360)]);
    setQuality(qualityRef.current);
    setBeats(beatsRef.current);
    setPublished(publishedRef.current);
    setDebug({
      active: activeRef.current,
      opticalSamples: rawSamplesRef.current.length,
      fusedSamples: channelsRef.current.length,
      torchAttempted: cameraControllerRef.current.hasTorchAttempted(),
      lastUpdateMs: Date.now(),
    });
  }, []);

  const resetProcessors = useCallback(() => {
    extractorRef.current.reset();
    fusionRef.current.reset();
    beatDetectorRef.current.reset();
    publicationGateRef.current.reset();
    rawSamplesRef.current = [];
    channelsRef.current = [];
    qualityRef.current = null;
    beatsRef.current = null;
    publishedRef.current = createEmptyPublishedPPGMeasurement(cameraRef.current);
    lastVibratedBeatRef.current = null;
  }, []);

  const processFrame = useCallback(() => {
    return (frame: Parameters<FrameSampler["start"]>[1] extends (arg: infer F) => void ? F : never) => {
      if (!activeRef.current) return;
      frameStatsRef.current = frameSamplerRef.current.getStats();

      const sample = extractorRef.current.processFrame(frame);
      if (!sample) {
        publishUiSnapshot();
        return;
      }

      const fused = fusionRef.current.push(sample);
      const selectedSeries = fusionRef.current.getSelectedSeries(20);
      const opticalWindow = extractorRef.current.getSamples(30);
      const beatResult = beatDetectorRef.current.detect(selectedSeries);
      const signalQuality =
        selectedSeries.length >= 3
          ? qualityAnalyzerRef.current.evaluate({
              selectedSeries,
              opticalSamples: extractorRef.current.getSamples(12),
              roi: sample.roiEvidence,
              channels: fused,
              beats: beatResult,
            })
          : createEmptySignalQuality(["INSUFFICIENT_SELECTED_SERIES"]);
      const publishedMeasurement = publicationGateRef.current.evaluate({
        camera: cameraRef.current,
        roi: sample.roiEvidence,
        channels: fused,
        quality: signalQuality,
        beats: beatResult,
        opticalSamples: opticalWindow,
        selectedSeries,
      });

      rawSamplesRef.current = opticalWindow;
      channelsRef.current = fusionRef.current.getHistory(30);
      beatsRef.current = beatResult;
      qualityRef.current = signalQuality;
      publishedRef.current = publishedMeasurement;

      if (publishedMeasurement.canVibrateBeat) {
        const lastBeat = beatResult.beats[beatResult.beats.length - 1];
        if (
          lastBeat &&
          lastBeat.confidence >= 0.75 &&
          lastVibratedBeatRef.current !== lastBeat.t
        ) {
          lastVibratedBeatRef.current = lastBeat.t;
          navigator.vibrate?.([35]);
        }
      }

      publishUiSnapshot();
    };
  }, [publishUiSnapshot]);

  const start = useCallback(async () => {
    if (activeRef.current) return;
    activeRef.current = true;
    resetProcessors();
    publishUiSnapshot(true);

    const cameraState = await cameraControllerRef.current.start();
    cameraRef.current = cameraState;
    publishedRef.current = createEmptyPublishedPPGMeasurement(cameraState);
    publishUiSnapshot(true);

    if (!cameraState.stream || !videoRef.current) {
      activeRef.current = false;
      publishUiSnapshot(true);
      return;
    }

    const video = videoRef.current;
    video.srcObject = cameraState.stream;
    video.muted = true;
    video.playsInline = true;

    try {
      await video.play();
    } catch {
      cameraRef.current = {
        ...cameraRef.current,
        error: "No se pudo iniciar la reproduccion del video",
      };
      publishedRef.current = createEmptyPublishedPPGMeasurement(cameraRef.current);
      activeRef.current = false;
      publishUiSnapshot(true);
      return;
    }

    frameSamplerRef.current.start(video, processFrame());
  }, [processFrame, publishUiSnapshot, resetProcessors]);

  const stop = useCallback(async () => {
    activeRef.current = false;
    frameSamplerRef.current.stop();
    await cameraControllerRef.current.stop();
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    cameraRef.current = cameraControllerRef.current.getState();
    frameStatsRef.current = createEmptyFrameStats();
    resetProcessors();
    publishUiSnapshot(true);
  }, [publishUiSnapshot, resetProcessors]);

  useEffect(() => {
    const sampler = frameSamplerRef.current;
    const cameraController = cameraControllerRef.current;
    return () => {
      activeRef.current = false;
      sampler.stop();
      void cameraController.stop();
    };
  }, []);

  return {
    videoRef,
    start,
    stop,
    camera,
    frameStats,
    rawSamples,
    channels,
    quality,
    beats,
    published,
    debug,
  };
}
