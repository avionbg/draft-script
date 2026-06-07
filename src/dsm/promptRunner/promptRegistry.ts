import * as vscode from 'vscode';
import { PromptDefinition } from './types';
import { loadPrompts } from './promptLoader';

export class PromptRegistry implements vscode.Disposable {
  private prompts = new Map<string, PromptDefinition>();
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(private readonly rootFolder: string) {}

  load(): void {
    this.prompts = loadPrompts(this.rootFolder);
  }

  watch(context: vscode.ExtensionContext): void {
    const pattern = new vscode.RelativePattern(this.rootFolder, '.draft-script/prompts/*.md');
    this.watcher  = vscode.workspace.createFileSystemWatcher(pattern);
    const reload  = () => { this.prompts = loadPrompts(this.rootFolder); };
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
    context.subscriptions.push(this.watcher);
  }

  getAll(): PromptDefinition[] {
    return [...this.prompts.values()];
  }

  get(id: string): PromptDefinition | undefined {
    return this.prompts.get(id);
  }

  dispose(): void {
    this.watcher?.dispose();
  }
}
