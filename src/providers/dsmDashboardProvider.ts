import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { renderDashboard } from '../dsm/dashboard/dashboardEngine';
import { loadDashboardData } from '../dsm/dashboard/dashboardData';
import { layoutClass, layoutColumns } from '../dsm/dashboard/layout';
import { DashboardProfileService } from '../dsm/dashboard/profileService';
import { CELL_LINK_CSS, CELL_LINK_JS } from '../dsm/dashboard/widgetRenderer';
import { navigateWithSelection } from '../utils/navigation';

export class DsmDashboardProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly getRootFolder: () => string) {}

  refresh(): void {
    if (this.view) {
      this.view.webview.html = this.buildHtml();
    }
  }

  reload(): void {
    new DashboardProfileService(this.getRootFolder()).reload();
    this.refresh();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      if (msg.command !== 'navigateToChapter') return;
      await this.navigateToChapter(msg);
    });
    webviewView.webview.html = this.buildHtml();
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

  private indexesExist(): boolean {
    return fs.existsSync(path.join(this.getRootFolder(), '.draft-script', 'indexes'));
  }

  private buildHtml(): string {
    if (!vscode.workspace.getConfiguration('draftScript').get<boolean>('enableLLM', true)) {
      return messageHtml('LLM Features Disabled', 'Enable LLM features in Draft-Script settings to use dashboards.');
    }
    if (!this.indexesExist()) {
      return messageHtml('No DSM data yet', 'Run DSM: Rescan Changed Chapters to analyse your novel.');
    }

    try {
      const service = new DashboardProfileService(this.getRootFolder());
      const profile = service.getProfile('sidebar');
      if (!profile) return messageHtml('Dashboard Missing', 'Create .draft-script/dashboards/sidebar.json.');
      const widgets = service.resolveWidgets(profile);
      const data = loadDashboardData(this.getRootFolder(), widgets);
      const columns = layoutColumns(profile.layout);
      const body = renderDashboard({ profile, widgets, data });
      return page(`<div class="dashboard-shell ${layoutClass(profile.layout)}" style="--dashboard-columns:${columns}">${body}</div>`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return messageHtml('Dashboard Error', msg);
    }
  }
}

function page(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>${CSS}${CELL_LINK_CSS}</style>
</head>
<body>${body}<script>${CELL_LINK_JS}</script></body>
</html>`;
}

function messageHtml(title: string, body: string): string {
  return page(`<div class="empty"><strong>${esc(title)}</strong><br>${esc(body)}</div>`);
}

const CSS = `
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    font-size: var(--vscode-font-size);
    margin: 0;
    padding: 0;
  }
  .empty { padding: 16px 12px; opacity: 0.7; font-size: 0.9em; line-height: 1.7; }
  .empty strong { opacity: 1; font-weight: 600; }
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
    border-bottom: 1px solid var(--vscode-widget-border);
    min-width: 0;
  }
  .widget:last-child { border-bottom: none; }
  .widget-title {
    padding: 7px 10px 2px;
    font-size: 0.76em;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.5;
  }
  .widget-body { padding: 2px 10px 8px; }
  .metric { font-size: 2em; font-weight: 700; line-height: 1.1; padding: 2px 0 0; }
  .metric-label { font-size: 0.35em; font-weight: 400; opacity: 0.5; margin-left: 4px; }
  .list-row {
    padding: 2px 0;
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .list-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .list-sub { flex-shrink: 0; font-size: 0.85em; }
  .warning-row {
    display: flex;
    align-items: baseline;
    gap: 5px;
    padding: 2px 0;
    font-size: 0.88em;
    min-width: 0;
  }
  .warn-icon { flex-shrink: 0; opacity: 0.65; color: var(--vscode-charts-yellow, #cca700); font-size: 0.85em; }
  .warn-success { color: var(--vscode-charts-green, #89d185); }
  .warn-info { color: var(--vscode-charts-blue, #4ea6ff); }
  .warn-error { color: var(--vscode-errorForeground, #f48771); }
  .warn-warning { color: var(--vscode-charts-yellow, #cca700); }
  .warn-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .warn-meta { flex-shrink: 0; opacity: 0.5; font-size: 0.82em; white-space: nowrap; }
  .ok { opacity: 0.45; font-size: 0.88em; padding: 2px 0; }
  .dim { opacity: 0.5; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th { text-align: left; opacity: 0.5; font-weight: 600; font-size: 0.85em; padding: 2px 3px; border-bottom: 1px solid var(--vscode-widget-border); }
  td { padding: 2px 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100px; }
  .bar-row { display: flex; align-items: center; gap: 5px; padding: 2px 0; font-size: 0.88em; }
  .bar-label { width: 70px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; height: 4px; background: var(--vscode-widget-border); border-radius: 2px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--vscode-charts-blue, #4ea6ff); border-radius: 2px; }
  .bar-count { flex-shrink: 0; opacity: 0.55; font-size: 0.85em; min-width: 18px; text-align: right; }
  .timeline-row { display: flex; align-items: baseline; gap: 6px; padding: 2px 0; font-size: 0.88em; }
  .tl-chapter { flex-shrink: 0; font-size: 0.8em; opacity: 0.55; font-weight: 600; min-width: 30px; }
  .tl-content { min-width: 0; }
  .tl-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .tl-desc { display: none; }
  .svg-widget svg { display: block; width: 100%; height: auto; overflow: visible; }
  .sparkline-line { fill: none; stroke: var(--vscode-charts-blue, #4ea6ff); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .strip-bar { fill: var(--vscode-charts-blue, #4ea6ff); }
  .heatmap-cell { fill: var(--vscode-charts-blue, #4ea6ff); }
  .heatmap-label { fill: var(--vscode-foreground); opacity: 0.58; font-size: 7px; }
  .svg-caption, .svg-legend { margin-top: 3px; font-size: 0.76em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
