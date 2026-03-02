// src/inline-runs.js
// Shared helpers for collecting PptxGenJS text run objects from inline HTML content.
// Kept separate from list-renderer.js and table.js to avoid circular dependencies.
import { getTextStyle } from './style.js';

/**
 * Collects PptxGenJS text run objects for inline content inside an element,
 * recursing into child elements (spans, bold, em, etc.).
 */
export function collectListParts(node, parentStyle, scale) {
  const parts = [];

  if (node.nodeType === 1) {
    const beforeStyle = window.getComputedStyle(node, '::before');
    const content = beforeStyle.content;
    if (content && content !== 'none' && content !== 'normal' && content !== '""') {
      const cleanContent = content.replace(/^['"]|['"]$/g, '');
      if (cleanContent.trim()) {
        parts.push({
          text: cleanContent + ' ',
          options: getTextStyle(window.getComputedStyle(node), scale),
        });
      }
    }
  }

  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      const val = child.nodeValue.replace(/[\n\r\t]+/g, ' ').replace(/\s{2,}/g, ' ');
      if (val) {
        const styleToUse = node.nodeType === 1 ? window.getComputedStyle(node) : parentStyle;
        parts.push({ text: val, options: getTextStyle(styleToUse, scale) });
      }
    } else if (child.nodeType === 1) {
      parts.push(...collectListParts(child, parentStyle, scale));
    }
  });

  // Trim boundary HTML indentation whitespace (e.g. <strong>\n  TEXT\n</strong>)
  if (parts.length > 0 && typeof parts[0].text === 'string') {
    parts[0].text = parts[0].text.trimStart();
    if (!parts[0].text) parts.shift();
  }
  if (parts.length > 0 && typeof parts[parts.length - 1].text === 'string') {
    parts[parts.length - 1].text = parts[parts.length - 1].text.trimEnd();
    if (!parts[parts.length - 1].text) parts.pop();
  }

  return parts;
}

/**
 * Like collectListParts but stops at nested UL/OL elements.
 */
export function collectLiDirectParts(li, liStyle, scale) {
  const parts = [];

  const beforeStyle = window.getComputedStyle(li, '::before');
  const content = beforeStyle.content;
  if (content && content !== 'none' && content !== 'normal' && content !== '""') {
    const cleanContent = content.replace(/^['"]|['"]$/g, '');
    if (cleanContent.trim()) {
      parts.push({
        text: cleanContent + ' ',
        options: getTextStyle(window.getComputedStyle(li), scale),
      });
    }
  }

  li.childNodes.forEach((child) => {
    if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) return;

    if (child.nodeType === 3) {
      const val = child.nodeValue.replace(/[\n\r\t]+/g, ' ').replace(/\s{2,}/g, ' ');
      if (val.trim()) {
        parts.push({ text: val, options: getTextStyle(liStyle, scale) });
      }
    } else if (child.nodeType === 1) {
      parts.push(...collectListParts(child, liStyle, scale));
    }
  });

  // Trim boundary HTML indentation whitespace
  if (parts.length > 0 && typeof parts[0].text === 'string') {
    parts[0].text = parts[0].text.trimStart();
    if (!parts[0].text) parts.shift();
  }
  if (parts.length > 0 && typeof parts[parts.length - 1].text === 'string') {
    parts[parts.length - 1].text = parts[parts.length - 1].text.trimEnd();
    if (!parts[parts.length - 1].text) parts.pop();
  }

  return parts;
}
