// ─── Source ──────────────────────────────────────────────────────────────────

export type SourceType =
  | 'characters' | 'locations' | 'objects' | 'groups'
  | 'timeline' | 'threads' | 'continuity' | 'signals' | 'timeIndex' | 'chapters';

// ─── View ────────────────────────────────────────────────────────────────────

export type ViewType =
  | 'metric' | 'list' | 'warning-list' | 'status-list' | 'table' | 'bar-list' | 'timeline'
  | 'sparkline' | 'heatmap' | 'timeline-strip' | 'chapter-density-strip' | 'thread-lifecycle-strip';

// ─── Field config ─────────────────────────────────────────────────────────────

export interface FieldConfig {
  key:            string;
  label?:         string;       // column header / aria label
  format?:        string;       // "{value}" template, e.g. "Ch. {value}"
  fallback?:      string;       // shown when null / undefined / empty; default "—"
  isLink?:        boolean;
  linkType?:      'chapter' | 'entity' | string;
  width?:         string;       // CSS width hint, e.g. "80px"
  align?:         'left' | 'center' | 'right';
  maxLength?:     number;       // truncate cell text to N chars + "…"
  hidden?:        boolean;      // omit from rendered output
  renderer?:      string;       // hint for a custom cell renderer
  className?:     string;       // extra CSS class on the cell/element
  tooltipField?:  string;       // key of another row field to use as tooltip
}

// Field entries may be a plain key string or a full FieldConfig.
export type RawFieldConfig = string | FieldConfig;

// ─── Metric config ────────────────────────────────────────────────────────────

export interface MetricConfig {
  type:   'count' | 'sum' | 'avg' | 'max' | 'min';
  label?: string;
  field?: string;   // required for sum / avg / max / min
}

// ─── Filter ───────────────────────────────────────────────────────────────────

export interface FilterOperator {
  eq?:          unknown;
  ne?:          unknown;
  lt?:          number;
  lte?:         number;
  gt?:          number;
  gte?:         number;
  includes?:    string;       // item string value contains this substring
  includesAny?: string[];     // item array field contains any of these
  includesAll?: string[];     // item array field contains all of these
  in?:          unknown[];    // item value is in this list
  notIn?:       unknown[];
}

// Simple value or advanced operator — both are valid filter field values.
// Simple:   { "status": "open" }
// Advanced: { "status": { "eq": "open" }, "confidence": { "gte": 0.8 } }
export type FilterValue = string | string[] | boolean | number | FilterOperator;

export interface FilterConfig {
  [key: string]: FilterValue;
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

export interface SortConfig {
  field:     string;
  direction: 'asc' | 'desc';
}

// ─── Transform ────────────────────────────────────────────────────────────────

export interface TransformConfig {
  filter?:  FilterConfig;
  filterAny?: FilterConfig[];
  sort?:    SortConfig;
  groupBy?: string;
  limit?:   number;
}

// ─── View config ──────────────────────────────────────────────────────────────

export interface ViewConfig {
  type:               ViewType;

  // Field list — string shorthand and FieldConfig objects are both valid.
  // Use getWidgetFields() from normalize.ts to get a normalized FieldConfig[].
  fields?:            RawFieldConfig[];

  emptyMessage?:      string;

  // Metric widget — explicit aggregation instead of implicit "count by fields[0]"
  metric?:            MetricConfig;

  // Bar-list widget — explicit primary / value instead of positional fields[0]/[1]
  primaryField?:      string;
  valueField?:        string;

  // List / warning-list — optional semantic shortcuts
  itemTitleField?:    string;
  itemSubtitleField?: string;
  severityField?:     string;
  iconField?:         string;

  // Compact SVG view settings.
  xField?:       string;
  yField?:       string;
  labelField?:   string;
  seriesField?:  string;
  maxRows?:      number;
  maxColumns?:   number;
  minValue?:     number;
  maxValue?:     number;
  palette?:      string[];
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export type DashboardLayout = 'vertical' | 'grid' | 'columns' | 'tabs';

export interface WidgetLayoutConfig {
  span?:    number;   // how many grid columns this widget occupies
  height?:  string;   // CSS height override, e.g. "320px" — bare numbers are coerced to px at load time
  compact?: boolean;  // tighter padding variant
}

// ─── Widget & Dashboard ───────────────────────────────────────────────────────

export interface WidgetConfig {
  id:        string;
  title:     string;
  source:    SourceType;
  transform: TransformConfig;
  view:      ViewConfig;
  layout?:   WidgetLayoutConfig;
}

export interface DashboardProfile {
  id:           string;
  title:        string;
  description?: string;
  layout:       DashboardLayout;
  widgets:      string[];
}

export interface DashboardRenderInput {
  profile: DashboardProfile;
  widgets: WidgetConfig[];
  data:    Partial<Record<SourceType, Record<string, unknown>[]>>;
}
