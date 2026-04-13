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
  if (r < 26 || r > 250) return false;
  if (textureScore < 0.17 || textureScore > 0.9) return false;

  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  if (sat > 0.86) return false;
  if (sat < 0.055) return false;

  if (!(r >= g * 0.9 && r >= b * 1.03)) return false;
  if (g < b * 0.74) return false;
  if (b > g * 1.06) return false;

  const t = r + g + b + 1e-6;
  const rr = r / t;
  if (rr < 0.31 || rr > 0.6) return false;

  const rg = r / (g + 1);
  const gb = g / (b + 1e-6);
  if (rg < 0.92 || rg > 3.05) return false;
  if (gb < 0.95 || gb > 2.15) return false;

  return true;
}
