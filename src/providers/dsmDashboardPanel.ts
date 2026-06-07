import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { renderDashboard } from '../dsm/dashboard/dashboardEngine';
import { loadDashboardData } from '../dsm/dashboard/dashboardData';
import { layoutClass, layoutColumns } from '../dsm/dashboard/layout';
import { DashboardProfile } from '../dsm/dashboard/types';
import { DashboardProfileService } from '../dsm/dashboard/profileService';
import { CELL_LINK_CSS, CELL_LINK_JS } from '../dsm/dashboard/widgetRenderer';
import { navigateWithSelection } from '../utils/navigation';

export class DsmDashboardPanel {
  private static instances = new Set<DsmDashboardPanel>();

  private readonly instanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly getRootFolder: () => string,
    private readonly context: vscode.ExtensionContext,
    private readonly profileId: string,
  ) {
    DsmDashboardPanel.instances.add(this);
    this.update();
    panel.onDidDispose(() => DsmDashboardPanel.instances.delete(this));
    panel.webview.onDidReceiveMessage(
      async (msg: Record<string, unknown>) => {
        if (msg.command !== 'navigateToChapter') return;
        await this.navigateToChapter(msg);
      },
      undefined,
      context.subscriptions,
    );
  }

  static open(context: vscode.ExtensionContext, getRootFolder: () => string, profileId: string): void {
    const service = new DashboardProfileService(getRootFolder());
    const profile = service.getProfile(profileId);
    const title = profile?.title ?? profileId;
    const panel = vscode.window.createWebviewPanel(
      'draftScript.dashboard',
      title,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    context.subscriptions.push(panel);
    new DsmDashboardPanel(panel, getRootFolder, context, profileId);
  }

  static refresh(): void {
    for (const instance of DsmDashboardPanel.instances) instance.update();
  }

  static reload(): void {
    for (const instance of DsmDashboardPanel.instances) {
      new DashboardProfileService(instance.getRootFolder()).reload();
      instance.update();
    }
  }

  private update(): void {
    this.panel.webview.html = this.buildHtml();
  }

  private indexesExist(): boolean {
    return fs.existsSync(path.join(this.getRootFolder(), '.draft-script', 'indexes'));
  }

  private buildHtml(): string {
    if (!this.indexesExist()) {
      return messagePage('No DSM data yet', 'Run DSM: Rescan Changed Chapters to analyse your novel.');
    }

    try {
      const service = new DashboardProfileService(this.getRootFolder());
      const profile = service.getProfile(this.profileId);
      if (!profile) return messagePage('Dashboard Missing', `Profile "${this.profileId}" was not found.`);
      const widgets = service.resolveWidgets(profile);
      const data = loadDashboardData(this.getRootFolder(), widgets);
      const columns = layoutColumns(profile.layout);
      const body = renderDashboard({ profile, widgets, data });
      this.panel.title = profile.title;
      return dashboardPage(profile, this.instanceId, columns, body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return messagePage('Dashboard Error', msg);
    }
  }

  private async navigateToChapter(msg: Record<string, unknown>): Promise<void> {
    const filePath = msg.filePath as string | undefined;
    if (!filePath) return;
    await navigateWithSelection({
      filePath,
      root:          this.getRootFolder(),
      referenceText: (msg.referenceText as string | undefined)?.trim(),
      title:         msg.title as string | undefined,
    });
  }
}

function dashboardPage(profile: DashboardProfile, instanceId: string, columns: number, widgets: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>${PANEL_CSS}${CELL_LINK_CSS}</style>
</head>
<body>
<div class="panel-header">
  <span class="panel-title">${esc(profile.title)}</span>
  <span class="panel-hint dim">${esc(profile.id)} / ${esc(instanceId)}</span>
</div>
<div class="dashboard-shell ${layoutClass(profile.layout)}" style="--dashboard-columns:${columns}">
${widgets}
</div>
<script>${CELL_LINK_JS}</script>
</body>
</html>`;
}

function messagePage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: var(--vscode-font-size); margin: 0; padding: 40px 32px; }
p { opacity: 0.65; line-height: 1.7; }
strong { opacity: 1; }
</style>
</head>
<body><p><strong>${esc(title)}</strong><br>${esc(body)}</p></body>
</html>`;
}


const PANEL_CSS = `
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    font-size: var(--vscode-font-size);
    background: var(--vscode-editor-background);
    margin: 0;
    padding: 0;
  }
  .panel-header {
    display: flex;
    align-items: baseline;
    gap: 16px;
    padding: 10px 20px;
    border-bottom: 1px solid var(--vscode-widget-border);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  .panel-title { font-size: 1em; font-weight: 700; }
  .panel-hint { font-size: 0.8em; }
  .dashboard-shell {
    display: grid;
    grid-template-columns: repeat(var(--dashboard-columns, 1), minmax(0, 1fr));
  }
  .dashboard-layout-vertical { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dashboard-layout-vertical .widget:not([class*="widget-span"]) { grid-column: 1 / -1; }
  .widget-span-1 { grid-column: span 1; }
  .widget-span-2 { grid-column: span 2; }
  .widget-span-3 { grid-column: span 3; }
  .widget-span-4 { grid-column: span 4; }
  .widget {
    grid-column: span 1;
    padding: 14px 20px 16px;
    border-bottom: 1px solid var(--vscode-widget-border);
    min-width: 0;
  }
  .widget-compact { padding: 8px 14px 10px; }
  .widget-title {
    font-size: 0.76em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.45;
    margin-bottom: 8px;
  }
  .metric { font-size: 2.6em; font-weight: 700; line-height: 1; }
  .metric-label { font-size: 0.32em; font-weight: 400; opacity: 0.5; margin-left: 4px; vertical-align: middle; }
  .list-row { padding: 3px 0; font-size: 0.92em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; gap: 6px; align-items: baseline; }
  .list-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list-sub { flex-shrink: 0; font-size: 0.85em; }
  .warning-row { display: flex; align-items: baseline; gap: 6px; padding: 3px 0; font-size: 0.9em; min-width: 0; }
  .warn-icon { flex-shrink: 0; opacity: 0.7; color: var(--vscode-charts-yellow, #cca700); font-size: 0.85em; }
  .warn-success { color: var(--vscode-charts-green, #89d185); }
  .warn-info { color: var(--vscode-charts-blue, #4ea6ff); }
  .warn-error { color: var(--vscode-errorForeground, #f48771); }
  .warn-warning { color: var(--vscode-charts-yellow, #cca700); }
  .warn-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .warn-meta { flex-shrink: 0; opacity: 0.45; font-size: 0.85em; white-space: nowrap; }
  .ok { opacity: 0.4; font-size: 0.9em; padding: 3px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  thead { position: sticky; top: 0; background: var(--vscode-editor-background); }
  th { text-align: left; opacity: 0.45; font-weight: 600; font-size: 0.85em; padding: 3px 10px 4px; border-bottom: 1px solid var(--vscode-widget-border); white-space: nowrap; }
  td { padding: 5px 10px; border-bottom: 1px solid var(--vscode-widget-border); }
  tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
  .timeline-row { display: flex; align-items: flex-start; gap: 12px; padding: 5px 0; font-size: 0.9em; border-bottom: 1px solid var(--vscode-widget-border); }
  .timeline-row:last-child { border-bottom: none; }
  .tl-chapter { flex-shrink: 0; font-weight: 700; opacity: 0.5; font-size: 0.82em; min-width: 38px; padding-top: 1px; }
  .tl-content { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .tl-summary { font-weight: 500; }
  .tl-desc { font-size: 0.88em; opacity: 0.6; }
  .bar-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 0.9em; }
  .bar-label { width: 120px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; height: 5px; background: var(--vscode-widget-border); border-radius: 3px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--vscode-charts-blue, #4ea6ff); border-radius: 3px; }
  .bar-count { flex-shrink: 0; opacity: 0.55; font-size: 0.85em; min-width: 22px; text-align: right; }
  .svg-widget svg { display: block; width: 100%; height: auto; overflow: visible; }
  .sparkline-line { fill: none; stroke: var(--vscode-charts-blue, #4ea6ff); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .strip-bar { fill: var(--vscode-charts-blue, #4ea6ff); }
  .heatmap-cell { fill: var(--vscode-charts-blue, #4ea6ff); }
  .heatmap-label { fill: var(--vscode-foreground); opacity: 0.58; font-size: 7px; }
  .svg-caption, .svg-legend { margin-top: 5px; font-size: 0.78em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dim { opacity: 0.45; }
`;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
