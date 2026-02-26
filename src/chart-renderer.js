// src/chart-renderer.js
import { parseColor, FONT_SCALE_FACTOR } from './utils.js';

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

  const TYPE_MAP = {
    bar: pptx.charts.BAR,
    line: pptx.charts.LINE,
    pie: pptx.charts.PIE,
    doughnut: pptx.charts.DOUGHNUT,
    radar: pptx.charts.RADAR,
    scatter: pptx.charts.SCATTER,
  };
  const chartType = TYPE_MAP[type];
  if (!chartType) return null;

  const datasets = config.data?.datasets || [];
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
    ...(colors.length > 0 && { chartColors: colors }),
    valGridLine: valScale.grid?.display === false ? { style: 'none' } : undefined,
    catGridLine: catScale.grid?.display === false ? { style: 'none' } : undefined,
    ...(catFont.family && { catAxisLabelFontFace: catFont.family }),
    ...(catFont.size && { catAxisLabelFontSize: catFont.size * FONT_SCALE_FACTOR }),
    ...(catColor && { catAxisLabelColor: catColor }),
    ...(valFont.family && { valAxisLabelFontFace: valFont.family }),
    ...(valFont.size && { valAxisLabelFontSize: valFont.size * FONT_SCALE_FACTOR }),
    ...(valColor && { valAxisLabelColor: valColor }),
    ...(valScale.min !== undefined && { valAxisMinVal: valScale.min }),
    ...(valScale.max !== undefined && { valAxisMaxVal: valScale.max }),
    // beginAtZero may be on either scale axis depending on how the Chart.js config is authored
    // ...((valScale.beginAtZero || catScale.beginAtZero) && { valAxisMinVal: 0 }),
    showLegend: plugins.legend?.display !== false,
    showValue: plugins.datalabels?.display === true,
    chartArea: { fill: { color: 'FFFFFF' } },
    plotArea: { fill: { color: 'FFFFFF' } },
  };

  return { type: 'chart', zIndex, domOrder, chartType, chartData, options: chartOptions };
}
