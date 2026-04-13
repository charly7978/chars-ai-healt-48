import { FrameData } from './types';
import { ProcessedSignal } from '../../types/signal';

/**
 * Extracción PPG: barrido casi completo del sensor + tesela ganadora (literatura cámara-PPG:
 * máxima señal en región de contacto, no solo centro óptico).
 */
export class FrameProcessor {
  private readonly CONFIG: { TEXTURE_GRID_SIZE: number; ROI_SIZE_FACTOR: number };
  private readonly RED_GAIN = 1.06;
  private readonly GREEN_SUPPRESSION = 0.92;
  private readonly SIGNAL_GAIN = 0.99;
  private readonly MIN_RED_THRESHOLD = 0.32;
  private readonly EDGE_CONTRAST_THRESHOLD = 0.17;

  private lastFrames: Array<{ red: number; green: number; blue: number }> = [];
  private readonly HISTORY_SIZE = 25;
  private lastLightLevel: number = -1;

  private roiHistory: Array<{ x: number; y: number; width: number; height: number }> = [];
  private readonly ROI_HISTORY_SIZE = 10;

  constructor(config: { TEXTURE_GRID_SIZE: number; ROI_SIZE_FACTOR: number }) {
    this.CONFIG = {
      ...config,
      ROI_SIZE_FACTOR: Math.min(0.8, config.ROI_SIZE_FACTOR * 1.15)
    };
  }

  extractFrameData(imageData: ImageData): FrameData {
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;
    const margin = 0.015;
    const sx = Math.floor(w * margin);
    const sy = Math.floor(h * margin);
    const ex = Math.ceil(w * (1 - margin));
    const ey = Math.ceil(h * (1 - margin));
    const gw = 5;
    const gh = 5;
    const tw = Math.max(1, ex - sx) / gw;
    const th = Math.max(1, ey - sy) / gh;

    const tr = new Array(gw * gh).fill(0);
    const tg = new Array(gw * gh).fill(0);
    const tb = new Array(gw * gh).fill(0);
    const tc = new Array(gw * gh).fill(0);
    let totalLuminance = 0;
    let pixelCount = 0;

    for (let y = sy; y < ey; y++) {
      for (let x = sx; x < ex; x++) {
        const i = (y * w + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const tx = Math.min(gw - 1, Math.floor((x - sx) / tw));
        const ty = Math.min(gh - 1, Math.floor((y - sy) / th));
        const ti = ty * gw + tx;
        tr[ti] += r;
        tg[ti] += g;
        tb[ti] += b;
        tc[ti]++;
        totalLuminance += (r * 0.299 + g * 0.587 + b * 0.114) / 255;
        pixelCount++;
      }
    }

    if (pixelCount < 1) {
      return {
        redValue: 0,
        textureScore: 0,
        rToGRatio: 1,
        rToBRatio: 1,
        avgRed: 0,
        avgGreen: 0,
        avgBlue: 0,
        rawRgb: { r: 0, g: 0, b: 0 }
      };
    }

    const tileMr: number[] = [];
    for (let ti = 0; ti < gw * gh; ti++) {
      tileMr.push(tc[ti] > 0 ? tr[ti] / tc[ti] : 0);
    }

    let bestIdx = 0;
    let bestScore = -1;
    for (let ti = 0; ti < gw * gh; ti++) {
      if (tc[ti] < 1) continue;
      const mr = tileMr[ti];
      const mg = tg[ti] / tc[ti];
      const mb = tb[ti] / tc[ti];
      const rg = mr / (mg + 1);
      let score = mr;
      if (rg >= 0.7 && rg <= 4.3 && mr > mb * 0.68) {
        score = mr * 1.22;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = ti;
      }
    }

    const nPix = Math.max(1, tc[bestIdx]);
    const mr = tr[bestIdx] / nPix;
    const mg = tg[bestIdx] / nPix;
    const mb = tb[bestIdx] / nPix;

    const rawRgb = { r: mr, g: mg, b: mb };

    const avgLuminance = (totalLuminance / pixelCount) * 100;
    if (this.lastLightLevel < 0) {
      this.lastLightLevel = avgLuminance;
    } else {
      this.lastLightLevel = this.lastLightLevel * 0.7 + avgLuminance * 0.3;
    }

    const meansNonZero = tileMr.filter((_, i) => tc[i] > 0);
    let textureScore = 0.45;
    if (meansNonZero.length > 3) {
      const m = meansNonZero.reduce((a, b) => a + b, 0) / meansNonZero.length;
      const v = Math.sqrt(
        meansNonZero.reduce((s, x) => s + (x - m) * (x - m), 0) / meansNonZero.length
      );
      textureScore = Math.max(0.2, Math.min(1, Math.pow(v / 28, 0.75)));
    }

    this.lastFrames.push({ red: mr, green: mg, blue: mb });
    if (this.lastFrames.length > this.HISTORY_SIZE) {
      this.lastFrames.shift();
    }

    let dynamicGain = 1.0;
    if (this.lastFrames.length >= 6) {
      const avgHistRed = this.lastFrames.reduce((sum, frame) => sum + frame.red, 0) / this.lastFrames.length;
      if (avgHistRed >= 42 && avgHistRed <= 195 && this.calculateEdgeContrast() > this.EDGE_CONTRAST_THRESHOLD) {
        dynamicGain = 1.08;
      } else if (avgHistRed < 42 && avgHistRed > this.MIN_RED_THRESHOLD * 22) {
        dynamicGain = 1.0;
      } else if (avgHistRed <= this.MIN_RED_THRESHOLD * 22) {
        dynamicGain = 0.9;
      }
    }

    const avgRed = Math.max(0, Math.min(255, mr * this.RED_GAIN * this.SIGNAL_GAIN * dynamicGain));
    const avgGreen = mg * this.GREEN_SUPPRESSION;
    const avgBlue = mb;

    const rToGRatio = mg > 0.5 ? avgRed / (mg + 1e-6) : 1.2;
    const rToBRatio = mb > 0.5 ? mr / (mb + 1e-6) : 1.0;

    return {
      redValue: avgRed,
      avgRed,
      avgGreen,
      avgBlue,
      rawRgb,
      textureScore,
      rToGRatio,
      rToBRatio
    };
  }

  private calculateEdgeContrast(): number {
    if (this.lastFrames.length < 2) return 0;

    const lastFrame = this.lastFrames[this.lastFrames.length - 1];
    const prevFrame = this.lastFrames[this.lastFrames.length - 2];

    const diff =
      Math.abs(lastFrame.red - prevFrame.red) +
      Math.abs(lastFrame.green - prevFrame.green) +
      Math.abs(lastFrame.blue - prevFrame.blue);

    return Math.min(1, diff / 255);
  }

  private getLightLevelQualityFactor(lightLevel: number): number {
    if (lightLevel >= 30 && lightLevel <= 80) {
      return 1.0;
    }
    if (lightLevel < 30) {
      return Math.max(0.3, lightLevel / 30);
    }
    return Math.max(0.3, 1.0 - (lightLevel - 80) / 60);
  }

  detectROI(redValue: number, imageData: ImageData): ProcessedSignal['roi'] {
    const centerX = Math.floor(imageData.width / 2);
    const centerY = Math.floor(imageData.height / 2);

    let adaptiveROISizeFactor = this.CONFIG.ROI_SIZE_FACTOR;

    if (redValue < 32) {
      adaptiveROISizeFactor = Math.min(0.78, adaptiveROISizeFactor * 1.01);
    } else if (redValue > 105) {
      adaptiveROISizeFactor = Math.max(0.42, adaptiveROISizeFactor * 0.99);
    }

    const minDimension = Math.min(imageData.width, imageData.height);
    const maxRoiSize = minDimension * 0.85;
    const minRoiSize = minDimension * 0.35;

    let roiSize = minDimension * adaptiveROISizeFactor;
    roiSize = Math.max(minRoiSize, Math.min(maxRoiSize, roiSize));

    const newROI = {
      x: centerX - roiSize / 2,
      y: centerY - roiSize / 2,
      width: roiSize,
      height: roiSize
    };

    this.roiHistory.push(newROI);

    if (this.roiHistory.length > this.ROI_HISTORY_SIZE) {
      const excessCount = this.roiHistory.length - this.ROI_HISTORY_SIZE;
      this.roiHistory.splice(0, excessCount);
    }

    if (this.roiHistory.length >= 6) {
      const avgX = this.roiHistory.reduce((sum, roi) => sum + roi.x, 0) / this.roiHistory.length;
      const avgY = this.roiHistory.reduce((sum, roi) => sum + roi.y, 0) / this.roiHistory.length;
      const avgWidth = this.roiHistory.reduce((sum, roi) => sum + roi.width, 0) / this.roiHistory.length;
      const avgHeight = this.roiHistory.reduce((sum, roi) => sum + roi.height, 0) / this.roiHistory.length;

      return {
        x: avgX,
        y: avgY,
        width: avgWidth,
        height: avgHeight
      };
    }

    return newROI;
  }
}
