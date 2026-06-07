import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface FolderItem extends vscode.QuickPickItem {
  absolutePath: string;
}

/** Recursively collect directories up to `maxDepth` levels below `root`. */
function collectSubfolders(root: string, maxDepth: number): string[] {
  const results: string[] = [];

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'out') {
        continue;
      }
      const full = path.join(dir, entry.name);
      results.push(full);
      walk(full, depth + 1);
    }
  }

  walk(root, 1);
  return results;
}

/**
 * Command: let the user pick a novel root folder from within the current
 * workspace, then persist the choice to workspace settings.
 *
 * The `onFolderSelected` callback is called with the resolved absolute path
 * so the caller can refresh all providers immediately.
 */
export async function selectNovelFolder(
  onFolderSelected: (absolutePath: string) => void
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage(
      'Draft-Script: No workspace folder is open. Open a folder first.'
    );
    return;
  }

  const subfolders = collectSubfolders(workspaceRoot, 4);

  // Build QuickPick items — workspace root first, then each subfolder
  const items: FolderItem[] = [
    {
      label: '$(root-folder)  / (workspace root)',
      description: workspaceRoot,
      absolutePath: workspaceRoot,
    },
    ...subfolders.map(abs => {
      const rel = path.relative(workspaceRoot, abs);
      // Indent visually by depth so the hierarchy is readable
      const depth = rel.split(path.sep).length - 1;
      const indent = '    '.repeat(depth);
      return {
        label: `$(folder)  ${indent}${path.basename(abs)}`,
        description: rel,
        absolutePath: abs,
      };
    }),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Draft-Script: Select Novel Root Folder',
    placeHolder: 'Choose a folder inside this workspace',
    matchOnDescription: true,
  });

  if (!picked) return;

  // Persist as a relative path (or empty string for workspace root)
  const relToSave = path.relative(workspaceRoot, picked.absolutePath);
  await vscode.workspace.getConfiguration('draftScript').update(
    'novelFolder',
    relToSave === '' ? '' : relToSave,
    vscode.ConfigurationTarget.Workspace
  );

  vscode.window.showInformationMessage(
    `Draft-Script: Novel folder set to "${relToSave || '/ (workspace root)'}" — reloading…`
  );

  onFolderSelected(picked.absolutePath);
}
