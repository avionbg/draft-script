import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import * as crypto from 'crypto';

import { NavigatorItem }         from '../providers/navigatorTreeProvider';
import { NavigatorTreeProvider } from '../providers/navigatorTreeProvider';

function sectionHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function extractSectionText(filePath: string, startLine: number): string | null {
  let content: string;
  try { content = fs.readFileSync(filePath, 'utf-8'); }
  catch { return null; }

  const lines = content.split('\n');
  if (startLine >= lines.length) return null;

  const headingMatch = /^(#{1,6})\s/.exec(lines[startLine]);
  const level = headingMatch ? headingMatch[1].length : 1;

  let end = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s/.exec(lines[i]);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(startLine, end).join('\n');
}

export async function markChapterScanned(
  item:               NavigatorItem | undefined,
  navigatorProvider:  NavigatorTreeProvider,
  getRootFolder:      () => string,
): Promise<void> {
  if (!item || item.kind !== 'heading' || !item.itemFilePath || item.itemLine == null) {
    vscode.window.showWarningMessage('DSM: Select a chapter heading to mark as scanned.');
    return;
  }

  const title       = String(item.label).trim();
  const chaptersDir = path.join(getRootFolder(), '.draft-script', 'analysis', 'chapters');

  if (!fs.existsSync(chaptersDir)) {
    vscode.window.showWarningMessage(`DSM: No analysis found for "${title}". Analyze it first.`);
    return;
  }

  // Locate analysis file by matching chapter title
  let foundFile: string | undefined;
  let analysis: Record<string, unknown> | undefined;

  for (const name of fs.readdirSync(chaptersDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const p    = path.join(chaptersDir, name);
      const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as { chapter?: { title?: string } };
      if (data?.chapter?.title === title) { foundFile = p; analysis = data as Record<string, unknown>; break; }
    } catch { /* skip corrupt */ }
  }

  if (!foundFile || !analysis) {
    vscode.window.showWarningMessage(`DSM: No analysis found for "${title}". Analyze it first.`);
    return;
  }

  const sectionText = extractSectionText(item.itemFilePath, item.itemLine);
  if (!sectionText) {
    vscode.window.showWarningMessage(`DSM: Could not read section for "${title}".`);
    return;
  }

  const currentHash = sectionHash(sectionText);
  const chapter     = analysis['chapter'] as Record<string, unknown>;

  if (chapter['contentHash'] === currentHash) {
    vscode.window.showInformationMessage(`DSM: "${title}" is already up to date.`);
    return;
  }

  chapter['contentHash'] = currentHash;
  fs.writeFileSync(foundFile, JSON.stringify(analysis, null, 2), 'utf-8');
  navigatorProvider.refresh();
}
