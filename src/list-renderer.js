// src/list-renderer.js
import { parseColor, FONT_SCALE_FACTOR, isIconElement } from './utils.js';
export { collectListParts, collectLiDirectParts } from './inline-runs.js';
import { collectLiDirectParts } from './inline-runs.js';

/**
 * Returns true when a UL/OL contains structures too complex for native PPTX
 * bullet rendering (flex/grid LIs, media elements, icons).
 * Nested lists are fine and handled by processListLevel.
 */
export function isComplexHierarchy(root) {
  const stack = [root];
  while (stack.length > 0) {
    const el = stack.pop();

    if (el.tagName === 'LI') {
      const s = window.getComputedStyle(el);
      if (s.display === 'flex' || s.display === 'grid' || s.display === 'inline-flex') return true;
    }

    if (['IMG', 'SVG', 'CANVAS', 'VIDEO', 'IFRAME'].includes(el.tagName)) return true;
    if (isIconElement(el)) return true;

    for (let i = 0; i < el.children.length; i++) {
      stack.push(el.children[i]);
    }
  }
  return false;
}

/**
 * Recursively collects PptxGenJS text run objects for all LI items in a list,
 * including nested lists at increasing indentLevel.
 *
 * Bullet chars cycle: disc (•) → circle (○) → square (■) per depth level.
 *
 * @param {Element} listNode     - UL or OL element
 * @param {number}  depth        - Nesting depth (0 = top level)
 * @param {Array}   out          - Accumulator; push text run objects here
 * @param {Object}  config       - Layout config (must contain `scale`)
 * @param {Object}  globalOptions
 */
export function processListLevel(listNode, depth, out, config, globalOptions) {
  const BULLET_CODES = ['2022', '25E6', '25A0']; // disc, circle, square
  const liChildren = Array.from(listNode.children).filter((c) => c.tagName === 'LI');

  liChildren.forEach((li) => {
    const liStyle = window.getComputedStyle(li);
    const liRect = li.getBoundingClientRect();
    const parentRect = listNode.getBoundingClientRect();

    // ── 1. Bullet config ────────────────────────────────────────────────────
    let bullet = { type: 'bullet' };
    const listStyleType = liStyle.listStyleType || 'disc';

    if (listNode.tagName === 'OL' || listStyleType === 'decimal') {
      bullet = { type: 'number' };
    } else if (listStyleType === 'none') {
      bullet = false;
    } else {
      const code = BULLET_CODES[depth % BULLET_CODES.length];
      let finalHex = '000000';
      let markerFontSize = null;

      if (globalOptions?.listConfig?.color) {
        finalHex = parseColor(globalOptions.listConfig.color).hex || '000000';
      } else {
        const markerStyle = window.getComputedStyle(li, '::marker');
        const markerColor = parseColor(markerStyle.color);
        if (markerColor.hex) {
          finalHex = markerColor.hex;
        } else {
          const colorObj = parseColor(liStyle.color);
          if (colorObj.hex) finalHex = colorObj.hex;
        }
        const markerFs = parseFloat(markerStyle.fontSize);
        if (!isNaN(markerFs) && markerFs > 0) {
          markerFontSize = markerFs * FONT_SCALE_FACTOR * config.scale;
        }
      }

      bullet = { code, color: finalHex };
      if (markerFontSize) bullet.fontSize = markerFontSize;
    }

    // ── 2. Hanging indent (from LI visual offset within its container) ──────
    const visualIndentPx = liRect.left - parentRect.left;
    const computedIndentPt = visualIndentPx * FONT_SCALE_FACTOR * config.scale;
    if (bullet && computedIndentPt > 0) bullet.indent = computedIndentPt;

    // ── 3. Text parts (direct content only, no nested list text) ────────────
    const parts = collectLiDirectParts(li, liStyle, config.scale);

    if (parts.length > 0) {
      parts.forEach((p) => {
        if (!p.options) p.options = {};
        if (depth > 0) p.options.indentLevel = depth;
      });

      // Prepend a ZWS run to carry bullet style (color/size can differ from body text)
      if (bullet) {
        const firstInfo = parts[0].options;
        const bulletRun = {
          text: '\u200B',
          options: {
            ...firstInfo,
            color: bullet.color || firstInfo.color,
            fontSize: bullet.fontSize || firstInfo.fontSize,
            bullet,
            ...(depth > 0 && { indentLevel: depth }),
          },
        };
        if (bullet.color) bulletRun.options.color = bullet.color;
        if (bullet.fontSize) bulletRun.options.fontSize = bullet.fontSize;
        parts.unshift(bulletRun);
      }

      // Paragraph spacing
      let ptBefore = 0;
      let ptAfter = 0;
      if (globalOptions.listConfig?.spacing) {
        if (typeof globalOptions.listConfig.spacing.before === 'number')
          ptBefore = globalOptions.listConfig.spacing.before;
        if (typeof globalOptions.listConfig.spacing.after === 'number')
          ptAfter = globalOptions.listConfig.spacing.after;
      } else {
        const mt = parseFloat(liStyle.marginTop) || 0;
        const mb = parseFloat(liStyle.marginBottom) || 0;
        if (mt > 0) ptBefore = mt * FONT_SCALE_FACTOR * config.scale;
        if (mb > 0) ptAfter = mb * FONT_SCALE_FACTOR * config.scale;
      }
      if (ptBefore > 0) parts[0].options.paraSpaceBefore = ptBefore;
      if (ptAfter > 0) parts[0].options.paraSpaceAfter = ptAfter;

      // Paragraph break after each LI (caller strips the trailing one)
      parts[parts.length - 1].options.breakLine = true;

      out.push(...parts);
    }

    // ── 4. Recurse into nested lists ─────────────────────────────────────────
    Array.from(li.children).forEach((child) => {
      if (child.tagName === 'UL' || child.tagName === 'OL') {
        processListLevel(child, depth + 1, out, config, globalOptions);
      }
    });
  });
}
