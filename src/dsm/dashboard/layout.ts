import { DashboardLayout } from './types';

export function layoutClass(layout: DashboardLayout): string {
  return `dashboard-layout-${layout}`;
}

export function layoutColumns(layout: DashboardLayout): number {
  switch (layout) {
    case 'vertical': return 2;
    default:         return 1;
  }
}

export function getWidgetSpan(span: number | undefined, columns: number): number | undefined {
  if (typeof span !== 'number' || !Number.isFinite(span)) return undefined;
  const n = Math.floor(span);
  if (n < 1) return undefined;
  return Math.min(n, columns);
}
