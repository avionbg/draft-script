import * as vscode from 'vscode';

/**
 * Provides read-only content for a single, fixed virtual document:
 *   draft-focus://current/chapter.md
 *
 * Because the URI never changes, VS Code always reuses the same editor tab.
 * Clicking a different chapter simply fires onDidChange, VS Code re-calls
 * provideTextDocumentContent(), and the tab content updates in-place.
 * No real files, no virtual filesystem, no tab pile-up.
 */
export class ChapterContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'draft-focus';

  /** The single tab URI — always the same so VS Code reuses it. */
  static readonly uri = vscode.Uri.parse(
    `${ChapterContentProvider.scheme}://current/chapter.md`
  );

  // Static fields let the analytics provider read source context without
  // requiring a direct reference to this instance.

  /** Absolute path of the source .md file containing the current chapter. */
  static currentSourcePath = '';

  /** Zero-based line number of the heading in the source file.
   *  Analytics adds this offset when building navigation jump targets. */
  static currentHeadingLine = 0;

  private _content = '';
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  /** Update the tab content and source-position metadata. */
  show(chapterText: string, sourcePath: string, headingLine: number): void {
    this._content = chapterText;
    ChapterContentProvider.currentSourcePath = sourcePath;
    ChapterContentProvider.currentHeadingLine = headingLine;
    // Notify VS Code to re-call provideTextDocumentContent for our URI
    this._onDidChange.fire(ChapterContentProvider.uri);
  }

  provideTextDocumentContent(_uri: vscode.Uri): string {
    return this._content;
  }
}
