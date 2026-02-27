// src/chart-renderer.js
import { parseColor, FONT_SCALE_FACTOR } from './utils.js';

/**
 * Converts a serialised Chart.js datalabels formatter string to an OOXML number format code.
 * Handles the common patterns:  value.toFixed(n)  and  + "%" / + '%'  suffix.
 * Returns null when the pattern is not recognised (caller keeps the default).
 */
function formatterToFormatCode(formatter) {
  if (!formatter || typeof formatter !== 'string') return null;
  const toFixedMatch = formatter.match(/\.toFixed\((\d+)\)/);
  const decimals = toFixedMatch ? parseInt(toFixedMatch[1], 10) : null;
  const hasPct = /\+\s*['"`]%['"`]/.test(formatter);
  if (decimals === null && !hasPct) return null;
  const numPart = decimals === null ? '#,##0' : (decimals === 0 ? '0' : '0.' + '0'.repeat(decimals));
  // OOXML literal suffix: enclose in double-quotes inside the format string
  return numPart + (hasPct ? '"%"' : '');
}

/**
 * Maps a Chart.js config object to a PptxGenJS native chart render item.
 * Returns null if the chart type is unsupported (caller should fall back to image).
 *
 * Gotchas:
 *  - Font size: Chart.js px * FONT_SCALE_FACTOR -> pt
 *  - Horizontal bars: PptxGenJS renders first item at bottom, Chart.js at top -> reverse
 *  - beginAtZero: may be on either scale axis in Chart.js configs
 *  - indexAxis:"y" -> swap valScale/catScale assignments
 */
export function buildChartItem(config, pptx, zIndex, domOrder, x, y, w, h) {
  const type = config.type;
  const isHorizontal = config.options?.indexAxis === 'y';

  // A Chart.js line chart with fill on any dataset is an area chart in PPTX terms.
  const datasets = config.data?.datasets || [];
  const isAreaLine =
    type === 'line' &&
    datasets.some((ds) => ds.fill !== undefined && ds.fill !== false && ds.fill !== null);

  const TYPE_MAP = {
    bar: pptx.charts.BAR,
    line: isAreaLine ? pptx.charts.AREA : pptx.charts.LINE,
    pie: pptx.charts.PIE,
    doughnut: pptx.charts.DOUGHNUT,
    radar: pptx.charts.RADAR,
    scatter: pptx.charts.SCATTER,
  };
  const chartType = TYPE_MAP[type];
  if (!chartType) return null;

  const labels = config.data?.labels || [];

  const isPielike = type === 'pie' || type === 'doughnut';

  // PptxGenJS horizontal bars render first item at the bottom; Chart.js renders it at the top.
  const rawLabels = labels.map((l) => String(l).replace(/&amp;/g, '&'));
  let normalizedLabels = isHorizontal ? [...rawLabels].reverse() : rawLabels;

  // For pie/doughnut with no labels: PptxGenJS uses labels.length to determine how many
  // per-slice <c:dPt> color elements to emit. With labels=[] it emits 0 dPt elements and
  // falls back to the theme accent color (blue). Synthesize placeholder labels so the slice
  // count is correct and chartColors are applied.
  if (isPielike && normalizedLabels.length === 0 && datasets[0]?.data?.length > 0) {
    normalizedLabels = datasets[0].data.map((_, i) => String(i));
  }

  const chartData = datasets.map((ds) => ({
    name: ds.label || '',
    labels: normalizedLabels,
    values: isHorizontal ? [...(ds.data || [])].reverse() : (ds.data || []),
  }));

  // Fast-path hex conversion; canvas round-trip only for rgb/named colors
  const toHex = (color) => {
    if (!color) return null;
    if (/^#[0-9a-fA-F]{6}$/.test(color)) return color.slice(1).toUpperCase();
    if (/^#[0-9a-fA-F]{3}$/.test(color))
      return color.slice(1).split('').map((c) => c + c).join('').toUpperCase();
    return parseColor(color).hex;
  };

  // Pie/doughnut: backgroundColor is per-slice (array); bar/line: per-dataset (scalar or first).
  const colors = isPielike
    ? (datasets[0]?.backgroundColor
        ? (Array.isArray(datasets[0].backgroundColor)
            ? datasets[0].backgroundColor.map(toHex)
            : [toHex(datasets[0].backgroundColor)])
        : [])
      .filter(Boolean)
    : datasets
        .map((ds) => {
          const bg = Array.isArray(ds.backgroundColor) ? ds.backgroundColor[0] : ds.backgroundColor;
          return toHex(bg);
        })
        .filter(Boolean);

  const opts = config.options || {};
  const scales = opts.scales || {};
  const valScale = isHorizontal ? (scales.x || {}) : (scales.y || {});
  const catScale = isHorizontal ? (scales.y || {}) : (scales.x || {});
  const plugins = opts.plugins || {};

  const catFont = catScale.ticks?.font || {};
  const valFont = valScale.ticks?.font || {};
  const catColor = toHex(catScale.ticks?.color);
  const valColor = toHex(valScale.ticks?.color);
  const chartOptions = {
    x, y, w, h,
    ...(type === 'bar' && { barDir: isHorizontal ? 'bar' : 'col' }),
    ...(isAreaLine && valScale.stacked && { barGrouping: 'stacked' }),
    // barGapWidthPct: derived from Chart.js categoryPercentage / barPercentage.
    // Check both dataset-level and options.datasets.bar level; dataset takes precedence.
    ...(type === 'bar' && (() => {
      const dsBar = opts.datasets?.bar || {};
      const ds0 = datasets[0] || {};
      const catPct = ds0.categoryPercentage ?? dsBar.categoryPercentage;
      const barPct = ds0.barPercentage ?? dsBar.barPercentage;
      if (catPct === undefined && barPct === undefined) return {};
      const fill = (barPct ?? 1.0) * (catPct ?? 0.8);
      return { barGapWidthPct: Math.round((1 - fill) / fill * 100) };
    })()),
    ...(colors.length > 0 && { chartColors: colors }),
    // scale.display:false hides the whole axis (labels + grid); grid.display:false hides only gridlines
    ...(valScale.display === false && { valAxisHidden: true }),
    ...(catScale.display === false && { catAxisHidden: true }),
    valGridLine: (valScale.display === false || valScale.grid?.display === false)
      ? { style: 'none' }
      : valScale.grid?.color || valScale.grid?.lineWidth
        ? {
            color: toHex(valScale.grid.color) || '888888',
            size: valScale.grid.lineWidth ? Math.max(0.25, valScale.grid.lineWidth * 0.75) : 1,
          }
        : undefined,
    catGridLine: (catScale.display === false || catScale.grid?.display === false) ? { style: 'none' } : undefined,
    ...(catFont.family && { catAxisLabelFontFace: catFont.family }),
    ...(catFont.size && { catAxisLabelFontSize: catFont.size * FONT_SCALE_FACTOR }),
    ...(catColor && { catAxisLabelColor: catColor }),
    ...(valFont.family && { valAxisLabelFontFace: valFont.family }),
    ...(valFont.size && { valAxisLabelFontSize: valFont.size * FONT_SCALE_FACTOR }),
    ...(valColor && { valAxisLabelColor: valColor }),
    // beginAtZero on either axis sets the floor to 0 when no explicit min is provided
    ...(() => {
      const minVal = valScale.min !== undefined
        ? valScale.min
        : (valScale.beginAtZero || catScale.beginAtZero) ? 0 : undefined;
      return minVal !== undefined ? { valAxisMinVal: minVal } : {};
    })(),
    ...(valScale.max !== undefined && { valAxisMaxVal: valScale.max }),
    showLegend: plugins.legend?.display !== false,
    showValue: plugins.datalabels?.display === true,
    // datalabels text formatting: color, font, and number format from formatter string
    ...(plugins.datalabels?.display === true && (() => {
      const dl = plugins.datalabels;
      const result = {};
      const dlColor = toHex(dl.color);
      if (dlColor) result.dataLabelColor = dlColor;
      if (dl.font?.size) result.dataLabelFontSize = Math.round(dl.font.size * FONT_SCALE_FACTOR);
      if (dl.font?.weight === 'bold') result.dataLabelFontBold = true;
      if (dl.font?.family) result.dataLabelFontFace = dl.font.family;
      const fmtCode = formatterToFormatCode(
        typeof dl.formatter === 'string' ? dl.formatter : null
      );
      if (fmtCode) result.dataLabelFormatCode = fmtCode;
      return result;
    })()),
    chartArea: { fill: { color: 'FFFFFF' } },
    plotArea: { fill: { color: 'FFFFFF' } },
  };

  // PptxGenJS only emits crossBetween="midCat" (no gap at axis edge) for SCATTER or combo
  // charts that include AREA. When Chart.js sets x.offset=false we want midCat, so wrap
  // the area chart in the combo-array API to trigger that code path.
  const useComboFormat = isAreaLine && catScale.offset === false;

  return { type: 'chart', zIndex, domOrder, chartType, chartData, options: chartOptions, useComboFormat };
}
