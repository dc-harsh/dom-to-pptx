# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2025-12-29

### Added
- **Automatic Font Discovery:** The library now automatically scans the DOM for used font families, extracts their `@font-face` URLs from the document stylesheets, and embeds them into the PPTX file; Addresses [#4].
- **Custom Font Embedding:** Added support for manually embedding web fonts (TTF, WOFF, OTF).
- **Font Configuration:** Added `fonts` option for manual font URLs and `autoEmbedFonts` (default: `true`) to toggle automatic detection.

### Changed
- **Build Configuration:** Updated Rollup build to include necessary Node.js polyfills (Buffer, Stream) for the browser bundle to support binary font manipulation.
- **Text Detection:** Improved `isTextContainer` logic to better distinguish between pure text nodes and structural inline elements (like icons or styled spans).

## [1.0.9] - 2025-12-28

### Fixed
- **Complex Gradients:** Fixed `linear-gradient` parsing to correctly support degree-based angles (e.g., `45deg`) and complex directional keywords (e.g., `to top right`), ensuring background gradients match the CSS exactly.
- **Icon Visibility:** Fixed an issue where icons (Font Awesome, Material Icons, etc.) nested within list items or text containers were being treated as empty text and failing to render, fixes [#3].

## [1.0.8] - 2025-12-12 (Hot-Patch)

### Fixed

- **Fixed SVGs not getting converted**: Seperated the logic to handle SVGs and Web Components/Icons.


## [1.0.7] - 2025-12-12

### Fixed

- **Fix Stacking Context/Z-Index**: Implemented logic to traverse and inherit Z-index from parents. Render queue is now sorted by Z-index then DOM order, preventing text from being hidden behind background cards.
- **Support Web Components/Icons**: Updated `createRenderItem` and `isTextContainer` to recognize `ion-icon` and custom tags. These are now rasterized via canvas rather than ignored.
- **Fix Mixed Content (Icons + Text)**: Switched main traversal loop to use `childNodes` instead of `children`. Added specific handler for `nodeType === 3` (Text Nodes) to render orphan text residing next to icons/shapes.
- **Fix Styled Inline Spans (Badges)**: Updated `isTextContainer` to return `false` if children have visible backgrounds or borders. This ensures elements like "Pune/Vashi" badges render as individual styled shapes instead of flattening into unstyled text runs.

## [1.0.6] - 2025-12-06

### Added

- Standalone UMD bundle `dist/dom-to-pptx.bundle.js` which includes runtime dependencies for single-script usage.
- `SUPPORTED.md` listing common supported HTML elements and CSS features.

### Fixed

- Rounded corner math: decreased false-positive circle detection and capped `rectRadius` to avoid pill-shaped elements becoming full circles.
- Partial border-radius clipping: elements inside `overflow:hidden` are now correctly rendered with clipping preserved.
- Very small elements (sub-pixel) rendering: lowered threshold to include tiny decorative elements (e.g., 2x2 dots).
- Backdrop blur support: simulated `backdrop-filter: blur()` using html2canvas snapshotting.
- CORS canvas errors: replaced fragile foreignObject rendering with safer SVG + canvas or html2canvas-based capture where appropriate.

## [1.0.3] - Previous

- Minor fixes and optimizations.
