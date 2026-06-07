import { SourceType, WidgetConfig } from './types';
import { loadSource } from './sourceAdapters';

export function loadDashboardData(rootPath: string, widgets: WidgetConfig[]): Partial<Record<SourceType, Record<string, unknown>[]>> {
  const data: Partial<Record<SourceType, Record<string, unknown>[]>> = {};
  for (const source of new Set(widgets.map(w => w.source))) {
    data[source] = loadSource(rootPath, source);
  }
  return data;
}
