// src/table.js
import { parseColor } from './color.js';
import { getTextStyle, getPadding } from './style.js';

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

        // Hyperlink handling
        let cellText = cell.innerText.replace(/[\n\r\t]+/g, ' ').trim();
        let hyperlinkData = null;
        if (anchor) {
          const anchorColor = parseColor(window.getComputedStyle(anchor).color);
          if (anchorColor.hex) textStyle.color = anchorColor.hex;
          textStyle.underline = textStyle.underline || window.getComputedStyle(anchor).textDecoration.includes('underline');
          const href = anchor.getAttribute('href');
          if (href) hyperlinkData = { url: href };
          const anchorText = anchor.innerText.replace(/[\n\r\t]+/g, ' ').trim();
          if (anchorText) cellText = anchorText;
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
