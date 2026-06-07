import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAllMarkdownFiles } from '../utils/markdownParser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChapterFile {
  filePath: string;
  dir:      string;
  number:   number;
  numStr:   string;  // original digit string — preserves leading-zero width
  sep:      string;  // separator between number and title (e.g. "-", " - ", "_")
  title:    string;  // rest of basename after separator
}

// Matches: {digits}{separator}{title}
// Separator: optional spaces + dash/en-dash/colon/underscore + optional spaces, OR just spaces
const CHAPTER_RE = /^(\d+)([\s]*[-–:_][\s]*|[\s]+)(.+)$/;

// ---------------------------------------------------------------------------
// Parsers / builders
// ---------------------------------------------------------------------------

function parseChapter(filePath: string): ChapterFile | null {
  const base = path.basename(filePath, '.md');
  const m    = base.match(CHAPTER_RE);
  if (!m) return null;
  return {
    filePath,
    dir:    path.dirname(filePath),
    number: parseInt(m[1], 10),
    numStr: m[1],
    sep:    m[2],
    title:  m[3].trim(),
  };
}

function buildPath(ch: ChapterFile, newNumber: number): string {
  const w      = Math.max(ch.numStr.length, String(newNumber).length);
  const numStr = String(newNumber).padStart(w, '0');
  return path.join(ch.dir, `${numStr}${ch.sep}${ch.title}.md`);
}

/** Strips characters invalid in filenames; keeps the rest as-is. */
function sanitizeTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '').trim() || 'New Chapter';
}

/** Updates the first `chapterNumber:`, `chapter:`, or `number:` YAML field in frontmatter if present. */
function applyFrontmatterUpdate(content: string, newNumber: number): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  const updated = content.slice(0, end + 4)
    .replace(/^(chapterNumber|chapter|number)\s*:\s*\d+/mi, (_, key) => `${key}: ${newNumber}`);
  return updated + content.slice(end + 4);
}

/**
 * Rename a chapter file to reflect a new chapter number.
 * Reads current content, applies frontmatter update, writes to new path, deletes old path.
 */
function renameChapter(ch: ChapterFile, newNumber: number): void {
  const newPath = buildPath(ch, newNumber);
  if (newPath === ch.filePath) return;
  const content = applyFrontmatterUpdate(
    fs.readFileSync(ch.filePath, 'utf-8'), newNumber
  );
  fs.writeFileSync(newPath, content, 'utf-8');
  fs.unlinkSync(ch.filePath);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** All numbered .md chapter files that are direct children of `dir`. */
function siblingChapters(dir: string): ChapterFile[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map(e  => parseChapter(path.join(dir, e.name)))
      .filter((c): c is ChapterFile => c !== null);
  } catch { return []; }
}

/**
 * Resolves the target file path.
 * If called from a context menu the item carries `itemFilePath`.
 * If called from the Command Palette (no item), shows a quick pick.
 */
async function resolveTargetFile(
  item: { itemFilePath?: string } | undefined,
  novelFolder: string,
): Promise<string | undefined> {
  if (item?.itemFilePath) return item.itemFilePath;

  const options = getAllMarkdownFiles(novelFolder)
    .filter(f => path.basename(f) !== 'characters.md')
    .map(f => ({ f, ch: parseChapter(f) }))
    .filter((x): x is { f: string; ch: ChapterFile } => x.ch !== null)
    .map(({ f, ch }) => ({
      label:       path.basename(f, '.md'),
      description: path.relative(novelFolder, path.dirname(f)) || '.',
      filePath:    f,
      detail:      `Chapter ${ch.number}`,
    }));

  if (options.length === 0) {
    vscode.window.showInformationMessage(
      'No numbered chapter files found (expected format: "23 - Title.md").'
    );
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(options, {
    placeHolder:        'Select a chapter',
    matchOnDescription: true,
  });
  return picked?.filePath;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function insertChapterBefore(
  item: { itemFilePath?: string } | undefined,
  novelFolder: string,
): Promise<void> {
  const filePath = await resolveTargetFile(item, novelFolder);
  if (!filePath) return;

  const selected = parseChapter(filePath);
  if (!selected) {
    vscode.window.showWarningMessage(
      'This file does not follow a numbered chapter format (e.g. "23 - Title.md").'
    );
    return;
  }

  const input = await vscode.window.showInputBox({
    title:         'Insert Chapter Before',
    prompt:        `Insert before chapter ${selected.number} — enter new chapter title`,
    value:         'New Chapter',
    validateInput: v => v.trim() ? null : 'Title cannot be empty',
  });
  if (input === undefined) return;
  const title = sanitizeTitle(input);

  const siblings = siblingChapters(selected.dir);

  // Shift chapters >= selected.number upward — descending order avoids rename collisions
  siblings
    .filter(c => c.number >= selected.number)
    .sort((a, b) => b.number - a.number)
    .forEach(c => renameChapter(c, c.number + 1));

  const numStr  = String(selected.number).padStart(selected.numStr.length, '0');
  const newPath = path.join(selected.dir, `${numStr}${selected.sep}${title}.md`);
  fs.writeFileSync(newPath, `# ${input.trim()}\n\n`, 'utf-8');

  const doc = await vscode.workspace.openTextDocument(newPath);
  await vscode.window.showTextDocument(doc);
}

export async function insertChapterAfter(
  item: { itemFilePath?: string } | undefined,
  novelFolder: string,
): Promise<void> {
  const filePath = await resolveTargetFile(item, novelFolder);
  if (!filePath) return;

  const selected = parseChapter(filePath);
  if (!selected) {
    vscode.window.showWarningMessage(
      'This file does not follow a numbered chapter format (e.g. "23 - Title.md").'
    );
    return;
  }

  const input = await vscode.window.showInputBox({
    title:         'Insert Chapter After',
    prompt:        `Insert after chapter ${selected.number} — enter new chapter title`,
    value:         'New Chapter',
    validateInput: v => v.trim() ? null : 'Title cannot be empty',
  });
  if (input === undefined) return;
  const title = sanitizeTitle(input);

  const siblings = siblingChapters(selected.dir);

  // Shift chapters > selected.number upward — descending order avoids rename collisions
  siblings
    .filter(c => c.number > selected.number)
    .sort((a, b) => b.number - a.number)
    .forEach(c => renameChapter(c, c.number + 1));

  const newNumber = selected.number + 1;
  const w         = Math.max(selected.numStr.length, String(newNumber).length);
  const numStr    = String(newNumber).padStart(w, '0');
  const newPath   = path.join(selected.dir, `${numStr}${selected.sep}${title}.md`);
  fs.writeFileSync(newPath, `# ${input.trim()}\n\n`, 'utf-8');

  const doc = await vscode.workspace.openTextDocument(newPath);
  await vscode.window.showTextDocument(doc);
}

export async function renumberChapters(novelFolder: string): Promise<void> {
  if (!novelFolder || !fs.existsSync(novelFolder)) {
    vscode.window.showErrorMessage('Draft-Script: No novel folder configured.');
    return;
  }

  const allFiles = getAllMarkdownFiles(novelFolder)
    .filter(f => path.basename(f) !== 'characters.md');

  // Group numbered chapter files by directory
  const byDir = new Map<string, ChapterFile[]>();
  for (const f of allFiles) {
    const ch = parseChapter(f);
    if (!ch) continue;
    if (!byDir.has(ch.dir)) byDir.set(ch.dir, []);
    byDir.get(ch.dir)!.push(ch);
  }

  if (byDir.size === 0) {
    vscode.window.showInformationMessage(
      'No numbered chapter files found (expected format: "23 - Title.md").'
    );
    return;
  }

  const totalFiles = [...byDir.values()].reduce((n, arr) => n + arr.length, 0);
  const ok = await vscode.window.showWarningMessage(
    `Renumber ${totalFiles} chapter file(s) sequentially starting from 1?`,
    { modal: true },
    'Renumber'
  );
  if (ok !== 'Renumber') return;

  for (const [, chapters] of byDir) {
    // Sort by current number (ascending)
    chapters.sort((a, b) => a.number - b.number);

    // Phase 1: move all files that need renaming to temp names — avoids collisions entirely
    const pending: Array<{ tmp: string; ch: ChapterFile; newNumber: number }> = [];
    for (let i = 0; i < chapters.length; i++) {
      const ch        = chapters[i];
      const newNumber = i + 1;
      if (ch.number === newNumber) continue;  // already correct

      const tmp = ch.filePath + '.~renumber';
      fs.renameSync(ch.filePath, tmp);
      pending.push({ tmp, ch, newNumber });
    }

    // Phase 2: write final names with updated frontmatter
    for (const { tmp, ch, newNumber } of pending) {
      const content  = applyFrontmatterUpdate(fs.readFileSync(tmp, 'utf-8'), newNumber);
      const finalPath = buildPath(ch, newNumber);
      fs.writeFileSync(finalPath, content, 'utf-8');
      fs.unlinkSync(tmp);
    }
  }

  vscode.window.showInformationMessage('Chapters renumbered successfully.');
}

export async function moveChapter(
  item: { itemFilePath?: string } | undefined,
  novelFolder: string,
): Promise<void> {
  const filePath = await resolveTargetFile(item, novelFolder);
  if (!filePath) return;

  const selected = parseChapter(filePath);
  if (!selected) {
    vscode.window.showWarningMessage(
      'This file does not follow a numbered chapter format (e.g. "23 - Title.md").'
    );
    return;
  }

  const sorted = siblingChapters(selected.dir)
    .sort((a, b) => a.number - b.number || a.title.localeCompare(b.title));

  if (sorted.length <= 1) {
    vscode.window.showInformationMessage('Only one chapter — nothing to move.');
    return;
  }

  // After renumbering from base, target range = [base, base + count - 1].
  // The user enters the final chapter number they want the moved chapter to have.
  const base         = sorted[0].number;
  const maxTarget    = base + sorted.length - 1;
  const currentIndex = sorted.findIndex(c => c.filePath === selected.filePath);
  const currentTarget = base + currentIndex;

  const label = `${selected.numStr}${selected.sep}${selected.title}`;

  const input = await vscode.window.showInputBox({
    title:  'Move Chapter',
    prompt: `Move "${label}" to chapter number (${base}–${maxTarget}):`,
    value:  String(currentTarget),
    validateInput: v => {
      const n = parseInt(v.trim(), 10);
      if (!Number.isInteger(n) || n < base || n > maxTarget) {
        return `Enter a number between ${base} and ${maxTarget}`;
      }
      return null;
    },
  });
  if (input === undefined) return;

  const targetNumber = parseInt(input.trim(), 10);
  const targetIndex  = targetNumber - base;  // 0-based position in the reordered list

  if (targetIndex === currentIndex) {
    vscode.window.showInformationMessage(`"${label}" is already at position ${targetNumber}.`);
    return;
  }

  // Reorder in memory: remove selected, insert at target position
  const reordered = [...sorted];
  reordered.splice(currentIndex, 1);
  reordered.splice(targetIndex, 0, selected);

  // Collect files whose path actually changes after renumbering from base
  const toRename: Array<{ ch: ChapterFile; newNumber: number }> = [];
  for (let i = 0; i < reordered.length; i++) {
    const ch        = reordered[i];
    const newNumber = base + i;
    if (buildPath(ch, newNumber) !== ch.filePath) {
      toRename.push({ ch, newNumber });
    }
  }

  if (toRename.length === 0) {
    vscode.window.showInformationMessage('No files needed renaming.');
    return;
  }

  if (toRename.length >= 2) {
    const ok = await vscode.window.showWarningMessage(
      `Move "${label}" to position ${targetNumber}? This will rename ${toRename.length} chapter files.`,
      'Move',
    );
    if (ok !== 'Move') return;
  }

  // Two-phase rename: phase 1 → temp names, phase 2 → final names
  const uuid    = Date.now().toString(36);
  const pending: Array<{ tmp: string; ch: ChapterFile; newNumber: number }> = [];

  try {
    // Phase 1: all affected files → temp names (no collision risk)
    for (let i = 0; i < toRename.length; i++) {
      const { ch } = toRename[i];
      const tmp = `${ch.filePath}.~move-${uuid}-${i}`;
      fs.renameSync(ch.filePath, tmp);
      pending.push({ tmp, ch, newNumber: toRename[i].newNumber });
    }

    // Phase 2: temp names → final paths with updated frontmatter
    for (const { tmp, ch, newNumber } of pending) {
      const content   = applyFrontmatterUpdate(fs.readFileSync(tmp, 'utf-8'), newNumber);
      const finalPath = buildPath(ch, newNumber);
      fs.writeFileSync(finalPath, content, 'utf-8');
      fs.unlinkSync(tmp);
    }
  } catch (err) {
    // Best-effort rollback: restore any temp files still waiting for phase 2
    for (const { tmp, ch } of [...pending].reverse()) {
      try {
        if (fs.existsSync(tmp) && !fs.existsSync(ch.filePath)) {
          fs.renameSync(tmp, ch.filePath);
        }
      } catch { /* ignore */ }
    }
    vscode.window.showErrorMessage(
      `Move failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  // Open the moved chapter at its new path
  const movedFinalPath = buildPath(selected, targetNumber);
  if (fs.existsSync(movedFinalPath)) {
    const doc = await vscode.workspace.openTextDocument(movedFinalPath);
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  vscode.window.showInformationMessage(
    `Moved chapter to position ${targetNumber} and renumbered affected chapters.`
  );
}
