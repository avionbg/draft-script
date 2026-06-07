import * as vscode from 'vscode';

export class VirtualDocumentProvider implements vscode.TextDocumentContentProvider {
  static readonly PREVIEW_SCHEME = 'draft-script-preview';
  static readonly RESULT_SCHEME  = 'draft-script-result';

  private readonly docs         = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly          onDidChange = this._onDidChange.event;

  constructor(readonly scheme: string) {}

  set(key: string, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: this.scheme, path: `/${key}.md` });
    this.docs.set(uri.toString(), content);
    this._onDidChange.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
