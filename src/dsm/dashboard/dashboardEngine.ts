import { DashboardRenderInput, WidgetConfig } from './types';
import { applyTransform } from './transform';
import { renderWidget } from './widgetRenderer';
import { layoutColumns } from './layout';

export function renderDashboard(input: DashboardRenderInput): string {
  const columns = layoutColumns(input.profile.layout);
  return input.widgets
    .map(w => renderWidgetFull(w, input, columns))
    .join('\n');
}

function renderWidgetFull(cfg: WidgetConfig, input: DashboardRenderInput, columns: number): string {
  try {
    const raw = input.data[cfg.source] ?? [];
    const data = applyTransform(raw, cfg.transform);
    return renderWidget(cfg, data, columns);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `<div class="widget widget-error" id="${esc(cfg.id)}"><div class="widget-title">${esc(cfg.title)}</div><div class="widget-body"><em class="dim">Error: ${esc(msg)}</em></div></div>`;
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
