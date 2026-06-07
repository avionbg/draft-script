import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface ChapterMeta {
  sourcePath: string;
  headingText: string;
  headingLevel: number;
}

/**
 * Virtual filesystem provider (scheme: "draft-chapter") that exposes a single
 * section of a Markdown file as a standalone editable document.
 *
 * Read  → extract lines from heading to next sibling/parent heading.
 * Write → locate the heading in the source file by text match, replace only
 *         those lines, write back. This survives content edits that shift line
 *         numbers because it re-scans on every save.
 */
export class ChapterFileSystemProvider implements vscode.FileSystemProvider {
  static readonly scheme = 'draft-chapter';

  private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._emitter.event;

  // hash → ChapterMeta  (hash is also embedded in the URI path for extraction)
  private readonly _registry = new Map<string, ChapterMeta>();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Register a chapter section and return a URI for `openTextDocument`.
   *
   * The URI path is entirely ASCII so VS Code never mutates it through
   * percent-encoding normalisation, which would break the registry lookup.
   * The 8-character FNV-32 hash at the end of the filename acts as the stable
   * key; it is extracted by all provider methods so the lookup never relies on
   * `uri.toString()` equality.
   */
  registerChapter(meta: ChapterMeta): vscode.Uri {
    const hash = fnv32(`${meta.sourcePath}\0${meta.headingLevel}\0${meta.headingText}`);

    if (!this._registry.has(hash)) {
      this._registry.set(hash, meta);
    }

    // Strip non-ASCII for a readable tab label without encoding surprises
    const label = meta.headingText
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')  // remove combining diacritics (é→e, č→c)
      .replace(/[đĐ]/g, 'd')
      .replace(/[^a-zA-Z0-9 \-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40) || 'chapter';

    // Format: draft-chapter:///a1b2c3d4/Chapter-Name.md
    // Hash lives in the directory segment so the tab label shows just the chapter name.
    return vscode.Uri.parse(
      `${ChapterFileSystemProvider.scheme}:///${hash}/${label}.md`
    );
  }

  /** Extract the FNV-32 hash from the first path segment (works for both file and parent-dir URIs). */
  private hashFromUri(uri: vscode.Uri): string | undefined {
    const first = uri.path.split('/').find(s => s.length > 0);
    return first && /^[0-9a-f]{8}$/.test(first) ? first : undefined;
  }

  // ---------------------------------------------------------------------------
  // Section helpers
  // ---------------------------------------------------------------------------

  private readSection(meta: ChapterMeta): string {
    let raw: string;
    try {
      raw = fs.readFileSync(meta.sourcePath, 'utf-8');
    } catch {
      return `${'#'.repeat(meta.headingLevel)} ${meta.headingText}\n\n*(source file not found)*\n`;
    }

    const lines = raw.split('\n');
    const start = this.findHeadingLine(lines, meta);
    if (start === -1) {
      return `${'#'.repeat(meta.headingLevel)} ${meta.headingText}\n\n*(heading not found in source)*\n`;
    }

    const end = this.findSectionEnd(lines, start, meta.headingLevel);
    return lines.slice(start, end).join('\n');
  }

  private writeSection(meta: ChapterMeta, newContent: string): void {
    let raw: string;
    try {
      raw = fs.readFileSync(meta.sourcePath, 'utf-8');
    } catch {
      vscode.window.showErrorMessage(`Draft-Script: Cannot read source file:\n${meta.sourcePath}`);
      return;
    }

    const lines = raw.split('\n');
    const start = this.findHeadingLine(lines, meta);
    if (start === -1) {
      // Heading was removed externally — warn and bail out to avoid corruption
      vscode.window.showWarningMessage(
        `Draft-Script: Heading "${meta.headingText}" was not found in the source. Save aborted.`
      );
      return;
    }

    const end = this.findSectionEnd(lines, start, meta.headingLevel);
    const newLines = newContent.split('\n');

    const merged = [
      ...lines.slice(0, start),
      ...newLines,
      ...lines.slice(end),
    ].join('\n');

    fs.writeFileSync(meta.sourcePath, merged, 'utf-8');
  }

  /**
   * Locate the heading line by level + exact text match.
   * Re-scanning on each call means we tolerate line-number drift caused by
   * editing other sections.
   */
  private findHeadingLine(lines: string[], meta: ChapterMeta): number {
    const prefix = '#'.repeat(meta.headingLevel) + ' ';
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(prefix) && lines[i].slice(prefix.length).trim() === meta.headingText) {
        return i;
      }
    }
    return -1;
  }

  /** Returns the line index of the next heading at the same or higher rank (lower level number). */
  private findSectionEnd(lines: string[], start: number, level: number): number {
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,6})\s/);
      if (m && m[1].length <= level) return i;
    }
    return lines.length;
  }

  // ---------------------------------------------------------------------------
  // FileSystemProvider implementation
  // ---------------------------------------------------------------------------

  watch(): vscode.Disposable {
    // Active watching is not implemented — the author saves explicitly via Ctrl+S
    return new vscode.Disposable(() => { /* noop */ });
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const hash = this.hashFromUri(uri);
    if (!hash || !this._registry.has(hash)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const isDir = !uri.path.endsWith('.md');
    return { type: isDir ? vscode.FileType.Directory : vscode.FileType.File, ctime: 0, mtime: Date.now(), size: 0 };
  }

  readDirectory(): [string, vscode.FileType][] {
    throw vscode.FileSystemError.NoPermissions('draft-chapter URIs are files, not directories.');
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const hash = this.hashFromUri(uri);
    const meta = hash ? this._registry.get(hash) : undefined;
    if (!meta) throw vscode.FileSystemError.FileNotFound(uri);
    return Buffer.from(this.readSection(meta), 'utf-8');
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { readonly create: boolean; readonly overwrite: boolean }
  ): void {
    const hash = this.hashFromUri(uri);
    const meta = hash ? this._registry.get(hash) : undefined;
    if (!meta) throw vscode.FileSystemError.FileNotFound(uri);
    this.writeSection(meta, Buffer.from(content).toString('utf-8'));
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('Draft-Script: cannot delete chapter views.');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Draft-Script: cannot rename chapter views.');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** FNV-32a hash — fast, good distribution, returns 8 lowercase hex digits. */
function fnv32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
