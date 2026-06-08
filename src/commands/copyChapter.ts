import * as fs from 'fs';
import * as vscode from 'vscode';
import { NavigatorItem } from '../providers/navigatorTreeProvider';

export async function copyChapterToClipboard(item: NavigatorItem | undefined): Promise<void> {
  if (!item?.itemFilePath) {
    vscode.window.showWarningMessage('Draft-Script: Select a chapter or file to copy.');
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(item.itemFilePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Draft-Script: Could not read chapter: ${msg}`);
    return;
  }

  const text = item.kind === 'heading'
    ? extractSectionByLine(content, item.itemLine, item.headingLevel ?? 1)
    : content;

  if (!text.trim()) {
    vscode.window.showWarningMessage('Draft-Script: Nothing to copy for this chapter.');
    return;
  }

  await vscode.env.clipboard.writeText(text);
  vscode.window.showInformationMessage('Draft-Script: Copied chapter to clipboard.');
}

function extractSectionByLine(content: string, headingLine: number | undefined, headingLevel: number): string {
  if (headingLine === undefined || headingLine < 0) return content;

  const lines = content.split('\n');
  if (headingLine >= lines.length) return '';

  let end = lines.length;
  for (let i = headingLine + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s/);
    if (match && match[1].length <= headingLevel) {
      end = i;
      break;
    }
  }

  return lines.slice(headingLine, end).join('\n');
}
