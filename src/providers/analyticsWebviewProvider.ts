import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAllMarkdownFiles, countWords } from '../utils/markdownParser';
import { ChapterContentProvider } from './chapterContentProvider';
import { ChapterFileSystemProvider } from './chapterFileSystemProvider';
import { PromptRegistry } from '../dsm/promptRunner/promptRegistry';
import { LINE_EDIT_PROMPT_MISSING, renderLineEditPrompt } from '../dsm/promptRunner/lineEditPrompt';
import { createLlmProvider } from '../dsm/llmProviders';

// ---------------------------------------------------------------------------
// Stop-words
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
  'the','and','a','an','in','on','at','to','for','of','with','is','was',
  'are','were','be','been','being','have','has','had','do','does','did',
  'but','if','or','as','it','its','this','that','he','she','they','we',
  'you','i','me','him','her','them','us','my','his','their','our',
  'your','not','by','from','so','what','which','who','when','where','how',
  'all','would','will','can','could','should','may','might','then','than',
  'no','up','out','about','into','through','after','before','between',
  'each','more','also','just','get','got','said','says','like','one',
  'two','three','four','five','over','under','such','these','those',
  'some','any','only','even','very','still','back','way','down',
]);

// ---------------------------------------------------------------------------
// Analysis constants
// ---------------------------------------------------------------------------

const CACHE_VERSION = 2;
const MAX_NGRAM     = 5;
const WORD_RE       = /(?<!\p{L})(\p{L}{2,})(?!\p{L})/gu;

// FNV-1a hash of every parameter that affects analysis output.
// Bump CACHE_VERSION whenever you change the cache schema itself.
// Changing any value below automatically invalidates old disk caches.
const SETTINGS_HASH = ((): string => {
  const cfg = JSON.stringify({
    v:           CACHE_VERSION,
    stopWords:   [...STOP_WORDS].sort(),
    minNgram:    1,
    maxNgram:    MAX_NGRAM,
    minCount1:   3,
    minCountN:   2,
    maxItems:    50,
    coverage:    0.9,
    wordPattern: `/${WORD_RE.source}/${WORD_RE.flags}`,
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < cfg.length; i++) { h ^= cfg.charCodeAt(i); h = Math.imul(h, 0x01000193) | 0; }
  return (h >>> 0).toString(16).padStart(8, '0');
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Occurrence {
  file: string;
  line: number;
  col: number;
  wordStart: number;
}

interface NgramItem {
  text: string;
  count: number;
}

interface AnalysisResult {
  totalWords: number;
  uniqueWords: number;
  standardPages: number;
  groups: Array<{ n: number; items: NgramItem[] }>;
}

interface CacheSource {
  path:  string;   // relative to project root, forward slashes
  mtime: number;
  size?: number;
}

interface AnalyticsCache {
  version:      number;
  sourceMode:   'singleFile' | 'multiFile';
  settingsHash: string;
  generatedAt:  string;  // ISO timestamp
  sources:      CacheSource[];
  result:       AnalysisResult;
  occurrences:  Record<string, Occurrence[]>;  // paths relative to project root
}

interface SentenceTarget {
  id: string;
  filePath: string;
  range: vscode.Range;
  text: string;
  phrase: string;
  context: string;
  line: number;
  occurrenceIndex: number;
  before: string;
  after: string;
}

interface LineEditSuggestion extends SentenceTarget {
  id: string;
  replacement: string;
  reason: string;
  confidence: number;
  shouldChange: boolean;
  documentVersion: number;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class RepetitionWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _locked = false;

  /** phrase → all positions in the analyzed text (used for click-navigation) */
  private occurrences = new Map<string, Occurrence[]>();
  /** phrase → index of next occurrence to jump to */
  private clickIndex = new Map<string, number>();

  private currentEditor: vscode.TextEditor | undefined;

  private memCache: {
    result:       AnalysisResult;
    occurrences:  Map<string, Occurrence[]>;
    fileMtimes:   Map<string, number>;
    chapterKey:   string | null;  // null = novel scope
  } | null = null;

  /** Most recently computed result — rendered immediately when the view opens. */
  private lastResult: AnalysisResult | null = null;
  /** Title of the chapter that produced lastResult; null when scope is novel. */
  private lastChapterTitle: string | null = null;
  /** Non-null while a full scan is running; prevents duplicate concurrent scans. */
  private analysisPromise: Promise<void> | null = null;

  constructor(
    private novelFolder: string,
    private readonly getRootFolder: () => string,
    private readonly promptRegistry: PromptRegistry,
  ) {}

  refreshForEditor(editor: vscode.TextEditor | undefined): void {
    this.currentEditor = editor;
    this.render();
    this.kickoffAnalysis();
  }

  setNovelFolder(folder: string): void {
    this.novelFolder      = folder;
    this.memCache         = null;
    this.lastResult       = null;
    this.lastChapterTitle = null;
    this.occurrences.clear();
    this.clickIndex.clear();
    this.render();
    this.kickoffAnalysis();
  }

  toggleLock(): void {
    this._locked = !this._locked;
    vscode.commands.executeCommand('setContext', 'draftScript.repetitionLocked', this._locked);
    this.memCache         = null;
    this.lastResult       = null;
    this.lastChapterTitle = null;
    this.occurrences.clear();
    this.clickIndex.clear();
    this.render();
    this.kickoffAnalysis();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async msg => {
      if (msg.command === 'navigate') {
        await this.navigateTo(msg.phrase as string);
      } else if (msg.command === 'lineEditOccurrence') {
        await this.suggestLineEditForOccurrence(msg.phrase as string);
      } else if (msg.command === 'lineEditChapter') {
        await this.suggestLineEditsForChapter(msg.phrase as string);
      }
    });

    this.kickoffAnalysis();
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  private async navigateTo(phrase: string): Promise<void> {
    const key = phrase.toLowerCase();
    const locs = this.occurrences.get(key) ?? [];
    if (locs.length === 0) return;

    const idx = this.clickIndex.get(key) ?? 0;
    this.clickIndex.set(key, (idx + 1) % locs.length);

    const loc = locs[idx];
    const uri = vscode.Uri.file(loc.file);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);

    const start = new vscode.Position(loc.line, loc.col);
    const end   = new vscode.Position(loc.line, loc.col + phrase.length);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
  }

  // ---------------------------------------------------------------------------
  // Line edits
  // ---------------------------------------------------------------------------

  private async suggestLineEditForOccurrence(phrase: string): Promise<void> {
    const target = await this.resolveCurrentOrNextSentenceTarget(phrase);
    if (!target) return;
    const suggestions = await this.generateLineEditSuggestions([target], `DSM: Suggesting line edit for "${phrase}"...`);
    if (suggestions.length) LineEditReviewPanel.open(suggestions);
  }

  async suggestLineEditsForSelectedPhrase(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const phrase = editor?.document.getText(editor.selection).trim() ?? '';
    if (!phrase) {
      vscode.window.showWarningMessage('Draft-Script: Select a repeated phrase first.');
      return;
    }
    await this.suggestLineEditsForChapter(phrase);
  }

  private async suggestLineEditsForChapter(phrase: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.sentenceTargetFromSelection(editor, phrase)) {
      await this.navigateTo(phrase);
    }

    const targets = await this.collectChapterSentenceTargets(phrase);
    if (!targets.length) {
      vscode.window.showInformationMessage(`Draft-Script: No "${phrase}" occurrences found in the current chapter.`);
      return;
    }

    let selected = targets;
    if (targets.length > 20) {
      const choice = await vscode.window.showWarningMessage(
        `This chapter has ${targets.length} occurrences. Generate suggestions for the first 20?`,
        { modal: true },
        'Continue',
      );
      if (choice !== 'Continue') return;
      selected = targets.slice(0, 20);
    }

    const suggestions = await this.generateLineEditSuggestions(selected, `DSM: Suggesting ${selected.length} line edits...`);
    if (suggestions.length) LineEditReviewPanel.open(suggestions);
  }

  private async resolveCurrentOrNextSentenceTarget(phrase: string): Promise<SentenceTarget | null> {
    const editor = vscode.window.activeTextEditor;
    const active = editor ? this.sentenceTargetFromSelection(editor, phrase) : null;
    if (active) return active;

    await this.navigateTo(phrase);
    const nextEditor = vscode.window.activeTextEditor;
    return nextEditor ? this.sentenceTargetFromSelection(nextEditor, phrase) : null;
  }

  private sentenceTargetFromSelection(editor: vscode.TextEditor, phrase: string): SentenceTarget | null {
    const selected = editor.document.getText(editor.selection);
    if (!selected || selected.toLowerCase() !== phrase.toLowerCase()) return null;
    return this.sentenceTargetAt(editor.document, editor.document.offsetAt(editor.selection.start), phrase);
  }

  private async collectChapterSentenceTargets(phrase: string): Promise<SentenceTarget[]> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return [];

    const chapter = editor.document.uri.scheme === 'file'
      ? this.chapterSource(editor)
      : null;
    if (!chapter) return [];

    const doc = editor.document;
    const chapterStart = doc.offsetAt(new vscode.Position(chapter.lineOffset, 0));
    const chapterEnd = chapterStart + chapter.content.length;
    const locs = (this.occurrences.get(phrase.toLowerCase()) ?? [])
      .filter(loc => loc.file === doc.uri.fsPath)
      .map(loc => doc.offsetAt(new vscode.Position(loc.line, loc.col)))
      .filter(offset => offset >= chapterStart && offset <= chapterEnd)
      .sort((a, b) => a - b);

    const seen = new Set<string>();
    const targets: SentenceTarget[] = [];
    for (const offset of locs) {
      const target = this.sentenceTargetAt(doc, offset, phrase);
      if (!target) continue;
      const key = `${target.range.start.line}:${target.range.start.character}-${target.range.end.line}:${target.range.end.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ ...target, id: `item-${targets.length + 1}`, occurrenceIndex: targets.length + 1 });
    }
    return targets;
  }

  private sentenceTargetAt(doc: vscode.TextDocument, phraseOffset: number, phrase: string): SentenceTarget | null {
    const text = doc.getText();
    if (phraseOffset < 0 || phraseOffset >= text.length) return null;

    const start = findSentenceStart(text, phraseOffset);
    const end = findSentenceEnd(text, phraseOffset + phrase.length);
    const sentence = text.slice(start, end).trim();
    if (!sentence) return null;

    const beforeStart = Math.max(0, start - 500);
    const afterEnd = Math.min(text.length, end + 500);
    const range = new vscode.Range(doc.positionAt(start), doc.positionAt(end));

    return {
      id: 'item-1',
      filePath: doc.uri.fsPath,
      range,
      text: sentence,
      phrase,
      context: text.slice(beforeStart, afterEnd).trim(),
      line: range.start.line + 1,
      occurrenceIndex: 1,
      before: text.slice(beforeStart, start).trim(),
      after: text.slice(end, afterEnd).trim(),
    };
  }

  private async generateLineEditSuggestions(targets: SentenceTarget[], title: string): Promise<LineEditSuggestion[]> {
    const def = this.promptRegistry.getLineEditPrompt();
    if (!def) {
      vscode.window.showErrorMessage(LINE_EDIT_PROMPT_MISSING);
      return [];
    }

    const warnings = validateLineEditPromptBody(def.body);
    if (warnings.length) console.warn(`[LineEdit] ${warnings.join(' ')}`);

    const items = targets.map((target, index) => ({
      id: target.id || `item-${index + 1}`,
      sentence: target.text,
      contextBefore: target.before,
      contextAfter: target.after,
      line: target.line,
      occurrenceIndex: target.occurrenceIndex || index + 1,
    }));
    const chapterTitle = this.lastChapterTitle ?? '';
    const rendered = renderLineEditPrompt(this.promptRegistry, {
      rootFolder: this.getRootFolder(),
      context: compactLineEditContext(targets),
      phrase: targets[0]?.phrase ?? '',
      sentence: targets[0]?.text ?? '',
      itemsJson: JSON.stringify(items, null, 2),
      chapterTitle,
      filePath: targets[0]?.filePath,
      before: targets[0]?.before,
      after: targets[0]?.after,
      language: 'Serbian',
    });
    if (!rendered) {
      vscode.window.showErrorMessage(LINE_EDIT_PROMPT_MISSING);
      return [];
    }
    if (rendered.warnings.length) console.warn(`[LineEdit] ${rendered.warnings.join(' ')}`);

    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      async progress => {
        progress.report({ message: `${targets.length} item${targets.length === 1 ? '' : 's'}` });
        const cfg = vscode.workspace.getConfiguration('draftScript');
        const llm = createLlmProvider(cfg);
        let raw: string;
        try {
          raw = await llm.complete(rendered.rendered.finalPrompt);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          showLineEditErrorOutput(err);
          vscode.window.showErrorMessage(`Draft-Script: Line edit LLM failed: ${message}`);
          return [];
        }
        const parsed = await parseLineEditBatchResponse(raw, targets);
        if (!parsed.ok) {
          showLineEditRawOutput(raw);
          vscode.window.showErrorMessage('Draft-Script: Line edit LLM returned invalid JSON. No edits were applied.');
          return [];
        }
        for (const warning of parsed.warnings) console.warn(`[LineEdit] ${warning}`);
        return parsed.suggestions;
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------------------------

  private getSources(): { sources: Array<{ content: string; filePath: string; lineOffset: number }>; chapterKey: string | null; chapterTitle: string | null } {
    const editor = this.currentEditor ?? vscode.window.activeTextEditor;
    const doc = editor?.document;
    if (this._locked) return this.novelSources();

    // Focus-mode virtual chapter document (draft-focus:// or draft-chapter://)
    if (doc?.uri.scheme === ChapterContentProvider.scheme ||
        doc?.uri.scheme === ChapterFileSystemProvider.scheme) {
      const src = {
        content:    doc.getText(),
        filePath:   ChapterContentProvider.currentSourcePath,
        lineOffset: ChapterContentProvider.currentHeadingLine,
      };
      const title = doc.getText().split('\n').find(l => l.match(/^#{1,6}\s/))?.replace(/^#{1,6}\s+/, '') ?? 'Chapter';
      return { sources: [src], chapterKey: `${src.filePath}:${src.lineOffset}`, chapterTitle: title };
    }

    // Regular .md file — detect chapter under cursor
    if (editor && doc?.uri.scheme === 'file' && doc.uri.fsPath.toLowerCase().endsWith('.md')) {
      const src = this.chapterSource(editor);
      if (src) {
        const title = src.content.split('\n').find(l => l.match(/^#{1,6}\s/))?.replace(/^#{1,6}\s+/, '') ?? 'Chapter';
        return { sources: [src], chapterKey: `${src.filePath}:${src.lineOffset}`, chapterTitle: title };
      }
    }

    // Novel scope — all .md files in the novel folder
    if (!this.novelFolder || !fs.existsSync(this.novelFolder)) return { sources: [], chapterKey: null, chapterTitle: null };
    const sources = getAllMarkdownFiles(this.novelFolder)
      .filter(f => path.basename(f) !== 'characters.md')
      .flatMap(f => {
        try { return [{ content: fs.readFileSync(f, 'utf-8'), filePath: f, lineOffset: 0 }]; }
        catch { return []; }
      });
    return { sources, chapterKey: null, chapterTitle: null };
  }

  private novelSources(): { sources: Array<{ content: string; filePath: string; lineOffset: number }>; chapterKey: string | null; chapterTitle: string | null } {
    if (!this.novelFolder || !fs.existsSync(this.novelFolder)) {
      return { sources: [], chapterKey: null, chapterTitle: null };
    }

    const sources = getAllMarkdownFiles(this.novelFolder)
      .filter(f => path.basename(f) !== 'characters.md')
      .flatMap(f => {
        try { return [{ content: fs.readFileSync(f, 'utf-8'), filePath: f, lineOffset: 0 }]; }
        catch { return []; }
      });
    return { sources, chapterKey: null, chapterTitle: null };
  }

  private chapterSource(editor: vscode.TextEditor): { content: string; filePath: string; lineOffset: number } | null {
    const lines = editor.document.getText().split('\n');
    const clamp = Math.min(editor.selection.active.line, lines.length - 1);

    let headingLine = -1, headingLevel = 0;
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

    return {
      content:    lines.slice(headingLine, endLine).join('\n'),
      filePath:   editor.document.uri.fsPath,
      lineOffset: headingLine,
    };
  }

  /** Starts a background analysis unless one is already running. */
  private kickoffAnalysis(): void {
    if (this.analysisPromise) return;
    this.analysisPromise = this.runAnalysis().finally(() => {
      this.analysisPromise = null;
    });
  }

  private async runAnalysis(): Promise<void> {
    const { sources, chapterKey, chapterTitle } = this.getSources();

    // ── In-memory cache ──────────────────────────────────────────────────────
    if (this.memCache) {
      const mc = this.memCache;
      if (
        mc.chapterKey === chapterKey &&
        mc.fileMtimes.size === sources.length &&
        sources.every(s => mc.fileMtimes.get(s.filePath) === safeStatMtime(s.filePath))
      ) {
        if (!this.lastResult) {
          if (this.occurrences.size === 0) {
            for (const [k, v] of mc.occurrences) this.occurrences.set(k, v);
          }
          this.lastResult       = mc.result;
          this.lastChapterTitle = chapterTitle;
          this.render();
        }
        return;
      }
    }

    // ── Disk cache (novel scope only) ────────────────────────────────────────
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const cacheFile = !chapterKey && wsRoot
      ? path.join(wsRoot, '.draft-script', 'analytics-cache.json')
      : null;

    if (cacheFile && wsRoot) {
      const disk = tryReadCache(cacheFile);
      if (disk && isCacheValid(disk, sources, wsRoot)) {
        const diskOccs = new Map<string, Occurrence[]>();
        for (const [phrase, occs] of Object.entries(disk.occurrences)) {
          diskOccs.set(phrase, (occs as Occurrence[]).map(o => ({
            ...o,
            file: toAbsPath(o.file, wsRoot),
          })));
        }
        this.occurrences.clear();
        for (const [k, v] of diskOccs) this.occurrences.set(k, v);
        this.memCache = {
          result:      disk.result,
          occurrences: diskOccs,
          fileMtimes:  buildMtimeMap(sources),
          chapterKey:  null,
        };
        this.lastResult       = disk.result;
        this.lastChapterTitle = null;
        this.render();
        return;
      }
    }

    // ── Full async scan ──────────────────────────────────────────────────────
    // Use a local occurrences map so the currently displayed results stay
    // navigable for the entire duration of the scan.
    this.postToWebview({ command: 'progress', phase: 'Scanning chapters...', current: 0, total: sources.length });

    const freqs:     Map<string, number>[] = Array.from({ length: MAX_NGRAM }, () => new Map());
    const localOccs: Map<string, Occurrence[]> = new Map();
    let totalWords = 0;

    for (let srcIdx = 0; srcIdx < sources.length; srcIdx++) {
      const src = sources[srcIdx];
      totalWords += countWords(src.content);

      const lines = src.content.split('\n');
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (line.trim().startsWith('```') || line.trim().startsWith('    ')) continue;
        const stripped = line.replace(/`[^`]+`/g, '');

        const words: { w: string; col: number }[] = [];
        WORD_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = WORD_RE.exec(stripped)) !== null) {
          words.push({ w: m[1].toLowerCase(), col: m.index });
        }

        for (let i = 0; i < words.length; i++) {
          for (let n = 1; n <= MAX_NGRAM && i + n <= words.length; n++) {
            const slice = words.slice(i, i + n);
            if (n === 1) {
              if (slice[0].w.length < 3 || STOP_WORDS.has(slice[0].w)) continue;
            } else {
              if (slice.every(t => STOP_WORDS.has(t.w))) continue;
            }

            const phrase = slice.map(t => t.w).join(' ');
            freqs[n - 1].set(phrase, (freqs[n - 1].get(phrase) ?? 0) + 1);

            if (!localOccs.has(phrase)) localOccs.set(phrase, []);
            localOccs.get(phrase)!.push({
              file:      src.filePath,
              line:      li + src.lineOffset,
              col:       slice[0].col,
              wordStart: i,
            });
          }
        }
      }

      // Yield to the event loop after each source file so the extension host
      // stays responsive throughout the scan.
      await yieldToEventLoop();
      this.postToWebview({ command: 'progress', phase: 'Scanning chapters...', current: srcIdx + 1, total: sources.length });
    }

    // Post-processing — yield before each step so the UI can update.
    this.postToWebview({ command: 'progress', phase: 'Building repetition index...' });
    await yieldToEventLoop();

    // Remove occurrences for sub-threshold phrases — main memory win.
    for (let n = 1; n <= MAX_NGRAM; n++) {
      const minCount = n === 1 ? 3 : 2;
      for (const [phrase, count] of freqs[n - 1]) {
        if (count < minCount) localOccs.delete(phrase);
      }
    }

    this.postToWebview({ command: 'progress', phase: 'Applying overlap filter...' });
    await yieldToEventLoop();

    const suppressed = suppressedNgrams(freqs, localOccs);

    this.postToWebview({ command: 'progress', phase: 'Finalizing results...' });
    await yieldToEventLoop();

    const groups = [1, 2, 3, 4, 5].map(n => {
      const minCount = n === 1 ? 3 : 2;
      const items = [...freqs[n - 1].entries()]
        .filter(([phrase, c]) => c >= minCount && !suppressed.has(phrase))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([text, count]) => ({ text, count }));
      return { n, items };
    });

    const result: AnalysisResult = {
      totalWords,
      uniqueWords: freqs[0].size,
      standardPages: Math.ceil(totalWords / 250),
      groups,
    };

    // Trim to visible phrases only — suppressed/sub-threshold phrases have no
    // clickable rows and their occurrence arrays would waste memory.
    const visible = new Set(groups.flatMap(g => g.items.map(i => i.text)));
    for (const phrase of [...localOccs.keys()]) {
      if (!visible.has(phrase)) localOccs.delete(phrase);
    }

    // Atomically replace class state so navigation is never in a partial state.
    this.occurrences.clear();
    this.clickIndex.clear();
    for (const [k, v] of localOccs) this.occurrences.set(k, v);
    this.memCache         = { result, occurrences: new Map(localOccs), fileMtimes: buildMtimeMap(sources), chapterKey };
    this.lastResult       = result;
    this.lastChapterTitle = chapterTitle;

    if (cacheFile && wsRoot) {
      const cacheOccs: Record<string, Occurrence[]> = {};
      for (const [phrase, occs] of localOccs) {
        cacheOccs[phrase] = occs.map(o => ({ ...o, file: toRelPath(o.file, wsRoot) }));
      }
      tryWriteCache(cacheFile, {
        version:      CACHE_VERSION,
        sourceMode:   sources.length === 1 ? 'singleFile' : 'multiFile',
        settingsHash: SETTINGS_HASH,
        generatedAt:  new Date().toISOString(),
        sources:      sources.map(s => ({
          path:  toRelPath(s.filePath, wsRoot),
          mtime: safeStatMtime(s.filePath),
          size:  safeStatSize(s.filePath),
        })),
        result,
        occurrences: cacheOccs,
      });
    }

    this.render();
  }

  private render(): void {
    if (this._view) {
      this._view.webview.html = this.buildHtml(this._view.webview);
    }
  }

  private postToWebview(msg: object): void {
    this._view?.webview.postMessage(msg);
  }

  // ---------------------------------------------------------------------------
  // HTML
  // ---------------------------------------------------------------------------

  private llmDisabledHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         font-size: var(--vscode-font-size); margin: 0; padding: 0; }
  .msg { padding: 16px 12px; opacity: 0.7; font-size: 0.88em; line-height: 1.7; }
  strong { opacity: 1; font-weight: 600; display: block; margin-bottom: 4px; }
</style>
</head>
<body>
  <div class="msg">
    <strong>LLM Features Disabled</strong>
    This panel requires chapter analysis.<br>
    Enable <em>LLM features</em> in Draft-Script settings to use this view.
  </div>
</body>
</html>`;
  }

  private buildHtml(_webview: vscode.Webview): string {
    if (!vscode.workspace.getConfiguration('draftScript').get<boolean>('enableLLM', true)) {
      return this.llmDisabledHtml();
    }
    const a = this.lastResult;
    const isChapter = this.lastChapterTitle !== null;

    const scopeBar = isChapter
      ? `<div class="scope-bar chapter">
  <span class="scope-icon">&#9673;</span>
  <span class="scope-title" title="${esc(this.lastChapterTitle ?? '')}">${esc(this.lastChapterTitle ?? '')}</span>
</div>`
      : `<div class="scope-bar novel">
  <span class="scope-icon">&#9678;</span>
  <span>Novel</span>
</div>`;

    const groupsHtml = a
      ? a.groups.map((g, gi) => {
          if (g.items.length === 0) {
            return `<details data-group="${g.n}">
          <summary><span class="glabel">${g.n} word${g.n > 1 ? 's' : ''}</span>
            <span class="gbadge dim">&mdash;</span></summary>
          <p class="empty">No phrases found.</p>
        </details>`;
          }
          const rows = g.items.map(item =>
            `<div class="row" data-phrase="${esc(item.text)}" onclick="navFromRow(this)" oncontextmenu="phraseMenu(event, this.dataset.phrase || '')">
           <span class="phrase">${esc(item.text)}</span>
           <span class="badge">${item.count}</span>
         </div>`
          ).join('');
          return `<details data-group="${g.n}">
        <summary>
          <span class="glabel">${g.n} word${g.n > 1 ? 's' : ''}</span>
          <span class="gbadge">${g.items.length}</span>
        </summary>
        <div class="group-body">${rows}</div>
      </details>`;
        }).join('')
      : '';

    // Progress area: visible when no results yet; JS can also show it during
    // a background rescan while stale results are still displayed.
    const progressDisplay = a ? 'none' : 'block';

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

  /* Scope bar */
  .scope-bar {
    display: flex; align-items: center; gap: 5px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--vscode-widget-border);
    margin-bottom: 8px;
    font-size: 0.8em; font-weight: 600;
  }
  .scope-bar.chapter { color: var(--vscode-textLink-activeForeground, #4ea6ff); }
  .scope-bar.novel   { opacity: 0.55; }
  .scope-icon { font-size: 0.85em; flex-shrink: 0; }
  .scope-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .ngrams { padding: 0 8px 8px; }

  /* Collapsible n-gram groups */
  details { border: 1px solid var(--vscode-widget-border); border-radius: 3px; margin-bottom: 4px; }
  summary {
    display: flex; align-items: center; justify-content: space-between;
    padding: 5px 8px; cursor: pointer;
    user-select: none; list-style: none;
    font-size: 0.82em; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  summary::-webkit-details-marker { display: none; }
  summary::before {
    content: '▶'; font-size: 0.7em; margin-right: 6px;
    transition: transform 0.15s;
    opacity: 0.5;
  }
  details[open] > summary::before { transform: rotate(90deg); }
  .glabel { flex: 1; }
  .gbadge {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px; padding: 1px 7px;
    font-size: 0.85em; font-weight: 700;
  }
  .gbadge.dim { opacity: 0.4; background: transparent; }

  /* Phrase rows */
  .group-body { padding: 2px 0; }
  .row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 3px 8px; cursor: pointer; border-radius: 2px; font-size: 0.88em;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .phrase { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge {
    flex-shrink: 0; margin-left: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px; padding: 1px 6px;
    font-size: 0.78em; font-weight: 700; min-width: 20px; text-align: center;
  }
  .hint { font-size: 0.72em; opacity: 0.45; margin: 0 0 8px; }
  .empty { font-size: 0.82em; opacity: 0.5; padding: 4px 8px 8px; margin: 0; }
  .ctx-menu {
    position: fixed; z-index: 10; min-width: 190px;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border));
    box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    padding: 3px 0; border-radius: 3px; display: none;
  }
  .ctx-menu button {
    display: block; width: 100%; text-align: left; padding: 5px 10px;
    border: none; background: transparent; color: inherit; font: inherit;
    font-size: 0.86em; cursor: pointer;
  }
  .ctx-menu button:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }

  /* Progress */
  #progress-area {
    display: ${progressDisplay};
    padding: 12px 4px 8px;
  }
  #progress-phase { font-size: 0.85em; opacity: 0.75; margin: 0 0 8px; }
  #progress-bar-wrap {
    height: 3px;
    background: var(--vscode-widget-border);
    border-radius: 2px; overflow: hidden; margin-bottom: 5px;
  }
  #progress-bar {
    height: 100%; width: 0%;
    background: var(--vscode-button-background);
    transition: width 0.25s ease;
  }
  #progress-detail { font-size: 0.78em; opacity: 0.55; margin: 0; }
</style>
</head>
<body>

${a ? scopeBar : ''}

<div id="progress-area">
  <p id="progress-phase">Analyzing manuscript...</p>
  <div id="progress-bar-wrap"><div id="progress-bar"></div></div>
  <p id="progress-detail">&nbsp;</p>
</div>

<div class="ngrams">
${a ? '<p class="hint">Click a phrase to jump &middot; repeat clicks cycle through all instances</p>' : ''}
${groupsHtml}
</div>
<div class="ctx-menu" id="phraseMenu">
  <button onclick="lineEditOccurrence()">Suggest Line Edit for This Occurrence</button>
  <button onclick="lineEditChapter()">Suggest Line Edits for This Chapter</button>
</div>

<script>
  var vscode = acquireVsCodeApi();
  var menuPhrase = '';
  var viewState = vscode.getState() || {};

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.command !== 'progress') { return; }

    var area  = document.getElementById('progress-area');
    var phase = document.getElementById('progress-phase');
    var bar   = document.getElementById('progress-bar');
    var det   = document.getElementById('progress-detail');

    area.style.display = 'block';
    phase.textContent  = msg.phase || 'Analyzing...';

    if (msg.current != null && msg.total != null && msg.total > 0) {
      var pct = Math.round(msg.current / msg.total * 100);
      bar.style.width = pct + '%';
      det.textContent = msg.current + ' / ' + msg.total + ' · ' + pct + '%';
    } else {
      bar.style.width = '66%';
      det.textContent = '';
    }
  });

  window.addEventListener('click', function() { hidePhraseMenu(); });
  function initDetailsState() {
    var details = Array.from(document.querySelectorAll('details[data-group]'));
    if (!details.length) return;
    var saved = Array.isArray(viewState.openGroups) ? viewState.openGroups : null;
    details.forEach(function(d, idx) {
      var group = d.dataset.group || '';
      d.open = saved ? saved.indexOf(group) !== -1 : idx === 0;
      d.addEventListener('toggle', saveDetailsState);
    });
    saveDetailsState();
  }
  function saveDetailsState() {
    viewState.openGroups = Array.from(document.querySelectorAll('details[data-group]'))
      .filter(function(d) { return d.open; })
      .map(function(d) { return d.dataset.group || ''; });
    vscode.setState(viewState);
  }
  function nav(phrase) { vscode.postMessage({ command: 'navigate', phrase: phrase }); }
  function navFromRow(row) { nav(row.dataset.phrase || ''); }
  function phraseMenu(event, phrase) {
    event.preventDefault();
    menuPhrase = phrase;
    var menu = document.getElementById('phraseMenu');
    menu.style.display = 'block';
    menu.style.left = Math.min(event.clientX, window.innerWidth - 220) + 'px';
    menu.style.top = Math.min(event.clientY, window.innerHeight - 70) + 'px';
  }
  function hidePhraseMenu() {
    var menu = document.getElementById('phraseMenu');
    if (menu) menu.style.display = 'none';
  }
  function lineEditOccurrence() {
    hidePhraseMenu();
    vscode.postMessage({ command: 'lineEditOccurrence', phrase: menuPhrase });
  }
  function lineEditChapter() {
    hidePhraseMenu();
    vscode.postMessage({ command: 'lineEditChapter', phrase: menuPhrase });
  }
  initDetailsState();
</script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Line edit review panel
// ---------------------------------------------------------------------------

class LineEditReviewPanel {
  static open(suggestions: LineEditSuggestion[]): void {
    const panel = vscode.window.createWebviewPanel(
      'draftScript.lineEditReview',
      'Line Edit Suggestions',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const diffUris: vscode.Uri[] = [];

    panel.webview.html = lineEditReviewHtml(suggestions);
    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      if (msg.command === 'cancelLineEdits') {
        panel.dispose();
        return;
      }
      if (msg.command === 'openDiff') {
        const suggestion = suggestions.find(s => s.id === String(msg.id ?? ''));
        if (suggestion) {
          const replacement = typeof msg.replacement === 'string' ? msg.replacement : suggestion.replacement;
          diffUris.push(...await openLineEditDiff({ ...suggestion, replacement }));
        }
        return;
      }
      if (msg.command === 'openAcceptedDiff') {
        const decisions = Array.isArray(msg.decisions) ? msg.decisions as Array<Record<string, unknown>> : [];
        const uris = await openAcceptedLineEditDiff(suggestions, decisions);
        diffUris.push(...uris);
        return;
      }
      if (msg.command !== 'applyLineEdits') return;
      const decisions = Array.isArray(msg.decisions) ? msg.decisions as Array<Record<string, unknown>> : [];
      const applied = await applyLineEditSuggestions(suggestions, decisions);
      const skipped = applied.skipped
        ? ` Skipped ${applied.skipped} stale suggestion${applied.skipped === 1 ? '' : 's'}.`
        : '';
      vscode.window.showInformationMessage(`Applied ${applied.applied} line edit${applied.applied === 1 ? '' : 's'}.${skipped}`);
      panel.dispose();
    });
    panel.onDidDispose(() => {
      LineEditDiffDocumentProvider.instance().delete(diffUris);
    });
  }
}

class LineEditDiffDocumentProvider implements vscode.TextDocumentContentProvider {
  private static readonly SCHEME = 'draft-script-line-edit-diff';
  private static _instance: LineEditDiffDocumentProvider | undefined;
  private static _registration: vscode.Disposable | undefined;

  private readonly docs = new Map<string, string>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  static instance(): LineEditDiffDocumentProvider {
    if (!this._instance) {
      this._instance = new LineEditDiffDocumentProvider();
      this._registration = vscode.workspace.registerTextDocumentContentProvider(this.SCHEME, this._instance);
    }
    return this._instance;
  }

  set(label: string, side: 'original' | 'suggested', content: string): vscode.Uri {
    const safeLabel = label.replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) || 'line-edit';
    const title = side === 'original' ? 'Draft-Script Original' : 'Draft-Script Suggested';
    const uri = vscode.Uri.from({
      scheme: LineEditDiffDocumentProvider.SCHEME,
      authority: side,
      path: `/${title} - ${safeLabel} - ${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
    });
    this.docs.set(uri.toString(), content);
    this._onDidChange.fire(uri);
    return uri;
  }

  delete(uris: vscode.Uri[]): void {
    for (const uri of uris) this.docs.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? '';
  }
}

async function openLineEditDiff(suggestion: LineEditSuggestion): Promise<vscode.Uri[]> {
  const provider = LineEditDiffDocumentProvider.instance();
  const label = `${path.basename(suggestion.filePath)} line ${suggestion.line}`;
  const original = buildLineEditDiffContent(suggestion, suggestion.text, 'Draft-Script Original');
  const suggested = buildLineEditDiffContent(suggestion, suggestion.replacement || suggestion.text, 'Draft-Script Suggested');
  const originalUri = provider.set(label, 'original', original);
  const suggestedUri = provider.set(label, 'suggested', suggested);

  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    suggestedUri,
    `Draft-Script Line Edit: ${label}`,
    { preview: false },
  );
  return [originalUri, suggestedUri];
}

async function openAcceptedLineEditDiff(
  suggestions: LineEditSuggestion[],
  decisions: Array<Record<string, unknown>>,
): Promise<vscode.Uri[]> {
  const byId = new Map(suggestions.map(s => [s.id, s]));
  const accepted = decisions
    .filter(d => d.accepted === true)
    .map(d => ({ suggestion: byId.get(String(d.id)), replacement: String(d.replacement ?? '') }))
    .filter((d): d is { suggestion: LineEditSuggestion; replacement: string } => !!d.suggestion && d.replacement.trim().length > 0)
    .sort((a, b) => {
      if (a.suggestion.filePath !== b.suggestion.filePath) return a.suggestion.filePath.localeCompare(b.suggestion.filePath);
      return a.suggestion.range.start.compareTo(b.suggestion.range.start);
    });

  if (!accepted.length) {
    vscode.window.showInformationMessage('Draft-Script: No accepted line edits selected for diff.');
    return [];
  }

  const provider = LineEditDiffDocumentProvider.instance();
  const label = `${accepted.length} accepted line edit${accepted.length === 1 ? '' : 's'}`;
  const original = buildAcceptedLineEditDiffContent(accepted, 'original');
  const suggested = buildAcceptedLineEditDiffContent(accepted, 'suggested');
  const originalUri = provider.set(label, 'original', original);
  const suggestedUri = provider.set(label, 'suggested', suggested);

  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    suggestedUri,
    `Draft-Script Accepted Line Edits: ${accepted.length}`,
    { preview: false },
  );
  return [originalUri, suggestedUri];
}

function buildLineEditDiffContent(suggestion: LineEditSuggestion, sentence: string, title: string): string {
  const before = compactContextLines(suggestion.before, 'tail', 2);
  const after = compactContextLines(suggestion.after, 'head', 2);
  return [
    ...before,
    sentence.trim(),
    ...after,
    '',
  ].join('\n');
}

function buildAcceptedLineEditDiffContent(
  accepted: Array<{ suggestion: LineEditSuggestion; replacement: string }>,
  side: 'original' | 'suggested',
): string {
  return accepted
    .map(item => {
      const s = item.suggestion;
      const sentence = side === 'original' ? s.text : item.replacement;
      return [
        `--- ${path.basename(s.filePath)} line ${s.line} ${'-'.repeat(40)}`,
        ...compactContextLines(s.before, 'tail', 2),
        sentence.trim(),
        ...compactContextLines(s.after, 'head', 2),
      ].join('\n');
    })
    .join('\n\n');
}

function compactContextLines(text: string, side: 'head' | 'tail', limit: number): string[] {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const selected = side === 'head' ? lines.slice(0, limit) : lines.slice(-limit);
  return selected.map(line => line.length > 260 ? `${line.slice(0, 257)}...` : line);
}

async function applyLineEditSuggestions(
  suggestions: LineEditSuggestion[],
  decisions: Array<Record<string, unknown>>,
): Promise<{ applied: number; skipped: number }> {
  const byId = new Map(suggestions.map(s => [s.id, s]));
  const accepted = decisions
    .filter(d => d.accepted === true)
    .map(d => ({ suggestion: byId.get(String(d.id)), replacement: String(d.replacement ?? '') }))
    .filter((d): d is { suggestion: LineEditSuggestion; replacement: string } => !!d.suggestion && d.replacement.trim().length > 0)
    .sort((a, b) => {
      if (a.suggestion.filePath !== b.suggestion.filePath) return a.suggestion.filePath.localeCompare(b.suggestion.filePath);
      return b.suggestion.range.start.compareTo(a.suggestion.range.start);
    });

  const edit = new vscode.WorkspaceEdit();
  let skipped = 0;
  let applied = 0;
  let reveal: { uri: vscode.Uri; range: vscode.Range } | undefined;

  for (const item of accepted) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.suggestion.filePath));
    const current = doc.getText(item.suggestion.range).trim();
    if (current !== item.suggestion.text.trim()) {
      skipped++;
      continue;
    }
    if (!reveal || item.suggestion.range.start.compareTo(reveal.range.start) < 0) {
      reveal = { uri: doc.uri, range: item.suggestion.range };
    }
    edit.replace(doc.uri, item.suggestion.range, item.replacement.trim());
    applied++;
  }

  if (applied > 0) {
    await vscode.workspace.applyEdit(edit);
    if (reveal) {
      const doc = await vscode.workspace.openTextDocument(reveal.uri);
      const editor = await vscode.window.showTextDocument(doc);
      editor.selection = new vscode.Selection(reveal.range.start, reveal.range.start);
      editor.revealRange(reveal.range, vscode.TextEditorRevealType.InCenter);
    }
  }
  return { applied, skipped };
}

function lineEditReviewHtml(suggestions: LineEditSuggestion[]): string {
  const rows = suggestions.map(s => {
    const keep = !s.shouldChange;
    return `<div class="suggestion" data-id="${esc(s.id)}">
  <div class="suggestion-head">
    <label class="accept"><input type="checkbox" ${keep ? '' : 'checked'} ${keep ? 'disabled' : ''}> ${keep ? 'Keep original' : 'Accept'}</label>
    <button onclick="openDiff(this)">Open Diff</button>
  </div>
  <div class="loc">Line ${s.line} &middot; ${esc(path.basename(s.filePath))}</div>
  <div class="label">Original</div>
  <pre>${esc(s.text)}</pre>
  <div class="label">Replacement</div>
  <textarea ${keep ? 'disabled' : ''}>${esc(s.replacement || s.text)}</textarea>
  <div class="meta">${esc(s.reason || (keep ? 'LLM recommends keeping the original.' : ''))} &middot; confidence ${Number(s.confidence || 0).toFixed(2)}</div>
</div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; }
.toolbar { position: sticky; top: 0; display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--vscode-widget-border); background: var(--vscode-editor-background); }
.toolbar strong { margin-right: auto; }
button { font: inherit; padding: 4px 10px; cursor: pointer; }
.list { padding: 10px 14px 18px; }
.suggestion { border-bottom: 1px solid var(--vscode-widget-border); padding: 12px 0; }
.suggestion:last-child { border-bottom: none; }
.suggestion-head { display: flex; align-items: center; gap: 8px; }
.suggestion-head button { margin-left: auto; }
.accept { font-weight: 600; }
.loc, .meta { opacity: 0.62; font-size: 0.86em; margin-top: 4px; }
.label { opacity: 0.55; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.76em; margin-top: 10px; }
pre { white-space: pre-wrap; background: rgba(128,128,128,0.08); padding: 8px; border-radius: 4px; margin: 4px 0 0; }
textarea { width: 100%; min-height: 72px; margin-top: 4px; padding: 8px; box-sizing: border-box; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 4px; }
</style>
</head>
<body>
<div class="toolbar">
  <strong>${suggestions.length} line edit suggestion${suggestions.length === 1 ? '' : 's'}</strong>
  <button onclick="setAll(true)">Accept All Suggested</button>
  <button onclick="setAll(false)">Reject all</button>
  <button onclick="openAcceptedDiff()">Open Diff for Accepted</button>
  <button onclick="apply()">Apply accepted</button>
  <button onclick="cancel()">Cancel</button>
</div>
<div class="list">${rows}</div>
<script>
const vscode = acquireVsCodeApi();
const reviewState = vscode.getState() || {};
function setAll(value) {
  document.querySelectorAll('.suggestion input[type=checkbox]:not(:disabled)').forEach(function(cb) { cb.checked = value; });
  saveReviewState();
}
function apply() {
  vscode.postMessage({ command: 'applyLineEdits', decisions: collectDecisions() });
}
function collectDecisions() {
  return Array.from(document.querySelectorAll('.suggestion')).map(function(row) {
    return {
      id: row.dataset.id,
      accepted: row.querySelector('input').checked && !row.querySelector('input').disabled,
      replacement: row.querySelector('textarea').value
    };
  });
}
function saveReviewState() {
  var decisionsById = {};
  collectDecisions().forEach(function(decision) {
    decisionsById[decision.id] = {
      accepted: decision.accepted,
      replacement: decision.replacement
    };
  });
  vscode.setState({ decisionsById: decisionsById });
}
function restoreReviewState() {
  var saved = reviewState.decisionsById || {};
  document.querySelectorAll('.suggestion').forEach(function(row) {
    var item = saved[row.dataset.id];
    if (!item) return;
    var input = row.querySelector('input');
    var textarea = row.querySelector('textarea');
    if (textarea && typeof item.replacement === 'string') textarea.value = item.replacement;
    if (input && !input.disabled && typeof item.accepted === 'boolean') input.checked = item.accepted;
  });
}
function bindReviewState() {
  document.querySelectorAll('.suggestion input[type=checkbox], .suggestion textarea').forEach(function(el) {
    el.addEventListener('change', saveReviewState);
    el.addEventListener('input', saveReviewState);
  });
}
function openAcceptedDiff() {
  saveReviewState();
  vscode.postMessage({ command: 'openAcceptedDiff', decisions: collectDecisions() });
}
function openDiff(button) {
  var row = button.closest('.suggestion');
  saveReviewState();
  vscode.postMessage({
    command: 'openDiff',
    id: row.dataset.id,
    replacement: row.querySelector('textarea').value
  });
}
function cancel() {
  vscode.postMessage({ command: 'cancelLineEdits' });
}
restoreReviewState();
bindReviewState();
saveReviewState();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Async yield
// ---------------------------------------------------------------------------

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function findSentenceStart(text: string, offset: number): number {
  let i = Math.max(0, Math.min(offset, text.length - 1));
  while (i > 0) {
    const prev = text[i - 1];
    if (/[.!?\u2026]/.test(prev) || prev === '\n') break;
    i--;
  }
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

function findSentenceEnd(text: string, offset: number): number {
  let i = Math.max(0, Math.min(offset, text.length));
  while (i < text.length) {
    const ch = text[i];
    i++;
    if (/[.!?\u2026]/.test(ch)) {
      while (i < text.length && /["')\]\u201d\u2019]/.test(text[i])) i++;
      break;
    }
    if (ch === '\n') break;
  }
  return i;
}

type LineEditBatchParseResult =
  | { ok: true; suggestions: LineEditSuggestion[]; warnings: string[] }
  | { ok: false; warnings: string[] };

async function parseLineEditBatchResponse(raw: string, targets: SentenceTarget[]): Promise<LineEditBatchParseResult> {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    if (!Array.isArray(obj.items)) return { ok: false, warnings: ['Line edit response is missing items array.'] };

    const warnings: string[] = [];
    const targetsById = new Map(targets.map(t => [t.id, t]));
    const responseById = new Map<string, Record<string, unknown>>();
    for (const item of obj.items) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id : '';
      if (!id) continue;
      if (!targetsById.has(id)) {
        warnings.push(`Ignoring unknown line edit item id "${id}".`);
        continue;
      }
      responseById.set(id, row);
    }

    const suggestions: LineEditSuggestion[] = [];
    for (const target of targets) {
      const row = responseById.get(target.id);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target.filePath));
      if (!row) {
        warnings.push(`Line edit response is missing item id "${target.id}".`);
        suggestions.push({
          ...target,
          replacement: target.text,
          reason: 'No suggestion returned.',
          confidence: 0,
          shouldChange: false,
          documentVersion: doc.version,
        });
        continue;
      }

      let replacement = typeof row.replacement === 'string' ? row.replacement.trim() : '';
      let shouldChange = row.shouldChange === true;
      if (shouldChange && !replacement) {
        warnings.push(`Line edit item "${target.id}" has shouldChange=true but no replacement.`);
        shouldChange = false;
      }
      if (!replacement || replacement === target.text.trim()) {
        replacement = target.text;
        shouldChange = false;
      }

      suggestions.push({
        ...target,
        replacement,
        reason: typeof row.reason === 'string' ? row.reason : '',
        confidence: normalizeConfidence(row.confidence),
        shouldChange,
        documentVersion: doc.version,
      });
    }

    return { ok: true, suggestions, warnings };
  } catch {
    return { ok: false, warnings: ['Line edit response is not valid JSON.'] };
  }
}

function validateLineEditPromptBody(body: string): string[] {
  return ['context', 'phrase', 'itemsJson']
    .filter(key => !body.includes(`{{${key}}}`))
    .map(key => `Line edit prompt is missing {{${key}}}.`);
}

function compactLineEditContext(targets: SentenceTarget[]): string {
  return targets
    .slice(0, 20)
    .map(target => [
      `[${target.id} | line ${target.line}]`,
      target.before ? `Before: ${target.before}` : '',
      `Sentence: ${target.text}`,
      target.after ? `After: ${target.after}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n\n');
}

function normalizeConfidence(value: unknown): number {
  let confidence = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(confidence)) return 0;
  if (confidence > 1 && confidence <= 100) confidence = confidence / 100;
  return Math.max(0, Math.min(1, confidence));
}

let lineEditOutput: vscode.OutputChannel | undefined;

function showLineEditRawOutput(raw: string): void {
  lineEditOutput ??= vscode.window.createOutputChannel('Draft-Script Line Edit');
  lineEditOutput.clear();
  lineEditOutput.appendLine('LLM returned invalid line-edit JSON:');
  lineEditOutput.appendLine('');
  lineEditOutput.appendLine(raw);
  lineEditOutput.show(true);
}

function showLineEditErrorOutput(err: unknown): void {
  lineEditOutput ??= vscode.window.createOutputChannel('Draft-Script Line Edit');
  lineEditOutput.clear();
  lineEditOutput.appendLine('Line edit LLM call failed:');
  lineEditOutput.appendLine('');
  if (err instanceof Error) {
    lineEditOutput.appendLine(`${err.name}: ${err.message}`);
    if (err.stack) {
      lineEditOutput.appendLine('');
      lineEditOutput.appendLine(err.stack);
    }
  } else {
    lineEditOutput.appendLine(String(err));
  }
  lineEditOutput.show(true);
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

function safeStatMtime(p: string): number {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function safeStatSize(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function toRelPath(abs: string, root: string): string {
  return path.relative(root, abs).replace(/\\/g, '/');
}

function toAbsPath(rel: string, root: string): string {
  return path.join(root, rel);
}

function buildMtimeMap(sources: Array<{ filePath: string }>): Map<string, number> {
  return new Map(sources.map(s => [s.filePath, safeStatMtime(s.filePath)]));
}

function isCacheValid(
  cache: AnalyticsCache,
  sources: Array<{ filePath: string }>,
  wsRoot: string,
): boolean {
  if (cache.version !== CACHE_VERSION)      return false;
  if (cache.settingsHash !== SETTINGS_HASH) return false;
  if (!Array.isArray(cache.sources))        return false;
  if (cache.sources.length !== sources.length) return false;

  const byRel = new Map(cache.sources.map(s => [s.path, s]));
  for (const src of sources) {
    const rel = toRelPath(src.filePath, wsRoot);
    const cached = byRel.get(rel);
    if (!cached) return false;
    if (cached.mtime !== safeStatMtime(src.filePath)) return false;
    if (cached.size !== undefined && cached.size !== safeStatSize(src.filePath)) return false;
  }
  return true;
}

function tryReadCache(cacheFile: string): AnalyticsCache | null {
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as AnalyticsCache; }
  catch { return null; }
}

function tryWriteCache(cacheFile: string, cache: AnalyticsCache): void {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf-8');
  } catch { /* non-fatal — next open will recompute */ }
}

// ---------------------------------------------------------------------------
// Overlap suppression
// ---------------------------------------------------------------------------

// Returns phrases whose occurrences are >=90% explained by longer accepted phrases at the same positions.
function suppressedNgrams(
  freqs: Map<string, number>[],
  occurrences: Map<string, Occurrence[]>,
  coverage = 0.9,
): Set<string> {
  // Lookup set per phrase: "file\0line\0wordStart"
  const occSets = new Map<string, Set<string>>();
  for (const [phrase, occs] of occurrences) {
    const set = new Set<string>();
    for (const o of occs) set.add(`${o.file}\0${o.line}\0${o.wordStart}`);
    occSets.set(phrase, set);
  }

  // Collect all phrases that pass the min-count filter
  const accepted = new Set<string>();
  for (let n = 1; n <= MAX_NGRAM; n++) {
    const minCount = n === 1 ? 3 : 2;
    for (const [phrase, count] of freqs[n - 1]) {
      if (count >= minCount) accepted.add(phrase);
    }
  }

  // Process longest first so suppressed-by-a-suppressed-phrase doesn't chain incorrectly
  const sorted = [...accepted].sort(
    (a, b) => b.split(' ').length - a.split(' ').length,
  );
  const suppressed = new Set<string>();

  for (let si = 0; si < sorted.length; si++) {
    const shortPhrase = sorted[si];
    const shortWords  = shortPhrase.split(' ');
    const shortOccs   = occurrences.get(shortPhrase) ?? [];
    if (shortOccs.length === 0) continue;

    const coveredIdx = new Set<number>();

    for (let li = 0; li < si; li++) {
      const longPhrase = sorted[li];
      if (suppressed.has(longPhrase)) continue;          // a suppressed phrase can't provide coverage
      const longWords  = longPhrase.split(' ');
      if (longWords.length <= shortWords.length) break;  // sorted desc — nothing longer remains

      // Check every position where shortPhrase sits inside longPhrase
      for (let offset = 0; offset <= longWords.length - shortWords.length; offset++) {
        if (!shortWords.every((w, j) => w === longWords[offset + j])) continue;
        const longSet = occSets.get(longPhrase) ?? new Set<string>();
        for (let i = 0; i < shortOccs.length; i++) {
          if (coveredIdx.has(i)) continue;
          const key = `${shortOccs[i].file}\0${shortOccs[i].line}\0${shortOccs[i].wordStart - offset}`;
          if (longSet.has(key)) coveredIdx.add(i);
        }
      }
      if (coveredIdx.size === shortOccs.length) break;   // fully covered — skip remaining long phrases
    }

    if (shortOccs.length > 0 && coveredIdx.size / shortOccs.length >= coverage) {
      suppressed.add(shortPhrase);
    }
  }

  return suppressed;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
