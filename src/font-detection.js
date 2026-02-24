// src/font-detection.js

/**
 * Traverses DOM elements and collects every unique primary font-family in use.
 * @param {HTMLElement | string | Array} root
 * @returns {Set<string>}
 */
export function getUsedFontFamilies(root) {
  const families = new Set();

  function scan(node) {
    if (node.nodeType === 1) {
      const primary = window.getComputedStyle(node).fontFamily
        .split(',')[0].trim().replace(/['"]/g, '');
      if (primary) families.add(primary);
    }
    for (const child of node.childNodes) scan(child);
  }

  const elements = Array.isArray(root) ? root : [root];
  elements.forEach((el) => {
    const node = typeof el === 'string' ? document.querySelector(el) : el;
    if (node) scan(node);
  });

  return families;
}

/**
 * Scans document.styleSheets for @font-face rules matching the requested families.
 * Returns an array of { name, url } objects ready for font embedding.
 * Prefers ttf/otf/woff over woff2.
 */
export async function getAutoDetectedFonts(usedFamilies) {
  const foundFonts = [];
  const processedUrls = new Set();

  const extractUrl = (srcStr) => {
    const matches = srcStr.match(/url\((['"]?)(.*?)\1\)/g);
    if (!matches) return null;
    let fallback = null;
    for (const match of matches) {
      const url = match.replace(/url\((['"]?)(.*?)\1\)/, '$2');
      if (url.startsWith('data:')) continue;
      if (url.includes('.ttf') || url.includes('.otf') || url.includes('.woff')) return url;
      if (!fallback) fallback = url;
    }
    return fallback;
  };

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = sheet.cssRules || sheet.rules;
      if (!rules) continue;

      for (const rule of Array.from(rules)) {
        if (rule.constructor.name === 'CSSFontFaceRule' || rule.type === 5) {
          const family = rule.style.getPropertyValue('font-family').replace(/['"]/g, '').trim();
          if (!usedFamilies.has(family)) continue;
          const url = extractUrl(rule.style.getPropertyValue('src'));
          if (url && !processedUrls.has(url)) {
            processedUrls.add(url);
            foundFonts.push({ name: family, url });
          }
        }
      }
    } catch (e) {
      console.warn('Cannot scan stylesheet for fonts (CORS restriction):', sheet.href);
    }
  }

  return foundFonts;
}
