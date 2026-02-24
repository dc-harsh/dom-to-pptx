// src/canvas-capture.js
import html2canvas from 'html2canvas';

/**
 * Captures a DOM element to a PNG data URL using html2canvas.
 * Includes fixes for font rendering, border-radius clipping, and glyph bleed.
 */
export async function elementToCanvasImage(node, widthPx, heightPx) {
  return new Promise((resolve) => {
    const originalId = node.id;
    const tempId = 'pptx-capture-' + Math.random().toString(36).substr(2, 9);
    node.id = tempId;

    const width = Math.max(Math.ceil(widthPx), 1);
    const height = Math.max(Math.ceil(heightPx), 1);
    const style = window.getComputedStyle(node);

    // Extra padding to capture content that bleeds outside the box (e.g. font glyphs)
    const padding = 10;

    html2canvas(node, {
      backgroundColor: null,
      logging: false,
      scale: 3,
      useCORS: true,
      width: width + padding * 2,
      height: height + padding * 2,
      x: -padding,
      y: -padding,
      onclone: (clonedDoc) => {
        const clonedNode = clonedDoc.getElementById(tempId);
        if (clonedNode) {
          // Force FontAwesome on icon elements
          const icons = clonedNode.querySelectorAll('.fa, .fas, .far, .fab');
          icons.forEach((icon) => {
            icon.style.setProperty('font-family', 'FontAwesome', 'important');
          });

          // Fix image display
          const images = clonedNode.querySelectorAll('img');
          images.forEach((img) => {
            img.style.setProperty('display', 'inline-block', 'important');
          });

          // Allow content to bleed outside the box
          clonedNode.style.overflow = 'visible';

          // Center icon glyphs to prevent baseline clipping
          const tag = clonedNode.tagName;
          if (tag === 'I' || tag === 'SPAN' || clonedNode.className.includes('fa-')) {
            clonedNode.style.display = 'inline-flex';
            clonedNode.style.justifyContent = 'center';
            clonedNode.style.alignItems = 'center';
            clonedNode.style.setProperty('font-family', 'FontAwesome', 'important');
            clonedNode.style.margin = '0';
            clonedNode.style.lineHeight = '1';
            clonedNode.style.verticalAlign = 'middle';
          }
        }
      },
    })
      .then((canvas) => {
        if (originalId) node.id = originalId;
        else node.removeAttribute('id');

        const destCanvas = document.createElement('canvas');
        destCanvas.width = width;
        destCanvas.height = height;
        const ctx = destCanvas.getContext('2d');

        // Crop the padded capture back to the original dimensions
        const scale = 3;
        ctx.drawImage(canvas, padding * scale, padding * scale, width * scale, height * scale, 0, 0, width, height);

        // Apply border-radius clipping
        let tl = parseFloat(style.borderTopLeftRadius) || 0;
        let tr = parseFloat(style.borderTopRightRadius) || 0;
        let br = parseFloat(style.borderBottomRightRadius) || 0;
        let bl = parseFloat(style.borderBottomLeftRadius) || 0;

        const f = Math.min(
          width / (tl + tr) || Infinity,
          height / (tr + br) || Infinity,
          width / (br + bl) || Infinity,
          height / (bl + tl) || Infinity
        );
        if (f < 1) { tl *= f; tr *= f; br *= f; bl *= f; }

        if (tl + tr + br + bl > 0) {
          ctx.globalCompositeOperation = 'destination-in';
          ctx.beginPath();
          ctx.moveTo(tl, 0);
          ctx.lineTo(width - tr, 0);
          ctx.arcTo(width, 0, width, tr, tr);
          ctx.lineTo(width, height - br);
          ctx.arcTo(width, height, width - br, height, br);
          ctx.lineTo(bl, height);
          ctx.arcTo(0, height, 0, height - bl, bl);
          ctx.lineTo(0, tl);
          ctx.arcTo(0, 0, tl, 0, tl);
          ctx.closePath();
          ctx.fill();
        }

        resolve(destCanvas.toDataURL('image/png'));
      })
      .catch((e) => {
        if (originalId) node.id = originalId;
        else node.removeAttribute('id');
        console.warn('Canvas capture failed for node', node, e);
        resolve(null);
      });
  });
}
