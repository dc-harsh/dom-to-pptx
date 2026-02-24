// src/color.js

// Shared canvas context for color normalization (lazy-initialized)
let _ctx;
function getCtx() {
  if (!_ctx) _ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  return _ctx;
}

/**
 * Parses any CSS color string into { hex: 'RRGGBB', opacity: 0-1 }.
 * hex is always 6-char uppercase, no '#'. Returns { hex: null, opacity: 0 } for transparent.
 */
export function parseColor(str) {
  if (!str || str === 'transparent' || str.trim() === 'rgba(0, 0, 0, 0)') {
    return { hex: null, opacity: 0 };
  }

  const ctx = getCtx();
  ctx.fillStyle = str;
  const computed = ctx.fillStyle;

  // Fast path: hex output
  if (computed.startsWith('#')) {
    let hex = computed.slice(1);
    let opacity = 1;
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length === 8) {
      opacity = parseInt(hex.slice(6), 16) / 255;
      hex = hex.slice(0, 6);
    }
    return { hex: hex.toUpperCase(), opacity };
  }

  // Fast path: rgb/rgba output
  if (computed.startsWith('rgb')) {
    const match = computed.match(/[\d.]+/g);
    if (match && match.length >= 3) {
      const r = parseInt(match[0]);
      const g = parseInt(match[1]);
      const b = parseInt(match[2]);
      const a = match.length > 3 ? parseFloat(match[3]) : 1;
      const hex = ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
      return { hex, opacity: a };
    }
  }

  // Fallback: use canvas pixel readback for oklch, lab, color(srgb…), etc.
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  const a = data[3] / 255;
  if (a === 0) return { hex: null, opacity: 0 };
  const hex = ((1 << 24) + (data[0] << 16) + (data[1] << 8) + data[2]).toString(16).slice(1).toUpperCase();
  return { hex, opacity: a };
}

/**
 * Extracts the first color from a CSS gradient string.
 * Used as a fallback when the text color is transparent (gradient clipped text).
 */
export function getGradientFallbackColor(bgImage) {
  if (!bgImage || bgImage === 'none') return null;

  const match = bgImage.match(/gradient\((.*)\)/);
  if (!match) return null;
  const content = match[1];

  // Split by comma, respecting nested parentheses (rgb(), oklch(), etc.)
  const parts = [];
  let current = '';
  let depth = 0;
  for (const ch of content) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; }
    else current += ch;
  }
  if (current) parts.push(current.trim());

  for (const part of parts) {
    if (/^(to\s|[\d.]+(deg|rad|turn|grad))/.test(part)) continue;
    const colorPart = part.replace(/\s+(-?[\d.]+(%|px|em|rem|ch|vh|vw)?)$/, '');
    if (colorPart) return colorPart;
  }

  return null;
}
