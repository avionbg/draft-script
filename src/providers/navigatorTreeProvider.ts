import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { countWords, parseHeadings, HeadingNode } from '../utils/markdownParser';

// ---------------------------------------------------------------------------
// Tree item
// ---------------------------------------------------------------------------

export type NavigatorItemKind = 'folder' | 'file' | 'heading';

export class NavigatorItem extends vscode.TreeItem {
  /** Raw word count stored for parent-folder accumulation. */
  readonly wordCount: number;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: NavigatorItemKind,
    public readonly itemFilePath: string | undefined,
    public readonly itemLine: number | undefined,
    wordCount: number | undefined,
    public readonly children: NavigatorItem[],
    /** Only set for heading items — passed to openAtLine for chapter-focus mode. */
    public readonly headingLevel?: number,
    /** Whether this heading's chapter has a DSM analysis file. */
    analyzed?: boolean,
    /** Whether the chapter content changed since the last DSM scan. */
    stale?: boolean
  ) {
    super(label, collapsibleState);
    this.wordCount = wordCount ?? 0;

    const showWC = vscode.workspace
      .getConfiguration('draftScript')
      .get<boolean>('showTreeWordCount', true);

    if (showWC && this.wordCount > 0) {
      this.description = `${this.wordCount.toLocaleString()} w`;
      this.tooltip = `${this.wordCount.toLocaleString()} words`;
    }

    // Heading items: pass heading title + level so openAtLine can open a virtual
    // chapter document in focus mode without needing to re-parse the file.
    if (kind === 'heading' && itemFilePath && itemLine !== undefined) {
      this.command = {
        command: 'draftScript.openAtLine',
        title: 'Go to heading',
        arguments: [itemFilePath, itemLine, label as string, headingLevel],
      };
    } else if (itemFilePath) {
      this.command = {
        command: 'vscode.open',
        title: 'Open file',
        arguments: [vscode.Uri.file(itemFilePath)],
      };
    }

    switch (kind) {
      case 'folder':
        this.iconPath = new vscode.ThemeIcon('folder');
        break;
      case 'file':
        this.iconPath = new vscode.ThemeIcon('markdown');
        this.contextValue = 'draftScriptFile';
        break;
      case 'heading':
        if ((headingLevel ?? 1) === 1) {
          this.iconPath = stale
            ? new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.orange'))
            : analyzed
              ? new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
              : new vscode.ThemeIcon('circle-large-outline');
        } else {
          this.label = '   ' + (label as string);
        }
        this.contextValue = 'draftScriptHeading';
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Tree data provider
// ---------------------------------------------------------------------------

export class NavigatorTreeProvider implements vscode.TreeDataProvider<NavigatorItem> {
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<NavigatorItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Maps chapter title → stored contentHash from its analysis file. */
  private analyzedHashes: Map<string, string> = new Map();

  constructor(private novelFolder: string) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setNovelFolder(folder: string): void {
    this.novelFolder = folder;
    this.refresh();
  }

  getTreeItem(element: NavigatorItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: NavigatorItem): NavigatorItem[] {
    if (element) return element.children;
    if (!this.novelFolder || !fs.existsSync(this.novelFolder)) return [];
    this.analyzedHashes = this.loadAnalyzedHashes();
    return this.buildFolderChildren(this.novelFolder);
  }

  private loadAnalyzedHashes(): Map<string, string> {
    const map = new Map<string, string>();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return map;
    const chaptersDir = path.join(root, '.draft-script', 'analysis', 'chapters');
    if (!fs.existsSync(chaptersDir)) return map;
    try {
      for (const name of fs.readdirSync(chaptersDir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(chaptersDir, name), 'utf-8'));
          if (data?.chapter?.title && data?.chapter?.contentHash) {
            map.set(data.chapter.title as string, data.chapter.contentHash as string);
          }
        } catch { /* skip corrupt files */ }
      }
    } catch { /* skip unreadable dir */ }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Builders
  // ---------------------------------------------------------------------------

  private buildFolderChildren(dir: string): NavigatorItem[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    // Directories first, then files; each group sorted alphanumerically
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });

    const excluded = new Set<string>(
      vscode.workspace.getConfiguration('draftScript').get<string[]>('navigatorExclude', [])
    );

    const items: NavigatorItem[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'characters.md') continue;
      if (entry.isDirectory() && excluded.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const folderItem = this.buildFolderItem(fullPath, entry.name);
        if (folderItem) items.push(folderItem);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        const fileItem = this.buildFileItem(fullPath);
        if (fileItem) items.push(fileItem);
      }
    }
    return items;
  }

  private buildFolderItem(folderPath: string, name: string): NavigatorItem | null {
    const children = this.buildFolderChildren(folderPath);
    const totalWC = children.reduce((sum, c) => sum + c.wordCount, 0);

    return new NavigatorItem(
      name,
      vscode.TreeItemCollapsibleState.Expanded,
      'folder',
      undefined,
      undefined,
      totalWC || undefined,
      children
    );
  }

  private buildFileItem(filePath: string): NavigatorItem | null {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const fileWC = countWords(content);
    const lines = content.split('\n');
    const headings = parseHeadings(content);
    const headingChildren = this.buildHeadingItems(headings, filePath, lines);

    return new NavigatorItem(
      path.basename(filePath, '.md'),
      headingChildren.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
      'file',
      filePath,
      undefined,
      fileWC,
      headingChildren
    );
  }

  private buildHeadingItems(
    headings: HeadingNode[],
    filePath: string,
    lines: string[]
  ): NavigatorItem[] {
    return headings.map(h => {
      const children    = this.buildHeadingItems(h.children, filePath, lines);
      const sectionText = this.extractSectionText(h, lines);
      const sectionWC   = countWords(sectionText);

      const storedHash  = h.level === 1 ? this.analyzedHashes.get(h.title) : undefined;
      const analyzed    = storedHash !== undefined;
      const stale       = analyzed && storedHash !== sectionHash(sectionText);

      return new NavigatorItem(
        h.title,
        children.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
        'heading',
        filePath,
        h.line,
        sectionWC,
        children,
        h.level,
        analyzed,
        stale
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract all lines belonging to this heading section (inclusive of the heading
   * itself, up to but not including the next heading of equal or higher rank).
   */
  private extractSectionText(heading: HeadingNode, lines: string[]): string {
    let end = lines.length;
    for (let i = heading.line + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s/);
      if (m && m[1].length <= heading.level) {
        end = i;
        break;
      }
    }
    return lines.slice(heading.line, end).join('\n');
  }
}

function sectionHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}
