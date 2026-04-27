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

## Required Final Record

Record the following from the debug panel for the device/browser tested:
- Torch available/enabled.
- Camera settings width, height and frame rate.
- Sampler measured FPS.
- Capabilities shown by the browser.
- Final publication state for each case.
