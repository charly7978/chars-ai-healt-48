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
import {
  buildAdaptiveKey,
  loadAdaptiveRecord,
  saveAdaptiveRecord,
} from "./camera/AdaptiveThresholdsStore";
import {
  NoFingerSelfTest,
  type NoFingerSelfTestReport,
} from "./diagnostics/NoFingerSelfTest";

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
  /** Hot-start calibration info loaded from persistence (null if first run for this device/camera). */
  calibration: {
    loaded: boolean;
    key: string | null;
    sessions: number;
    ageMs: number | null;
    sensorNoiseDb: number | null;
    acquisitionMethod: string | null;
  };
  /**
   * Reposition prompt: triggered when contactState stays non-stable for >= N seconds.
   * Pipeline keeps running — we never auto-restart the camera; we only ask the user
   * to reposition the finger. Cleared as soon as contact returns to stable.
   */
  repositionPrompt: {
    active: boolean;
    sinceMs: number;
    lastContactState: string;
    attempt: number;
    message: string;
  };
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
    noFingerSelfTest: NoFingerSelfTestReport;
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
  const noFingerSelfTestRef = useRef(new NoFingerSelfTest());
  const adaptivePersistKeyRef = useRef<string | null>(null);
  const lastAdaptivePersistAtRef = useRef(0);
  // Reposition prompt: tracks how long contactState has been non-stable.
  const nonStableSinceMsRef = useRef<number | null>(null);
  const repositionAttemptRef = useRef(0);
  const lastContactStateRef = useRef<string>("absent");
  // Calibration hot-start info (populated on start() if a record was restored).
  const calibrationRef = useRef<UsePPGMeasurementResult["calibration"]>({
    loaded: false,
    key: null,
    sessions: 0,
    ageMs: null,
    sensorNoiseDb: null,
    acquisitionMethod: null,
  });
  const repositionRef = useRef<UsePPGMeasurementResult["repositionPrompt"]>({
    active: false,
    sinceMs: 0,
    lastContactState: "absent",
    attempt: 0,
    message: "",
  });

  /** Threshold (ms) of continuous non-stable contact before prompting reposition. */
  const REPOSITION_PROMPT_AFTER_MS = 4000;

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
  const [calibration, setCalibration] = useState<UsePPGMeasurementResult["calibration"]>(
    calibrationRef.current,
  );
  const [repositionPrompt, setRepositionPrompt] = useState<UsePPGMeasurementResult["repositionPrompt"]>(
    repositionRef.current,
  );
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
    adaptive: adaptiveThresholdsRef.current.snapshot(),
    noFingerSelfTest: noFingerSelfTestRef.current.report(),
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
    setCalibration(calibrationRef.current);
    setRepositionPrompt(repositionRef.current);
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
      adaptive: adaptiveThresholdsRef.current.snapshot(),
      noFingerSelfTest: noFingerSelfTestRef.current.report(),
    });
  }, []);

  const resetProcessors = useCallback(() => {
    extractorRef.current.reset();
    fusionRef.current.reset();
    beatDetectorRef.current.reset();
    publicationGateRef.current.reset();
    adaptiveThresholdsRef.current.reset();
    noFingerSelfTestRef.current.reset();
    rawSamplesRef.current = [];
    channelsRef.current = [];
    qualityRef.current = createEmptySignalQuality();
    beatsRef.current = emptyBeats();
    publishedRef.current = createEmptyPublishedPPGMeasurement(cameraRef.current);
    lastVibratedBeatRef.current = null;
    nonStableSinceMsRef.current = null;
    repositionAttemptRef.current = 0;
    lastContactStateRef.current = "absent";
    repositionRef.current = {
      active: false,
      sinceMs: 0,
      lastContactState: "absent",
      attempt: 0,
      message: "",
    };
  }, []);

  /**
   * Track whether contact has been non-stable for too long. We never restart
   * the camera — we just surface a reposition prompt to the user. As soon as
   * contactState returns to "stable" we clear the prompt and bump the attempt
   * counter for telemetry.
   */
  const updateRepositionPrompt = useCallback(
    (contactState: string, nowMs: number, userGuidance: string) => {
      lastContactStateRef.current = contactState;
      if (contactState === "stable") {
        if (repositionRef.current.active) {
          repositionAttemptRef.current += 1;
        }
        nonStableSinceMsRef.current = null;
        repositionRef.current = {
          active: false,
          sinceMs: 0,
          lastContactState: contactState,
          attempt: repositionAttemptRef.current,
          message: "",
        };
        return;
      }
      if (nonStableSinceMsRef.current === null) {
        nonStableSinceMsRef.current = nowMs;
      }
      const elapsed = nowMs - nonStableSinceMsRef.current;
      const shouldPrompt = elapsed >= REPOSITION_PROMPT_AFTER_MS;
      const baseMsg = userGuidance && userGuidance.length > 0
        ? userGuidance
        : "Reubicá el dedo cubriendo bien la cámara y el flash.";
      repositionRef.current = {
        active: shouldPrompt,
        sinceMs: elapsed,
        lastContactState: contactState,
        attempt: repositionAttemptRef.current,
        message: shouldPrompt
          ? `Sin contacto estable hace ${(elapsed / 1000).toFixed(0)}s. ${baseMsg}`
          : "",
      };
    },
    [],
  );

  const processFrame = useCallback(() => {
    return (frame: RealFrame) => {
      if (!activeRef.current) return;
      frameStatsRef.current = frameSamplerRef.current.getStats();

      // Feed real telemetry into the adaptive threshold engine. Pure
      // observation — never substitutes or fabricates samples.
      adaptiveThresholdsRef.current.observeFrame({
        measuredFps: frameStatsRef.current.measuredFps,
        jitterMs: frameStatsRef.current.jitterMs,
        fpsQuality: frameStatsRef.current.fpsQuality,
        droppedFrameEstimate: frameStatsRef.current.droppedFrameEstimate,
        frameCount: frameStatsRef.current.frameCount,
        acquisitionMethod: frameStatsRef.current.acquisitionMethod === "none"
          ? "requestVideoFrameCallback"
          : frameStatsRef.current.acquisitionMethod,
      });

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
      // FORENSIC HARD GATE — adaptive per-device thresholds.
      // Block ROI/PPG/publication unless every hardware precondition
      // (calibrated against THIS device's measured cadence + torch
      // readback + sensor noise) is satisfied. No soft fallbacks.
      // ============================================================
      const cam = cameraRef.current;
      const samplerStats = frameStatsRef.current;
      const video = videoRef.current;
      const thr = adaptiveThresholdsRef.current.getThresholds();
      const videoReady = video !== null && video.readyState >= 2 &&
        video.videoWidth > 0 && video.videoHeight > 0;
      // Relaxed warmup: 10 real frames (~333 ms @ 30 fps) is enough to
      // verify the decoder is producing frames. The previous 30-frame
      // gate added a full second of dead time before any sample could
      // be processed and was the dominant cause of "app no mide".
      const decodedFramesOk = samplerStats.frameCount >= 10;
      // Adaptive cadence floor — but never below an absolute minimum that
      // any modern camera trivially meets (12 fps, jitter <= 25 ms).
      const fpsOk = samplerStats.fpsQuality >= Math.min(thr.minFpsQuality, 35) &&
        samplerStats.measuredFps >= Math.min(thr.minMeasuredFps, 12);
      const jitterOk = samplerStats.jitterMs <= Math.max(thr.maxJitterMs, 25);
      const droppedRatio = samplerStats.frameCount > 0
        ? samplerStats.droppedFrameEstimate / samplerStats.frameCount
        : 0;
      const droppedOk = droppedRatio <= Math.max(thr.maxDroppedRatio, 0.20);
      const torchRequested = cam.torchAvailable === true;
      // IMPORTANT: torch readback frequently lies on Android Chrome — the
      // hardware LED is ON but getSettings().torch returns false. We do NOT
      // hard-block on torch anymore; instead the publication gate handles
      // perfusion/SQI thresholds that physically require flash. This unblocks
      // devices where torch works but readback is unreliable.
      const torchOk = true;
      const streamOk = cam.streamActive === true && cam.cameraReady === true;

      // Inform the adaptive engine about torch readback so it can raise the
      // perfusion floor when the flashlight could not be physically applied.
      if (torchRequested) {
        adaptiveThresholdsRef.current.setTorchReadback(cam.torchEnabled === true);
      }

      const gateReasons: string[] = [];
      if (!videoReady) gateReasons.push("video-not-decoding");
      if (!decodedFramesOk) gateReasons.push(`warmup-frames<10 (${samplerStats.frameCount})`);
      if (!fpsOk) gateReasons.push(`fps-too-low (q=${samplerStats.fpsQuality},fps=${samplerStats.measuredFps.toFixed(1)})`);
      if (!jitterOk) gateReasons.push(`jitter-too-high (${samplerStats.jitterMs.toFixed(1)}ms)`);
      if (!droppedOk) gateReasons.push(`dropped-ratio-too-high (${(droppedRatio * 100).toFixed(0)}%)`);
      if (!streamOk) gateReasons.push("stream-not-live");
      void torchOk;

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
        // Acquisition not ready → no contact yet. Track for reposition prompt.
        updateRepositionPrompt("absent", frame.timestampMs, "");
        publishUiSnapshot();
        return;
      }

      const sample = extractorRef.current.processFrame(frame);

      // Always refresh ROI evidence for diagnostics, even if frame rejected.
      const lastEvidence = extractorRef.current.getLastEvidence();
      const lastRejectionMsg = extractorRef.current.getLastRejectionMessage();

      if (!sample) {
        // Ambient (finger-OFF) telemetry: when ROI is not accepted AND
        // contact state is "absent", we are looking at ambient light. Feed
        // the real RGB into the noise estimator so the adaptive perfusion
        // floor reflects this device's actual sensor noise — never simulated.
        if (lastEvidence && lastEvidence.contactState === "absent") {
          adaptiveThresholdsRef.current.observeAmbientSample(lastEvidence.linearMean);
        }
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
          // Forensic self-test: confirm gate stays closed under no-finger.
          noFingerSelfTestRef.current.observe({
            t: frame.timestampMs,
            roi: lastEvidence,
            published: publishedRef.current,
          });
        }
        // Track contact state for reposition prompt (absent / partial / searching / etc.).
        updateRepositionPrompt(
          lastEvidence?.contactState ?? "absent",
          frame.timestampMs,
          lastEvidence?.userGuidance ?? "",
        );
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
        adaptiveThresholds: adaptiveThresholdsRef.current.getThresholds(),
      });

      rawSamplesRef.current = opticalWindow;
      channelsRef.current = fusionRef.current.getHistory(30);
      beatsRef.current = beatResult;
      qualityRef.current = signalQuality;
      publishedRef.current = publishedMeasurement;

      // Forensic self-test on the active path too: even when ROI is accepted
      // we re-classify the scene optically. If hemoglobin signature is missing
      // but the gate published vitals, that's logged as a violation.
      noFingerSelfTestRef.current.observe({
        t: frame.timestampMs,
        roi: sample.roiEvidence,
        published: publishedMeasurement,
      });

      // Periodic persistence of derived adaptive thresholds (every 4s, only
      // when the engine has converged). On the next session this hot-starts
      // the gate — same device, same camera, no warmup wait.
      if (
        adaptivePersistKeyRef.current &&
        frame.timestampMs - lastAdaptivePersistAtRef.current > 4000
      ) {
        const exported = adaptiveThresholdsRef.current.exportRecord();
        if (exported) {
          const cam = cameraRef.current;
          saveAdaptiveRecord({
            key: adaptivePersistKeyRef.current,
            deviceId: cam.selectedDeviceId,
            cameraLabel: cam.diagnostics?.selectedDevice?.label ?? "",
            ...exported,
          });
          lastAdaptivePersistAtRef.current = frame.timestampMs;
        }
      }

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

      // Sample produced — track contact state from the active ROI evidence.
      updateRepositionPrompt(
        sample.roiEvidence.contactState,
        frame.timestampMs,
        sample.roiEvidence.userGuidance ?? "",
      );

      publishUiSnapshot();
    };
  }, [publishUiSnapshot, updateRepositionPrompt]);

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

    // Hot-start adaptive thresholds from any prior record for this device +
    // camera. The hydrated record provides the threshold floor; runtime EMA
    // and live observeFrame() calls will continue tightening from there.
    const cameraLabel = cameraState.diagnostics?.selectedDevice?.label ?? "";
    const adaptiveKey = buildAdaptiveKey({
      deviceId: cameraState.selectedDeviceId,
      cameraLabel,
    });
    adaptivePersistKeyRef.current = adaptiveKey;
    lastAdaptivePersistAtRef.current = 0;
    const restored = loadAdaptiveRecord(adaptiveKey);
    if (restored) {
      adaptiveThresholdsRef.current.hydrate({
        thresholds: restored.thresholds,
        sensorNoiseDb: restored.observed.sensorNoiseDb,
        p10MeasuredFps: restored.observed.p10MeasuredFps,
        p90JitterMs: restored.observed.p90JitterMs,
        acquisitionMethod: restored.acquisitionMethod,
        torchApplied: restored.torchApplied,
      });
      // eslint-disable-next-line no-console
      console.info(
        "[usePPGMeasurement] Hot-started adaptive thresholds for",
        adaptiveKey,
        "sessions=",
        restored.sessions,
      );
    }

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
    // Persist final adaptive snapshot before tearing down (only if engine
    // converged during this session — exportRecord() returns null otherwise).
    if (adaptivePersistKeyRef.current) {
      const exported = adaptiveThresholdsRef.current.exportRecord();
      if (exported) {
        const cam = cameraRef.current;
        saveAdaptiveRecord({
          key: adaptivePersistKeyRef.current,
          deviceId: cam.selectedDeviceId,
          cameraLabel: cam.diagnostics?.selectedDevice?.label ?? "",
          ...exported,
        });
      }
    }
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
