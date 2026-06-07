import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Matches <!--link-N-->CONTENT<!--/link-N--> including across lines
const LINK_RE = /<!--link-(\d+)-->([\s\S]*?)<!--\/link-\1-->/g;

interface ParsedLink {
  id: number;
  openTag: vscode.Range;
  content: vscode.Range;
  closeTag: vscode.Range;
}

export class CommentDecorationProvider
  implements vscode.DefinitionProvider, vscode.HoverProvider {

  // Tag text is hidden (opacity 0) and collapsed (large negative letterSpacing).
  // The visible link ID is injected per-range via renderOptions.before at setDecorations time.
  private readonly tagDecoration: vscode.TextEditorDecorationType;
  private readonly annotationDecoration: vscode.TextEditorDecorationType;

  constructor(private readonly getRootFolder: () => string) {
    this.tagDecoration = vscode.window.createTextEditorDecorationType({
      opacity: '0',
      letterSpacing: '-100px',
    });

    this.annotationDecoration = vscode.window.createTextEditorDecorationType({
      textDecoration: 'underline dotted',
      cursor: 'pointer',
    });
  }

  dispose(): void {
    this.tagDecoration.dispose();
    this.annotationDecoration.dispose();
  }

  private parseLinks(document: vscode.TextDocument): ParsedLink[] {
    const text = document.getText();
    const results: ParsedLink[] = [];
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = LINK_RE.exec(text)) !== null) {
      const id = parseInt(m[1], 10);
      const openTagLen  = `<!--link-${id}-->`.length;
      const closeTagLen = `<!--/link-${id}-->`.length;
      const openStart   = m.index;
      const openEnd     = openStart + openTagLen;
      const contEnd     = openEnd + m[2].length;
      const closeEnd    = contEnd + closeTagLen;

      results.push({
        id,
        openTag:  new vscode.Range(document.positionAt(openStart), document.positionAt(openEnd)),
        content:  new vscode.Range(document.positionAt(openEnd),   document.positionAt(contEnd)),
        closeTag: new vscode.Range(document.positionAt(contEnd),   document.positionAt(closeEnd)),
      });
    }

    return results;
  }

  /** Extract the body of a note entry from notes.md, stripping the trailing separator. */
  private readNote(id: number): string | undefined {
    const notesPath = path.join(this.getRootFolder(), 'notes.md');
    let raw: string;
    try { raw = fs.readFileSync(notesPath, 'utf-8'); }
    catch { return undefined; }

    const heading = `<!-- Link-${id} -->`;
    const headingIdx = raw.indexOf(`${heading}\n`);
    if (headingIdx === -1) return undefined;

    const bodyStart = headingIdx + heading.length + 1;
    const nextSection = raw.indexOf('\n<!-- Link-', bodyStart);
    const body = nextSection === -1 ? raw.slice(bodyStart) : raw.slice(bodyStart, nextSection);

    return body.replace(/\n?---\s*$/, '').trim() || undefined;
  }

  updateDecorations(editor: vscode.TextEditor): void {
    if (editor.document.languageId !== 'markdown') return;

    const links = this.parseLinks(editor.document);

    // Open tags get a small italic ID badge before them; close tags are just collapsed.
    editor.setDecorations(this.tagDecoration, [
      ...links.map(l => ({
        range: l.openTag,
        renderOptions: {
          before: {
            contentText: `${l.id}`,
            color: new vscode.ThemeColor('editorCodeLens.foreground'),
            fontStyle: 'italic',
            margin: '0 1px',
          },
        },
      })),
      ...links.map(l => ({ range: l.closeTag })),
    ]);

    editor.setDecorations(
      this.annotationDecoration,
      links.map(l => l.content),
    );
  }

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location | undefined {
    if (document.languageId !== 'markdown') return;

    const links = this.parseLinks(document);
    const link = links.find(l => l.content.contains(position));
    if (!link) return;

    const notesPath = path.join(this.getRootFolder(), 'notes.md');
    let raw: string;
    try { raw = fs.readFileSync(notesPath, 'utf-8'); }
    catch { return; }

    const lineIndex = raw.split('\n').findIndex(l => l.trim() === `<!-- Link-${link.id} -->`);
    if (lineIndex < 0) return;

    const pos = new vscode.Position(lineIndex, 0);
    return new vscode.Location(vscode.Uri.file(notesPath), pos);
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    if (document.languageId !== 'markdown') return;

    const links = this.parseLinks(document);
    const link = links.find(l =>
      l.openTag.contains(position) ||
      l.content.contains(position) ||
      l.closeTag.contains(position),
    );
    if (!link) return;

    const note = this.readNote(link.id);
    const idBadge = `<div style="text-align:right;font-size:0.75em;opacity:0.4;margin-bottom:2px">#${link.id}</div>`;
    const body   = note ?? '*(no note found in notes.md)*';
    const md = new vscode.MarkdownString(`${idBadge}\n\n${body}`);
    md.isTrusted    = true;
    md.supportHtml  = true;

    return new vscode.Hover(md, new vscode.Range(link.openTag.start, link.closeTag.end));
  }
}
