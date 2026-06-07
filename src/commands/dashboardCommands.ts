import * as fs from 'fs';
import * as vscode from 'vscode';
import { DsmDashboardPanel } from '../providers/dsmDashboardPanel';
import { DsmDashboardProvider } from '../providers/dsmDashboardProvider';
import { DashboardProfileService } from '../dsm/dashboard/profileService';

export async function openDashboard(
  context: vscode.ExtensionContext,
  getRootFolder: () => string,
): Promise<void> {
  const service = new DashboardProfileService(getRootFolder());
  let profiles;
  try {
    profiles = service.reload();
  } catch (err) {
    vscode.window.showErrorMessage(`Draft-Script: cannot load dashboard profiles. ${message(err)}`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    profiles.map(profile => ({
      label: profile.title,
      description: profile.id,
      detail: profile.widgets.join(', '),
      profileId: profile.id,
    })),
    { placeHolder: 'Open dashboard profile' }
  );
  if (!picked) return;
  DsmDashboardPanel.open(context, getRootFolder, picked.profileId);
}

export function reloadDashboards(getRootFolder: () => string, sidebar: DsmDashboardProvider): void {
  try {
    new DashboardProfileService(getRootFolder()).reload();
    sidebar.reload();
    DsmDashboardPanel.reload();
    vscode.window.showInformationMessage('Draft-Script: dashboards reloaded.');
  } catch (err) {
    vscode.window.showErrorMessage(`Draft-Script: cannot reload dashboards. ${message(err)}`);
  }
}

export async function openDashboardFolder(getRootFolder: () => string): Promise<void> {
  const service = new DashboardProfileService(getRootFolder());
  service.ensureDefaultProfiles();
  const dir = service.profilesDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await vscode.env.openExternal(vscode.Uri.file(dir));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
