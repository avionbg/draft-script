import { TransformConfig, FilterConfig, FilterValue, FilterOperator, SortConfig } from './types';

export function applyTransform(
  data: Record<string, unknown>[],
  config: TransformConfig,
): Record<string, unknown>[] {
  let result = [...data];
  if (config.filter)              result = applyFilter(result, config.filter);
  if (config.filterAny?.length)    result = result.filter(item => config.filterAny!.some(f => matchesAll(item, f)));
  if (config.sort)                result = applySort(result, config.sort);
  if (config.groupBy)             result = applyGroupBy(result, config.groupBy);
  if (config.limit !== undefined) result = result.slice(0, config.limit);
  return result;
}

// ─── Filter ───────────────────────────────────────────────────────────────────

function isOperator(v: FilterValue): v is FilterOperator {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function matchesOperator(itemValue: unknown, op: FilterOperator): boolean {
  if (op.eq      !== undefined && itemValue !== op.eq)                                    return false;
  if (op.ne      !== undefined && itemValue === op.ne)                                    return false;
  if (op.lt      !== undefined && (typeof itemValue !== 'number' || itemValue >= op.lt))  return false;
  if (op.lte     !== undefined && (typeof itemValue !== 'number' || itemValue >  op.lte)) return false;
  if (op.gt      !== undefined && (typeof itemValue !== 'number' || itemValue <= op.gt))  return false;
  if (op.gte     !== undefined && (typeof itemValue !== 'number' || itemValue <  op.gte)) return false;
  if (op.in      !== undefined && !op.in.includes(itemValue))                             return false;
  if (op.notIn   !== undefined &&  op.notIn.includes(itemValue))                          return false;
  if (op.includes !== undefined) {
    if (!String(itemValue).includes(op.includes)) return false;
  }
  if (op.includesAny !== undefined) {
    const arr = Array.isArray(itemValue) ? (itemValue as unknown[]) : [];
    if (!op.includesAny.some(v => arr.includes(v))) return false;
  }
  if (op.includesAll !== undefined) {
    const arr = Array.isArray(itemValue) ? (itemValue as unknown[]) : [];
    if (!op.includesAll.every(v => arr.includes(v))) return false;
  }
  return true;
}

function matchesFilter(item: Record<string, unknown>, key: string, fv: FilterValue): boolean {
  // Derived-field filters.
  if (key === 'lastSeenBeforeChapters') {
    const n     = typeof fv === 'number' ? fv : 0;
    const total = (item['_totalChapters'] as number) ?? 0;
    const last  = (item['lastSeenChapter'] as number) ?? 0;
    return total - last >= n;
  }
  if (key === 'firstSeenAfterChapter') {
    const n     = typeof fv === 'number' ? fv : 0;
    const first = (item['firstSeenChapter'] as number) ?? 0;
    return first > n;
  }

  const itemValue = item[key];

  // Advanced operator object
  if (isOperator(fv)) return matchesOperator(itemValue, fv);

  // String array shorthand — match any if item field is also array; equality if scalar
  if (Array.isArray(fv)) {
    const arr = Array.isArray(itemValue) ? (itemValue as unknown[]) : [itemValue];
    return fv.some(v => arr.includes(v));
  }

  // Scalar equality
  if (typeof fv === 'boolean') return Boolean(itemValue) === fv;
  return itemValue === fv;
}

function applyFilter(
  data: Record<string, unknown>[],
  f: FilterConfig,
): Record<string, unknown>[] {
  return data.filter(item => matchesAll(item, f));
}

function matchesAll(item: Record<string, unknown>, f: FilterConfig): boolean {
  return Object.entries(f).every(([key, fv]) => matchesFilter(item, key, fv as FilterValue));
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

function applySort(data: Record<string, unknown>[], s: SortConfig): Record<string, unknown>[] {
  return [...data].sort((a, b) => {
    const av = a[s.field] ?? '';
    const bv = b[s.field] ?? '';
    const cmp = (typeof av === 'number' && typeof bv === 'number')
      ? av - bv
      : String(av).localeCompare(String(bv), undefined, { numeric: true });
    return s.direction === 'asc' ? cmp : -cmp;
  });
}

// ─── Group-by ─────────────────────────────────────────────────────────────────

function applyGroupBy(data: Record<string, unknown>[], field: string): Record<string, unknown>[] {
  const groups = new Map<unknown, Record<string, unknown>[]>();
  for (const item of data) {
    const key = item[field];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return Array.from(groups.entries()).map(([k, items]) => ({
    _group: k,
    items,
    count:  items.length,
  }));
}
