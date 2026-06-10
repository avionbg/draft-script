import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAllMarkdownFiles } from '../utils/markdownParser';

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Scan all novel files and return the highest chapter number matching the format. */
function findLastChapterNumber(novelFolder: string, format: string): number {
  const parts = format.split('{num}');
  if (parts.length !== 2) return 0;

  const re = new RegExp(
    `^#\\s+${escapeForRegex(parts[0])}(\\d+)${escapeForRegex(parts[1])}`,
    'gm'
  );

  let max = 0;
  for (const file of getAllMarkdownFiles(novelFolder)) {
    if (path.basename(file) === 'characters.md') continue;
    try {
      const content = fs.readFileSync(file, 'utf-8');
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    } catch { continue; }
  }
  return max;
}

function chapterHeadingRegex(format: string): RegExp | null {
  const parts = format.split('{num}');
  if (parts.length !== 2) return null;
  return new RegExp(
    `^#\\s+${escapeForRegex(parts[0])}(\\d+)${escapeForRegex(parts[1])}`,
    'gm'
  );
}

function getNovelMarkdownFiles(novelFolder: string): string[] {
  const excluded = new Set<string>(
    vscode.workspace.getConfiguration('draftScript').get<string[]>('navigatorExclude', [])
  );
  return getAllMarkdownFiles(novelFolder)
    .filter(file => {
      if (path.basename(file) === 'characters.md') return false;
      const rel = path.relative(novelFolder, file);
      const firstSegment = rel.split(path.sep)[0];
      return !excluded.has(firstSegment);
    });
}

function getChapterFiles(novelFolder: string, format: string): string[] {
  const re = chapterHeadingRegex(format);
  if (!re) return [];
  const files: string[] = [];
  for (const file of getNovelMarkdownFiles(novelFolder)) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      re.lastIndex = 0;
      if (re.test(content)) files.push(file);
    } catch { /* skip unreadable */ }
  }
  return files;
}

function findSingleNovelFile(novelFolder: string, format: string): string | undefined {
  const chapterFiles = getChapterFiles(novelFolder, format);
  if (chapterFiles.length === 1) return chapterFiles[0];

  const active = vscode.window.activeTextEditor?.document;
  if (
    active?.uri.scheme === 'file' &&
    active.languageId === 'markdown' &&
    active.uri.fsPath.startsWith(novelFolder) &&
    chapterFiles.length === 0
  ) {
    return active.uri.fsPath;
  }

  const mdFiles = getNovelMarkdownFiles(novelFolder);
  return mdFiles.length === 1 ? mdFiles[0] : undefined;
}

export async function addChapter(novelFolder: string): Promise<void> {
  if (!novelFolder || !fs.existsSync(novelFolder)) {
    vscode.window.showErrorMessage('Draft-Script: No novel folder configured.');
    return;
  }

  const cfg    = vscode.workspace.getConfiguration('draftScript');
  const format = cfg.get<string>('chapterFormat', 'Chapter {num}:').trim();

  const nextNum = findLastChapterNumber(novelFolder, format) + 1;
  const prefix  = format.replace('{num}', String(nextNum));
  const initial = prefix + ' ';

  const title = await vscode.window.showInputBox({
    title:          'Draft-Script: Add Chapter',
    prompt:         'Enter chapter title',
    value:          initial,
    valueSelection: [initial.length, initial.length],
  });
  if (title === undefined) return;

  const trimmed = title.trim();
  if (!trimmed) return;

  const singleFilePath = findSingleNovelFile(novelFolder, format);
  if (singleFilePath) {
    const filePath = singleFilePath;
    if (!filePath) {
      vscode.window.showWarningMessage('Draft-Script: No manuscript file found.');
      return;
    }

    const existing = fs.readFileSync(filePath, 'utf-8');
    const base = existing.trimEnd();
    const separator = base.length > 0 ? '\n\n' : '';
    const insert = `${separator}# ${trimmed}\n\n`;
    const headingOffset = base.length + separator.length;
    fs.writeFileSync(filePath, `${base}${insert}`, 'utf-8');

    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const start = doc.positionAt(headingOffset);
    const end = doc.positionAt(headingOffset + `# ${trimmed}`.length);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
    return;
  }

  // Build a safe filename slug
  const slug = trimmed
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/[^a-zA-Z0-9 \-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 50) || 'chapter';

  const filename = `${String(nextNum).padStart(2, '0')}-${slug}.md`;
  const filePath  = path.join(novelFolder, filename);

  if (fs.existsSync(filePath)) {
    vscode.window.showWarningMessage(`Draft-Script: ${filename} already exists.`);
    return;
  }

  fs.writeFileSync(filePath, `# ${trimmed}\n\n`, 'utf-8');
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
}
