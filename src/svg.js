// src/svg.js
import { parseColor, getGradientFallbackColor } from './color.js';

// ── SVG shape generators ───────────────────────────────────────────────────

/**
 * Generates a base64 SVG data URL for composite borders that respect border-radius.
 */
export function generateCompositeBorderSVG(w, h, radius, sides) {
  radius = radius / 2;
  const clipId = 'clip_' + Math.random().toString(36).substr(2, 9);
  let rects = '';

  if (sides.top.width > 0 && sides.top.color)
    rects += `<rect x="0" y="0" width="${w}" height="${sides.top.width}" fill="#${sides.top.color}" />`;
  if (sides.right.width > 0 && sides.right.color)
    rects += `<rect x="${w - sides.right.width}" y="0" width="${sides.right.width}" height="${h}" fill="#${sides.right.color}" />`;
  if (sides.bottom.width > 0 && sides.bottom.color)
    rects += `<rect x="0" y="${h - sides.bottom.width}" width="${w}" height="${sides.bottom.width}" fill="#${sides.bottom.color}" />`;
  if (sides.left.width > 0 && sides.left.color)
    rects += `<rect x="0" y="0" width="${sides.left.width}" height="${h}" fill="#${sides.left.color}" />`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><clipPath id="${clipId}"><rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" /></clipPath></defs>
    <g clip-path="url(#${clipId})">${rects}</g>
  </svg>`;

  return 'data:image/svg+xml;base64,' + btoa(svg);
}

/**
 * Generates a base64 SVG data URL for a solid fill with non-uniform corner radii.
 */
export function generateCustomShapeSVG(w, h, color, opacity, radii) {
  let { tl, tr, br, bl } = radii;

  const factor = Math.min(
    w / (tl + tr) || Infinity, h / (tr + br) || Infinity,
    w / (br + bl) || Infinity, h / (bl + tl) || Infinity
  );
  if (factor < 1) { tl *= factor; tr *= factor; br *= factor; bl *= factor; }

  const path = `M ${tl} 0 L ${w - tr} 0 A ${tr} ${tr} 0 0 1 ${w} ${tr}
    L ${w} ${h - br} A ${br} ${br} 0 0 1 ${w - br} ${h}
    L ${bl} ${h} A ${bl} ${bl} 0 0 1 0 ${h - bl}
    L 0 ${tl} A ${tl} ${tl} 0 0 1 ${tl} 0 Z`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <path d="${path}" fill="#${color}" fill-opacity="${opacity}" />
  </svg>`;

  return 'data:image/svg+xml;base64,' + btoa(svg);
}

/**
 * Generates a base64 SVG data URL for a CSS linear-gradient background.
 */
export function generateGradientSVG(w, h, bgString, radius, border) {
  try {
    const match = bgString.match(/linear-gradient\((.*)\)/);
    if (!match) return null;
    const parts = match[1].split(/,(?![^()]*\))/).map((p) => p.trim());
    if (parts.length < 2) return null;

    let x1 = '0%', y1 = '0%', x2 = '0%', y2 = '100%';
    let stopsStartIndex = 0;
    const first = parts[0].toLowerCase();

    if (first.startsWith('to ')) {
      stopsStartIndex = 1;
      const dir = first.replace('to ', '').trim();
      const DIRS = {
        top: { y1: '100%', y2: '0%' }, bottom: { y1: '0%', y2: '100%' },
        left: { x1: '100%', x2: '0%' }, right: { x2: '100%' },
        'top right': { x1: '0%', y1: '100%', x2: '100%', y2: '0%' },
        'top left':  { x1: '100%', y1: '100%', x2: '0%', y2: '0%' },
        'bottom right': { x2: '100%', y2: '100%' },
        'bottom left':  { x1: '100%', y2: '100%' },
      };
      Object.assign({ x1, y1, x2, y2 }, DIRS[dir] || {});
      if (DIRS[dir]) ({ x1 = x1, y1 = y1, x2 = x2, y2 = y2 } = { x1, y1, x2, y2, ...DIRS[dir] });
    } else if (first.match(/^-?[\d.]+(deg|rad|turn|grad)$/)) {
      stopsStartIndex = 1;
      const val = parseFloat(first);
      if (!isNaN(val)) {
        const deg = first.includes('rad') ? val * (180 / Math.PI) : val;
        const cssRad = ((deg - 90) * Math.PI) / 180;
        const s = 50;
        x1 = (50 - Math.sin(cssRad) * s).toFixed(1) + '%';
        y1 = (50 + Math.cos(cssRad) * s).toFixed(1) + '%';
        x2 = (50 + Math.sin(cssRad) * s).toFixed(1) + '%';
        y2 = (50 - Math.cos(cssRad) * s).toFixed(1) + '%';
      }
    }

    let stopsXML = '';
    parts.slice(stopsStartIndex).forEach((part, idx, arr) => {
      let color = part;
      let offset = Math.round((idx / (arr.length - 1)) * 100) + '%';
      const posMatch = part.match(/^(.*?)\s+(-?[\d.]+(?:%|px)?)$/);
      if (posMatch) { color = posMatch[1]; offset = posMatch[2]; }

      let stopOpacity = 1;
      if (color.includes('rgba')) {
        const m = color.match(/[\d.]+/g);
        if (m && m.length >= 4) {
          stopOpacity = m[3];
          color = `rgb(${m[0]},${m[1]},${m[2]})`;
        }
      }
      stopsXML += `<stop offset="${offset}" stop-color="${color.trim()}" stop-opacity="${stopOpacity}"/>`;
    });

    const strokeAttr = border ? `stroke="#${border.color}" stroke-width="${border.width}"` : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <defs><linearGradient id="grad" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopsXML}</linearGradient></defs>
      <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="url(#grad)" ${strokeAttr} />
    </svg>`;

    return 'data:image/svg+xml;base64,' + btoa(svg);
  } catch (e) {
    console.warn('Gradient generation failed:', e);
    return null;
  }
}

/**
 * Generates a base64 SVG data URL for a Gaussian-blurred shape (soft-edge effect).
 * Returns { data, padding } — padding is the extra space added around the shape.
 */
export function generateBlurredSVG(w, h, color, radius, blurPx) {
  const padding = blurPx * 3;
  const fullW = w + padding * 2;
  const fullH = h + padding * 2;
  const x = padding;
  const y = padding;

  const isCircle = radius >= Math.min(w, h) / 2 - 1 && Math.abs(w - h) < 2;
  const shapeTag = isCircle
    ? `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#${color}" filter="url(#f1)" />`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#${color}" filter="url(#f1)" />`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${fullW}" height="${fullH}" viewBox="0 0 ${fullW} ${fullH}">
    <defs><filter id="f1" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="${blurPx}" />
    </filter></defs>
    ${shapeTag}
  </svg>`;

  return { data: 'data:image/svg+xml;base64,' + btoa(svg), padding };
}

// ── SVG node converters ────────────────────────────────────────────────────

/**
 * Inlines computed styles from a live SVG node into a cloned SVG node.
 * Required before serializing with XMLSerializer so styles are preserved.
 */
function inlineSvgStyles(source, target) {
  const computed = window.getComputedStyle(source);

  if (computed.fill === 'none') target.setAttribute('fill', 'none');
  else if (computed.fill) target.style.fill = computed.fill;

  if (computed.stroke === 'none') target.setAttribute('stroke', 'none');
  else if (computed.stroke) target.style.stroke = computed.stroke;

  ['stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight']
    .forEach((prop) => {
      const val = computed[prop];
      if (val && val !== 'auto') target.style[prop] = val;
    });

  for (let i = 0; i < source.children.length; i++) {
    if (target.children[i]) inlineSvgStyles(source.children[i], target.children[i]);
  }
}

/** Converts an SVG node to a rasterized PNG data URL (3× scale). */
export function svgToPng(node) {
  return new Promise((resolve) => {
    const clone = node.cloneNode(true);
    const rect = node.getBoundingClientRect();
    const width = rect.width || 300;
    const height = rect.height || 150;

    inlineSvgStyles(node, clone);
    clone.setAttribute('width', width);
    clone.setAttribute('height', height);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

    const xml = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = 3;
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(null);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  });
}

/** Converts an SVG node to a base64 SVG data URL (vector, editable in PowerPoint). */
export function svgToSvg(node) {
  return new Promise((resolve) => {
    try {
      const clone = node.cloneNode(true);
      const rect = node.getBoundingClientRect();
      const width = rect.width || 300;
      const height = rect.height || 150;

      inlineSvgStyles(node, clone);
      clone.setAttribute('width', width);
      clone.setAttribute('height', height);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (clone.querySelector('[*|href]') || clone.innerHTML.includes('xlink:')) {
        clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
      }

      const xml = new XMLSerializer().serializeToString(clone);
      resolve(`data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`);
    } catch (e) {
      console.warn('SVG serialization failed:', e);
      resolve(null);
    }
  });
}
