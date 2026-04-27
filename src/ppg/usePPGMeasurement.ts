import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import {
  PPGCameraController,
  createEmptyPPGCameraState,
  type PPGCameraState,
} from "./camera/PPGCameraController";
import {
  FrameSampler,
  type FrameSamplerStats,
  type RealFrame,
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
import {
  AdaptiveAcquisitionThresholds,
  type AdaptiveProfileSnapshot,
} from "./camera/AdaptiveAcquisitionThresholds";

export interface UsePPGMeasurementResult {
  videoRef: RefObject<HTMLVideoElement>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  camera: PPGCameraState;
  frameStats: {
    measuredFps: number;
    fpsInstant: number;
    fpsMedian: number;
    fpsQuality: number;
    jitterMs: number;
    frameCount: number;
    droppedFrames: number;
    droppedFrameEstimate: number;
    width: number;
    height: number;
    sampleIntervalMs: number;
    sampleIntervalStdMs: number;
    isActive: boolean;
    acquisitionMethod: FrameSamplerStats["acquisitionMethod"];
    targetFps: number;
  };
  fpsStats: {
    acquisitionFps: number;
    processingFps: number;
    renderFps: number;
  };
  rawSamples: PPGOpticalSample[];
  channels: FusedPPGChannels[];
  quality: PPGSignalQuality;
  beats: BeatDetectionResult;
  published: PublishedPPGMeasurement;
  debug: {
    active: boolean;
    opticalSamples: number;
    fusedSamples: number;
    cameraStreamActive: boolean;
    torchApplied: boolean;
    frameIntervalMs: number;
    frameIntervalStdMs: number;
    measuredFps: number;
    targetFs: number;
    selectedChannel: string;
    channelSelectionReason: string;
    lastUpdateMs: number;
    adaptive: AdaptiveProfileSnapshot;
  };
}

function createEmptyCameraState(): PPGCameraState {
  return createEmptyPPGCameraState();
}

function createEmptyFrameStats(): FrameSamplerStats {
  return {
    measuredFps: 0,
    fpsInstant: 0,
    fpsMedian: 0,
    fpsQuality: 0,
    jitterMs: 0,
    frameCount: 0,
    droppedFrames: 0,
    droppedFrameEstimate: 0,
    width: 0,
    height: 0,
    sampleIntervalMs: 0,
    sampleIntervalStdMs: 0,
    lastFrameTimeMs: 0,
    isActive: false,
    acquisitionMethod: "none",
    targetFps: 30,
  };
}

function emptyBeats(): BeatDetectionResult {
  return {
    beats: [],
    withheldBeats: [],
    bpm: null,
    rrIntervalsMs: [],
    confidence: 0,
    peakBpm: null,
    medianIbiBpm: null,
    fftBpm: null,
    autocorrBpm: null,
    estimatorAgreementBpm: 999,
    rejectedCandidates: 0,
    sampleRateHz: 30,
    irregularityFlag: false,
    ibiStdMs: 0,
    pulseRegularity: 0,
    derivativeQuality: 0,
    publicationException: "NO_BEATS_DETECTED",
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
  const adaptiveThresholdsRef = useRef(new AdaptiveAcquisitionThresholds());

  const cameraRef = useRef<PPGCameraState>(createEmptyCameraState());
  const rawSamplesRef = useRef<PPGOpticalSample[]>([]);
  const channelsRef = useRef<FusedPPGChannels[]>([]);
  const qualityRef = useRef<PPGSignalQuality>(createEmptySignalQuality());
  const beatsRef = useRef<BeatDetectionResult>(emptyBeats());
  const publishedRef = useRef<PublishedPPGMeasurement>(
    createEmptyPublishedPPGMeasurement(cameraRef.current),
  );
  const frameStatsRef = useRef<FrameSamplerStats>(createEmptyFrameStats());

  // FPS tracking
  const processingFpsRef = useRef(0);
  const lastProcessTimeRef = useRef(0);
  const processCountRef = useRef(0);

  const [camera, setCamera] = useState<PPGCameraState>(cameraRef.current);
  const [frameStats, setFrameStats] = useState<FrameSamplerStats>(frameStatsRef.current);
  const [fpsStats, setFpsStats] = useState<UsePPGMeasurementResult["fpsStats"]>({
    acquisitionFps: 0,
    processingFps: 0,
    renderFps: 0,
  });
  const [rawSamples, setRawSamples] = useState<PPGOpticalSample[]>([]);
  const [channels, setChannels] = useState<FusedPPGChannels[]>([]);
  const [quality, setQuality] = useState<PPGSignalQuality>(qualityRef.current);
  const [beats, setBeats] = useState<BeatDetectionResult>(beatsRef.current);
  const [published, setPublished] = useState<PublishedPPGMeasurement>(publishedRef.current);
  const [debug, setDebug] = useState<UsePPGMeasurementResult["debug"]>({
    active: false,
    opticalSamples: 0,
    fusedSamples: 0,
    cameraStreamActive: false,
    torchApplied: false,
    frameIntervalMs: 0,
    frameIntervalStdMs: 0,
    measuredFps: 0,
    targetFs: 30,
    selectedChannel: "--",
    channelSelectionReason: "--",
    lastUpdateMs: 0,
  });

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
    const samplerStats = frameStatsRef.current;
    const latestChannel = channelsRef.current[channelsRef.current.length - 1];
    setDebug({
      active: activeRef.current,
      opticalSamples: rawSamplesRef.current.length,
      fusedSamples: channelsRef.current.length,
      cameraStreamActive: cameraRef.current.streamActive,
      torchApplied: cameraRef.current.torchApplied,
      frameIntervalMs: samplerStats.sampleIntervalMs,
      frameIntervalStdMs: samplerStats.sampleIntervalStdMs,
      measuredFps: samplerStats.measuredFps,
      targetFs: 30, // Target uniform sampling rate
      selectedChannel: latestChannel?.selectedName ?? "--",
      channelSelectionReason: latestChannel?.selectionReason ?? "--",
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
    qualityRef.current = createEmptySignalQuality();
    beatsRef.current = emptyBeats();
    publishedRef.current = createEmptyPublishedPPGMeasurement(cameraRef.current);
    lastVibratedBeatRef.current = null;
  }, []);

  const processFrame = useCallback(() => {
    return (frame: RealFrame) => {
      if (!activeRef.current) return;
      frameStatsRef.current = frameSamplerRef.current.getStats();

      // Track processing FPS
      const now = performance.now();
      processCountRef.current++;
      if (now - lastProcessTimeRef.current >= 1000) {
        processingFpsRef.current = processCountRef.current;
        processCountRef.current = 0;
        lastProcessTimeRef.current = now;
        setFpsStats((prev) => ({
          ...prev,
          acquisitionFps: frameStatsRef.current.measuredFps,
          processingFps: processingFpsRef.current,
        }));
      }

      // ============================================================
      // FORENSIC HARD GATE: block ROI/PPG/publication unless every
      // hardware precondition is satisfied. No soft fallbacks.
      // ============================================================
      const cam = cameraRef.current;
      const samplerStats = frameStatsRef.current;
      const video = videoRef.current;
      const videoReady = video !== null && video.readyState >= 2 &&
        video.videoWidth > 0 && video.videoHeight > 0;
      const decodedFramesOk = samplerStats.frameCount >= 30;
      const fpsOk = samplerStats.fpsQuality >= 50 && samplerStats.measuredFps >= 18;
      const jitterOk = samplerStats.jitterMs <= 14;
      const torchRequested = cam.torchAvailable === true;
      const torchOk = !torchRequested || cam.torchEnabled === true;
      const streamOk = cam.streamActive === true && cam.cameraReady === true;

      const gateReasons: string[] = [];
      if (!videoReady) gateReasons.push("video-not-decoding");
      if (!decodedFramesOk) gateReasons.push(`warmup-frames<30 (${samplerStats.frameCount})`);
      if (!fpsOk) gateReasons.push(`fps-quality<50 (q=${samplerStats.fpsQuality},fps=${samplerStats.measuredFps.toFixed(1)})`);
      if (!jitterOk) gateReasons.push(`jitter>14ms (${samplerStats.jitterMs.toFixed(1)})`);
      if (!streamOk) gateReasons.push("stream-not-live");
      if (!torchOk) gateReasons.push("torch-requested-but-not-applied");

      const acquisitionReadyNow = gateReasons.length === 0;

      // Sync controller state (mark/clear acquisitionReady) and refresh local
      // cameraRef snapshot so downstream UI/publication see the truth.
      if (acquisitionReadyNow && !cam.acquisitionReady) {
        cameraControllerRef.current.markAcquisitionReady({
          warmupFrames: samplerStats.frameCount,
          warmupJitterMs: samplerStats.jitterMs,
          warmupFpsStdMs: samplerStats.sampleIntervalStdMs,
          fpsReal: samplerStats.measuredFps,
        });
        cameraRef.current = cameraControllerRef.current.getState();
      } else if (!acquisitionReadyNow && cam.acquisitionReady) {
        cameraControllerRef.current.clearAcquisitionReady(gateReasons);
        cameraRef.current = cameraControllerRef.current.getState();
      }

      if (!acquisitionReadyNow) {
        // Hard gate: do NOT touch extractor / fusion / beats / publication.
        // Only refresh published snapshot so the HUD shows the rejection.
        const prev = publishedRef.current;
        const staleSinceMs = prev.lastValidTimestamp !== null
          ? Math.max(0, frame.timestampMs - prev.lastValidTimestamp)
          : 0;
        publishedRef.current = {
          ...prev,
          state: cam.cameraReady ? "CAMERA_READY_NO_PPG" : "CAMERA_STARTING",
          canPublishVitals: false,
          canVibrateBeat: false,
          bpm: null,
          bpmConfidence: 0,
          oxygen: { ...prev.oxygen, spo2: null, confidence: 0, canPublish: false, reasons: ["ACQUISITION_NOT_READY"] },
          waveformSource: "NONE",
          beatMarkers: [],
          withheldBeatMarkers: [],
          quality: createEmptySignalQuality(gateReasons),
          evidence: {
            ...prev.evidence,
            camera: cameraRef.current,
          },
          message: `ADQUISICIÓN NO LISTA: ${gateReasons.join(" | ")}`,
          lastValidTimestamp: null,
          staleSinceMs,
          staleBadge: prev.lastValidTimestamp === null ? "never" : staleSinceMs <= 6000 ? "stale" : "expired",
        };
        publishUiSnapshot();
        return;
      }

      const sample = extractorRef.current.processFrame(frame);

      // Always refresh ROI evidence for diagnostics, even if frame rejected.
      const lastEvidence = extractorRef.current.getLastEvidence();
      const lastRejectionMsg = extractorRef.current.getLastRejectionMessage();

      if (!sample) {
        // Refresh published.evidence.roi so HUD reflects current camera state
        if (lastEvidence) {
          const prev = publishedRef.current;
          const staleSinceMs = prev.lastValidTimestamp !== null
            ? Math.max(0, frame.timestampMs - prev.lastValidTimestamp)
            : 0;
          publishedRef.current = {
            ...prev,
            state: "CAMERA_READY_NO_PPG",
            canPublishVitals: false,
            canVibrateBeat: false,
            bpm: null,
            bpmConfidence: 0,
            oxygen: { ...prev.oxygen, spo2: null, confidence: 0, canPublish: false, reasons: [lastRejectionMsg ?? "ROI_NOT_ACCEPTED"] },
            waveformSource: "NONE",
            beatMarkers: [],
            withheldBeatMarkers: [],
            quality: createEmptySignalQuality([...(lastEvidence.reason ?? []), lastRejectionMsg ?? "ROI_NOT_ACCEPTED"]),
            evidence: {
              ...prev.evidence,
              camera: cameraRef.current,
              roi: lastEvidence,
            },
            message: lastRejectionMsg
              ? `SIN MUESTRA PPG: ${lastRejectionMsg}`
              : prev.message,
            lastValidTimestamp: null,
            staleSinceMs,
            staleBadge: prev.lastValidTimestamp === null ? "never" : staleSinceMs <= 6000 ? "stale" : "expired",
          };
        }
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
        fpsQuality: frameStatsRef.current.fpsQuality,
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
          lastBeat.confidence >= 0.7 &&
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
    if (activeRef.current) {
      return;
    }
    activeRef.current = true;
    resetProcessors();
    publishUiSnapshot(true);

    const video = videoRef.current;
    if (!video) {
      console.error("[usePPGMeasurement] videoRef.current is null");
      activeRef.current = false;
      publishUiSnapshot(true);
      return;
    }

    let cameraState;
    try {
      // Forensic: open camera + torch SYNCHRONOUSLY from the user gesture so
      // the browser preserves user-activation needed to enable the flashlight.
      cameraState = await cameraControllerRef.current.startFromGesture(video);
    } catch (e) {
      console.error("[usePPGMeasurement] startFromGesture failed:", e);
      activeRef.current = false;
      publishUiSnapshot(true);
      return;
    }

    cameraRef.current = cameraState;
    publishedRef.current = createEmptyPublishedPPGMeasurement(cameraState);
    publishUiSnapshot(true);

    if (!cameraState.stream) {
      console.error("[usePPGMeasurement] No stream from camera");
      activeRef.current = false;
      publishUiSnapshot(true);
      return;
    }

    // Wait until the bound video element is decoding frames.
    if (video.readyState < 2) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (video.readyState >= 2 || !activeRef.current) {
            resolve();
          } else {
            requestAnimationFrame(check);
          }
        };
        check();
      });
    }

    if (!activeRef.current) {
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
    fpsStats,
    rawSamples,
    channels,
    quality,
    beats,
    published,
    debug,
  };
}
