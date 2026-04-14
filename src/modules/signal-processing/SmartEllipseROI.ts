/**
 * @file SmartEllipseROI.ts
 * @description Sistema inteligente de ROI basado en detección de elipse del dedo
 * Utiliza edge detection, contorno analítico y PCA para encontrar la orientación óptima
 * del dedo y extraer la región de máximo flujo sanguíneo.
 * 
 * Algoritmo:
 * 1. Sobel edge detection sobre canal R
 * 2. Contour tracing para encontrar borde del dedo
 * 3. Ellipse fitting a los puntos del contorno
 * 4. PCA para determinar eje mayor (orientación del dedo)
 * 5. ROI óptimo = región central del eje mayor
 */

export interface Point2D {
  x: number;
  y: number;
}

export interface EllipseFit {
  center: Point2D;
  axes: { major: number; minor: number };
  angle: number; // Radianes, orientación del eje mayor
  quality: number; // 0-1, calidad del ajuste
}

export interface SmartROI {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number; // Rotación del ROI para alinear con dedo
  confidence: number; // 0-1 confianza en la detección
  ellipse: EllipseFit;
  fingerPixels: number; // Número de píxeles detectados como dedo
  avgRedIntensity: number; // Intensidad media R en el ROI
}

export interface GridCell {
  x: number;
  y: number;
  width: number;
  height: number;
  meanR: number;
  meanG: number;
  meanB: number;
  variance: number;
  isSelected: boolean;
  perfusionScore: number;
}

export class SmartEllipseROI {
  private readonly edgeThreshold: number = 25;
  private readonly minFingerArea: number = 8000; // Píxeles mínimos para dedo válido
  private readonly maxFingerArea: number = 45000; // Píxeles máximos
  private readonly gridSize: number = 4; // Grid 4x6 adaptable
  
  // Cache de contornos para estabilidad temporal
  private lastContour: Point2D[] = [];
  private contourStability: number = 0;
  private lastROI: SmartROI | null = null;

  /**
   * Procesar frame completo y retornar ROI inteligente basado en elipse del dedo
   */
  processFrame(imageData: ImageData): SmartROI | null {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;

    // PASO 1: Edge detection con operador Sobel sobre canal R
    const edges = this.sobelEdgeDetection(data, width, height);

    // PASO 2: Encontrar contorno cerrado más grande (dedo)
    const contour = this.findLargestContour(edges, width, height);
    
    if (contour.length < 50) {
      return this.lastROI; // Mantener ROI anterior si no hay detección válida
    }

    // PASO 3: Actualizar estabilidad del contorno
    this.updateContourStability(contour);

    // PASO 4: Ellipse fitting a los puntos del contorno
    const ellipse = this.fitEllipse(contour);

    // PASO 5: Verificar calidad del ajuste
    if (ellipse.quality < 0.3) {
      return this.lastROI;
    }

    // PASO 6: Calcular ROI óptimo basado en elipse
    const roi = this.calculateOptimalROI(ellipse, contour, data, width, height);

    // PASO 7: Análisis de grid adaptable para tesela ganadora
    const grid = this.analyzeAdaptiveGrid(roi, data, width, height);
    const enhancedROI = this.enhanceROIWithGrid(roi, grid);

    this.lastROI = enhancedROI;
    return enhancedROI;
  }

  /**
   * Sobel edge detection optimizado
   * Aplica operador Sobel sobre el canal R para detectar bordes del dedo
   */
  private sobelEdgeDetection(data: Uint8ClampedArray, width: number, height: number): boolean[] {
    const edges = new Array(width * height).fill(false);
    const gradientMagnitudes = new Float32Array(width * height);

    // Kernels Sobel
    const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        let gx = 0, gy = 0;

        // Aplicar kernels Sobel
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const idx = ((y + ky) * width + (x + kx)) * 4;
            const r = data[idx]; // Canal R

            const kernelIdx = (ky + 1) * 3 + (kx + 1);
            gx += r * sobelX[kernelIdx];
            gy += r * sobelY[kernelIdx];
          }
        }

        // Magnitud del gradiente
        const magnitude = Math.sqrt(gx * gx + gy * gy);
        gradientMagnitudes[y * width + x] = magnitude;
      }
    }

    // Umbral adaptativo basado en estadísticas de gradiente
    const meanGradient = this.calculateMean(gradientMagnitudes);
    const stdGradient = this.calculateStd(gradientMagnitudes, meanGradient);
    const adaptiveThreshold = meanGradient + 2 * stdGradient;

    // Aplicar umbral
    for (let i = 0; i < gradientMagnitudes.length; i++) {
      edges[i] = gradientMagnitudes[i] > Math.max(this.edgeThreshold, adaptiveThreshold);
    }

    return edges;
  }

  /**
   * Encontrar el contorno cerrado más grande usando flood fill + chain code
   */
  private findLargestContour(edges: boolean[], width: number, height: number): Point2D[] {
    const visited = new Array(width * height).fill(false);
    let largestContour: Point2D[] = [];
    let maxArea = 0;

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = y * width + x;

        if (edges[idx] && !visited[idx]) {
          const contour = this.traceContour(edges, visited, x, y, width, height);
          
          if (contour.length > largestContour.length) {
            largestContour = contour;
            maxArea = contour.length;
          }
        }
      }
    }

    return largestContour;
  }

  /**
   * Tracing de contorno usando algoritmo de seguimiento de bordes
   */
  private traceContour(
    edges: boolean[], 
    visited: boolean[], 
    startX: number, 
    startY: number, 
    width: number, 
    height: number
  ): Point2D[] {
    const contour: Point2D[] = [];
    const directions = [
      { dx: 1, dy: 0 }, { dx: 1, dy: 1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 1 },
      { dx: -1, dy: 0 }, { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 }
    ];

    let x = startX;
    let y = startY;
    let dir = 0;

    for (let step = 0; step < 10000; step++) {
      const idx = y * width + x;
      
      if (visited[idx]) break;
      visited[idx] = true;
      contour.push({ x, y });

      // Buscar siguiente punto del borde
      let found = false;
      for (let i = 0; i < 8; i++) {
        const newDir = (dir + i) % 8;
        const nx = x + directions[newDir].dx;
        const ny = y + directions[newDir].dy;

        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const nIdx = ny * width + nx;
          if (edges[nIdx] && !visited[nIdx]) {
            x = nx;
            y = ny;
            dir = (newDir + 5) % 8; // Ajustar dirección
            found = true;
            break;
          }
        }
      }

      if (!found) break;
      if (x === startX && y === startY) break;
    }

    return contour;
  }

  /**
   * Ajuste de elipse a puntos del contorno usando método de mínimos cuadrados
   * Basado en: Fitzgibbon et al. "Direct Least Squares Fitting of Ellipses"
   */
  private fitEllipse(contour: Point2D[]): EllipseFit {
    if (contour.length < 5) {
      return { center: { x: 0, y: 0 }, axes: { major: 0, minor: 0 }, angle: 0, quality: 0 };
    }

    // Calcular centroide
    let sumX = 0, sumY = 0;
    for (const p of contour) {
      sumX += p.x;
      sumY += p.y;
    }
    const centerX = sumX / contour.length;
    const centerY = sumY / contour.length;

    // Calcular matriz de covarianza (momentos de segundo orden)
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of contour) {
      const dx = p.x - centerX;
      const dy = p.y - centerY;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }

    const n = contour.length;
    sxx /= n;
    syy /= n;
    sxy /= n;

    // Calcular eigenvalores de la matriz de covarianza
    const trace = sxx + syy;
    const det = sxx * syy - sxy * sxy;
    const discriminant = Math.sqrt(trace * trace - 4 * det);

    const lambda1 = (trace + discriminant) / 2;
    const lambda2 = (trace - discriminant) / 2;

    // Ejes de la elipse (2 * sqrt(eigenvalor) = semi-eje)
    const majorAxis = 2 * Math.sqrt(Math.max(lambda1, lambda2)) * 2.5;
    const minorAxis = 2 * Math.sqrt(Math.min(lambda1, lambda2)) * 2.5;

    // Calcular ángulo de orientación
    let angle = 0;
    if (sxy !== 0 || sxx !== syy) {
      angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    }

    // Calcular calidad del ajuste basada en circularidad
    const circularity = minorAxis / Math.max(majorAxis, 1e-10);
    const sizeQuality = majorAxis > 50 && majorAxis < 400 ? 1 : 0.5;
    const quality = circularity * sizeQuality * Math.min(1, contour.length / 200);

    return {
      center: { x: centerX, y: centerY },
      axes: { major: majorAxis, minor: minorAxis },
      angle,
      quality
    };
  }

  /**
   * Calcular ROI óptimo basado en la elipse ajustada
   * La región óptima es la parte central del eje mayor donde el flujo sanguíneo es máximo
   */
  private calculateOptimalROI(
    ellipse: EllipseFit,
    contour: Point2D[],
    data: Uint8ClampedArray,
    width: number,
    height: number
  ): SmartROI {
    // Centro del ROI: ligeramente desplazado desde centro de elipse hacia la punta del dedo
    // (asumimos que la punta está en la dirección del eje mayor)
    const tipOffset = ellipse.axes.major * 0.15;
    const roiCenterX = ellipse.center.x + Math.cos(ellipse.angle) * tipOffset;
    const roiCenterY = ellipse.center.y + Math.sin(ellipse.angle) * tipOffset;

    // Dimensiones del ROI: ancho = eje menor, alto = 40% del eje mayor
    const roiWidth = ellipse.axes.minor * 0.8;
    const roiHeight = ellipse.axes.major * 0.4;

    // Calcular intensidad media R en el ROI
    const avgRed = this.calculateAverageRedInRegion(
      Math.round(roiCenterX - roiWidth / 2),
      Math.round(roiCenterY - roiHeight / 2),
      Math.round(roiWidth),
      Math.round(roiHeight),
      data,
      width,
      height
    );

    return {
      x: Math.max(0, roiCenterX - roiWidth / 2),
      y: Math.max(0, roiCenterY - roiHeight / 2),
      width: Math.min(roiWidth, width),
      height: Math.min(roiHeight, height),
      angle: ellipse.angle,
      confidence: ellipse.quality,
      ellipse,
      fingerPixels: contour.length,
      avgRedIntensity: avgRed
    };
  }

  /**
   * Análisis de grid adaptable para tesela ganadora
   * Divide el ROI en grid 4×6 y selecciona teselas con máxima perfusión
   */
  private analyzeAdaptiveGrid(
    roi: SmartROI,
    data: Uint8ClampedArray,
    width: number,
    height: number
  ): GridCell[] {
    const gridW = 6;
    const gridH = 4;
    const cellWidth = roi.width / gridW;
    const cellHeight = roi.height / gridH;
    const grid: GridCell[] = [];

    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const cellX = Math.round(roi.x + gx * cellWidth);
        const cellY = Math.round(roi.y + gy * cellHeight);
        const cellW = Math.round(cellWidth);
        const cellH = Math.round(cellHeight);

        const stats = this.calculateCellStats(cellX, cellY, cellW, cellH, data, width, height);
        
        // Perfusion score basado en varianza (componente AC) e intensidad R
        const perfusionScore = stats.variance * (stats.meanR / 255);

        grid.push({
          x: cellX,
          y: cellY,
          width: cellW,
          height: cellH,
          meanR: stats.meanR,
          meanG: stats.meanG,
          meanB: stats.meanB,
          variance: stats.variance,
          isSelected: false,
          perfusionScore
        });
      }
    }

    // Seleccionar top 3 teselas con mayor perfusion score
    const sorted = [...grid].sort((a, b) => b.perfusionScore - a.perfusionScore);
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
      sorted[i].isSelected = true;
    }

    return grid;
  }

  /**
   * Mejorar ROI basado en análisis de grid
   */
  private enhanceROIWithGrid(roi: SmartROI, grid: GridCell[]): SmartROI {
    const selectedCells = grid.filter(c => c.isSelected);
    
    if (selectedCells.length === 0) return roi;

    // Calcular ROI ponderado por teselas seleccionadas
    let totalWeight = 0;
    let weightedX = 0;
    let weightedY = 0;

    for (const cell of selectedCells) {
      const weight = cell.perfusionScore;
      weightedX += (cell.x + cell.width / 2) * weight;
      weightedY += (cell.y + cell.height / 2) * weight;
      totalWeight += weight;
    }

    if (totalWeight > 0) {
      roi.x = weightedX / totalWeight - roi.width / 2;
      roi.y = weightedY / totalWeight - roi.height / 2;
    }

    return roi;
  }

  /**
   * Actualizar estabilidad del contorno temporal
   */
  private updateContourStability(currentContour: Point2D[]): void {
    if (this.lastContour.length === 0 || currentContour.length === 0) {
      this.contourStability = 0;
      this.lastContour = currentContour;
      return;
    }

    // Calcular distancia Hausdorff simplificada entre contornos
    const dist = this.calculateContourDistance(this.lastContour, currentContour);
    const normalizedDist = Math.min(1, dist / 50);

    // Actualizar estabilidad con EMA
    this.contourStability = this.contourStability * 0.8 + (1 - normalizedDist) * 0.2;
    this.lastContour = currentContour;
  }

  /**
   * Calcular distancia entre dos contornos
   */
  private calculateContourDistance(c1: Point2D[], c2: Point2D[]): number {
    const n = Math.min(c1.length, c2.length);
    if (n === 0) return 1000;

    let sumDist = 0;
    for (let i = 0; i < n; i++) {
      const dx = c1[i].x - c2[i].x;
      const dy = c1[i].y - c2[i].y;
      sumDist += Math.sqrt(dx * dx + dy * dy);
    }

    return sumDist / n;
  }

  /**
   * Calcular estadísticas de una celda del grid
   */
  private calculateCellStats(
    x: number, y: number, w: number, h: number,
    data: Uint8ClampedArray, imgWidth: number, imgHeight: number
  ): { meanR: number; meanG: number; meanB: number; variance: number } {
    let sumR = 0, sumG = 0, sumB = 0;
    let count = 0;
    const values: number[] = [];

    for (let py = y; py < y + h && py < imgHeight; py++) {
      for (let px = x; px < x + w && px < imgWidth; px++) {
        const idx = (py * imgWidth + px) * 4;
        const r = data[idx];
        sumR += r;
        sumG += data[idx + 1];
        sumB += data[idx + 2];
        values.push(r);
        count++;
      }
    }

    if (count === 0) return { meanR: 0, meanG: 0, meanB: 0, variance: 0 };

    const mean = sumR / count;
    const variance = values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / count;

    return {
      meanR: mean,
      meanG: sumG / count,
      meanB: sumB / count,
      variance
    };
  }

  /**
   * Calcular promedio de R en región
   */
  private calculateAverageRedInRegion(
    x: number, y: number, w: number, h: number,
    data: Uint8ClampedArray, width: number, height: number
  ): number {
    let sum = 0;
    let count = 0;

    for (let py = y; py < y + h && py < height; py++) {
      for (let px = x; px < x + w && px < width; px++) {
        const idx = (py * width + px) * 4;
        sum += data[idx];
        count++;
      }
    }

    return count > 0 ? sum / count : 0;
  }

  /**
   * Calcular media de array
   */
  private calculateMean(arr: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
    }
    return sum / arr.length;
  }

  /**
   * Calcular desviación estándar
   */
  private calculateStd(arr: Float32Array, mean: number): number {
    let sumSq = 0;
    for (let i = 0; i < arr.length; i++) {
      const diff = arr[i] - mean;
      sumSq += diff * diff;
    }
    return Math.sqrt(sumSq / arr.length);
  }

  /**
   * Reset del detector
   */
  reset(): void {
    this.lastContour = [];
    this.contourStability = 0;
    this.lastROI = null;
  }

  /**
   * Obtener estabilidad actual del contorno (0-1)
   */
  getStability(): number {
    return this.contourStability;
  }
}
