import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import { analyzeText, buildAnalysisPromptPreview } from '../dsm/analyzer';
import { createLlmProvider }  from '../dsm/llmProviders';
import { AnalysisStore }      from '../dsm/analysisStore';
import { CanonManager, ENTITY_CATEGORIES, normalizeId } from '../dsm/canonManager';
import { IndexBuilder }       from '../dsm/indexBuilder';
import { OverrideStore }      from '../dsm/overrideStore';
import { ChapterAnalysis, ChapterEntity } from '../dsm/draftScriptTypes';
import { SignalManager }      from '../dsm/signalManager';
import { DsmParseError, ChapterSource } from '../dsm/types';
import { DsmReviewPanel, ChapterListItem } from '../providers/dsmReviewPanel';
import { NavigatorItem }      from '../providers/navigatorTreeProvider';
import { extractSection, getAllMarkdownFiles, parseHeadings, HeadingNode } from '../utils/markdownParser';

// ---------------------------------------------------------------------------
// DSM: Analyze Selected Text
// ---------------------------------------------------------------------------

export async function dsmAnalyzeText(
  getRootFolder:  () => string,
  getNovelFolder: () => string,
  context: vscode.ExtensionContext
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  if (editor.selection.isEmpty) {
    vscode.window.showWarningMessage('DSM: Select text to analyze first.');
    return;
  }

  const format   = chapterFormat();
  const filePath = editor.document.uri.fsPath;
  const chapter  = chapterAboveSelection(editor.document, editor.selection);

  const clippedText  = chapter
    ? clipTextToChapter(editor.document, editor.selection, chapter.line, chapter.level)
    : editor.document.getText(editor.selection);
  const chapterNum   = chapter ? extractChapterNumber(chapter.title, format) : undefined;
  const sourceChapter: ChapterSource = {
    filePath,
    title:      chapter?.title ?? path.basename(filePath, '.md'),
    chapterNum,
  };

  const chapterList  = buildChapterList(getNovelFolder(), format);
  const currentIndex = findChapterIndex(chapterList, sourceChapter);

  await runDsmPipeline(
    clippedText, getRootFolder, getNovelFolder, context,
    sourceChapter, chapterList, currentIndex
  );
}

// ---------------------------------------------------------------------------
// DSM: Analyze Chapter (from Navigator tree context menu)
// ---------------------------------------------------------------------------

export async function dsmAnalyzeChapter(
  item:           NavigatorItem,
  getRootFolder:  () => string,
  getNovelFolder: () => string,
  context: vscode.ExtensionContext
): Promise<void> {
  const resolved = resolveNavigatorChapter(item);
  if (!resolved) return;

  const { text, sourceChapter } = resolved;
  const format        = chapterFormat();
  const chapterList   = buildChapterList(getNovelFolder(), format);
  const currentIndex  = findChapterIndex(chapterList, sourceChapter);

  await runDsmPipeline(
    text, getRootFolder, getNovelFolder, context,
    sourceChapter, chapterList, currentIndex
  );
}

export async function dsmPreviewAnalyzeChapter(
  item:           NavigatorItem,
  getRootFolder:  () => string,
): Promise<void> {
  const resolved = resolveNavigatorChapter(item);
  if (!resolved) return;

  const root   = getRootFolder();
  const store  = new AnalysisStore(root);
  const sigMgr = new SignalManager(root);
  const { prompt, promptSource } = buildAnalysisPromptPreview(resolved.text, store, sigMgr);
  const doc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content:  formatAnalysisPromptPreview(resolved.sourceChapter, promptSource, prompt),
  });

  await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri);
}

// ---------------------------------------------------------------------------
// Shared pipeline
// ---------------------------------------------------------------------------

async function runDsmPipeline(
  text:           string,
  getRootFolder:  () => string,
  getNovelFolder: () => string,
  context:        vscode.ExtensionContext,
  sourceChapter:  ChapterSource,
  chapterList:    ChapterListItem[],
  currentIndex:   number,
  autoScan:       boolean = false,
  mergeAlways:    boolean = false,
): Promise<void> {
  const cfg      = vscode.workspace.getConfiguration('draftScript');
  const provider = createLlmProvider(cfg);
  const root     = getRootFolder();
  const store    = new AnalysisStore(root);
  const canon    = new CanonManager(root);
  const sigMgr   = new SignalManager(root);
  const overrides = new OverrideStore(root);
  const builder  = new IndexBuilder(root, store, canon, overrides);

  const chapterLabel = sourceChapter.chapterNum != null
    ? `#${sourceChapter.chapterNum}`
    : sourceChapter.title;

  await vscode.window.withProgress(
    {
      location:    vscode.ProgressLocation.Notification,
      title:       `DSM: Analyzing ${chapterLabel} with ${provider.id}…`,
      cancellable: false,
    },
    async () => {
      try {
        const { analysis, promptSource } = await analyzeText(
          text, provider, store, canon, sigMgr, overrides, sourceChapter
        );

        // 1. Write chapter analysis immediately
        store.write(analysis);

        // 2. Rebuild all derived indexes
        builder.buildAll();

        // 3. Open review panel
        const nextItem = currentIndex >= 0 ? chapterList[currentIndex + 1] : undefined;

        DsmReviewPanel.create(
          analysis, canon, context, promptSource, sourceChapter,
          nextItem, autoScan, mergeAlways,
          (next, nextAutoScan, nextMergeAlways) =>
            runDsmPipelineForChapter(next, getRootFolder, getNovelFolder, context, chapterList, nextAutoScan, nextMergeAlways),
        );
      } catch (err) {
        if (err instanceof DsmParseError) {
          DsmReviewPanel.createError(err.message, err.raw, context);
        } else {
          vscode.window.showErrorMessage(
            `DSM: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  );
}

async function runDsmPipelineForChapter(
  item:           ChapterListItem,
  getRootFolder:  () => string,
  getNovelFolder: () => string,
  context:        vscode.ExtensionContext,
  chapterList:    ChapterListItem[],
  autoScan:       boolean,
  mergeAlways:    boolean = false,
): Promise<void> {
  let content: string;
  try {
    content = fs.readFileSync(item.filePath, 'utf-8');
  } catch {
    vscode.window.showWarningMessage(`DSM: Could not read "${item.filePath}".`);
    return;
  }

  const text = item.headingLine === 0 && item.headingLevel === 0
    ? content
    : extractSection(content, item.title, item.headingLevel);

  const sourceChapter: ChapterSource = {
    filePath:   item.filePath,
    title:      item.title,
    chapterNum: item.chapterNum,
  };
  const currentIndex = findChapterIndex(chapterList, sourceChapter);

  await runDsmPipeline(
    text, getRootFolder, getNovelFolder, context,
    sourceChapter, chapterList, currentIndex, autoScan, mergeAlways
  );
}

function resolveNavigatorChapter(item: NavigatorItem): { text: string; sourceChapter: ChapterSource } | undefined {
  if (!item.itemFilePath) return undefined;

  const format     = chapterFormat();
  const title      = typeof item.label === 'string' ? item.label : path.basename(item.itemFilePath, '.md');
  const chapterNum = extractChapterNumber(title, format);

  if (chapterNum == null) {
    vscode.window.showWarningMessage(
      `DSM: "${title}" doesn't match the chapter format ("${format}"). Only numbered chapters can be analyzed.`
    );
    return undefined;
  }

  let content: string;
  try {
    content = fs.readFileSync(item.itemFilePath, 'utf-8');
  } catch {
    vscode.window.showWarningMessage('DSM: Could not read chapter file.');
    return undefined;
  }

  const text = (item.kind === 'heading' && item.headingLevel !== undefined)
    ? extractSection(content, title, item.headingLevel)
    : content;

  return {
    text,
    sourceChapter: { filePath: item.itemFilePath, title, chapterNum },
  };
}

function formatAnalysisPromptPreview(
  sourceChapter: ChapterSource,
  promptSource:  string,
  prompt:        string,
): string {
  const chapterLabel = sourceChapter.chapterNum != null
    ? `#${sourceChapter.chapterNum} ${sourceChapter.title}`
    : sourceChapter.title;

  return [
    `# DSM Analyze Chapter Preview: ${chapterLabel}`,
    '',
    `**Prompt source:** ${promptSource}  `,
    `**Chapter file:** ${sourceChapter.filePath}  `,
    `**Estimated tokens:** ${estimateTokens(prompt).toLocaleString()}`,
    '',
    '## Rendered Prompt',
    '',
    prompt,
  ].join('\n');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// DSM: Rescan Changed Chapters
// ---------------------------------------------------------------------------

export async function dsmRescanChanged(
  getRootFolder:  () => string,
  getNovelFolder: () => string,
): Promise<void> {
  const cfg            = vscode.workspace.getConfiguration('draftScript');
  const minCertainty   = cfg.get<number>('dsmRescanMinCertainty', 80);
  const mergeUncertain = cfg.get<boolean>('dsmRescanMergeUncertain', false);
  const format         = chapterFormat();
  const root           = getRootFolder();

  const store   = new AnalysisStore(root);
  const canon   = new CanonManager(root);
  const sigMgr  = new SignalManager(root);
  const overrides = new OverrideStore(root);
  const builder = new IndexBuilder(root, store, canon, overrides);

  const chapterList = buildChapterList(getNovelFolder(), format);
  if (chapterList.length === 0) {
    vscode.window.showInformationMessage('DSM: No numbered chapters found.');
    return;
  }

  // Collect stale chapters (changed or never analyzed)
  type StaleItem = { item: ChapterListItem; text: string };
  const stale: StaleItem[] = [];

  for (const item of chapterList) {
    let content: string;
    try { content = fs.readFileSync(item.filePath, 'utf-8'); } catch { continue; }

    const text = item.headingLine === 0 && item.headingLevel === 0
      ? content
      : extractSection(content, item.title, item.headingLevel);

    const currentHash = store.computeContentHash(text);
    const stored      = store.read(item.chapterNum);
    if (!stored || stored.chapter.contentHash !== currentHash) {
      stale.push({ item, text });
    }
  }

  if (stale.length === 0) {
    vscode.window.showInformationMessage('DSM: All chapters are up to date — nothing to rescan.');
    return;
  }

  const provider = createLlmProvider(cfg);
  let done = 0, failed = 0;

  await vscode.window.withProgress(
    {
      location:    vscode.ProgressLocation.Notification,
      title:       `DSM: Rescanning ${stale.length} changed chapter${stale.length !== 1 ? 's' : ''}…`,
      cancellable: false,
    },
    async (progress) => {
      for (const { item, text } of stale) {
        progress.report({ message: `#${item.chapterNum} (${done + failed + 1}/${stale.length})` });

        const sourceChapter: ChapterSource = {
          filePath:   item.filePath,
          title:      item.title,
          chapterNum: item.chapterNum,
        };

        try {
          const { analysis } = await analyzeText(text, provider, store, canon, sigMgr, overrides, sourceChapter);
          applyAutoApproval(analysis, canon, minCertainty, mergeUncertain, overrides);
          store.write(analysis);
          done++;
        } catch (err) {
          failed++;
          console.error(`DSM rescan failed for #${item.chapterNum}: ${err instanceof Error ? err.message : err}`);
        }
      }

      builder.buildAll();
    }
  );

  const msg = failed > 0
    ? `DSM: Rescanned ${done} chapter${done !== 1 ? 's' : ''}, ${failed} failed. Check the console for details.`
    : `DSM: Rescanned ${done} chapter${done !== 1 ? 's' : ''} successfully.`;
  vscode.window.showInformationMessage(msg);
}

export function applyAutoApproval(
  analysis:       ChapterAnalysis,
  canon:          CanonManager,
  minCertainty:   number,
  mergeUncertain: boolean,
  overrides?:     OverrideStore,
): void {
  // confidence is stored as 0.0–1.0 (from LLM prompt), minCertainty is 0–100 from settings
  const threshold = minCertainty / 100;
  for (const category of ENTITY_CATEGORIES) {
    const effectiveCanon = canon.readEffective(category, overrides?.readCanon(category));
    const entities = (analysis as unknown as Record<string, ChapterEntity[]>)[category] ?? [];
    for (const entity of entities) {
      const match = findEffectiveCanonMatch(entity, effectiveCanon);
      if (match) {
        entity.status = 'already_indexed';
        entity.canonId = match.id;
        delete entity.possibleCanonId;
        continue;
      }

      if (entity.status === 'new' && entity.confidence >= threshold) {
        canon.addEntry(category, {
          id:          entity.id,
          name:        entity.name,
          aliases:     entity.aliases ?? [],
          description: entity.description ?? '',
        });
        entity.status  = 'already_indexed';
        entity.canonId = entity.id;
      } else if (
        mergeUncertain &&
        entity.status === 'uncertain' &&
        entity.possibleCanonId != null &&
        entity.confidence >= threshold
      ) {
        entity.status  = 'already_indexed';
        entity.canonId = entity.possibleCanonId;
        delete entity.possibleCanonId;
      }
    }
  }
}

function findEffectiveCanonMatch(entity: ChapterEntity, canonEntries: { id: string; name: string; aliases: string[] }[]): { id: string } | undefined {
  const entityIds = [entity.name, ...(entity.aliases ?? [])].map(normalizeId);
  return canonEntries.find(entry => {
    const canonIds = [entry.name, ...(entry.aliases ?? [])].map(normalizeId);
    return entityIds.some(id => canonIds.includes(id));
  });
}

// ---------------------------------------------------------------------------
// Chapter list — only numbered chapters (matching format)
// ---------------------------------------------------------------------------

export function buildChapterList(novelFolder: string, format: string): ChapterListItem[] {
  const result: ChapterListItem[] = [];
  if (!novelFolder || !fs.existsSync(novelFolder)) return result;

  for (const filePath of getAllMarkdownFiles(novelFolder)) {
    if (path.basename(filePath) === 'characters.md') continue;
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    const headings = parseHeadings(content);
    if (headings.length === 0) {
      const title      = path.basename(filePath, '.md');
      const chapterNum = extractChapterNumber(title, format);
      if (chapterNum != null) {
        result.push({ filePath, title, headingLevel: 0, headingLine: 0, chapterNum });
      }
    } else {
      flattenHeadings(filePath, headings, format, result);
    }
  }

  return result.sort((a, b) => a.chapterNum - b.chapterNum);
}

function flattenHeadings(
  filePath: string,
  nodes:    HeadingNode[],
  format:   string,
  out:      ChapterListItem[]
): void {
  for (const h of nodes) {
    const chapterNum = extractChapterNumber(h.title, format);
    if (chapterNum != null) {
      out.push({ filePath, title: h.title, headingLevel: h.level, headingLine: h.line, chapterNum });
    }
    flattenHeadings(filePath, h.children, format, out);
  }
}

function findChapterIndex(list: ChapterListItem[], chapter: ChapterSource): number {
  if (chapter.chapterNum == null) return -1;
  return list.findIndex(c => c.chapterNum === chapter.chapterNum && c.filePath === chapter.filePath);
}

// ---------------------------------------------------------------------------
// Chapter number extraction
// ---------------------------------------------------------------------------

function chapterFormat(): string {
  return vscode.workspace.getConfiguration('draftScript').get<string>('chapterFormat', 'Chapter {num}:');
}

export function extractChapterNumber(title: string, format: string): number | undefined {
  const re = chapterFormatToRegex(format);
  const m  = re.exec(title);
  return m ? parseInt(m[1], 10) : undefined;
}

function chapterFormatToRegex(format: string): RegExp {
  const escaped = format.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace('\\{num\\}', '(\\d+)');
  return new RegExp(pattern);
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

interface ChapterInfo { title: string; line: number; level: number }

function chapterAboveSelection(
  doc:       vscode.TextDocument,
  selection: vscode.Selection
): ChapterInfo | undefined {
  for (let line = selection.start.line - 1; line >= 0; line--) {
    const m = doc.lineAt(line).text.match(/^(#{1,6})\s+(.+)/);
    if (m) return { title: m[2].trim(), line, level: m[1].length };
  }
  return undefined;
}

function clipTextToChapter(
  doc:          vscode.TextDocument,
  selection:    vscode.Selection,
  headingLine:  number,
  headingLevel: number
): string {
  let chapterEndLine = doc.lineCount;
  for (let line = headingLine + 1; line < doc.lineCount; line++) {
    const m = doc.lineAt(line).text.match(/^(#{1,6})\s/);
    if (m && m[1].length <= headingLevel) { chapterEndLine = line; break; }
  }

  const effectiveEndLine = Math.min(selection.end.line, chapterEndLine - 1);
  const effectiveEnd     = selection.end.line <= effectiveEndLine
    ? selection.end
    : new vscode.Position(effectiveEndLine, doc.lineAt(effectiveEndLine).text.length);

  return doc.getText(new vscode.Range(selection.start, effectiveEnd));
}
