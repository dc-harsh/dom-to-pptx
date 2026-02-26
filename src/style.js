// src/style.js
import { parseColor, getGradientFallbackColor } from './color.js';
import { FONT_SCALE_FACTOR } from './constants.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function mapDashType(style) {
  if (style === 'dashed') return 'dash';
  if (style === 'dotted') return 'dot';
  return 'solid';
}

// ── Border ─────────────────────────────────────────────────────────────────

/**
 * Analyses computed border styles and returns a rendering strategy:
 *   { type: 'none' }
 *   { type: 'uniform', options }
 *   { type: 'composite', sides }
 */
export function getBorderInfo(style, scale) {
  const read = (side) => ({
    width: parseFloat(style[`border${side}Width`]) || 0,
    style: style[`border${side}Style`],
    color: parseColor(style[`border${side}Color`]).hex,
  });

  const top = read('Top');
  const right = read('Right');
  const bottom = read('Bottom');
  const left = read('Left');

  if (!top.width && !right.width && !bottom.width && !left.width) return { type: 'none' };

  const isUniform =
    top.width === right.width && top.width === bottom.width && top.width === left.width &&
    top.style === right.style && top.style === bottom.style && top.style === left.style &&
    top.color === right.color && top.color === bottom.color && top.color === left.color;

  if (isUniform) {
    return {
      type: 'uniform',
      options: {
        width: top.width * 0.75 * scale,
        color: top.color,
        transparency: (1 - parseColor(style.borderTopColor).opacity) * 100,
        dashType: mapDashType(top.style),
      },
    };
  }

  return { type: 'composite', sides: { top, right, bottom, left } };
}

// ── Shadow ─────────────────────────────────────────────────────────────────

/**
 * Parses a CSS box-shadow string and returns a PptxGenJS shadow descriptor,
 * or null if no visible shadow is found.
 */
export function getVisibleShadow(shadowStr, scale) {
  if (!shadowStr || shadowStr === 'none') return null;
  for (let s of shadowStr.split(/,(?![^()]*\))/)) {
    s = s.trim();
    if (s.startsWith('rgba(0, 0, 0, 0)')) continue;
    const match = s.match(/(rgba?\([^)]+\)|#[0-9a-fA-F]+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/);
    if (match) {
      const x = parseFloat(match[2]);
      const y = parseFloat(match[3]);
      const blur = parseFloat(match[4]);
      const dist = Math.sqrt(x * x + y * y);
      let angle = Math.atan2(y, x) * (180 / Math.PI);
      if (angle < 0) angle += 360;
      const colorObj = parseColor(match[1]);
      return {
        type: 'outer',
        angle,
        blur: blur * 0.75 * scale,
        offset: dist * 0.75 * scale,
        color: colorObj.hex || '000000',
        opacity: colorObj.opacity,
      };
    }
  }
  return null;
}

// ── Text ───────────────────────────────────────────────────────────────────

/**
 * Converts a computed CSS style to a PptxGenJS text-run options object.
 */
export function getTextStyle(style, scale) {
  let colorObj = parseColor(style.color);

  // Gradient-clipped text has opacity 0 — fall back to first gradient color
  const bgClip = style.webkitBackgroundClip || style.backgroundClip;
  if (colorObj.opacity === 0 && bgClip === 'text') {
    const fallback = getGradientFallbackColor(style.backgroundImage);
    if (fallback) colorObj = parseColor(fallback);
  }

  const fontSizePx = parseFloat(style.fontSize);

  const mt = parseFloat(style.marginTop) || 0;
  const mb = parseFloat(style.marginBottom) || 0;
  const paraSpaceBefore = mt > 0 ? mt * FONT_SCALE_FACTOR * scale : 0;
  const paraSpaceAfter  = mb > 0 ? mb * FONT_SCALE_FACTOR * scale : 0;

  return {
    color: colorObj.hex || '000000',
    fontFace: style.fontFamily.split(',')[0].replace(/['"]/g, ''),
    fontSize: fontSizePx * FONT_SCALE_FACTOR * scale,
    bold: parseInt(style.fontWeight) >= 600,
    italic: style.fontStyle === 'italic',
    underline: style.textDecoration.includes('underline'),
    ...(paraSpaceBefore > 0 && { paraSpaceBefore }),
    ...(paraSpaceAfter  > 0 && { paraSpaceAfter }),
    ...(parseColor(style.backgroundColor).hex
      ? { highlight: parseColor(style.backgroundColor).hex }
      : {}),
  };
}

/**
 * Converts CSS padding to a [top, right, bottom, left] array in inches (scaled).
 */
export function getPadding(style, scale) {
  const toIn = (px) => (parseFloat(px) || 0) * (1 / 96) * scale;
  return [
    toIn(style.paddingTop),
    toIn(style.paddingRight),
    toIn(style.paddingBottom),
    toIn(style.paddingLeft),
  ];
}

/**
 * Returns a soft-edge blur value in PPTX points, or null if no blur filter.
 */
export function getSoftEdges(filterStr, scale) {
  if (!filterStr || filterStr === 'none') return null;
  const match = filterStr.match(/blur\(([\d.]+)px\)/);
  return match ? parseFloat(match[1]) * 0.75 * scale : null;
}

/**
 * Parses a CSS transform matrix and returns the rotation angle in degrees.
 */
export function getRotation(transformStr) {
  if (!transformStr || transformStr === 'none') return 0;
  const values = transformStr.split('(')[1].split(')')[0].split(',');
  if (values.length < 4) return 0;
  return Math.round(Math.atan2(parseFloat(values[1]), parseFloat(values[0])) * (180 / Math.PI));
}

// ── DOM queries ────────────────────────────────────────────────────────────

/**
 * Returns true if any ancestor has overflow:hidden / overflow:clip.
 */
export function isClippedByParent(node) {
  let parent = node.parentElement;
  while (parent && parent !== document.body) {
    const ov = window.getComputedStyle(parent).overflow;
    if (ov === 'hidden' || ov === 'clip') return true;
    parent = parent.parentElement;
  }
  return false;
}

/**
 * Returns true if the node contains only inline text-like children
 * (no block elements, media, or icon components).
 */
export function isTextContainer(node) {
  if (!node.textContent.trim().length) return false;

  const children = Array.from(node.children);
  if (children.length === 0) return true;

  const isSafeInline = (el) => {
    if (el.tagName.includes('-')) return false;
    if (el.tagName === 'IMG' || el.tagName === 'SVG') return false;

    if (el.tagName === 'I' || el.tagName === 'SPAN') {
      const cls = el.getAttribute('class') || '';
      if (
        cls.includes('fa-') || cls.includes('fas') || cls.includes('far') || cls.includes('fab') ||
        cls.includes('material-icons') || cls.includes('bi-') || cls.includes('icon')
      ) return false;
    }

    const style = window.getComputedStyle(el);
    const isInlineTag = ['SPAN', 'B', 'STRONG', 'EM', 'I', 'A', 'SMALL', 'MARK'].includes(el.tagName);
    if (!isInlineTag && !style.display.includes('inline')) return false;

    // Empty visual objects (dot separators, decorative badges with no text)
    const bgColor = parseColor(style.backgroundColor);
    const hasBg = bgColor.hex && bgColor.opacity > 0;
    const hasBorder = parseFloat(style.borderWidth) > 0 && parseColor(style.borderColor).opacity > 0;
    if (!el.textContent.trim().length && (hasBg || hasBorder)) return false;

    return true;
  };

  return children.every(isSafeInline);
}

/**
 * Returns true if the element should be rendered as an icon image
 * (web components, custom elements, CSS icon libraries like FontAwesome).
 */
export function isIconElement(node) {
  const tag = node.tagName.toUpperCase();

  if (
    tag.includes('-') ||
    ['MATERIAL-ICON', 'ICONIFY-ICON', 'REMIX-ICON', 'ION-ICON', 'EVA-ICON', 'BOX-ICON', 'FA-ICON'].includes(tag)
  ) return true;

  if (tag === 'I' || tag === 'SPAN') {
    const cls = node.getAttribute('class') || '';
    if (
      typeof cls === 'string' &&
      (cls.includes('fa-') || cls.includes('fas') || cls.includes('far') || cls.includes('fab') ||
        cls.includes('bi-') || cls.includes('material-icons') || cls.includes('icon'))
    ) {
      const before = window.getComputedStyle(node, '::before').content;
      const after = window.getComputedStyle(node, '::after').content;
      const hasContent = (c) => c && c !== 'none' && c !== 'normal' && c !== '""';
      if (hasContent(before) || hasContent(after)) return true;
    }
  }

  return false;
}
