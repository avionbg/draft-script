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
