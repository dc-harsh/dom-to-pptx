// src/element-renderer.js
import {
  parseColor,
  getTextStyle,
  isTextContainer,
  getVisibleShadow,
  generateGradientSVG,
  getRotation,
  svgToPng,
  svgToSvg,
  getPadding,
  getSoftEdges,
  generateBlurredSVG,
  getBorderInfo,
  generateCompositeBorderSVG,
  isClippedByParent,
  generateCustomShapeSVG,
  extractTableData,
  isIconElement,
} from './utils.js';
import { PX_TO_INCH, TABLE_MEDIA_SELECTOR } from './constants.js';
import { elementToCanvasImage } from './canvas-capture.js';
import { buildChartItem } from './chart-renderer.js';
import { processListLevel, isComplexHierarchy } from './list-renderer.js';
import { getProcessedImage } from './image-processor.js';

/**
 * Builds thin rectangle shape items for each side of a composite (non-uniform) border.
 */
export function createCompositeBorderItems(sides, x, y, w, h, scale, zIndex, domOrder) {
  const items = [];
  const pxToInch = 1 / 96;
  const common = { zIndex: zIndex + 1, domOrder, shapeType: 'rect' };

  if (sides.top.width > 0)
    items.push({ ...common, options: { x, y, w, h: sides.top.width * pxToInch * scale, fill: { color: sides.top.color } } });
  if (sides.right.width > 0)
    items.push({ ...common, options: { x: x + w - sides.right.width * pxToInch * scale, y, w: sides.right.width * pxToInch * scale, h, fill: { color: sides.right.color } } });
  if (sides.bottom.width > 0)
    items.push({ ...common, options: { x, y: y + h - sides.bottom.width * pxToInch * scale, w, h: sides.bottom.width * pxToInch * scale, fill: { color: sides.bottom.color } } });
  if (sides.left.width > 0)
    items.push({ ...common, options: { x, y, w: sides.left.width * pxToInch * scale, h, fill: { color: sides.left.color } } });

  return items;
}

/**
 * Inspects a DOM node and returns a render descriptor for the PPTX pipeline.
 *
 * @returns {{ items: Array, job?: Function, stopRecursion: boolean } | null}
 *   items         - Render queue entries (shape / image / text / table / chart)
 *   job           - Optional async function for heavy work (image capture, SVG raster)
 *   stopRecursion - When true the caller must NOT recurse into node's children
 */
export function prepareRenderItem(node, config, domOrder, pptx, effectiveZIndex, computedStyle, globalOptions = {}) {
  // Root element is handled by processSlide (slide.background) — skip as shape
  if (node === config.root) return null;

  // ── Text Node ──────────────────────────────────────────────────────────────
  if (node.nodeType === 3) {
    const textContent = node.nodeValue.trim();
    if (!textContent) return null;

    const parent = node.parentElement;
    if (!parent) return null;
    if (isTextContainer(parent)) return null; // parent handles it as a whole

    const range = document.createRange();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    range.detach();

    const style = window.getComputedStyle(parent);
    const x = config.offX + (rect.left - config.rootX) * PX_TO_INCH * config.scale;
    const y = config.offY + (rect.top - config.rootY) * PX_TO_INCH * config.scale;
    const w = rect.width * PX_TO_INCH * config.scale;
    const h = rect.height * PX_TO_INCH * config.scale;

    return {
      items: [{
        type: 'text',
        zIndex: effectiveZIndex,
        domOrder,
        textParts: [{ text: textContent, options: getTextStyle(style, config.scale) }],
        options: { x, y, w, h, margin: 0, autoFit: false },
      }],
      stopRecursion: false,
    };
  }

  if (node.nodeType !== 1) return null;

  const style = computedStyle;
  const rect = node.getBoundingClientRect();
  if (rect.width < 0.5 || rect.height < 0.5) return null;

  const zIndex = effectiveZIndex;
  const rotation = getRotation(style.transform);
  const elementOpacity = parseFloat(style.opacity);
  const safeOpacity = isNaN(elementOpacity) ? 1 : elementOpacity;

  const widthPx = node.offsetWidth || rect.width;
  const heightPx = node.offsetHeight || rect.height;
  const unrotatedW = widthPx * PX_TO_INCH * config.scale;
  const unrotatedH = heightPx * PX_TO_INCH * config.scale;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  let x = config.offX + (centerX - config.rootX) * PX_TO_INCH * config.scale - unrotatedW / 2;
  let y = config.offY + (centerY - config.rootY) * PX_TO_INCH * config.scale - unrotatedH / 2;
  let w = unrotatedW;
  let h = unrotatedH;

  const items = [];

  // ── TABLE ──────────────────────────────────────────────────────────────────
  if (node.tagName === 'TABLE') {
    const tableData = extractTableData(node, config.scale);
    const tableItem = { type: 'table', zIndex: effectiveZIndex, domOrder, tableData, options: { x, y, w: unrotatedW, h: unrotatedH } };

    const mediaEls = Array.from(node.querySelectorAll(TABLE_MEDIA_SELECTOR));
    const mediaItems = [];
    const mediaJobs = [];

    mediaEls.forEach((mediaEl, idx) => {
      const mediaStyle = window.getComputedStyle(mediaEl);
      if (mediaStyle.display === 'none' || mediaStyle.visibility === 'hidden' || mediaStyle.opacity === '0') return;

      const result = prepareRenderItem(
        mediaEl, config, domOrder + (idx + 1) / (mediaEls.length + 1),
        pptx, effectiveZIndex, mediaStyle, globalOptions
      );
      if (result) {
        if (result.items) mediaItems.push(...result.items);
        if (result.job) mediaJobs.push(result.job);
      }
    });

    return {
      items: [tableItem, ...mediaItems],
      job: mediaJobs.length ? async () => Promise.all(mediaJobs.map((t) => t())) : null,
      stopRecursion: true,
    };
  }

  // ── LIST (UL / OL) ─────────────────────────────────────────────────────────
  if ((node.tagName === 'UL' || node.tagName === 'OL') && !isComplexHierarchy(node)) {
    const listItems = [];
    processListLevel(node, 0, listItems, config, globalOptions);

    if (listItems.length > 0) {
      const last = listItems[listItems.length - 1];
      if (last.options?.breakLine) delete last.options.breakLine;

      const bgColorObj = parseColor(style.backgroundColor);
      if (bgColorObj.hex && bgColorObj.opacity > 0) {
        items.push({ type: 'shape', zIndex, domOrder, shapeType: 'rect', options: { x, y, w, h, fill: { color: bgColorObj.hex } } });
      }
      items.push({
        type: 'text', zIndex: zIndex + 1, domOrder, textParts: listItems,
        options: { x, y, w, h, align: 'left', valign: 'top', margin: 0, autoFit: false, wrap: true },
      });
      return { items, stopRecursion: true };
    }
  }

  // ── CANVAS ─────────────────────────────────────────────────────────────────
  if (node.tagName === 'CANVAS') {
    const chartJson = node.dataset?.chart;
    if (chartJson) {
      try {
        const chartConfig = JSON.parse(chartJson);
        const chartItem = buildChartItem(chartConfig, pptx, zIndex, domOrder, x, y, w, h);
        if (chartItem) return { items: [chartItem], job: null, stopRecursion: true };
      } catch (e) {
        console.warn('data-chart parse failed, falling back to image:', e);
      }
    }

    const item = { type: 'image', zIndex, domOrder, options: { x, y, w, h, rotate: rotation, data: null } };
    const job = async () => {
      try {
        const dataUrl = node.toDataURL('image/png');
        if (dataUrl && dataUrl.length > 10) item.options.data = dataUrl;
        else item.skip = true;
      } catch (e) {
        console.warn('Failed to capture canvas content:', e);
        item.skip = true;
      }
    };
    return { items: [item], job, stopRecursion: true };
  }

  // ── SVG ────────────────────────────────────────────────────────────────────
  if (node.nodeName.toUpperCase() === 'SVG') {
    const item = { type: 'image', zIndex, domOrder, options: { data: null, x, y, w, h, rotate: rotation } };
    const job = async () => {
      const converter = globalOptions.svgAsVector ? svgToSvg : svgToPng;
      const processed = await converter(node);
      if (processed) item.options.data = processed;
      else item.skip = true;
    };
    return { items: [item], job, stopRecursion: true };
  }

  // ── IMG ────────────────────────────────────────────────────────────────────
  if (node.tagName === 'IMG') {
    let radii = {
      tl: parseFloat(style.borderTopLeftRadius) || 0,
      tr: parseFloat(style.borderTopRightRadius) || 0,
      br: parseFloat(style.borderBottomRightRadius) || 0,
      bl: parseFloat(style.borderBottomLeftRadius) || 0,
    };
    const hasAnyRadius = radii.tl > 0 || radii.tr > 0 || radii.br > 0 || radii.bl > 0;
    if (!hasAnyRadius) {
      const parent = node.parentElement;
      const parentStyle = window.getComputedStyle(parent);
      if (parentStyle.overflow !== 'visible') {
        const pRadii = {
          tl: parseFloat(parentStyle.borderTopLeftRadius) || 0,
          tr: parseFloat(parentStyle.borderTopRightRadius) || 0,
          br: parseFloat(parentStyle.borderBottomRightRadius) || 0,
          bl: parseFloat(parentStyle.borderBottomLeftRadius) || 0,
        };
        const pRect = parent.getBoundingClientRect();
        if (Math.abs(pRect.width - rect.width) < 5 && Math.abs(pRect.height - rect.height) < 5) radii = pRadii;
      }
    }

    const item = { type: 'image', zIndex, domOrder, options: { x, y, w, h, rotate: rotation, data: null } };
    const job = async () => {
      const processed = await getProcessedImage(
        node.src, widthPx, heightPx, radii,
        style.objectFit || 'fill', style.objectPosition || '50% 50%'
      );
      if (processed) item.options.data = processed;
      else item.skip = true;
    };
    return { items: [item], job, stopRecursion: true };
  }

  // ── ICON ELEMENTS (FontAwesome, Material, etc.) ────────────────────────────
  if (isIconElement(node)) {
    const item = { type: 'image', zIndex, domOrder, options: { x, y, w, h, rotate: rotation, data: null } };
    const job = async () => {
      const pngData = await elementToCanvasImage(node, widthPx, heightPx);
      if (pngData) item.options.data = pngData;
      else item.skip = true;
    };
    return { items: [item], job, stopRecursion: true };
  }

  // ── Border radius helpers ──────────────────────────────────────────────────
  const borderRadiusValue = parseFloat(style.borderRadius) || 0;
  const borderBottomLeftRadius = parseFloat(style.borderBottomLeftRadius) || 0;
  const borderBottomRightRadius = parseFloat(style.borderBottomRightRadius) || 0;
  const borderTopLeftRadius = parseFloat(style.borderTopLeftRadius) || 0;
  const borderTopRightRadius = parseFloat(style.borderTopRightRadius) || 0;

  const hasPartialBorderRadius =
    (borderBottomLeftRadius > 0 && borderBottomLeftRadius !== borderRadiusValue) ||
    (borderBottomRightRadius > 0 && borderBottomRightRadius !== borderRadiusValue) ||
    (borderTopLeftRadius > 0 && borderTopLeftRadius !== borderRadiusValue) ||
    (borderTopRightRadius > 0 && borderTopRightRadius !== borderRadiusValue) ||
    (borderRadiusValue === 0 && (borderBottomLeftRadius || borderBottomRightRadius || borderTopLeftRadius || borderTopRightRadius));

  const tempBg = parseColor(style.backgroundColor);
  const isTxt = isTextContainer(node);
  const hasContent = node.textContent.trim().length > 0 || node.children.length > 0;

  // ── Empty shape with partial radius → SVG vector ───────────────────────────
  if (hasPartialBorderRadius && tempBg.hex && !isTxt && !hasContent) {
    const shapeSvg = generateCustomShapeSVG(widthPx, heightPx, tempBg.hex, tempBg.opacity, {
      tl: parseFloat(style.borderTopLeftRadius) || 0,
      tr: parseFloat(style.borderTopRightRadius) || 0,
      br: parseFloat(style.borderBottomRightRadius) || 0,
      bl: parseFloat(style.borderBottomLeftRadius) || 0,
    });
    return { items: [{ type: 'image', zIndex, domOrder, options: { data: shapeSvg, x, y, w, h, rotate: rotation } }], stopRecursion: true };
  }

  // ── Clipped empty leaf → raster capture ───────────────────────────────────
  if (hasPartialBorderRadius && isClippedByParent(node) && !hasContent) {
    x += (parseFloat(style.marginLeft) || 0) * PX_TO_INCH * config.scale;
    y += (parseFloat(style.marginTop) || 0) * PX_TO_INCH * config.scale;

    const item = { type: 'image', zIndex, domOrder, options: { x, y, w, h, rotate: rotation, data: null } };
    const job = async () => {
      const img = await elementToCanvasImage(node, widthPx, heightPx);
      if (img) item.options.data = img;
      else item.skip = true;
    };
    return { items: [item], job, stopRecursion: true };
  }

  // ── Standard CSS extraction (backgrounds, borders, shadows, text) ──────────
  const bgColorObj = parseColor(style.backgroundColor);
  const bgClip = style.webkitBackgroundClip || style.backgroundClip;
  const isBgClipText = bgClip === 'text';
  const hasGradient = !isBgClipText && style.backgroundImage && style.backgroundImage.includes('linear-gradient');

  const borderColorObj = parseColor(style.borderColor);
  const borderWidth = parseFloat(style.borderWidth);
  const hasBorder = borderWidth > 0 && borderColorObj.hex;

  const borderInfo = getBorderInfo(style, config.scale);
  const hasUniformBorder = borderInfo.type === 'uniform';
  const hasCompositeBorder = borderInfo.type === 'composite';

  const shadowStr = style.boxShadow;
  const hasShadow = shadowStr && shadowStr !== 'none';
  const softEdge = getSoftEdges(style.filter, config.scale);

  let isImageWrapper = false;
  const imgChild = Array.from(node.children).find((c) => c.tagName === 'IMG');
  if (imgChild) {
    const childW = imgChild.offsetWidth || imgChild.getBoundingClientRect().width;
    const childH = imgChild.offsetHeight || imgChild.getBoundingClientRect().height;
    if (childW >= widthPx - 2 && childH >= heightPx - 2) isImageWrapper = true;
  }

  // Build text payload if this is a text container
  let textPayload = null;
  if (isTextContainer(node)) {
    const textParts = [];
    let trimNextLeading = false;

    node.childNodes.forEach((child, index) => {
      if (child.tagName === 'BR') {
        if (textParts.length > 0) {
          const last = textParts[textParts.length - 1];
          if (last.text && typeof last.text === 'string') last.text = last.text.trimEnd();
        }
        textParts.push({ text: '', options: { breakLine: true } });
        trimNextLeading = true;
        return;
      }

      let textVal = child.nodeType === 3 ? child.nodeValue : child.textContent;
      let nodeStyle = child.nodeType === 1 ? window.getComputedStyle(child) : style;
      textVal = textVal.replace(/[\n\r\t]+/g, ' ').replace(/\s{2,}/g, ' ');
      // Element children (span, b, strong, etc.) always have HTML-indentation whitespace
      // at their boundaries — trim it. Word separators come from adjacent text nodes.
      if (child.nodeType === 1) textVal = textVal.trim();

      if (index === 0) textVal = textVal.trimStart();
      if (trimNextLeading) { textVal = textVal.trimStart(); trimNextLeading = false; }
      if (index === node.childNodes.length - 1) textVal = textVal.trimEnd();
      if (nodeStyle.textTransform === 'uppercase') textVal = textVal.toUpperCase();
      if (nodeStyle.textTransform === 'lowercase') textVal = textVal.toLowerCase();

      if (textVal.length > 0) {
        const textOpts = getTextStyle(nodeStyle, config.scale);
        // Naked text nodes must not repeat the parent shape's background as a highlight
        if (child.nodeType === 3 && textOpts.highlight) delete textOpts.highlight;
        textParts.push({ text: textVal, options: textOpts });
      }
    });

    // Post-process: trim boundary whitespace that HTML indentation leaves on element
    // children at non-zero / non-last indices (e.g. <div>\n  <span>TEXT</span>\n</div>)
    if (textParts.length > 0) {
      const first = textParts[0];
      if (typeof first.text === 'string' && !first.options?.breakLine) {
        first.text = first.text.trimStart();
        if (!first.text) textParts.shift();
      }
    }
    if (textParts.length > 0) {
      const last = textParts[textParts.length - 1];
      if (typeof last.text === 'string' && !last.options?.breakLine) {
        last.text = last.text.trimEnd();
        if (!last.text) textParts.pop();
      }
    }
    if (textParts.length > 0) {
      let align = style.textAlign || 'left';
      if (align === 'start') align = 'left';
      if (align === 'end') align = 'right';

      // Prefer child element text-align (can override parent via CSS cascade)
      const firstChildEl = Array.from(node.childNodes).find((c) => c.nodeType === 1);
      if (firstChildEl) {
        const childAlign = window.getComputedStyle(firstChildEl).textAlign;
        if (childAlign === 'center' || childAlign === 'right') align = childAlign;
      }

      let valign = 'top';
      if (style.alignItems === 'center') valign = 'middle';
      if (style.justifyContent === 'center' && style.display.includes('flex')) align = 'center';
      const pt = parseFloat(style.paddingTop) || 0;
      const pb = parseFloat(style.paddingBottom) || 0;
      if (Math.abs(pt - pb) < 2 && bgColorObj.hex) valign = 'middle';

      let padding = getPadding(style, config.scale);
      if (align === 'center' && valign === 'middle') padding = [0, 0, 0, 0];

      textPayload = { text: textParts, align, valign, inset: padding };
    }
  }

  if (hasGradient || (softEdge && bgColorObj.hex && !isImageWrapper)) {
    let bgData = null;
    let padIn = 0;
    if (softEdge) {
      const svgInfo = generateBlurredSVG(widthPx, heightPx, bgColorObj.hex, borderRadiusValue, softEdge);
      bgData = svgInfo.data;
      padIn = svgInfo.padding * PX_TO_INCH * config.scale;
    } else {
      bgData = generateGradientSVG(
        widthPx, heightPx, style.backgroundImage, borderRadiusValue,
        hasBorder ? { color: borderColorObj.hex, width: borderWidth } : null
      );
    }

    if (bgData) {
      items.push({ type: 'image', zIndex, domOrder, options: { data: bgData, x: x - padIn, y: y - padIn, w: w + padIn * 2, h: h + padIn * 2, rotate: rotation } });
    }

    if (textPayload) {
      const firstRun = textPayload.text[0];
      if (firstRun?.options && !Number.isFinite(firstRun.options.fontSize)) firstRun.options.fontSize = 12;
      items.push({
        type: 'text', zIndex: zIndex + 1, domOrder, textParts: textPayload.text,
        options: { x, y, w, h, align: textPayload.align, valign: textPayload.valign, inset: textPayload.inset, rotate: rotation, margin: 0, wrap: true, autoFit: false },
      });
    }
    if (hasCompositeBorder) {
      items.push(...createCompositeBorderItems(borderInfo.sides, x, y, w, h, config.scale, zIndex, domOrder));
    }
  } else if ((bgColorObj.hex && !isImageWrapper) || hasUniformBorder || hasCompositeBorder || hasShadow || textPayload) {
    const finalAlpha = safeOpacity * bgColorObj.opacity;
    const transparency = (1 - finalAlpha) * 100;
    const useSolidFill = bgColorObj.hex && !isImageWrapper;

    if (hasPartialBorderRadius && useSolidFill && !textPayload) {
      const shapeSvg = generateCustomShapeSVG(widthPx, heightPx, bgColorObj.hex, bgColorObj.opacity, {
        tl: parseFloat(style.borderTopLeftRadius) || 0,
        tr: parseFloat(style.borderTopRightRadius) || 0,
        br: parseFloat(style.borderBottomRightRadius) || 0,
        bl: parseFloat(style.borderBottomLeftRadius) || 0,
      });
      items.push({ type: 'image', zIndex, domOrder, options: { data: shapeSvg, x, y, w, h, rotate: rotation } });
    } else {
      const shapeOpts = {
        x, y, w, h, rotate: rotation,
        fill: useSolidFill ? { color: bgColorObj.hex, transparency } : { type: 'none' },
        line: hasUniformBorder ? borderInfo.options : null,
      };
      if (hasShadow) shapeOpts.shadow = getVisibleShadow(shadowStr, config.scale);

      const minDimension = Math.min(widthPx, heightPx);
      let rawRadius = parseFloat(style.borderRadius) || 0;
      const isPercentage = style.borderRadius && style.borderRadius.toString().includes('%');
      let radiusPx = isPercentage ? (rawRadius / 100) * minDimension : rawRadius;
      const isSquare = Math.abs(widthPx - heightPx) < 1;
      const isFullyRound = radiusPx >= minDimension / 2;

      let shapeType = pptx.ShapeType.rect;
      if (isFullyRound && (isPercentage || isSquare)) {
        shapeType = pptx.ShapeType.ellipse;
      } else if (radiusPx > 0) {
        shapeType = pptx.ShapeType.roundRect;
        let r = radiusPx / minDimension;
        if (r > 0.5) r = 0.5;
        if (minDimension < 100) r *= 0.25;
        shapeOpts.rectRadius = r;
      }

      if (textPayload) {
        const firstRun = textPayload.text[0];
        if (firstRun?.options && !Number.isFinite(firstRun.options.fontSize)) firstRun.options.fontSize = 12;
        items.push({
          type: 'text', zIndex, domOrder, textParts: textPayload.text,
          options: { shape: shapeType, ...shapeOpts, rotate: rotation, align: textPayload.align, valign: textPayload.valign, inset: textPayload.inset, margin: 0, wrap: true, autoFit: false },
        });
      } else if (!hasPartialBorderRadius) {
        items.push({ type: 'shape', zIndex, domOrder, shapeType, options: shapeOpts });
      }
    }

    if (hasCompositeBorder) {
      const borderSvgData = generateCompositeBorderSVG(widthPx, heightPx, borderRadiusValue, borderInfo.sides);
      if (borderSvgData) {
        items.push({ type: 'image', zIndex: zIndex + 1, domOrder, options: { data: borderSvgData, x, y, w, h, rotate: rotation } });
      }
    }
  }

  return { items, stopRecursion: !!textPayload };
}
