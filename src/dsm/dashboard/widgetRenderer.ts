import { WidgetConfig, ViewType, ViewConfig, FieldConfig } from './types';
import { getWidgetFields, renderFieldText } from './normalize';
import { getWidgetSpan } from './layout';

// ─── Shared snippets injected by the panel ────────────────────────────────────

export const CELL_LINK_CSS = `
  .cell-link {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--vscode-textLink-foreground, var(--vscode-foreground));
    font: inherit; text-decoration: underline; text-underline-offset: 2px;
    text-decoration-color: transparent; transition: text-decoration-color 0.15s;
  }
  .cell-link:hover { text-decoration-color: currentColor; }
`;

export const CELL_LINK_JS = `
  const vscode = acquireVsCodeApi();
  function navigate(el) {
    vscode.postMessage({ command: 'navigateToChapter', filePath: el.dataset.fp, title: el.dataset.title, referenceText: el.dataset.ref || undefined });
  }
`;

// ─── Renderer registry ────────────────────────────────────────────────────────
// Add a new view type by adding one entry here — nothing else changes.

type Renderer = (data: Record<string, unknown>[], view: ViewConfig) => string;

const RENDERERS: Record<ViewType, Renderer> = {
  'metric':       renderMetric,
  'list':         renderList,
  'warning-list': renderWarningList,
  'status-list':  renderWarningList,
  'table':        renderTable,
  'bar-list':     renderBarList,
  'timeline':     renderTimeline,
  'sparkline':    renderSparkline,
  'heatmap':      renderHeatmap,
  'timeline-strip': renderTimelineStrip,
  'chapter-density-strip': renderChapterDensityStrip,
  'thread-lifecycle-strip': renderThreadLifecycleStrip,
};

// ─── Public entry point ───────────────────────────────────────────────────────

export function renderWidget(cfg: WidgetConfig, data: Record<string, unknown>[], columns = 4): string {
  const renderer = RENDERERS[cfg.view.type];
  const body = renderer
    ? renderer(data, cfg.view)
    : `<em class="dim">Unknown view type: ${esc(cfg.view.type)}</em>`;

  const span         = getWidgetSpan(cfg.layout?.span, columns);
  const spanClass    = span ? ` widget-span-${span}` : '';
  const heightStyle  = cfg.layout?.height  ? ` style="height:${esc(cfg.layout.height)}${typeof cfg.layout.height === 'number' ? 'px' : ''};overflow:auto"` : '';
  const compactClass = cfg.layout?.compact ? ' widget-compact' : '';

  return `<div class="widget widget-type-${esc(cfg.view.type)}${spanClass}${compactClass}" id="${esc(cfg.id)}"${heightStyle}>
  <div class="widget-title">${esc(cfg.title)}</div>
  <div class="widget-body">${body}</div>
</div>`;
}

// ─── Metric ───────────────────────────────────────────────────────────────────

function renderMetric(data: Record<string, unknown>[], view: ViewConfig): string {
  const mc = view.metric;

  // No metric config or explicit count → just show row count
  if (!mc || mc.type === 'count') {
    const label = mc?.label ? `<span class="metric-label">${esc(mc.label)}</span>` : '';
    return `<div class="metric">${data.length}${label}</div>`;
  }

  const field = mc.field ?? '';
  const nums  = data.map(d => Number(d[field])).filter(n => !isNaN(n));
  let value: number;
  switch (mc.type) {
    case 'sum': value = nums.reduce((a, b) => a + b, 0); break;
    case 'avg': value = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; break;
    case 'max': value = nums.length ? Math.max(...nums) : 0; break;
    case 'min': value = nums.length ? Math.min(...nums) : 0; break;
    default:    value = data.length;
  }

  const label = mc.label ? `<span class="metric-label">${esc(mc.label)}</span>` : '';
  return `<div class="metric">${formatNum(value)}${label}</div>`;
}

// ─── List ─────────────────────────────────────────────────────────────────────

function renderList(data: Record<string, unknown>[], view: ViewConfig): string {
  if (!data.length) return emptyMsg(view);
  const fields = visibleFields(view);
  return data.map(item => {
    const titleField    = view.itemTitleField    ? { key: view.itemTitleField }    : fields[0];
    const subtitleField = view.itemSubtitleField ? { key: view.itemSubtitleField } : fields[1];
    const title    = titleField    ? renderFieldText(item, titleField)    : '';
    const subtitle = subtitleField ? renderFieldText(item, subtitleField) : '';
    return `<div class="list-row">
  <span class="list-title">${esc(title)}</span>${subtitle ? `<span class="list-sub dim">${esc(subtitle)}</span>` : ''}
</div>`;
  }).join('');
}

// ─── Warning list ─────────────────────────────────────────────────────────────

function renderWarningList(data: Record<string, unknown>[], view: ViewConfig): string {
  if (!data.length) {
    return `<div class="ok">&#10003;&nbsp;${esc(view.emptyMessage ?? 'None')}</div>`;
  }
  const fields = visibleFields(view);
  const primary = fields[0];
  const metas   = fields.slice(1);

  return data.map(item => {
    const label   = primary ? renderFieldText(item, primary) : '';
    const tooltip = primary?.tooltipField ? String(item[primary.tooltipField] ?? label) : label;
    const meta    = metas.map(f => renderFieldText(item, f)).filter(v => v !== '—').join('&nbsp;&nbsp;');
    const severity = rowSeverity(item, view);
    const icon     = rowIcon(item, view, severity);
    return `<div class="warning-row">
  <span class="warn-icon warn-${esc(severity)}">${icon}</span>
  <span class="warn-label" title="${esc(tooltip)}">${esc(label)}</span>
  ${meta ? `<span class="warn-meta dim">${meta}</span>` : ''}
</div>`;
  }).join('');
}

// ─── Table ────────────────────────────────────────────────────────────────────

function rowSeverity(item: Record<string, unknown>, view: ViewConfig): string {
  const raw = view.severityField ? String(item[view.severityField] ?? '') : '';
  const status = raw || String(item['suggestedStatus'] ?? item['status'] ?? '');
  if (['error', 'critical'].includes(status)) return 'error';
  if (['resolved', 'success'].includes(status)) return 'success';
  if (['changed', 'active', 'info'].includes(status)) return 'info';
  if (['uncertain', 'dormant', 'warning'].includes(status)) return 'warning';
  return 'warning';
}

function rowIcon(item: Record<string, unknown>, view: ViewConfig, severity: string): string {
  const raw = view.iconField ? String(item[view.iconField] ?? '') : '';
  if (raw) return esc(raw);
  switch (severity) {
    case 'success': return '&#10003;';
    case 'info':    return '&#9432;';
    case 'error':   return '&#10007;';
    default:        return '&#9888;';
  }
}

function renderTable(data: Record<string, unknown>[], view: ViewConfig): string {
  if (!data.length) return emptyMsg(view);
  const fields = visibleFields(view);
  const header  = fields.map(f =>
    `<th${f.align ? ` style="text-align:${f.align}"` : ''}${f.width ? ` style="width:${f.width}"` : ''}>${esc(f.label ?? f.key)}</th>`
  ).join('');

  const rows = data.map(item => {
    const cells = fields.map(f => {
      const text    = renderFieldText(item, f);
      const classes = f.className ? ` class="${esc(f.className)}"` : '';
      const align   = f.align     ? ` style="text-align:${f.align}"` : '';
      if (f.isLink) {
        const fp  = String(item[`_${f.key}_fp`]    ?? '');
        const ttl = String(item[`_${f.key}_title`] ?? '');
        const ref = String(item[`_${f.key}_ref`]   ?? '');
        if (fp) {
          const dataRef = ref ? ` data-ref="${esc(ref)}"` : '';
          return `<td${classes}${align}><button class="cell-link" onclick="navigate(this)" data-fp="${esc(fp)}" data-title="${esc(ttl)}"${dataRef} title="${esc(ttl || text)}">${esc(text)}</button></td>`;
        }
      }
      return `<td title="${esc(text)}"${classes}${align}>${esc(text)}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  return `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
}

// ─── Bar list ─────────────────────────────────────────────────────────────────

function renderBarList(data: Record<string, unknown>[], view: ViewConfig): string {
  if (!data.length) return emptyMsg(view);
  const fields     = getWidgetFields(view);
  const primaryKey = view.primaryField ?? fields[0]?.key ?? 'name';
  const valueKey   = view.valueField   ?? fields[1]?.key ?? 'count';

  const primaryFc: FieldConfig = { key: primaryKey, ...(fields.find(f => f.key === primaryKey) ?? {}) };
  const max = Math.max(...data.map(d => Number(d[valueKey]) || 0), 1);

  return data.map(item => {
    const label = renderFieldText(item, primaryFc);
    const count = Number(item[valueKey]) || 0;
    const pct   = Math.round((count / max) * 100);
    return `<div class="bar-row">
  <span class="bar-label" title="${esc(label)}">${esc(label)}</span>
  <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
  <span class="bar-count dim">${count}</span>
</div>`;
  }).join('');
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

function renderTimeline(data: Record<string, unknown>[], view: ViewConfig): string {
  if (!data.length) return emptyMsg(view);
  const fields    = getWidgetFields(view);
  const chField   = fields[0] ?? { key: 'chapterNumber' };
  const titleFld  = fields[1] ?? { key: 'title' };
  const descFld   = fields[2];

  return data.map(item => {
    const rawCh = renderFieldText(item, chField);
    // Add "Ch." prefix when no explicit format is set.
    const ch      = chField.format ? rawCh : `Ch.${rawCh}`;
    const summary = renderFieldText(item, titleFld);
    const desc    = descFld ? renderFieldText(item, descFld) : '';
    return `<div class="timeline-row">
  <span class="tl-chapter">${esc(ch)}</span>
  <div class="tl-content">
    <span class="tl-summary" title="${esc(summary)}">${esc(summary)}</span>
    ${desc && desc !== '—' ? `<span class="tl-desc dim">${esc(desc)}</span>` : ''}
  </div>
</div>`;
  }).join('');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function renderSparkline(data: Record<string, unknown>[], view: ViewConfig): string {
  const points = aggregatePoints(data, view.xField ?? 'chapterNumber', view.yField ?? view.valueField ?? 'count');
  if (!points.length) return emptyMsg(view);
  const width = 280, height = 54, pad = 4;
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = view.minValue ?? Math.min(0, ...ys);
  const maxY = view.maxValue ?? Math.max(...ys, 1);
  const line = points.sort((a, b) => a.x - b.x).map(p => {
    const x = scale(p.x, minX, maxX, pad, width - pad);
    const y = scale(p.y, minY, maxY, height - pad, pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const last = points[points.length - 1];
  return `<div class="svg-widget sparkline-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="sparkline"><polyline class="sparkline-line" points="${line}" /></svg><div class="svg-caption dim">max ${formatNum(maxY)} · last ${formatNum(last.y)}</div></div>`;
}

function renderTimelineStrip(data: Record<string, unknown>[], view: ViewConfig): string {
  const points = aggregatePoints(data, view.xField ?? 'chapterNumber', view.valueField ?? 'count');
  if (!points.length) return emptyMsg(view);
  const width = 280, height = 34, pad = 4;
  const minX = Math.min(...points.map(p => p.x));
  const maxX = Math.max(...points.map(p => p.x));
  const maxY = Math.max(...points.map(p => p.y), 1);
  const bars = points.sort((a, b) => a.x - b.x).map(p => {
    const x = scale(p.x, minX, maxX, pad, width - pad);
    const h = scale(p.y, 0, maxY, 3, height - 8);
    return `<rect class="strip-bar" x="${(x - 1.5).toFixed(1)}" y="${(height - h).toFixed(1)}" width="3" height="${h.toFixed(1)}"><title>Ch.${p.x}: ${p.y}</title></rect>`;
  }).join('');
  return `<div class="svg-widget"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="timeline strip">${bars}</svg></div>`;
}

function renderChapterDensityStrip(data: Record<string, unknown>[], view: ViewConfig): string {
  if (!data.length) return emptyMsg(view);
  const fields = ['threadCount', 'continuityCount', 'timelineCount', 'signalCount'];
  const colors = view.palette ?? ['#4ea6ff', '#89d185', '#cca700', '#d186d1'];
  const rows = data.filter(row => Number(row['chapterNumber']) > 0).sort((a, b) => Number(a['chapterNumber']) - Number(b['chapterNumber']));
  const width = 280;
  const cell = Math.max(2, Math.floor(width / Math.max(rows.length, 1)));
  const max = Math.max(...rows.flatMap(r => fields.map(f => Number(r[f]) || 0)), 1);
  const cells = rows.map((row, col) => {
    const ch = Number(row['chapterNumber']);
    return fields.map((field, r) => {
      const value = Number(row[field]) || 0;
      const opacity = value ? 0.2 + 0.8 * (value / max) : 0.08;
      return `<rect x="${col * cell}" y="${r * 9}" width="${Math.max(cell - 1, 1)}" height="8" fill="${esc(colors[r] ?? colors[0])}" opacity="${opacity.toFixed(2)}"><title>Ch.${ch} ${field}: ${value}</title></rect>`;
    }).join('');
  }).join('');
  return `<div class="svg-widget density-strip"><svg viewBox="0 0 ${width} ${fields.length * 9}" role="img" aria-label="chapter density strip">${cells}</svg><div class="svg-legend dim">threads · continuity · timeline · signals</div></div>`;
}

function renderThreadLifecycleStrip(data: Record<string, unknown>[], view: ViewConfig): string {
  const colors: Record<string, string> = {
    new: '#4ea6ff',
    progressed: '#89d185',
    reinforced: '#cca700',
    changed: '#d186d1',
    resolved: '#6ccf8d',
    reopened: '#f48771',
    partially_resolved: '#c586c0',
  };
  const rows = expandThreadLifecyclePoints(data);
  if (!rows.length) return emptyMsg(view);
  const byChapter = new Map<number, Map<string, number>>();
  for (const row of rows) {
    if (!byChapter.has(row.x)) byChapter.set(row.x, new Map());
    const kind = row.label || 'progressed';
    const map = byChapter.get(row.x)!;
    map.set(kind, (map.get(kind) ?? 0) + 1);
  }
  const chapters = [...byChapter.keys()].sort((a, b) => a - b);
  const kinds = Object.keys(colors);
  const width = 280;
  const cell = Math.max(2, Math.floor(width / Math.max(chapters.length, 1)));
  const max = Math.max(...[...byChapter.values()].flatMap(m => [...m.values()]), 1);
  const cells = chapters.map((ch, col) => {
    const map = byChapter.get(ch)!;
    return kinds.map((kind, r) => {
      const value = map.get(kind) ?? 0;
      const opacity = value ? 0.2 + 0.8 * (value / max) : 0.04;
      return `<rect x="${col * cell}" y="${r * 7}" width="${Math.max(cell - 1, 1)}" height="6" fill="${colors[kind]}" opacity="${opacity.toFixed(2)}"><title>Ch.${ch} ${kind}: ${value}</title></rect>`;
    }).join('');
  }).join('');
  return `<div class="svg-widget lifecycle-strip"><svg viewBox="0 0 ${width} ${kinds.length * 7}" role="img" aria-label="thread lifecycle strip">${cells}</svg><div class="svg-legend dim">new · progressed · reinforced · changed · resolved</div></div>`;
}

function renderHeatmap(data: Record<string, unknown>[], view: ViewConfig): string {
  const points = expandHeatmapPoints(data, view.xField ?? 'chapterNumber', view.yField ?? 'id', view.valueField ?? 'count', view.labelField ?? view.yField ?? 'id');
  if (!points.length) return emptyMsg(view);
  const maxRows = view.maxRows ?? 14;
  const topRows = [...new Map(points.map(p => [p.y, p.yLabel])).entries()]
    .map(([id, label]) => ({ id, label, total: points.filter(p => p.y === id).reduce((sum, p) => sum + p.value, 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, maxRows);
  const rowIds = new Set(topRows.map(r => r.id));
  const filtered = points.filter(p => rowIds.has(p.y));
  const xs = [...new Set(filtered.map(p => p.x))].sort((a, b) => a - b);
  const shownXs = xs.slice(Math.max(0, xs.length - (view.maxColumns ?? 80)));
  const xSet = new Set(shownXs);
  const cellW = 5, cellH = 8, labelW = 86;
  const width = labelW + shownXs.length * cellW;
  const height = topRows.length * cellH;
  const max = view.maxValue ?? Math.max(...filtered.map(p => p.value), 1);
  const lookup = new Map(filtered.filter(p => xSet.has(p.x)).map(p => [`${p.y}:${p.x}`, p.value]));
  const labels = topRows.map((r, i) => `<text class="heatmap-label" x="0" y="${i * cellH + 6}">${esc(truncate(r.label, 18))}</text>`).join('');
  const cells = topRows.map((r, row) => shownXs.map((x, col) => {
    const value = lookup.get(`${r.id}:${x}`) ?? 0;
    const opacity = value ? 0.18 + 0.82 * (value / max) : 0.05;
    return `<rect class="heatmap-cell" x="${labelW + col * cellW}" y="${row * cellH}" width="4" height="7" opacity="${opacity.toFixed(2)}"><title>${esc(r.label)} Ch.${x}: ${value}</title></rect>`;
  }).join('')).join('');
  return `<div class="svg-widget heatmap-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="heatmap">${labels}${cells}</svg></div>`;
}

interface Point { x: number; y: number; label?: string; }
interface HeatPoint { x: number; y: string; yLabel: string; value: number; }

function aggregatePoints(data: Record<string, unknown>[], xField: string, yField: string): Point[] {
  const expanded = expandNestedPoints(data, xField, yField);
  const map = new Map<number, number>();
  for (const p of expanded) map.set(p.x, (map.get(p.x) ?? 0) + p.y);
  return [...map.entries()].map(([x, y]) => ({ x, y })).sort((a, b) => a.x - b.x);
}

function expandNestedPoints(data: Record<string, unknown>[], xField: string, yField: string): Point[] {
  const out: Point[] = [];
  for (const row of data) {
    const directX = toNumber(row[xField]);
    if (directX !== undefined) {
      out.push({ x: directX, y: toNumber(row[yField]) ?? 1, label: String(row[yField] ?? '') });
      continue;
    }
    for (const key of ['appearances', 'mentions', 'entries', 'history']) {
      const nested = row[key];
      if (!Array.isArray(nested)) continue;
      for (const item of nested as Record<string, unknown>[]) {
        const x = toNumber(item[xField]) ?? toNumber(item['chapter']) ?? toNumber(item['chapterNumber']);
        if (x === undefined) continue;
        out.push({ x, y: toNumber(item[yField]) ?? 1, label: String(item[yField] ?? row[yField] ?? '') });
      }
    }
  }
  return out;
}

function expandHeatmapPoints(data: Record<string, unknown>[], xField: string, yField: string, valueField: string, labelField: string): HeatPoint[] {
  const out: HeatPoint[] = [];
  for (const row of data) {
    const y = String(row[yField] ?? row['id'] ?? row['title'] ?? row['name'] ?? '');
    const yLabel = String(row[labelField] ?? row['title'] ?? row['name'] ?? y);
    const directX = toNumber(row[xField]);
    if (directX !== undefined) {
      out.push({ x: directX, y, yLabel, value: toNumber(row[valueField]) ?? 1 });
      continue;
    }
    for (const key of ['appearances', 'mentions', 'entries', 'history']) {
      const nested = row[key];
      if (!Array.isArray(nested)) continue;
      for (const item of nested as Record<string, unknown>[]) {
        const x = toNumber(item[xField]) ?? toNumber(item['chapter']) ?? toNumber(item['chapterNumber']);
        if (x === undefined) continue;
        out.push({ x, y, yLabel, value: toNumber(item[valueField]) ?? 1 });
      }
    }
  }
  return out;
}

function expandThreadLifecyclePoints(data: Record<string, unknown>[]): Point[] {
  const out: Point[] = [];
  for (const row of data) {
    const history = row['history'];
    if (Array.isArray(history) && history.length) {
      for (const item of history as Record<string, unknown>[]) {
        const x = toNumber(item['chapter']) ?? toNumber(item['chapterNumber']);
        if (x === undefined) continue;
        out.push({ x, y: 1, label: String(item['updateType'] ?? row['lastUpdateType'] ?? 'progressed') });
      }
      continue;
    }
    const appearances = row['appearances'];
    if (Array.isArray(appearances)) {
      for (const item of appearances as Record<string, unknown>[]) {
        const x = toNumber(item['chapterNumber']);
        if (x === undefined) continue;
        out.push({ x, y: 1, label: String(row['lastUpdateType'] ?? 'progressed') });
      }
    }
  }
  return out;
}

function scale(value: number, min: number, max: number, outMin: number, outMax: number): number {
  if (max <= min) return (outMin + outMax) / 2;
  return outMin + ((value - min) / (max - min)) * (outMax - outMin);
}

function toNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

function visibleFields(view: ViewConfig): FieldConfig[] {
  return getWidgetFields(view).filter(f => !f.hidden);
}

function emptyMsg(view: ViewConfig): string {
  return `<em class="dim">${esc(view.emptyMessage ?? 'none')}</em>`;
}

function formatNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function esc(s: string | number): string {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;');
}
