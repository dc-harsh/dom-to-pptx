// src/index.js
import * as PptxGenJSImport from 'pptxgenjs';
import { PPTXEmbedFonts } from './font-embedder.js';
import JSZip from 'jszip';
import { parseColor, getUsedFontFamilies, getAutoDetectedFonts } from './utils.js';
import { PX_TO_INCH } from './constants.js';
import { prepareRenderItem } from './element-renderer.js';

const PptxGenJS = PptxGenJSImport?.default ?? PptxGenJSImport;

const PPTX_WIDTH_IN = 10;
const PPTX_HEIGHT_IN = 5.625;

/**
 * Converts one or more HTML elements into a .pptx file.
 *
 * @param {HTMLElement | string | Array<HTMLElement | string>} target
 * @param {Object}  options
 * @param {string}  [options.fileName]
 * @param {boolean} [options.skipDownload=false]
 * @param {Object}  [options.listConfig]        - Bullet styling overrides
 * @param {boolean} [options.svgAsVector=false] - Keep SVG as vector (editable in PPT)
 * @param {Array}   [options.fonts]             - Font embed configs
 * @param {boolean} [options.autoEmbedFonts]    - Auto-detect & embed used fonts
 * @returns {Promise<Blob>}
 */
export async function exportToPptx(target, options = {}) {
  const resolvePptxConstructor = (pkg) => {
    if (!pkg) return null;
    if (typeof pkg === 'function') return pkg;
    if (pkg && typeof pkg.default === 'function') return pkg.default;
    if (pkg && typeof pkg.PptxGenJS === 'function') return pkg.PptxGenJS;
    if (pkg && pkg.PptxGenJS && typeof pkg.PptxGenJS.default === 'function') return pkg.PptxGenJS.default;
    return null;
  };

  const PptxConstructor = resolvePptxConstructor(PptxGenJS);
  if (!PptxConstructor) throw new Error('PptxGenJS constructor not found.');

  const pptx = new PptxConstructor();
  pptx.layout = 'LAYOUT_16x9';

  const elements = Array.isArray(target) ? target : [target];

  for (const el of elements) {
    const root = typeof el === 'string' ? document.querySelector(el) : el;
    if (!root) { console.warn('Element not found, skipping slide:', el); continue; }
    const slide = pptx.addSlide();
    await processSlide(root, slide, pptx, options);
  }

  // ── Font embedding ──────────────────────────────────────────────────────────
  let fontsToEmbed = options.fonts || [];

  if (options.autoEmbedFonts) {
    const usedFamilies = getUsedFontFamilies(elements);
    const detectedFonts = await getAutoDetectedFonts(usedFamilies);
    const explicitNames = new Set(fontsToEmbed.map((f) => f.name));
    for (const autoFont of detectedFonts) {
      if (!explicitNames.has(autoFont.name)) fontsToEmbed.push(autoFont);
    }
    if (detectedFonts.length > 0) {
      console.log('Auto-detected fonts:', detectedFonts.map((f) => f.name));
    }
  }

  let finalBlob;
  if (fontsToEmbed.length > 0) {
    const initialBlob = await pptx.write({ outputType: 'blob' });
    const zip = await JSZip.loadAsync(initialBlob);
    const embedder = new PPTXEmbedFonts();
    await embedder.loadZip(zip);

    for (const fontCfg of fontsToEmbed) {
      try {
        const response = await fetch(fontCfg.url);
        if (!response.ok) throw new Error(`Failed to fetch ${fontCfg.url}`);
        const buffer = await response.arrayBuffer();
        const ext = fontCfg.url.split('.').pop().split(/[?#]/)[0].toLowerCase();
        const type = ['woff', 'otf'].includes(ext) ? ext : 'ttf';
        await embedder.addFont(fontCfg.name, buffer, type);
      } catch (e) {
        console.warn(`Failed to embed font: ${fontCfg.name} (${fontCfg.url})`, e);
      }
    }

    await embedder.updateFiles();
    finalBlob = await embedder.generateBlob();
  } else {
    finalBlob = await pptx.write({ outputType: 'blob' });
  }

  // ── Download ────────────────────────────────────────────────────────────────
  if (!options.skipDownload) {
    const fileName = options.fileName || 'export.pptx';
    const url = URL.createObjectURL(finalBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return finalBlob;
}

/**
 * Processes a single root element into a PPTX slide.
 */
async function processSlide(root, slide, pptx, globalOptions = {}) {
  const rootRect = root.getBoundingClientRect();
  const contentWidthIn = rootRect.width * PX_TO_INCH;
  const contentHeightIn = rootRect.height * PX_TO_INCH;
  const scale = Math.min(PPTX_WIDTH_IN / contentWidthIn, PPTX_HEIGHT_IN / contentHeightIn);

  const layoutConfig = {
    rootX: rootRect.x,
    rootY: rootRect.y,
    scale,
    offX: (PPTX_WIDTH_IN - contentWidthIn * scale) / 2,
    offY: (PPTX_HEIGHT_IN - contentHeightIn * scale) / 2,
    root,
  };

  // Apply root element background directly to the slide (not as a selectable shape)
  const rootBg = parseColor(window.getComputedStyle(root).backgroundColor);
  if (rootBg.hex) slide.background = { color: rootBg.hex };

  const renderQueue = [];
  const asyncTasks = [];
  let domOrderCounter = 0;

  function collect(node, parentZIndex) {
    const order = domOrderCounter++;
    let currentZ = parentZIndex;
    let nodeStyle = null;

    if (node.nodeType === 1) {
      nodeStyle = window.getComputedStyle(node);
      if (nodeStyle.display === 'none' || nodeStyle.visibility === 'hidden' || nodeStyle.opacity === '0') return;
      if (nodeStyle.zIndex !== 'auto') currentZ = parseInt(nodeStyle.zIndex);
    }

    const result = prepareRenderItem(node, layoutConfig, order, pptx, currentZ, nodeStyle, globalOptions);

    if (result) {
      if (result.items) renderQueue.push(...result.items);
      if (result.job) asyncTasks.push(result.job);
      if (result.stopRecursion) return;
    }

    const childNodes = node.childNodes;
    for (let i = 0; i < childNodes.length; i++) collect(childNodes[i], currentZ);
  }

  collect(root, 0);

  if (asyncTasks.length > 0) await Promise.all(asyncTasks.map((task) => task()));

  const finalQueue = renderQueue
    .filter((item) => !item.skip && (item.type !== 'image' || item.options.data))
    .sort((a, b) => a.zIndex !== b.zIndex ? a.zIndex - b.zIndex : a.domOrder - b.domOrder);

  for (const item of finalQueue) {
    if (item.type === 'shape') slide.addShape(item.shapeType, item.options);
    if (item.type === 'image') slide.addImage(item.options);
    if (item.type === 'chart') slide.addChart(item.chartType, item.chartData, item.options);
    if (item.type === 'text') slide.addText(item.textParts, item.options);
    if (item.type === 'table') {
      slide.addTable(item.tableData.rows, {
        x: item.options.x,
        y: item.options.y,
        w: item.options.w,
        colW: item.tableData.colWidths,
        rowH: item.tableData.rowHeights,
        autoPage: false,
        border: { type: 'none' },
        fill: { color: 'FFFFFF', transparency: 100 },
      });
    }
  }
}
