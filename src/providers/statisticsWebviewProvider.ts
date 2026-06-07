import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { countWords, getAllMarkdownFiles, parseHeadings } from '../utils/markdownParser';

const WORDS_PER_PAGE    = 250;
const WORDS_PER_LINE    = 10;
const WORDS_PER_MINUTE  = 200;

// Must stay in sync with ChapterContentProvider.scheme.
const CHAPTER_SCHEME = 'draft-focus';

interface Stats {
  scope:        'novel' | 'chapter';
  chapterTitle: string;
  words:        number;
  uniqueWords:  number;
  charsTotal:   number;
  charsSpaces:  number;
  chapters:     number;
  files:        number;
  estPages:     number;
  estLines:     number;
  readingMins:  number;
  readingSecs:  number;
}

export class StatisticsWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _lastEditor: vscode.TextEditor | undefined;
  private _locked    = false;
  private _novelCache: { mtimes: Map<string, number>; stats: Stats } | null = null;

  constructor(private novelFolder: string) {}

  refresh(): void {
    this.refreshForEditor(vscode.window.activeTextEditor);
  }

  refreshForEditor(editor: vscode.TextEditor | undefined): void {
    this._lastEditor = editor;
    if (this._view) {
      this._view.webview.html = this.buildHtml(editor);
    }
  }

  setNovelFolder(folder: string): void {
    this.novelFolder   = folder;
    this._novelCache   = null;
    this.refresh();
  }

  invalidateCache(): void {
    this._novelCache = null;
  }

  toggleLock(): void {
    this._locked = !this._locked;
    vscode.commands.executeCommand('setContext', 'draftScript.statsLocked', this._locked);
    this.refreshForEditor(this._lastEditor ?? vscode.window.activeTextEditor);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: false };
    webviewView.webview.html = this.buildHtml(
      this._lastEditor ?? vscode.window.activeTextEditor
    );
  }

  // ---------------------------------------------------------------------------
  // Stats computation
  // ---------------------------------------------------------------------------

  private computeStats(editor?: vscode.TextEditor): Stats {
    const activeDoc = editor?.document;

    if (!this._locked) {
      // Focus-mode virtual chapter document
      if (activeDoc && activeDoc.uri.scheme === CHAPTER_SCHEME) {
        return this.chapterStats(activeDoc.getText());
      }

      // Regular .md file — detect chapter from cursor position
      if (activeDoc?.uri.scheme === 'file' &&
          activeDoc.uri.fsPath.toLowerCase().endsWith('.md') &&
          editor) {
        const lines       = activeDoc.getText().split('\n');
        const cursorLine  = editor.selection.active.line;
        const chapterText = this.extractChapterAtLine(lines, cursorLine);
        if (chapterText !== null) {
          return this.chapterStats(chapterText);
        }
      }
    }

    return this.novelStats();
  }

  /** Extracts text from the heading the cursor is under to the next same-or-higher heading. */
  private extractChapterAtLine(lines: string[], cursorLine: number): string | null {
    const clamp = Math.min(cursorLine, lines.length - 1);

    let headingLine  = -1;
    let headingLevel = 0;
    for (let i = clamp; i >= 0; i--) {
      const m = lines[i].match(/^(#{1,6})\s/);
      if (m) { headingLine = i; headingLevel = m[1].length; break; }
    }
    if (headingLine === -1) return null;

    let endLine = lines.length;
    for (let i = headingLine + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s/);
      if (m && m[1].length <= headingLevel) { endLine = i; break; }
    }

    return lines.slice(headingLine, endLine).join('\n');
  }

  private chapterStats(content: string): Stats {
    const titleMatch  = content.match(/^#{1,6}\s+(.+)/m);
    const chapterTitle = titleMatch ? titleMatch[1].trim() : 'Chapter';

    const words       = countWords(content);
    const uniqueWords = countUniqueWords(content);
    const charsTotal  = content.length;
    const charsSpaces = (content.match(/ /g) ?? []).length;
    const totalSecs   = Math.round((words / WORDS_PER_MINUTE) * 60);

    return {
      scope: 'chapter', chapterTitle,
      words, uniqueWords, charsTotal, charsSpaces,
      chapters:    1,
      files:       1,
      estPages:    Math.ceil(words / WORDS_PER_PAGE),
      estLines:    Math.ceil(words / WORDS_PER_LINE),
      readingMins: Math.floor(totalSecs / 60),
      readingSecs: totalSecs % 60,
    };
  }

  private novelStats(): Stats {
    const empty: Stats = {
      scope: 'novel', chapterTitle: '',
      words: 0, uniqueWords: 0, charsTotal: 0, charsSpaces: 0,
      chapters: 0, files: 0,
      estPages: 0, estLines: 0, readingMins: 0, readingSecs: 0,
    };

    if (!this.novelFolder || !fs.existsSync(this.novelFolder)) return empty;

    const mdFiles = getAllMarkdownFiles(this.novelFolder).filter(
      f => path.basename(f) !== 'characters.md'
    );
    if (mdFiles.length === 0) return empty;

    // In-memory cache — invalidated by setNovelFolder / invalidateCache
    if (this._novelCache) {
      const c = this._novelCache;
      const valid = c.mtimes.size === mdFiles.length &&
        mdFiles.every(f => c.mtimes.get(f) === safeStatMtime(f));
      if (valid) return c.stats;
    }

    let words = 0, charsTotal = 0, charsSpaces = 0, chapters = 0;
    const uniqueSet = new Set<string>();

    for (const file of mdFiles) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        words       += countWords(content);
        charsTotal  += content.length;
        charsSpaces += (content.match(/ /g) ?? []).length;
        chapters    += parseHeadings(content).filter(h => h.level === 1).length;
        for (const m of content.matchAll(/\p{L}{2,}/gu)) {
          uniqueSet.add(m[0].toLowerCase());
        }
      } catch { /* skip unreadable */ }
    }

    if (chapters === 0) chapters = mdFiles.length;

    const totalSecs = Math.round((words / WORDS_PER_MINUTE) * 60);

    const stats: Stats = {
      scope: 'novel', chapterTitle: '',
      words, uniqueWords: uniqueSet.size, charsTotal, charsSpaces,
      chapters, files: mdFiles.length,
      estPages:    Math.ceil(words / WORDS_PER_PAGE),
      estLines:    Math.ceil(words / WORDS_PER_LINE),
      readingMins: Math.floor(totalSecs / 60),
      readingSecs: totalSecs % 60,
    };

    this._novelCache = { mtimes: new Map(mdFiles.map(f => [f, safeStatMtime(f)])), stats };
    return stats;
  }

  // ---------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------

  private buildHtml(editor?: vscode.TextEditor): string {
    const s = this.computeStats(editor);

    const charsCell = `${s.charsTotal.toLocaleString()}<span class="dim"> (+${s.charsSpaces.toLocaleString()} spaces)</span>`;

    const readingCell = s.readingMins > 0
      ? `${s.readingMins.toLocaleString()} min${s.readingSecs > 0 ? `, ${s.readingSecs} sec` : ''}`
      : `${s.readingSecs} sec`;

    const scopeBar = s.scope === 'chapter'
      ? `<div class="scope-bar chapter">
  <div class="scope-line"><span class="scope-icon">&#9673;</span>Scope: Chapter</div>
  <div class="chapter-name" title="${esc(s.chapterTitle)}">Chapter: ${esc(s.chapterTitle)}</div>
</div>`
      : `<div class="scope-bar novel">
  <div class="scope-line"><span class="scope-icon">&#9678;</span>Scope: Novel</div>
</div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    font-size: var(--vscode-font-size);
    margin: 0; padding: 0;
  }

  .scope-bar {
    padding: 5px 8px 5px;
    border-bottom: 1px solid var(--vscode-widget-border);
    margin-bottom: 2px;
  }
  .scope-line {
    display: flex; align-items: center; gap: 5px;
    font-size: 0.8em; font-weight: 600;
  }
  .scope-bar.chapter .scope-line { color: var(--vscode-textLink-activeForeground, #4ea6ff); }
  .scope-bar.novel   .scope-line { opacity: 0.55; }
  .scope-icon { font-size: 0.85em; flex-shrink: 0; }
  .chapter-name {
    margin-top: 2px;
    font-size: 0.82em; opacity: 0.8;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  table { width: 100%; border-collapse: collapse; }
  tr { border-bottom: 1px solid var(--vscode-widget-border); }
  tr:last-child { border-bottom: none; }
  td { padding: 5px 8px; vertical-align: middle; }
  .label { opacity: 0.65; font-size: 0.88em; white-space: nowrap; }
  .value { text-align: right; font-weight: 600; }
  .dim   { opacity: 0.55; font-weight: 400; font-size: 0.88em; }
  .gap td { padding-top: 10px; }
</style>
</head>
<body>
${scopeBar}
<table>
  <tr>
    <td class="label">Words</td>
    <td class="value">${s.words.toLocaleString()}</td>
  </tr>
  <tr>
    <td class="label">Unique Words</td>
    <td class="value">${s.uniqueWords.toLocaleString()}</td>
  </tr>
  <tr>
    <td class="label">Characters</td>
    <td class="value">${charsCell}</td>
  </tr>

  <tr class="gap">
    <td class="label">Est. Pages</td>
    <td class="value">${s.estPages.toLocaleString()}<span class="dim"> (${WORDS_PER_PAGE} w/page)</span></td>
  </tr>
  <tr>
    <td class="label">Est. Lines</td>
    <td class="value">${s.estLines.toLocaleString()}</td>
  </tr>
  <tr>
    <td class="label">Est. Reading Time</td>
    <td class="value">${readingCell}</td>
  </tr>

  <tr class="gap">
    <td class="label">Chapters</td>
    <td class="value">${s.chapters.toLocaleString()}</td>
  </tr>
  <tr>
    <td class="label">Files</td>
    <td class="value">${s.files.toLocaleString()}</td>
  </tr>
</table>
</body>
</html>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function countUniqueWords(text: string): number {
  const set = new Set<string>();
  for (const m of text.matchAll(/\p{L}{2,}/gu)) {
    set.add(m[0].toLowerCase());
  }
  return set.size;
}

function safeStatMtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}
