import * as fs from 'fs';
import * as path from 'path';
import { DashboardProfile, WidgetConfig } from './types';
import { normalizeDashboardProfile } from './normalize';
import { getWidgetMap } from './widgetRegistry';

export const DASHBOARD_DIR = '.draft-script';
export const DASHBOARD_PROFILES_DIR = path.join(DASHBOARD_DIR, 'dashboards');

const DEFAULT_PROFILES: DashboardProfile[] = [
  {
    id: 'sidebar',
    title: 'Sidebar',
    layout: 'vertical',
    widgets: ['threads_review', 'suggested_resolved', 'chapter_density_strip', 'signal_heatmap', 'dormant_threads', 'active_threads', 'metric_characters', 'metric_timeline'],
  },
  {
    id: 'threads',
    title: 'Threads',
    layout: 'vertical',
    widgets: ['metric_threads', 'thread_lifecycle_strip', 'thread_presence_heatmap', 'signal_heatmap', 'threads_review', 'suggested_resolved', 'dormant_threads', 'active_threads', 'threads_table', 'duplicate_threads'],
  },
  {
    id: 'timeline',
    title: 'Timeline',
    layout: 'vertical',
    widgets: ['metric_timeline', 'timeline_density_strip', 'time_gap_sparkline', 'timeline_events', 'timeline_table'],
  },
  {
    id: 'characters',
    title: 'Characters',
    layout: 'vertical',
    widgets: ['metric_characters', 'character_presence_heatmap', 'character_appearances', 'characters_table'],
  },
  {
    id: 'continuity',
    title: 'Continuity',
    layout: 'vertical',
    widgets: ['continuity_active'],
  },
];

export class DashboardProfileService {
  private profiles = new Map<string, DashboardProfile>();

  constructor(private readonly rootPath: string) {}

  profilesDir(): string {
    return path.join(this.rootPath, DASHBOARD_PROFILES_DIR);
  }

  ensureDefaultProfiles(): void {
    const dir = this.profilesDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const profile of DEFAULT_PROFILES) {
      const file = path.join(dir, `${profile.id}.json`);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf-8');
      }
    }
  }

  reload(): DashboardProfile[] {
    this.ensureDefaultProfiles();
    this.profiles.clear();
    for (const file of this.profileFiles()) {
      const profile = this.loadProfileFile(file);
      this.validateWidgetIds(profile);
      this.profiles.set(profile.id, profile);
    }
    return this.listProfiles();
  }

  listProfiles(): DashboardProfile[] {
    if (!this.profiles.size) return this.reload();
    return [...this.profiles.values()].sort((a, b) => a.title.localeCompare(b.title));
  }

  getProfile(id: string): DashboardProfile | undefined {
    if (!this.profiles.size) this.reload();
    return this.profiles.get(id);
  }

  resolveWidgets(profile: DashboardProfile): WidgetConfig[] {
    const widgetMap = getWidgetMap();
    return profile.widgets.map(id => {
      const widget = widgetMap.get(id);
      if (!widget) throw new Error(`Dashboard profile "${profile.id}" references unknown widget "${id}"`);
      return widget;
    });
  }

  private profileFiles(): string[] {
    const dir = this.profilesDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .map(name => path.join(dir, name));
  }

  private loadProfileFile(file: string): DashboardProfile {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return normalizeDashboardProfile(raw);
  }

  private validateWidgetIds(profile: DashboardProfile): void {
    const widgetMap = getWidgetMap();
    for (const id of profile.widgets) {
      if (!widgetMap.has(id)) {
        throw new Error(`Dashboard profile "${profile.id}" references unknown widget "${id}"`);
      }
    }
  }
}
