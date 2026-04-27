# PPG Acceptance Tests

These tests must be executed on a real mobile device with rear camera access. Browser
torch support, resolution and frame rate are hardware/browser dependent and must be
recorded from the forensic debug panel.

## Case A - Air

Steps:
1. Press Start.
2. Point the rear camera at open air for 60 seconds.
3. Keep the device steady.

Expected:
- Camera remains active.
- Torch is enabled when the browser exposes torch capability.
- `canPublishVitals=false`.
- `bpm=null`.
- Official waveform is `NONE` or `RAW_DEBUG_ONLY`, never `REAL_PPG`.
- No vibration occurs.
- Message is `SIN SEÑAL PPG VERIFICABLE`.

## Case B - Table, Clothes Or Wall

Steps:
1. Press Start.
2. Point the camera/flash at a non-human surface for 60 seconds.

Expected:
- No BPM is published.
- No vibration occurs.
- No official cardiac waveform is drawn.
- Debug reasons include lack of SQI, estimator coherence, contact evidence or PPG evidence.

## Case C - Real Finger

Steps:
1. Press Start.
2. Cover rear camera and flash with a real finger.
3. Hold steady for 8-15 seconds.

Expected:
- Baseline is acquired from real frames.
- Raw RGB, linear RGB and OD RGB are visible in debug.
- G1/G2/G3 are visible and selected channel is one of the official real channels.
- BPM is published only if SQI is valid.
- Beat markers align with accepted PPG peaks.
- Vibration occurs only on validated beats.

## Case D - Motion

Steps:
1. Start with a real finger until signal validates.
2. Move the finger abruptly.

Expected:
- SQI decreases.
- Publication is suspended or enters `PPG_LOST`.
- BPM continuity is not invented.
- Vibration stops unless validated beats return.

## Case E - Extreme Saturation Or Pressure

Steps:
1. Press the finger too hard or position it so the flash saturates the ROI.

Expected:
- No invented BPM.
- Debug reasons include `HIGH_SATURATION`, `SATURATION_DESTRUCTIVE`,
  pressure/contact or illumination rejection.
- UI suggests non-publication through `SIN SEÑAL PPG VERIFICABLE`.

## Case F - Torch Not Available

Steps:
1. Use a device/browser without torch capability (or block torch permission).
2. Press Start.
3. Place finger on camera.

Expected:
- Camera starts but shows `TORCH N/A` or `TORCH OFF`.
- If ambient light is sufficient, signal may still be acquired.
- If insufficient illumination, debug reasons include illumination rejection.
- BPM only published if signal quality is valid (strict quality checks).

## Case G - Front Camera Accidental

Steps:
1. Start camera selection (simulated or on devices with front/rear confusion).
2. Attempt to start with front camera.

Expected:
- App attempts to use rear camera first.
- If front camera is selected, `contactScore` should remain low.
- No valid PPG published from front camera (insufficient optical density).
- State remains `CAMERA_READY_NO_PPG` or `PPG_WEAK`.

## Case H - Low Light

Steps:
1. Start measurement in dark room.
2. Do NOT use torch (if possible).
3. Place finger on camera.

Expected:
- `illuminationScore` remains low.
- ROI may be rejected due to low light.
- No BPM published.
- Debug reasons include `ILLUMINATION_LOW` or similar.

## Case I - Finger Position Change

Steps:
1. Start with stable finger, wait for signal validation (10-15s).
2. Slightly move finger to different position on lens.
3. Hold in new position.

Expected:
- Immediate SQI drop when finger moves.
- Publication suspended (`canPublishVitals=false`).
- Baseline re-acquisition begins.
- After 8-15s in new position, signal may re-validate.
- No invented continuity during transition.

## Case J - JSON Export and Replay

Steps:
1. Perform Case C (Real Finger) for 30 seconds.
2. Click "EXPORT JSON" button in debug panel.
3. Save the exported file.
4. Review exported data.

Expected Export Contents:
- `timestamp`: ISO 8601 format.
- `fpsStats`: acquisitionFps, processingFps, renderFps.
- `frameStats`: measuredFps, frameCount, droppedFrames.
- `camera`: streamActive, cameraReady, torchEnabled.
- `roi`: accepted, contactScore, illuminationScore, motionRisk.
- `beats`: bpm, fftBpm, autocorrBpm, estimatorAgreementBpm, acceptedCount, rejectedCount.
- `quality`: totalScore, grade, snrDb, rrConsistency.
- `publication`: state, canPublishVitals, bpm, goodWindowStreak.
- `oxygen`: spo2, confidence, canPublish.
- `rawSamplesLast30s`: Array of optical samples (t, raw, linear, od, etc).
- `channelsLast30s`: Array of fused channels (t, g1, g2, g3, selected, selectedName).

---

# Evidence Recording Template

## Device Information
| Field | Value |
|-------|-------|
| Device Model | (e.g., iPhone 14 Pro, Samsung Galaxy S23) |
| Browser | (e.g., Safari 17, Chrome 120) |
| OS Version | (e.g., iOS 17.1, Android 14) |
| Test Date | YYYY-MM-DD |
| Tester Initials | |

## Per-Case Evidence

### Case ___ (A-J): ________________

| Metric | Value |
|--------|-------|
| **Camera Settings** | |
| Resolution | width x height |
| Frame Rate | ___ fps |
| **Torch** | |
| Available | Yes / No |
| Enabled | Yes / No |
| **Sampling** | |
| Measured FPS | ___ fps |
| Frame Interval | ___ ± ___ ms |
| Dropped Frames | ___ |
| **ROI** | |
| Accepted | Yes / No |
| Contact Score | ___% |
| Illumination Score | ___% |
| Motion Risk | ___% |
| Pressure Risk | ___% |
| **Signal Quality** | |
| SQI Total Score | ___ |
| SQI Grade | A / B / C / D / F |
| SNR | ___ dB |
| Band Power Ratio | ___ |
| RR Consistency | ___ |
| **Beats** | |
| BPM (peaks) | ___ |
| BPM (FFT) | ___ |
| BPM (autocorr) | ___ |
| Estimator Agreement | ___ BPM |
| Accepted Beats | ___ |
| Rejected Candidates | ___ |
| **Publication** | |
| State | ___ |
| Can Publish Vitals | Yes / No |
| BPM Published | ___ / null |
| BPM Confidence | ___% |
| Good Window Streak | ___ |
| Last Valid Timestamp | ___ s ago |
| **Oxygen** | |
| SpO2 | ___% / null |
| SpO2 Confidence | ___% |
| Can Publish SpO2 | Yes / No |
| **Rejection Reasons** | |
| (List all) | |

## Screenshots / JSON Exports
- [ ] Screenshot of monitor during test
- [ ] Screenshot of debug panel
- [ ] JSON export attached (Case J or any critical case)

## Sign-off
- [ ] All cases executed
- [ ] Evidence recorded
- [ ] No simulations detected
- [ ] `npm run verify` passed
- [ ] QA Engineer: _____________ Date: _______
