// src/table.js
import { parseColor } from './color.js';
import { getTextStyle, getPadding } from './style.js';
import { FONT_SCALE_FACTOR } from './constants.js';

/**
 * Extracts a list (UL/OL) inside a table cell as an array of PptxGenJS text run objects
 * using the native PptxGenJS bullet API.
 *
 * Table cells cannot use the ZWS-run trick used by list-renderer.js for standalone text boxes.
 * In table cells PptxGenJS emits one <a:pPr> per run that has paragraph-level properties;
 * having two runs per paragraph (ZWS + text) causes two <a:pPr> elements in the same <a:p>,
 * and PowerPoint uses the last one — which has <a:buNone/>.
 *
 * Solution: one run per list-item paragraph with `bullet` placed directly on it so
 * PptxGenJS emits a single <a:pPr> containing <a:buChar> and any other para properties.
 */
function extractCellListRuns(cell, scale) {
  const BULLET_CODES = ['2022', '25E6', '25A0']; // •  ◦  ▪
  const runs = [];

  function processListEl(listEl, depth) {
    Array.from(listEl.children).forEach((li) => {
      if (li.tagName !== 'LI') return;

      const liStyle = window.getComputedStyle(li);
      const liTextStyle = getTextStyle(liStyle, scale);

      // Prefer ::marker color, fall back to element color
      const markerStyle = window.getComputedStyle(li, '::marker');
      const markerColor = parseColor(markerStyle.color);
      const bulletColor = markerColor.hex || liTextStyle.color || '000000';
      const bullet = { code: BULLET_CODES[depth % BULLET_CODES.length], color: bulletColor };

      // Compute indent from the UL's padding-left, capped at 24 px.
      // Table-cell ULs without explicit padding use the browser default (~40 px),
      // which inflates the gap; 24 px matches the typical author-set value.
      const rawPaddingPx = parseFloat(window.getComputedStyle(listEl).paddingLeft) || 0;
      const paddingPx = Math.min(rawPaddingPx, 24);
      const computedIndentPt = paddingPx * FONT_SCALE_FACTOR * scale;
      if (computedIndentPt > 0) bullet.indent = computedIndentPt;

      // Use ::marker font size so the bullet glyph is sized correctly
      const markerFs = parseFloat(markerStyle.fontSize);
      if (!isNaN(markerFs) && markerFs > 0) bullet.fontSize = markerFs * FONT_SCALE_FACTOR * scale;

      // Collect direct text only (skip nested UL/OL — handled by recursion below)
      let directText = '';
      li.childNodes.forEach((child) => {
        if (child.nodeType === 3) {
          directText += child.textContent;
        } else if (child.nodeType === 1 && child.tagName !== 'UL' && child.tagName !== 'OL') {
          directText += child.innerText || child.textContent;
        }
      });
      directText = directText.replace(/[\n\r\t]+/g, ' ').trim();

      if (directText) {
        // Single run per paragraph: bullet + text in one options object → one <a:pPr> → no conflict.
        runs.push({
          text: directText,
          options: {
            ...liTextStyle,
            bullet,
            ...(depth > 0 && { indentLevel: depth }),
            breakLine: true,
          },
        });
      }

      // Recurse into nested lists
      Array.from(li.children).forEach((child) => {
        if (child.tagName === 'UL' || child.tagName === 'OL') processListEl(child, depth + 1);
      });
    });
  }

  cell.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      const t = child.textContent.replace(/[\n\r\t]+/g, ' ').trim();
      if (t) runs.push({ text: t, options: { ...getTextStyle(window.getComputedStyle(cell), scale), breakLine: true } });
    } else if (child.nodeType === 1) {
      if (child.tagName === 'UL' || child.tagName === 'OL') {
        processListEl(child, 0);
      } else {
        const nested = child.querySelector('ul, ol');
        if (nested) {
          processListEl(nested, 0);
        } else {
          const t = (child.innerText || child.textContent || '').replace(/[\n\r\t]+/g, ' ').trim();
          if (t) runs.push({ text: t, options: { ...getTextStyle(window.getComputedStyle(child), scale), breakLine: true } });
        }
      }
    }
  });

  // Strip trailing breakLine from the last item
  if (runs.length > 0 && runs[runs.length - 1].options?.breakLine) {
    delete runs[runs.length - 1].options.breakLine;
  }
  return runs;
}

/**
 * Reads a single TD/TH border side from a CSSStyleDeclaration.
 * Returns null when the border is effectively absent.
 */
function getTableBorder(style, side, scale) {
  const width = parseFloat(style[`border${side}Width`]) || 0;
  const borderStyle = style[`border${side}Style`];
  if (width === 0 || borderStyle === 'none' || borderStyle === 'hidden') return null;

  const color = parseColor(style[`border${side}Color`]);
  if (!color.hex || color.opacity === 0) return null;

  let dash = 'solid';
  if (borderStyle === 'dashed') dash = 'dash';
  if (borderStyle === 'dotted') dash = 'dot';

  return { pt: width * 0.75 * scale, color: color.hex, style: dash };
}

/**
 * Extracts all rows, column widths, and row heights from an HTML table
 * and returns them in PptxGenJS native table format.
 */
export function extractTableData(node, scale) {
  const rows = [];
  const colWidths = [];
  const rowHeights = [];

  // Column widths from the first row
  const firstRow = node.querySelector('tr');
  if (firstRow) {
    Array.from(firstRow.children).forEach((cell) => {
      colWidths.push(cell.getBoundingClientRect().width * (1 / 96) * scale);
    });
  }

  node.querySelectorAll('tr').forEach((tr) => {
    rowHeights.push(tr.getBoundingClientRect().height * (1 / 96) * scale);

    const rowData = [];
    Array.from(tr.children)
      .filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
      .forEach((cell) => {
        const style = window.getComputedStyle(cell);

        // Read text style from the innermost meaningful child (span or anchor)
        // so CSS class rules on child elements take precedence over inherited cell styles
        const anchor = cell.querySelector('a[href]');
        const styleSource = anchor || cell.querySelector('span') || cell;
        const textStyle = getTextStyle(window.getComputedStyle(styleSource), scale);

        // List handling — if cell contains a UL/OL, extract bullet text runs
        const cellListEl = cell.querySelector('ul, ol');
        let cellText;
        let hyperlinkData = null;

        if (cellListEl) {
          const runs = extractCellListRuns(cell, scale);
          cellText = runs.length > 0 ? runs : '';
        } else {
          // Hyperlink handling (no list)
          cellText = cell.innerText.replace(/[\n\r\t]+/g, ' ').trim();
          if (anchor) {
            const anchorColor = parseColor(window.getComputedStyle(anchor).color);
            if (anchorColor.hex) textStyle.color = anchorColor.hex;
            textStyle.underline = textStyle.underline || window.getComputedStyle(anchor).textDecoration.includes('underline');
            const href = anchor.getAttribute('href');
            if (href) hyperlinkData = { url: href };
            const anchorText = anchor.innerText.replace(/[\n\r\t]+/g, ' ').trim();
            if (anchorText) cellText = anchorText;
          }
        }

        // Cell background — walk up to tr/thead/tbody if cell itself is transparent
        let bg = parseColor(style.backgroundColor);
        if (!bg.hex || bg.opacity === 0) {
          let ancestor = cell.parentElement;
          while (ancestor && !['TABLE', 'BODY', 'HTML'].includes(ancestor.tagName.toUpperCase())) {
            const aBg = parseColor(window.getComputedStyle(ancestor).backgroundColor);
            if (aBg.hex && aBg.opacity > 0) { bg = aBg; break; }
            ancestor = ancestor.parentElement;
          }
        }
        const fill = bg.hex && bg.opacity > 0 ? { color: bg.hex } : null;

        // Alignment
        let align = 'left';
        if (style.textAlign === 'center') align = 'center';
        if (style.textAlign === 'right' || style.textAlign === 'end') align = 'right';
        let valign = 'top';
        if (style.verticalAlign === 'middle') valign = 'middle';
        if (style.verticalAlign === 'bottom') valign = 'bottom';

        // Padding → PPTX margin (in points, [t, r, b, l])
        const padding = getPadding(style, scale);
        const margin = padding.map((v) => v * 72);

        // Borders — cell borders take priority, tr borders as fallback
        const trStyle = window.getComputedStyle(cell.parentElement);
        const makeBorder = (side) =>
          getTableBorder(style, side, scale) || getTableBorder(trStyle, side, scale);

        const borderTop    = makeBorder('Top');
        const borderRight  = makeBorder('Right');
        const borderBottom = makeBorder('Bottom');
        const borderLeft   = makeBorder('Left');

        const toCell = (b) => b ? { pt: b.pt, color: b.color, type: b.style } : { type: 'none' };

        rowData.push({
          text: hyperlinkData
            ? [{ text: cellText, options: { color: textStyle.color, underline: textStyle.underline, hyperlink: hyperlinkData } }]
            : cellText,
          options: {
            color: textStyle.color,
            fontFace: textStyle.fontFace,
            fontSize: textStyle.fontSize,
            bold: textStyle.bold,
            italic: textStyle.italic,
            underline: textStyle.underline,
            fill,
            align,
            valign,
            margin,
            rowspan: parseInt(cell.getAttribute('rowspan')) || null,
            colspan: parseInt(cell.getAttribute('colspan')) || null,
            border: [toCell(borderTop), toCell(borderRight), toCell(borderBottom), toCell(borderLeft)],
          },
        });
      });

    if (rowData.length > 0) rows.push(rowData);
  });

  return { rows, colWidths, rowHeights };
}
