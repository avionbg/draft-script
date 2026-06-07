import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAllMarkdownFiles } from '../utils/markdownParser';

/**
 * Merges all Markdown files in the novel folder into a single file,
 * sorted by directory hierarchy then alphabetically within each folder.
 */
export async function mergeChapters(novelFolder: string): Promise<void> {
  if (!novelFolder) {
    vscode.window.showErrorMessage('Draft-Script: No novel folder configured. Check your settings.');
    return;
  }

  if (!fs.existsSync(novelFolder)) {
    vscode.window.showErrorMessage(`Draft-Script: Novel folder does not exist: ${novelFolder}`);
    return;
  }

  const files = getAllMarkdownFiles(novelFolder).filter(
    f => path.basename(f) !== 'characters.md'
  );

  if (files.length === 0) {
    vscode.window.showWarningMessage('Draft-Script: No Markdown files found in the novel folder.');
    return;
  }

  const saveUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(novelFolder, 'manuscript.md')),
    filters: { Markdown: ['md'] },
    title: 'Save Merged Manuscript',
  });

  if (!saveUri) return;

  const separator = '\n\n---\n\n';
  const parts: string[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      // Prefix a source comment so the origin is traceable in the merged output
      const relPath = path.relative(novelFolder, file);
      parts.push(`<!-- source: ${relPath} -->\n\n${content.trimEnd()}`);
    } catch {
      vscode.window.showWarningMessage(`Draft-Script: Could not read ${file}, skipping.`);
    }
  }

  fs.writeFileSync(saveUri.fsPath, parts.join(separator) + '\n', 'utf-8');

  const action = await vscode.window.showInformationMessage(
    `Draft-Script: Merged ${files.length} file(s) into ${path.basename(saveUri.fsPath)}.`,
    'Open File'
  );

  if (action === 'Open File') {
    vscode.commands.executeCommand('vscode.open', saveUri);
  }
}
