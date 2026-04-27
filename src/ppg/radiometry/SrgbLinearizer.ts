/**
 * SrgbLinearizer.ts
 * ----------------------------------------------------------------------------
 * Conversión de sRGB a lineal con corrección gamma.
 * 
 * Fórmula IEC 61966-2-1:
 * - Si c <= 0.04045: c_lin = c / 12.92
 * - Si c > 0.04045: c_lin = ((c + 0.055) / 1.055) ^ 2.4
 * 
 * Zero simulación. Procesa pixels reales únicamente.
 */

export interface Rgb8 {
  r: number;  // 0-255
  g: number;
  b: number;
}

export interface RgbLinear {
  r: number;  // 0-1 linear
  g: number;
  b: number;
}

const GAMMA_THRESHOLD = 0.04045;
const GAMMA_OFFSET = 0.055;
const GAMMA_SCALE = 1.055;
const LINEAR_DENOMINATOR = 12.92;
const GAMMA_EXPONENT = 2.4;

/**
 * Convierte un canal sRGB 8-bit a lineal 0-1.
 */
export function srgbChannelToLinear(c8: number): number {
  const c = c8 / 255;
  
  if (c <= GAMMA_THRESHOLD) {
    return c / LINEAR_DENOMINATOR;
  } else {
    return Math.pow((c + GAMMA_OFFSET) / GAMMA_SCALE, GAMMA_EXPONENT);
  }
}

/**
 * Convierte RGB 8-bit a lineal.
 */
export function srgbToLinear(rgb: Rgb8): RgbLinear {
  return {
    r: srgbChannelToLinear(rgb.r),
    g: srgbChannelToLinear(rgb.g),
    b: srgbChannelToLinear(rgb.b),
  };
}

/**
 * Convierte todo un buffer de ImageData a valores lineales.
 * Retorna array de RgbLinear para cada píxel, o estadísticas agregadas.
 */
export function processImageData(
  imageData: ImageData,
  options: { 
    sampleStep?: number;  // Procesar cada N píxeles para velocidad
    roi?: { x: number; y: number; width: number; height: number };
  } = {}
): {
  means: RgbLinear;
  medians: RgbLinear;
  trimmedMeans: RgbLinear;  // 5%-95% para robustez
  saturationRatio: number;
  darkRatio: number;
  validPixelRatio: number;
  redDominance: number;
  pixelCount: number;
} {
  const { sampleStep = 1, roi } = options;
  const data = imageData.data;
  const width = imageData.width;
  const height = imageData.height;

  // Determinar región de interés
  const roiX = roi?.x ?? 0;
  const roiY = roi?.y ?? 0;
  const roiW = roi?.width ?? width;
  const roiH = roi?.height ?? height;

  const rValues: number[] = [];
  const gValues: number[] = [];
  const bValues: number[] = [];
  
  let saturatedCount = 0;
  let darkCount = 0;
  let validCount = 0;
  let totalSampled = 0;

  const SATURATION_THRESHOLD = 250;
  const DARK_THRESHOLD = 5;

  for (let y = roiY; y < roiY + roiH; y += sampleStep) {
    for (let x = roiX; x < roiX + roiW; x += sampleStep) {
      if (y >= height || x >= width) continue;
      
      const idx = (y * width + x) * 4;
      const r8 = data[idx];
      const g8 = data[idx + 1];
      const b8 = data[idx + 2];

      totalSampled++;

      // Contar saturaciones y oscuros
      const maxVal = Math.max(r8, g8, b8);
      
      if (maxVal >= SATURATION_THRESHOLD) {
        saturatedCount++;
      }
      if (maxVal <= DARK_THRESHOLD) {
        darkCount++;
      }
      
      // Píxel válido para estadísticas (no saturado extremo)
      if (maxVal > DARK_THRESHOLD && maxVal < 255) {
        validCount++;
        const rLin = srgbChannelToLinear(r8);
        const gLin = srgbChannelToLinear(g8);
        const bLin = srgbChannelToLinear(b8);
        
        rValues.push(rLin);
        gValues.push(gLin);
        bValues.push(bLin);
      }
    }
  }

  if (rValues.length === 0) {
    return {
      means: { r: 0, g: 0, b: 0 },
      medians: { r: 0, g: 0, b: 0 },
      trimmedMeans: { r: 0, g: 0, b: 0 },
      saturationRatio: 0,
      darkRatio: 0,
      validPixelRatio: 0,
      redDominance: 0,
      pixelCount: 0,
    };
  }

  // Calcular estadísticas
  const means = calculateMeans(rValues, gValues, bValues);
  const medians = calculateMedians(rValues, gValues, bValues);
  const trimmedMeans = calculateTrimmedMeans(rValues, gValues, bValues, 0.05);

  return {
    means,
    medians,
    trimmedMeans,
    saturationRatio: saturatedCount / totalSampled,
    darkRatio: darkCount / totalSampled,
    validPixelRatio: validCount / totalSampled,
    redDominance: means.r / (means.g + means.b + 1e-6),
    pixelCount: rValues.length,
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function calculateMeans(r: number[], g: number[], b: number[]): RgbLinear {
  const sumR = r.reduce((a, v) => a + v, 0);
  const sumG = g.reduce((a, v) => a + v, 0);
  const sumB = b.reduce((a, v) => a + v, 0);
  const n = r.length;
  
  return {
    r: sumR / n,
    g: sumG / n,
    b: sumB / n,
  };
}

function calculateMedians(r: number[], g: number[], b: number[]): RgbLinear {
  return {
    r: median(r),
    g: median(g),
    b: median(b),
  };
}

function calculateTrimmedMeans(
  r: number[], 
  g: number[], 
  b: number[], 
  trimRatio: number
): RgbLinear {
  return {
    r: trimmedMean(r, trimRatio),
    g: trimmedMean(g, trimRatio),
    b: trimmedMean(b, trimRatio),
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function trimmedMean(values: number[], trimRatio: number): number {
  if (values.length === 0) return 0;
  
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const trimCount = Math.floor(n * trimRatio);
  
  const trimmed = sorted.slice(trimCount, n - trimCount);
  if (trimmed.length === 0) return sorted[Math.floor(n / 2)];
  
  return trimmed.reduce((a, v) => a + v, 0) / trimmed.length;
}
