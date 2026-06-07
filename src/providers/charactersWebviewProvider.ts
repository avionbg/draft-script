import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAllMarkdownFiles } from '../utils/markdownParser';
import { CanonCharacter, loadCanonCharacters, buildCanonRegex } from '../dsm/canonCharacters';

interface Occurrence {
  file:   string;
  line:   number;
  col:    number;
  length: number;
}

interface ChapterBreakdown {
  filePath:     string;
  title:        string;
  count:        number;
  headingLine:  number;
  headingText:  string;
  headingLevel: number;
}

export class CharactersWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  private _canonChars?: CanonCharacter[];
  private _occurrences         = new Map<string, Occurrence[]>();
  private _clickIndex          = new Map<string, number>();
  private _chapterCache        = new Map<string, ChapterBreakdown[]>();
  private _chapterOccurrences  = new Map<string, Occurrence[]>();
  private _chapterClickIndex   = new Map<string, number>();

  constructor(private novelFolder: string, private rootFolder: string) {}

  refresh(): void {
    this._canonChars = undefined;
    this._occurrences.clear();
    this._clickIndex.clear();
    this._chapterCache.clear();
    this._chapterOccurrences.clear();
    this._chapterClickIndex.clear();
    if (this._view) this._view.webview.html = this.buildHtml(this._view.webview);
  }

  setNovelFolder(folder: string): void {
    this.novelFolder = folder;
    this.refresh();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async msg => {
      switch (msg.command) {
        case 'openCanonEditor':
          vscode.commands.executeCommand('draftScript.dsmOpenCanonEditor');
          break;
        case 'navigate':
          await this.navigateTo(msg.name);
          break;
        case 'getChapters':
          await this.sendChapters(msg.name);
          break;
        case 'gotoChapter':
          await this.navigateInChapter(msg.name, msg.filePath, msg.line, msg.headingLevel);
          break;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Canon character loading
  // ---------------------------------------------------------------------------

  private getCanonCharacters(): CanonCharacter[] {
    if (!this._canonChars) {
      this._canonChars = this.rootFolder ? loadCanonCharacters(this.rootFolder) : [];
    }
    return this._canonChars;
  }

  private findCharByName(name: string): CanonCharacter | undefined {
    return this.getCanonCharacters().find(c => c.name === name);
  }

  // ---------------------------------------------------------------------------
  // Chapter breakdown
  // ---------------------------------------------------------------------------

  private getChapterBreakdown(name: string): ChapterBreakdown[] {
    if (!this.novelFolder || !fs.existsSync(this.novelFolder)) return [];

    const char = this.findCharByName(name);
    const re   = buildCanonRegex(name, char?.aliases ?? []);

    const files = getAllMarkdownFiles(this.novelFolder).filter(
      f => path.basename(f) !== 'characters.md'
    );
    const result: ChapterBreakdown[] = [];

    for (const file of files) {
      let content: string;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const lines = content.split('\n');

      let chapterHeadings = this.collectHeadingsAtLevel(lines, 1);
      if (chapterHeadings.length === 0) {
        const minLevel = this.minHeadingLevel(lines);
        if (minLevel > 0) chapterHeadings = this.collectHeadingsAtLevel(lines, minLevel);
      }

      if (chapterHeadings.length === 0) {
        let count = 0;
        for (const line of lines) { re.lastIndex = 0; while (re.exec(line) !== null) count++; }
        if (count > 0) {
          const base = path.basename(file, '.md');
          result.push({ filePath: file, title: base, count, headingLine: 0, headingText: base, headingLevel: 1 });
        }
        continue;
      }

      for (let ci = 0; ci < chapterHeadings.length; ci++) {
        const start = chapterHeadings[ci].line;
        const end   = ci + 1 < chapterHeadings.length ? chapterHeadings[ci + 1].line : lines.length;
        let count = 0;
        for (let li = start; li < end; li++) {
          re.lastIndex = 0;
          while (re.exec(lines[li]) !== null) count++;
        }
        if (count > 0) {
          const { text, level, line: headingLine } = chapterHeadings[ci];
          result.push({ filePath: file, title: text, count, headingLine, headingText: text, headingLevel: level });
        }
      }
    }

    return result.sort((a, b) => b.count - a.count);
  }

  private collectHeadingsAtLevel(
    lines: string[],
    level: number,
  ): { line: number; text: string; level: number }[] {
    const prefix = '#'.repeat(level) + ' ';
    const out: { line: number; text: string; level: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(prefix) && lines[i][prefix.length] !== '#') {
        out.push({ line: i, text: lines[i].slice(prefix.length).trim(), level });
      }
    }
    return out;
  }

  private minHeadingLevel(lines: string[]): number {
    let min = 7;
    for (const line of lines) {
      const m = line.match(/^(#{1,6})\s/);
      if (m && m[1].length < min) min = m[1].length;
    }
    return min < 7 ? min : 0;
  }

  private async sendChapters(name: string): Promise<void> {
    if (!this._view) return;
    if (!this._chapterCache.has(name)) {
      this._chapterCache.set(name, this.getChapterBreakdown(name));
    }
    this._view.webview.postMessage({
      command: 'showChapters',
      name,
      chapters: this._chapterCache.get(name)!,
    });
  }

  // ---------------------------------------------------------------------------
  // Occurrence navigation
  // ---------------------------------------------------------------------------

  private findOccurrences(name: string): Occurrence[] {
    if (!this.novelFolder || !fs.existsSync(this.novelFolder)) return [];

    const char = this.findCharByName(name);
    const re   = buildCanonRegex(name, char?.aliases ?? []);

    const files = getAllMarkdownFiles(this.novelFolder).filter(
      f => path.basename(f) !== 'characters.md'
    );
    const results: Occurrence[] = [];

    for (const file of files) {
      let content: string;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const lines = content.split('\n');
      for (let li = 0; li < lines.length; li++) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lines[li])) !== null) {
          results.push({ file, line: li, col: m.index, length: m[0].length });
        }
      }
    }

    if (!name.includes(' ') && results.length > 100) {
      return [
        ...results.slice(-50).reverse(),
        ...results.slice(0,  50).reverse(),
      ];
    }

    results.reverse();
    return results;
  }

  private async navigateTo(name: string): Promise<void> {
    if (!this._occurrences.has(name)) {
      this._occurrences.set(name, this.findOccurrences(name));
    }

    const locs = this._occurrences.get(name)!;
    if (locs.length === 0) {
      vscode.window.showInformationMessage(`Draft-Script: No occurrences of "${name}" found.`);
      return;
    }

    const idx = this._clickIndex.get(name) ?? 0;
    this._clickIndex.set(name, (idx + 1) % locs.length);

    const loc    = locs[idx];
    const uri    = vscode.Uri.file(loc.file);
    const doc    = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    const start = new vscode.Position(loc.line, loc.col);
    const end   = new vscode.Position(loc.line, loc.col + loc.length);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.AtTop);

    vscode.window.setStatusBarMessage(
      `$(person) ${name}  —  ${idx + 1} / ${locs.length}`,
      3000
    );
  }

  private async navigateInChapter(
    name:         string,
    filePath:     string,
    headingLine:  number,
    headingLevel: number,
  ): Promise<void> {
    const key = `${name}::${filePath}::${headingLine}`;

    if (!this._chapterOccurrences.has(key)) {
      const locs = this.findOccurrencesInChapter(name, filePath, headingLine, headingLevel);
      this._chapterOccurrences.set(key, locs);
      this._chapterClickIndex.set(key, 0);
    }

    const locs = this._chapterOccurrences.get(key)!;

    if (locs.length === 0) {
      const uri    = vscode.Uri.file(filePath);
      const doc    = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const pos    = new vscode.Position(headingLine, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
      return;
    }

    const idx = this._chapterClickIndex.get(key)!;
    this._chapterClickIndex.set(key, (idx + 1) % locs.length);

    const loc    = locs[idx];
    const uri    = vscode.Uri.file(loc.file);
    const doc    = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    const start = new vscode.Position(loc.line, loc.col);
    const end   = new vscode.Position(loc.line, loc.col + loc.length);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.AtTop);

    vscode.window.setStatusBarMessage(
      `$(person) ${name}  —  ${idx + 1} / ${locs.length} in chapter`,
      3000
    );
  }

  private findOccurrencesInChapter(
    name:         string,
    filePath:     string,
    headingLine:  number,
    headingLevel: number,
  ): Occurrence[] {
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }

    const lines = content.split('\n');

    let endLine = lines.length;
    for (let i = headingLine + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s/);
      if (m && m[1].length <= headingLevel) { endLine = i; break; }
    }

    const char    = this.findCharByName(name);
    const re      = buildCanonRegex(name, char?.aliases ?? []);
    const results: Occurrence[] = [];

    for (let li = headingLine; li < endLine; li++) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[li])) !== null) {
        results.push({ file: filePath, line: li, col: m.index, length: m[0].length });
      }
    }

    results.reverse();
    return results;
  }

  // ---------------------------------------------------------------------------
  // Novel content
  // ---------------------------------------------------------------------------

  private getNovelContent(): string {
    if (!this.novelFolder || !fs.existsSync(this.novelFolder)) return '';
    return getAllMarkdownFiles(this.novelFolder)
      .filter(f => path.basename(f) !== 'characters.md')
      .map(f => { try { return fs.readFileSync(f, 'utf-8'); } catch { return ''; } })
      .join('\n');
  }

  private countMentions(content: string, char: CanonCharacter): number {
    const re = buildCanonRegex(char.name, char.aliases);
    return (content.match(re) ?? []).length;
  }

  // ---------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------

  private buildHtml(_webview: vscode.Webview): string {
    const chars = this.getCanonCharacters();
    if (chars.length === 0) return this.emptyStateHtml();

    const cfg         = vscode.workspace.getConfiguration('draftScript');
    const showCount   = cfg.get<boolean>('showCharacterCount', true);
    const sorting     = cfg.get<string>('characterSorting', 'appearance');
    const novelContent = showCount ? this.getNovelContent() : '';

    const withCounts = chars.map(c => ({
      ...c,
      mentions: showCount ? this.countMentions(novelContent, c) : 0,
    }));

    if (sorting === 'alphabetical') {
      withCounts.sort((a, b) => a.name.localeCompare(b.name));
    }

    const rows = withCounts.map(c => {
      const safeName = esc(c.name);
      return `
        <div class="char-item">
          <div class="char-header">
            <span class="chevron" onclick="toggleChar(this.closest('.char-item'))">&#x276F;</span>
            <div class="char-info" data-name="${safeName}" onclick="navigateChar(this)">
              <span class="name">${safeName}</span>
              ${showCount
                ? `<span class="badge" title="${c.mentions} mentions">${c.mentions}</span>`
                : ''}
            </div>
          </div>
          <div class="char-chapters" data-name="${safeName}"></div>
        </div>`;
    }).join('');

    const countLegend = showCount
      ? `<div class="legend">Click name to cycle · badge = mentions</div>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    font-size: var(--vscode-font-size);
    margin: 0; padding: 0;
  }
  .legend {
    font-size: 0.72em; opacity: 0.5; text-align: right;
    padding: 4px 10px 2px; cursor: default;
  }
  .char-item { border-bottom: 1px solid var(--vscode-widget-border); }
  .char-item:last-child { border-bottom: none; }
  .char-header {
    display: flex; align-items: center;
    padding: 4px 10px 4px 4px;
  }
  .char-header:hover { background: var(--vscode-list-hoverBackground); }
  .chevron {
    flex-shrink: 0; width: 18px; height: 18px;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.65em; opacity: 0.45; cursor: pointer;
    transition: transform 0.15s; border-radius: 2px;
  }
  .chevron:hover { opacity: 0.9; background: var(--vscode-toolbar-hoverBackground); }
  .chevron.open { transform: rotate(90deg); opacity: 0.7; }
  .char-info {
    display: flex; align-items: center; flex: 1;
    cursor: pointer; overflow: hidden; padding-left: 2px;
    border-radius: 2px;
  }
  .char-info:hover .name { text-decoration: underline; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge {
    flex-shrink: 0; margin-left: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px; padding: 1px 7px;
    font-size: 0.8em; font-weight: 600;
    min-width: 20px; text-align: center;
  }
  .char-chapters { display: none; }
  .char-chapters.open { display: block; }
  .chapter-row {
    display: flex; align-items: center;
    padding: 3px 10px 3px 26px;
    cursor: pointer;
    border-top: 1px solid var(--vscode-widget-border);
    opacity: 0.88;
  }
  .chapter-row:hover { background: var(--vscode-list-hoverBackground); opacity: 1; }
  .chapter-row:hover .ch-title { text-decoration: underline; }
  .ch-title {
    flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 0.88em;
  }
  .ch-count {
    flex-shrink: 0; margin-left: 10px;
    font-size: 0.8em; opacity: 0.55;
    min-width: 14px; text-align: right;
  }
  .ch-loading {
    padding: 4px 10px 4px 26px;
    font-size: 0.82em; opacity: 0.45;
    border-top: 1px solid var(--vscode-widget-border);
  }
</style>
</head>
<body>
${countLegend}
<div class="list">${rows}</div>
<script>
  const vscode = acquireVsCodeApi();

  function toggleChar(item) {
    const body = item.querySelector('.char-chapters');
    const chev = item.querySelector('.chevron');
    if (body.classList.contains('open')) {
      body.classList.remove('open');
      chev.classList.remove('open');
    } else {
      body.classList.add('open');
      chev.classList.add('open');
      if (!body.dataset.loaded) {
        body.innerHTML = '<div class="ch-loading">Loading…</div>';
        vscode.postMessage({ command: 'getChapters', name: body.dataset.name });
      }
    }
  }

  function navigateChar(el) {
    vscode.postMessage({ command: 'navigate', name: el.dataset.name });
  }

  function openChapter(el) {
    vscode.postMessage({
      command:      'gotoChapter',
      name:         el.dataset.name,
      filePath:     el.dataset.path,
      line:         +el.dataset.line,
      headingText:  el.dataset.heading,
      headingLevel: +el.dataset.level,
    });
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function escAttr(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command !== 'showChapters') return;
    for (const body of document.querySelectorAll('.char-chapters')) {
      if (body.dataset.name !== msg.name) continue;
      body.dataset.loaded = 'true';
      body.innerHTML = msg.chapters.length === 0
        ? '<div class="ch-loading">No appearances found.</div>'
        : msg.chapters.map(ch =>
            '<div class="chapter-row"' +
            ' data-name="'    + escAttr(msg.name)        + '"' +
            ' data-path="'    + escAttr(ch.filePath)     + '"' +
            ' data-line="'    + ch.headingLine            + '"' +
            ' data-heading="' + escAttr(ch.headingText)   + '"' +
            ' data-level="'   + ch.headingLevel           + '"' +
            ' onclick="openChapter(this)">' +
            '<span class="ch-title">' + escHtml(ch.title) + '</span>' +
            '<span class="ch-count">' + ch.count          + '</span>' +
            '</div>'
          ).join('');
      break;
    }
  });
</script>
</body>
</html>`;
  }

  private emptyStateHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html, body { height: 100%; margin: 0;
    font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; padding: 20px; text-align: center; }
  p { margin: 0; opacity: 0.6; font-size: 0.9em; line-height: 1.5; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 8px 18px; font-size: 13px;
    cursor: pointer; border-radius: 2px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <p>No characters found.<br>Add them in the Canon Editor or run DSM analysis.</p>
  <button onclick="vscode.postMessage({command:'openCanonEditor'})">Open Canon Editor</button>
  <script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;')
          .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
