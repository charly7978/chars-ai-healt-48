/**
 * Criterios estrictos de reflexión cutánea bajo iluminación roja (cámara PPG).
 * Rechaza saturación tipo plástico/labial intenso, dominancia verde/azul no cutánea,
 * y escenas planas sin textura — sin datos sintéticos; solo umbrales físicos RGB.
 */

export function isStrictHemoglobinSkinContact(
  r: number,
  g: number,
  b: number,
  textureScore: number
): boolean {
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return false;
  // RELAJADO: Permitir rango más amplio de intensidad
  if (r < 15 || r > 255) return false;
  // RELAJADO: Permitir más variación de textura
  if (textureScore < 0.12 || textureScore > 0.95) return false;

  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  // RELAJADO: Permitir más saturación (piel real varía)
  if (sat > 0.95) return false;
  if (sat < 0.03) return false;

  // RELAJADO: R debe ser dominante pero no tanto
  if (!(r >= g * 0.75 && r >= b * 0.85)) return false;
  
  const t = r + g + b + 1e-6;
  const rr = r / t;
  // RELAJADO: Rango más amplio para tonos de piel diversos
  if (rr < 0.25 || rr > 0.70) return false;

  const rg = r / (g + 1);
  // RELAJADO: Rango más amplio para R/G ratio
  if (rg < 0.70 || rg > 4.0) return false;

  return true;
}
