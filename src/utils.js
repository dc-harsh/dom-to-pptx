// src/utils.js — barrel re-export
// All original exports are preserved here for backward compatibility.
// Implementation has been split into focused modules:
//   color.js        parseColor, getGradientFallbackColor
//   svg.js          SVG generators + svgToPng / svgToSvg
//   style.js        getTextStyle, getBorderInfo, isTextContainer, isIconElement, etc.
//   table.js        extractTableData
//   font-detection.js  getUsedFontFamilies, getAutoDetectedFonts
//   constants.js    FONT_SCALE_FACTOR, LINE_SPACING_PX_PER_PT (and PPI, PX_TO_INCH)

export { parseColor, getGradientFallbackColor } from './color.js';
export {
  generateCompositeBorderSVG,
  generateCustomShapeSVG,
  generateGradientSVG,
  generateBlurredSVG,
  svgToPng,
  svgToSvg,
} from './svg.js';
export {
  getBorderInfo,
  getVisibleShadow,
  getTextStyle,
  getPadding,
  getSoftEdges,
  getRotation,
  isClippedByParent,
  isTextContainer,
  isIconElement,
} from './style.js';
export { extractTableData } from './table.js';
export { getUsedFontFamilies, getAutoDetectedFonts } from './font-detection.js';
export { FONT_SCALE_FACTOR, LINE_SPACING_PX_PER_PT } from './constants.js';
