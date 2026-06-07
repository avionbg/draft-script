import {
  DashboardLayout,
  DashboardProfile,
  FieldConfig,
  FilterConfig,
  MetricConfig,
  RawFieldConfig,
  SortConfig,
  SourceType,
  TransformConfig,
  ViewConfig,
  ViewType,
  WidgetConfig,
  WidgetLayoutConfig,
} from './types';

export function normalizeFieldConfig(raw: RawFieldConfig): FieldConfig {
  return typeof raw === 'string' ? { key: raw } : raw;
}

export function getWidgetFields(view: ViewConfig): FieldConfig[] {
  return (view.fields ?? []).map(normalizeFieldConfig);
}

export function getFieldValue(row: Record<string, unknown>, field: FieldConfig): unknown {
  return row[field.key] ?? null;
}

export function formatFieldValue(value: unknown, field: FieldConfig): string {
  if (value === null || value === undefined || value === '') {
    return field.fallback ?? '-';
  }
  let text = field.format
    ? field.format.replace('{value}', String(value))
    : String(value);

  if (field.maxLength && text.length > field.maxLength) {
    text = `${text.slice(0, field.maxLength)}...`;
  }
  return text;
}

export function renderFieldText(row: Record<string, unknown>, field: FieldConfig): string {
  return formatFieldValue(getFieldValue(row, field), field);
}

export function normalizeViewConfig(raw: unknown): ViewConfig {
  if (typeof raw !== 'object' || raw === null) return { type: 'list' };
  const obj = raw as Record<string, unknown>;
  const view: ViewConfig = {
    type: (typeof obj['type'] === 'string' ? obj['type'] : 'list') as ViewType,
  };
  if (Array.isArray(obj['fields'])) view.fields = obj['fields'] as RawFieldConfig[];
  if (obj['emptyMessage']) view.emptyMessage = String(obj['emptyMessage']);
  if (obj['metric']) view.metric = obj['metric'] as MetricConfig;
  if (obj['primaryField']) view.primaryField = String(obj['primaryField']);
  if (obj['valueField']) view.valueField = String(obj['valueField']);
  if (obj['itemTitleField']) view.itemTitleField = String(obj['itemTitleField']);
  if (obj['itemSubtitleField']) view.itemSubtitleField = String(obj['itemSubtitleField']);
  if (obj['severityField']) view.severityField = String(obj['severityField']);
  if (obj['iconField']) view.iconField = String(obj['iconField']);
  if (obj['xField']) view.xField = String(obj['xField']);
  if (obj['yField']) view.yField = String(obj['yField']);
  if (obj['valueField']) view.valueField = String(obj['valueField']);
  if (obj['labelField']) view.labelField = String(obj['labelField']);
  if (obj['seriesField']) view.seriesField = String(obj['seriesField']);
  if (typeof obj['maxRows'] === 'number') view.maxRows = obj['maxRows'];
  if (typeof obj['maxColumns'] === 'number') view.maxColumns = obj['maxColumns'];
  if (typeof obj['minValue'] === 'number') view.minValue = obj['minValue'];
  if (typeof obj['maxValue'] === 'number') view.maxValue = obj['maxValue'];
  if (Array.isArray(obj['palette'])) view.palette = obj['palette'].map(String);
  return view;
}

function normalizeTransformConfig(raw: unknown): TransformConfig {
  if (typeof raw !== 'object' || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  const cfg: TransformConfig = {};
  if (obj['filter'] && typeof obj['filter'] === 'object') cfg.filter = obj['filter'] as FilterConfig;
  if (Array.isArray(obj['filterAny'])) {
    cfg.filterAny = obj['filterAny'].filter(f => typeof f === 'object' && f !== null) as FilterConfig[];
  }
  if (obj['sort'] && typeof obj['sort'] === 'object') cfg.sort = obj['sort'] as SortConfig;
  if (typeof obj['groupBy'] === 'string') cfg.groupBy = obj['groupBy'];
  if (typeof obj['limit'] === 'number') cfg.limit = obj['limit'];
  return cfg;
}

function normalizeLayoutConfig(raw: unknown): WidgetLayoutConfig {
  if (typeof raw !== 'object' || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  const cfg: WidgetLayoutConfig = {};
  if (typeof obj['span'] === 'number') cfg.span = obj['span'];
  if (typeof obj['compact'] === 'boolean') cfg.compact = obj['compact'];
  const h = obj['height'];
  if (typeof h === 'number') cfg.height = `${h}px`;
  else if (typeof h === 'string' && h) cfg.height = h;
  return cfg;
}

export function normalizeWidgetConfig(raw: unknown): WidgetConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid widget config');
  const obj = raw as Record<string, unknown>;
  const id = String(obj['id'] ?? '').trim();
  const title = String(obj['title'] ?? '').trim();
  if (!id) throw new Error('Widget is missing id');
  if (!title) throw new Error(`Widget "${id}" is missing title`);
  return {
    id,
    title,
    source:    (obj['source'] ?? 'characters') as SourceType,
    transform: normalizeTransformConfig(obj['transform']),
    view:      normalizeViewConfig(obj['view']),
    layout:    obj['layout'] ? normalizeLayoutConfig(obj['layout']) : undefined,
  };
}

export function normalizeDashboardProfile(raw: unknown): DashboardProfile {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid dashboard profile');
  const obj = raw as Record<string, unknown>;
  const id = String(obj['id'] ?? '').trim();
  const title = String(obj['title'] ?? '').trim();
  const widgets = Array.isArray(obj['widgets'])
    ? obj['widgets'].map(String).map(s => s.trim()).filter(Boolean)
    : [];
  if (!id) throw new Error('Dashboard profile is missing id');
  if (!title) throw new Error(`Dashboard profile "${id}" is missing title`);
  if (!widgets.length) throw new Error(`Dashboard profile "${id}" has no widgets`);
  return {
    id,
    title,
    description: typeof obj['description'] === 'string' ? obj['description'] : undefined,
    layout: normalizeDashboardLayout(obj['layout']),
    widgets,
  };
}

function normalizeDashboardLayout(raw: unknown): DashboardLayout {
  if (raw === undefined || raw === null || raw === '') return 'vertical';
  if (raw === 'vertical' || raw === 'grid' || raw === 'columns' || raw === 'tabs') return raw;
  throw new Error(`Unsupported dashboard layout "${String(raw)}"`);
}
