import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getAllMarkdownFiles, countWords } from '../utils/markdownParser';
import { ChapterContentProvider } from './chapterContentProvider';
import { ChapterFileSystemProvider } from './chapterFileSystemProvider';

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

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class RepetitionWebviewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

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

  constructor(private novelFolder: string) {}

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

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async msg => {
      if (msg.command === 'navigate') {
        await this.navigateTo(msg.phrase as string);
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
  // Analysis
  // ---------------------------------------------------------------------------

  private getSources(): { sources: Array<{ content: string; filePath: string; lineOffset: number }>; chapterKey: string | null; chapterTitle: string | null } {
    const editor = this.currentEditor ?? vscode.window.activeTextEditor;
    const doc = editor?.document;

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
            return `<details>
          <summary><span class="glabel">${g.n} word${g.n > 1 ? 's' : ''}</span>
            <span class="gbadge dim">&mdash;</span></summary>
          <p class="empty">No phrases found.</p>
        </details>`;
          }
          const rows = g.items.map(item =>
            `<div class="row" onclick="nav('${esc(item.text)}')">
           <span class="phrase">${esc(item.text)}</span>
           <span class="badge">${item.count}</span>
         </div>`
          ).join('');
          const openAttr = gi === 0 ? ' open' : '';
          return `<details${openAttr}>
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

<script>
  var vscode = acquireVsCodeApi();

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

  function nav(phrase) { vscode.postMessage({ command: 'navigate', phrase: phrase }); }
</script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Async yield
// ---------------------------------------------------------------------------

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
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
