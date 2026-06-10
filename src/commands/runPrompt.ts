import * as vscode from 'vscode';
import * as fs      from 'fs';
import * as path    from 'path';

import { PromptRegistry }                      from '../dsm/promptRunner/promptRegistry';
import { VirtualDocumentProvider }             from '../providers/promptResultProvider';
import { buildPrompt }                         from '../dsm/promptRunner/promptBuilder';
import { PromptDefinition, PromptRunContext, RenderedPrompt, PromptOutputConfig } from '../dsm/promptRunner/types';
import { renderIncludeTree, formatIncludeErrors } from '../dsm/promptRunner/includeResolver';
import { createLlmProvider }                   from '../dsm/llmProviders';
import { NavigatorItem }                       from '../providers/navigatorTreeProvider';

const STARTER_PROMPTS_DIR = path.join(extensionRoot(), 'resources', 'starter-prompts');

function extensionRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export async function installStarterPrompts(rootFolder: string): Promise<number | undefined> {
  const targetDir = path.join(rootFolder, '.draft-script', 'prompts');

  if (!fs.existsSync(STARTER_PROMPTS_DIR)) {
    vscode.window.showWarningMessage('DSM Prompt Runner: Starter prompts are not available in this extension build.');
    return undefined;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(STARTER_PROMPTS_DIR, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`DSM Prompt Runner: Could not read starter prompts: ${msg}`);
    return undefined;
  }

  fs.mkdirSync(targetDir, { recursive: true });

  let installed = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const source = path.join(STARTER_PROMPTS_DIR, entry.name);
    const target = path.join(targetDir, entry.name);
    if (fs.existsSync(target)) continue;
    fs.copyFileSync(source, target);
    installed++;
  }

  const action = await vscode.window.showInformationMessage(
    installed
      ? `DSM Prompt Runner: Installed ${installed} starter prompt(s).`
      : 'DSM Prompt Runner: Starter prompts are already installed.',
    'Open Prompts Folder'
  );
  if (action === 'Open Prompts Folder') {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(targetDir));
  }

  return installed;
}

// ─── Shared: pick + build ─────────────────────────────────────────────────────

async function pickPrompt(
  registry:      PromptRegistry,
  getRootFolder: () => string,
  filter?:       (def: PromptDefinition) => boolean,
  emptyHint?:    string,
): Promise<PromptDefinition | undefined> {
  const all     = registry.getAll();
  const prompts = filter ? all.filter(filter) : all.filter(p => !p.lineEdit);

  if (!prompts.length) {
    if (all.length && emptyHint) {
      vscode.window.showWarningMessage(`DSM Prompt Runner: ${emptyHint}`);
      return undefined;
    }
    const choice = await vscode.window.showWarningMessage(
      'DSM Prompt Runner: No prompts found in .draft-script/prompts/. Install starter prompts to get started.',
      'Install starter prompts',
      'Open prompts folder'
    );
    if (choice === 'Install starter prompts') {
      const installed = await installStarterPrompts(getRootFolder());
      if (installed && installed > 0) {
        registry.load();
        return pickPrompt(registry, getRootFolder, filter, emptyHint);
      }
    } else if (choice === 'Open prompts folder') {
      const promptDir = path.join(getRootFolder(), '.draft-script', 'prompts');
      fs.mkdirSync(promptDir, { recursive: true });
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(promptDir));
    }
    return undefined;
  }

  const items: (vscode.QuickPickItem & { promptId: string })[] = prompts.map(p => ({
    label:       p.menuTitle ?? p.title,
    description: p.scope,
    detail:      p.description,
    promptId:    p.id,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title:              'DSM: Select Prompt',
    placeHolder:        'Choose a prompt…',
    matchOnDescription: true,
    matchOnDetail:      true,
  });

  return picked ? registry.get(picked.promptId) : undefined;
}

interface PreparedPrompt {
  def:      PromptDefinition;
  ctx:      PromptRunContext;
  rendered: RenderedPrompt;
}

async function preparePrompt(
  registry:      PromptRegistry,
  item:          NavigatorItem | undefined,
  getRootFolder: () => string,
  filter?:       (def: PromptDefinition) => boolean,
  emptyHint?:    string,
): Promise<PreparedPrompt | null> {
  const def = await pickPrompt(registry, getRootFolder, filter, emptyHint);
  if (!def) return null;

  const ctx = resolveRunContext(def.scope, item, getRootFolder);
  if (!ctx) {
    vscode.window.showWarningMessage(
      'DSM Prompt Runner: Could not determine chapter context. Open or select a chapter first.'
    );
    return null;
  }

  if (def.writer) {
    const brief = await vscode.window.showInputBox({
      title:          'Chapter brief (optional)',
      placeHolder:    'What should happen in this chapter? Leave blank to let the prompt decide.',
      ignoreFocusOut: true,
    });
    if (brief === undefined) return null; // Escape
    ctx.userBrief = brief.trim() || undefined;
  }

  const rendered = buildPrompt(def, ctx);
  return { def, ctx, rendered };
}

// ─── Output path helpers ──────────────────────────────────────────────────────

function hasOutputPath(def: PromptDefinition): def is PromptDefinition & { output: PromptOutputConfig } {
  return typeof def.output === 'object' && def.output !== null && 'path' in def.output && !!def.output.path;
}

function resolveOutputPath(template: string, def: PromptDefinition, ctx: PromptRunContext): string {
  const sanitize = (s: string) => s.replace(/[\\/:*?"<>|]/g, '-');

  let p = template
    .replace(/\{\{chapterId\}\}/g,         ctx.chapterId    ?? 'chapter')
    .replace(/\{\{chapterNumber\}\}/g,     ctx.chapterNumber != null ? String(ctx.chapterNumber) : '')
    .replace(/\{\{nextChapterNumber\}\}/g, ctx.chapterNumber != null ? String(ctx.chapterNumber + 1) : '')
    .replace(/\{\{chapterTitle\}\}/g,      sanitize(ctx.chapterTitle ?? ''))
    .replace(/\{\{promptId\}\}/g,          def.id);

  // Strip any leading slash — the spec treats all configured paths as relative.
  p = p.replace(/^[/\\]+/, '');

  // If somehow still absolute (e.g., user pasted a full path), keep only
  // the last folder + filename so the result stays near the chapter file.
  if (path.isAbsolute(p)) {
    p = path.join(path.basename(path.dirname(p)), path.basename(p));
  }

  const base = ctx.chapterPath ? path.dirname(ctx.chapterPath) : ctx.rootFolder;
  return path.resolve(base, p);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export async function previewPrompt(
  item:            NavigatorItem | undefined,
  registry:        PromptRegistry,
  previewProvider: VirtualDocumentProvider,
  getRootFolder:   () => string,
): Promise<void> {
  const prepared = await preparePrompt(registry, item, getRootFolder);
  if (!prepared) return;

  const { def, rendered } = prepared;
  const content = formatPreviewDoc(def, rendered);
  const uri     = previewProvider.set(rendered.promptId, content);

  await vscode.window.showTextDocument(uri, {
    viewColumn: vscode.ViewColumn.Beside,
    preview:    true,
  });
}

export async function copyPrompt(
  item:          NavigatorItem | undefined,
  registry:      PromptRegistry,
  getRootFolder: () => string,
): Promise<void> {
  const prepared = await preparePrompt(registry, item, getRootFolder);
  if (!prepared) return;

  const { rendered } = prepared;
  await vscode.env.clipboard.writeText(rendered.finalPrompt);

  vscode.window.showInformationMessage(
    `Copied prompt to clipboard. Estimated tokens: ${rendered.estimatedTokens.toLocaleString()}`
  );
}

export async function runPrompt(
  item:           NavigatorItem | undefined,
  registry:       PromptRegistry,
  resultProvider: VirtualDocumentProvider,
  getRootFolder:  () => string,
): Promise<void> {
  const prepared = await preparePrompt(registry, item, getRootFolder);
  if (!prepared) return;

  const { def, ctx, rendered } = prepared;

  if (rendered.includeErrors.length > 0) {
    vscode.window.showErrorMessage(
      `DSM: Cannot run prompt — include errors:\n${formatIncludeErrors(rendered.includeErrors)}`
    );
    return;
  }

  // Token warning threshold
  const cfg       = vscode.workspace.getConfiguration('draftScript');
  const threshold = cfg.get<number>('promptWarningTokens', 10_000);

  if (rendered.estimatedTokens > threshold) {
    const proceed = await vscode.window.showWarningMessage(
      `Prompt is approximately ${rendered.estimatedTokens.toLocaleString()} tokens. Continue?`,
      { modal: true },
      'Continue'
    );
    if (proceed !== 'Continue') return;
  }

  const llm = createLlmProvider(cfg);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `DSM: Running "${rendered.promptTitle}"…`, cancellable: false },
    async () => {
      const t0      = Date.now();
      const result  = await llm.complete(rendered.finalPrompt);
      const elapsed = Date.now() - t0;
      const content = formatResultDoc(rendered, ctx, result, elapsed);
      const uri     = resultProvider.set(rendered.promptId, content);

      await vscode.commands.executeCommand('markdown.showLockedPreviewToSide', uri);
    }
  );
}

export async function runAndSavePrompt(
  item:          NavigatorItem | undefined,
  registry:      PromptRegistry,
  getRootFolder: () => string,
): Promise<void> {
  const prepared = await preparePrompt(
    registry,
    item,
    getRootFolder,
    hasOutputPath,
    'No prompts with an output path found. Add "output:\\n  path: ..." to a prompt file to enable Run And Save.',
  );
  if (!prepared) return;

  const { def, ctx, rendered } = prepared;

  if (rendered.includeErrors.length > 0) {
    vscode.window.showErrorMessage(
      `DSM: Cannot run prompt — include errors:\n${formatIncludeErrors(rendered.includeErrors)}`
    );
    return;
  }

  const cfg       = vscode.workspace.getConfiguration('draftScript');
  const threshold = cfg.get<number>('promptWarningTokens', 10_000);

  if (rendered.estimatedTokens > threshold) {
    const proceed = await vscode.window.showWarningMessage(
      `Prompt is approximately ${rendered.estimatedTokens.toLocaleString()} tokens. Continue?`,
      { modal: true },
      'Continue'
    );
    if (proceed !== 'Continue') return;
  }

  // hasOutputPath guard above guarantees def.output is PromptOutputConfig here
  const outputCfg = def.output as PromptOutputConfig;
  const outPath   = resolveOutputPath(outputCfg.path, def, ctx);

  const llm = createLlmProvider(cfg);

  let savedPath: string | undefined;
  let saveError: string | undefined;
  let elapsedMs: number | undefined;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `DSM: Running "${rendered.promptTitle}"…`, cancellable: false },
    async () => {
      try {
        const t0 = Date.now();
        const result = await llm.complete(rendered.finalPrompt);
        elapsedMs = Date.now() - t0;
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, result, 'utf-8');
        savedPath = outPath;
      } catch (err) {
        saveError = err instanceof Error ? err.message : String(err);
      }
    }
  );

  if (saveError) {
    vscode.window.showErrorMessage(`DSM: Failed to save output: ${saveError}`);
    return;
  }

  if (savedPath) {
    const rel    = path.relative(ctx.chapterPath ? path.dirname(ctx.chapterPath) : ctx.rootFolder, savedPath);
    const choice = await vscode.window.showInformationMessage(`Saved: ${rel}`, 'Open Preview', 'Open File');
    if (choice === 'Open Preview') {
      await vscode.commands.executeCommand('markdown.showLockedPreviewToSide', vscode.Uri.file(savedPath));
    } else if (choice === 'Open File') {
      await vscode.window.showTextDocument(vscode.Uri.file(savedPath));
    }
  }
}

// ─── Document formatters ──────────────────────────────────────────────────────

function formatPreviewDoc(def: PromptDefinition, rendered: RenderedPrompt): string {
  const cfg        = vscode.workspace.getConfiguration('draftScript');
  const provider   = def.provider ?? cfg.get<string>('dsmProvider', 'vscode-lm');
  const visibility = def.visibility ?? 'all';
  const date       = new Date(rendered.generatedAt).toLocaleString();

  // ── Token breakdown ──────────────────────────────────────────────────────
  const contextTokens  = rendered.contextBlocks.reduce((s, b) => s + b.tokens, 0);
  const includeTokens  = rendered.includeTokens;
  const templateTokens = rendered.estimatedTokens - contextTokens - includeTokens;

  // ── Context block stats ──────────────────────────────────────────────────
  const blockSection = rendered.contextBlocks.map(b =>
    `### ${b.title}\n\n- ${b.chars.toLocaleString()} chars\n- ${b.words.toLocaleString()} words\n- ${b.tokens.toLocaleString()} tokens`
  ).join('\n\n');

  // ── Include tree / errors ────────────────────────────────────────────────
  const hasIncludes = rendered.includeTree.length > 0 || rendered.includeErrors.length > 0;
  const includeSection: string[] = [];
  if (hasIncludes) {
    includeSection.push('## Included Files', '');
    if (rendered.includeErrors.length > 0) {
      includeSection.push('**Errors:**', '', '```', formatIncludeErrors(rendered.includeErrors), '```', '');
    }
    includeSection.push(renderIncludeTree(rendered.includeTree) || '*No includes used.*', '', '---', '');
  }

  const parts = [
    `# Prompt Preview: ${rendered.promptTitle}`,
    '',
    `**Prompt:** ${rendered.promptTitle}  `,
    `**Scope:** ${def.scope}  `,
    `**Visibility:** ${visibility}  `,
    `**Provider:** ${provider}  `,
    `**Generated:** ${date}  `,
    '',
    `**Total tokens:** ${rendered.estimatedTokens.toLocaleString()}  `,
    `**Context tokens:** ${contextTokens.toLocaleString()}  `,
    ...(includeTokens > 0 ? [`**Include tokens:** ${includeTokens.toLocaleString()}  `] : []),
    `**Template tokens:** ${Math.max(0, templateTokens).toLocaleString()}  `,
    `**Total characters:** ${rendered.estimatedChars.toLocaleString()}  `,
    `**Total words:** ${rendered.estimatedWords.toLocaleString()}  `,
    '',
    '---',
    '',
    ...includeSection,
    '## Context Blocks',
    '',
    blockSection || '*No context blocks rendered.*',
    '',
    '---',
    '',
    '## Rendered Prompt',
    '',
    rendered.finalPrompt,
  ];

  return parts.join('\n');
}

function formatResultDoc(rendered: RenderedPrompt, ctx: PromptRunContext, result: string, elapsedMs?: number): string {
  const chapterLine = ctx.chapterTitle
    ? `**Chapter:** ${ctx.chapterNumber != null ? `${ctx.chapterNumber} — ` : ''}${ctx.chapterTitle}  `
    : '';

  const durationLine = elapsedMs != null
    ? `**Duration:** ${elapsedMs < 60_000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${Math.floor(elapsedMs / 60_000)}m ${Math.round((elapsedMs % 60_000) / 1000)}s`}  `
    : undefined;

  return [
    `# ${rendered.promptTitle}`,
    '',
    chapterLine,
    `**Ran:** ${new Date().toLocaleString()}  `,
    durationLine,
    `**Tokens (estimated):** ${rendered.estimatedTokens.toLocaleString()}  `,
    '',
    '---',
    '',
    result,
  ].filter((l): l is string => l !== undefined).join('\n');
}

// ─── Context resolution ───────────────────────────────────────────────────────

function resolveRunContext(
  scope:         string,
  item:          NavigatorItem | undefined,
  getRootFolder: () => string,
): PromptRunContext | null {
  const rootFolder = getRootFolder();
  const ctx: PromptRunContext = { rootFolder };

  const filePath = item?.itemFilePath && fs.existsSync(item.itemFilePath)
    ? item.itemFilePath
    : undefined;

  if (filePath) {
    ctx.chapterPath = filePath;
    ctx.chapterId   = path.basename(filePath, path.extname(filePath));

    // Pass the heading label as a title hint so multi-chapter single-file novels
    // resolve to the correct chapter entry rather than always returning the first.
    const titleHint = item?.label ? String(item.label).trim() : undefined;
    const meta = readChapterMeta(rootFolder, ctx.chapterId, titleHint);
    if (meta) { ctx.chapterId = meta.id; ctx.chapterNumber = meta.number; ctx.chapterTitle = meta.title; }

    if (scope === 'chapter' || scope === 'selection') {
      ctx.chapterText = readChapterOrSection(item, filePath);
    }
  } else {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
      if (scope === 'manuscript') return ctx; // manuscript doesn't need a chapter
      return null;
    }

    ctx.chapterPath = editor.document.uri.fsPath;
    ctx.chapterId   = path.basename(ctx.chapterPath, path.extname(ctx.chapterPath));

    const meta = readChapterMeta(rootFolder, ctx.chapterId);
    if (meta) { ctx.chapterId = meta.id; ctx.chapterNumber = meta.number; ctx.chapterTitle = meta.title; }

    if (scope === 'selection') {
      const sel = editor.selection;
      if (!sel.isEmpty) ctx.selectedText = editor.document.getText(sel);
      else              ctx.chapterText  = editor.document.getText();
    } else if (scope === 'chapter') {
      ctx.chapterText = editor.document.getText();
    }
  }

  return ctx;
}

function readChapterMeta(rootFolder: string, chapterId: string, titleHint?: string) {
  try {
    const p    = path.join(rootFolder, '.draft-script', 'indexes', 'chapters.json');
    const list = JSON.parse(fs.readFileSync(p, 'utf-8')) as { id: string; number: number; title: string; filePath: string }[];

    // Primary: match by DSM-assigned id (one-file-per-chapter projects).
    const byId = list.find(c => c.id === chapterId);
    if (byId) return byId;

    // Fallback: match by actual filename. When all chapters share one file (single
    // large .md with heading-per-chapter), use the heading label to disambiguate.
    const byFile = list.filter(c => path.basename(c.filePath, path.extname(c.filePath)) === chapterId);
    if (!byFile.length)   return undefined;
    if (byFile.length === 1) return byFile[0];

    if (titleHint) {
      const exact = byFile.find(c => c.title === titleHint);
      if (exact) return exact;
      // Looser match: one contains the other (handles subtitle variations)
      const loose = byFile.find(c => c.title.includes(titleHint) || titleHint.includes(c.title));
      if (loose) return loose;
    }

    return undefined; // multiple chapters, no hint — don't guess
  } catch { return undefined; }
}

function readChapterOrSection(item: NavigatorItem | undefined, filePath: string): string {
  const text = fs.readFileSync(filePath, 'utf-8');

  if (item?.kind === 'heading' && item.headingLevel != null && item.label) {
    const lines  = text.split(/\r?\n/);
    const prefix = '#'.repeat(item.headingLevel) + ' ';
    const start  = lines.findIndex(l => l.startsWith(prefix) && l.includes(String(item.label)));
    if (start < 0) return text;

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = /^(#+) /.exec(lines[i]);
      if (m && m[1].length <= item.headingLevel) { end = i; break; }
    }
    return lines.slice(start, end).join('\n');
  }

  return text;
}
