import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAllMarkdownFiles } from '../utils/markdownParser';

interface NoteEntry {
  id: number;
  excerpt: string;
  comment: string;
}

export class CommentsWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly getRootFolder: () => string,
    private readonly getNovelFolder: () => string,
  ) {}

  refresh(): void {
    if (this._view) this._view.webview.html = this.buildHtml();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml();

    webviewView.webview.onDidReceiveMessage(async msg => {
      if (msg.command === 'navigate') await this.navigateTo(msg.id);
    });
  }

  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  private parseNotes(): NoteEntry[] {
    const notesPath = path.join(this.getRootFolder(), 'notes.md');
    let raw: string;
    try { raw = fs.readFileSync(notesPath, 'utf-8'); }
    catch { return []; }

    const entries: NoteEntry[] = [];
    // Split on "<!-- Link-N -->" markers — produces [preamble, id, body, id, body, ...]
    const parts = raw.split(/\n<!-- Link-(\d+) -->\n/);

    for (let i = 1; i < parts.length; i += 2) {
      const id      = parseInt(parts[i], 10);
      const body    = parts[i + 1] ?? '';

      const excerptMatch = body.match(/^((?:>.*\n?)+)/m);
      const excerpt = excerptMatch
        ? excerptMatch[1].replace(/^>\s?/gm, '').replace(/\n/g, ' ').trim()
        : '';

      const afterExcerpt = excerptMatch
        ? body.slice(excerptMatch.index! + excerptMatch[0].length)
        : body;

      const comment = afterExcerpt
        .replace(/^---\s*$/gm, '')
        .replace(/^\*\(no comment\)\*$/gm, '')
        .trim();

      entries.push({ id, excerpt, comment });
    }

    return entries;
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  private findLocation(id: number): { file: string; line: number; col: number } | undefined {
    const novelFolder = this.getNovelFolder();
    if (!novelFolder || !fs.existsSync(novelFolder)) return;

    const openTag = `<!--link-${id}-->`;

    for (const file of getAllMarkdownFiles(novelFolder)) {
      let content: string;
      try { content = fs.readFileSync(file, 'utf-8'); }
      catch { continue; }

      const lines = content.split('\n');
      for (let li = 0; li < lines.length; li++) {
        const col = lines[li].indexOf(openTag);
        if (col !== -1) return { file, line: li, col };
      }
    }
  }

  private async navigateTo(id: number): Promise<void> {
    const loc = this.findLocation(id);
    if (!loc) {
      vscode.window.showWarningMessage(`Draft-Script: Link ${id} not found in any novel file.`);
      return;
    }

    const doc    = await vscode.workspace.openTextDocument(vscode.Uri.file(loc.file));
    const editor = await vscode.window.showTextDocument(doc);
    const pos    = new vscode.Position(loc.line, loc.col);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
  }

  // ---------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------

  private buildHtml(): string {
    const entries = this.parseNotes();

    if (entries.length === 0) {
      return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 12px; opacity: 0.6; font-size: 0.9em; margin: 0; }
</style>
</head>
<body>No comments yet. Select text and use <em>Add Comment</em> to annotate a passage.</body>
</html>`;
    }

    const rows = entries.map(e => {
      const clean = stripMd(e.excerpt);
      const excerpt = clean.length > 80
        ? esc(clean.slice(0, 80)) + '…'
        : esc(clean);
      const comment = e.comment ? esc(stripMd(e.comment)) : '';

      return `<div class="note" data-id="${e.id}" onclick="navigate(${e.id})">
  <div class="note-header"><span class="link-id">#${e.id}</span> ${excerpt}</div>
  ${comment ? `<div class="comment">${comment}</div>` : ''}
</div>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         font-size: var(--vscode-font-size); margin: 0; padding: 0; }
  .note {
    padding: 5px 10px;
    border-bottom: 1px solid var(--vscode-widget-border);
    cursor: pointer;
    display: flex;
    flex-direction: row;
  }
  .note:last-child { border-bottom: none; }
  .note:hover { background: var(--vscode-list-hoverBackground); }
  .note-header {
    text-overflow: ellipsis;white-space: nowrap;
    font-size: 0.88em;
  }
  .link-id { font-size: 1; font-weight: 400; }
  .comment {
    font-size: 1em;
    margin-top: 2px; padding-left: 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
</style>
</head>
<body>
${rows}
<script>
  const vscode = acquireVsCodeApi();
  function navigate(id) {
    vscode.postMessage({ command: 'navigate', id });
  }
</script>
</body>
</html>`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripMd(s: string): string {
  return s
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n/g, ' ')
    .trim();
}
