import * as vscode from 'vscode';
import * as path from 'path';

import { NavigatorTreeProvider } from './providers/navigatorTreeProvider';
import { StatisticsWebviewProvider } from './providers/statisticsWebviewProvider';
import { CharactersWebviewProvider } from './providers/charactersWebviewProvider';
import { RepetitionWebviewProvider } from './providers/analyticsWebviewProvider';
import { mergeChapters } from './commands/mergeChapters';
import { splitDocument } from './commands/splitDocument';
import { selectNovelFolder } from './commands/selectNovelFolder';
import { ChapterContentProvider } from './providers/chapterContentProvider';
import { ChapterFileSystemProvider } from './providers/chapterFileSystemProvider';
import { extractSection } from './utils/markdownParser';
import { addComment }                        from './commands/addComment';
import { dsmAnalyzeText, dsmAnalyzeChapter, dsmPreviewAnalyzeChapter, dsmRescanChanged } from './commands/dsmAnalyzeText';
import { importDsmCharacters }               from './commands/importDsmCharacters';
import { CanonEditorPanel }                  from './providers/canonEditorPanel';
import { IndexExplorerPanel }               from './providers/indexExplorerPanel';
import { DsmDashboardProvider }              from './providers/dsmDashboardProvider';
import { DsmDashboardPanel }                from './providers/dsmDashboardPanel';
import { pickVsCodeLmModel, pickOllamaModel } from './dsm/llmProviders';
import { addChapter } from './commands/addChapter';
import { insertChapterBefore, insertChapterAfter, renumberChapters, moveChapter } from './commands/chapterManagement';
import { regenerateIndexes }   from './commands/regenerateIndexes';
import { markChapterScanned } from './commands/markScanned';
import { previewPrompt, copyPrompt, runPrompt, runAndSavePrompt } from './commands/runPrompt';
import { runThreadAction } from './commands/threadActions';
import { openDashboard, openDashboardFolder, reloadDashboards } from './commands/dashboardCommands';
import { inspectChapterTime, inspectTimeRange, inspectCurrentChapterTime } from './commands/timeInspector';
import { copyChapterToClipboard } from './commands/copyChapter';
import { StoryNavigatorPanel } from './providers/storyNavigatorPanel';
import { PromptRegistry }          from './dsm/promptRunner/promptRegistry';
import { VirtualDocumentProvider } from './providers/promptResultProvider';
import { CommentDecorationProvider } from './providers/commentDecorationProvider';
import { CharacterHoverProvider } from './providers/characterHoverProvider';
import { CommentsWebviewProvider } from './providers/commentsWebviewProvider';
import { getAllMarkdownFiles } from './utils/markdownParser';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRootFolder(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
}

function getNovelFolder(): string {
  const cfg = vscode.workspace.getConfiguration('draftScript');
  const configured = cfg.get<string>('novelFolder', '').trim();

  if (configured) {
    if (path.isAbsolute(configured)) return configured;
    const ws = vscode.workspace.workspaceFolders?.[0];
    if (ws) return path.join(ws.uri.fsPath, configured);
  }

  return getRootFolder();
}

// ---------------------------------------------------------------------------
// Focus mode toggle
// ---------------------------------------------------------------------------

async function doToggleViewMode(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('draftScript');
  const next = cfg.get<string>('viewMode', 'continuous') === 'continuous' ? 'focus' : 'continuous';
  await cfg.update('viewMode', next, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('setContext', 'draftScript.isFocusMode', next === 'focus');
  vscode.window.showInformationMessage(
    next === 'focus'
      ? 'Draft-Script: Chapter Focus — click a heading to open just that section.'
      : 'Draft-Script: Continuous — clicking a heading navigates inside the full file.'
  );
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

let dsmScanRunning = false;

function applyLlmContext(): void {
  const llm = vscode.workspace.getConfiguration('draftScript').get<boolean>('enableLLM', true);
  vscode.commands.executeCommand('setContext', 'draftScript.llmEnabled', llm);
}

function getNavigatorVisibleMarkdownFiles(folder: string): string[] {
  if (!folder || !fs.existsSync(folder)) return [];
  const excluded = new Set<string>(
    vscode.workspace.getConfiguration('draftScript').get<string[]>('navigatorExclude', [])
  );
  return getAllMarkdownFiles(folder).filter(f => {
    if (path.basename(f) === 'characters.md') return false;
    const rel = path.relative(folder, f);
    const firstSegment = rel.split(path.sep)[0];
    return !excluded.has(firstSegment);
  });
}

function updateMultiFileContextForFolder(folder: string): void {
  const files = getNavigatorVisibleMarkdownFiles(folder);
  vscode.commands.executeCommand('setContext', 'draftScript.isMultiFile', files.length > 1);
}

export function activate(context: vscode.ExtensionContext): void {
  const novelFolder = getNovelFolder();

  // Sync focus-mode context key so toolbar icons reflect the stored setting.
  const isFocus = vscode.workspace.getConfiguration('draftScript').get<string>('viewMode', 'continuous') === 'focus';
  vscode.commands.executeCommand('setContext', 'draftScript.isFocusMode', isFocus);

  // Set multi-file context so focus-mode buttons hide in split-file novels.
  updateMultiFileContextForFolder(novelFolder);
  vscode.commands.executeCommand('setContext', 'draftScript.statsLocked', false);

  // Apply LLM-toggle and panel-visibility context keys.
  applyLlmContext();

  // --- Providers ---
  const navigatorProvider = new NavigatorTreeProvider(novelFolder);
  const statisticsProvider = new StatisticsWebviewProvider(novelFolder);
  const charactersProvider = new CharactersWebviewProvider(novelFolder, getRootFolder());
  const repetitionProvider = new RepetitionWebviewProvider(novelFolder);
  const commentDecorationProvider = new CommentDecorationProvider(getRootFolder);
  const characterHoverProvider = new CharacterHoverProvider(getRootFolder);
  const commentsProvider = new CommentsWebviewProvider(getRootFolder, getNovelFolder);
  const dsmDashboardProvider = new DsmDashboardProvider(getRootFolder);

  // --- Prompt Runner ---
  const promptPreviewProvider = new VirtualDocumentProvider(VirtualDocumentProvider.PREVIEW_SCHEME);
  const promptResultProvider  = new VirtualDocumentProvider(VirtualDocumentProvider.RESULT_SCHEME);
  const promptRegistry        = new PromptRegistry(getRootFolder());
  promptRegistry.load();
  promptRegistry.watch(context);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(VirtualDocumentProvider.PREVIEW_SCHEME, promptPreviewProvider),
    vscode.workspace.registerTextDocumentContentProvider(VirtualDocumentProvider.RESULT_SCHEME,  promptResultProvider),
    promptPreviewProvider,
    promptResultProvider,
  );

  // --- Tree view ---
  const navigatorTree = vscode.window.createTreeView('draftScript.navigator', {
    treeDataProvider: navigatorProvider,
    showCollapseAll: true,
  });

  // --- Chapter content provider (read-only virtual chapter view) ---
  const chapterContent = new ChapterContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      ChapterContentProvider.scheme, chapterContent
    )
  );

  // --- Chapter filesystem provider (draft-chapter:///) - editable, syncs back to source ---
  const chapterFS = new ChapterFileSystemProvider();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      ChapterFileSystemProvider.scheme, chapterFS,
      { isCaseSensitive: false, isReadonly: false }
    )
  );

  // --- Webview views ---
  context.subscriptions.push(
    navigatorTree,
    vscode.window.registerWebviewViewProvider('draftScript.statistics', statisticsProvider),
    vscode.window.registerWebviewViewProvider('draftScript.characters', charactersProvider),
    vscode.window.registerWebviewViewProvider('draftScript.repetition', repetitionProvider),
    commentDecorationProvider,
    vscode.languages.registerDefinitionProvider({ language: 'markdown' }, commentDecorationProvider),
    vscode.languages.registerHoverProvider({ language: 'markdown' }, commentDecorationProvider),
    vscode.languages.registerHoverProvider({ language: 'markdown' }, characterHoverProvider),
    vscode.window.registerWebviewViewProvider('draftScript.comments', commentsProvider),
    vscode.window.registerWebviewViewProvider('draftScript.dsmDashboard', dsmDashboardProvider),
  );

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('draftScript.mergeChapters', () =>
      mergeChapters(getNovelFolder())
    ),
    vscode.commands.registerCommand('draftScript.splitDocument', () =>
      splitDocument(getNovelFolder())
    ),
    vscode.commands.registerCommand('draftScript.refreshNavigator', () => {
      const folder = getNovelFolder();
      navigatorProvider.setNovelFolder(folder);
      statisticsProvider.setNovelFolder(folder);
    }),
    vscode.commands.registerCommand('draftScript.refreshCharacters', () =>
      charactersProvider.setNovelFolder(getNovelFolder())
    ),
    vscode.commands.registerCommand('draftScript.refreshRepetition', () =>
      repetitionProvider.setNovelFolder(getNovelFolder())
    ),

    vscode.commands.registerCommand('draftScript.addChapter', () =>
      addChapter(getNovelFolder())
    ),

    vscode.commands.registerCommand('draftScript.addComment', () =>
      addComment(getRootFolder())
    ),

    vscode.commands.registerCommand('draftScript.dsmAnalyzeText', () =>
      dsmAnalyzeText(getRootFolder, getNovelFolder, context)
    ),

    vscode.commands.registerCommand('draftScript.dsmAnalyzeChapter', (item) =>
      dsmAnalyzeChapter(item, getRootFolder, getNovelFolder, context)
        .then(() => { dsmDashboardProvider.refresh(); DsmDashboardPanel.refresh(); })
        .catch(() => { /* error already shown by command */ })
    ),

    vscode.commands.registerCommand('draftScript.dsmPreviewAnalyzeChapter', (item) =>
      dsmPreviewAnalyzeChapter(item, getRootFolder)
    ),

    vscode.commands.registerCommand('draftScript.importDsmCharacters', () =>
      importDsmCharacters(getRootFolder)
    ),

    vscode.commands.registerCommand('draftScript.dsmOpenCanonEditor', () =>
      CanonEditorPanel.open(context)
    ),

    vscode.commands.registerCommand('draftScript.dsmOpenIndexExplorer', () =>
      IndexExplorerPanel.open(context)
    ),

    vscode.commands.registerCommand('draftScript.dsmSelectModel', () =>
      pickVsCodeLmModel()
    ),

    vscode.commands.registerCommand('draftScript.dsmSelectOllamaModel', () =>
      pickOllamaModel()
    ),

    vscode.commands.registerCommand('draftScript.dsmOpenDashboard', () =>
      openDashboard(context, getRootFolder)
    ),

    vscode.commands.registerCommand('draftScript.dsmReloadDashboards', () =>
      reloadDashboards(getRootFolder, dsmDashboardProvider)
    ),

    vscode.commands.registerCommand('draftScript.dsmOpenDashboardFolder', () =>
      openDashboardFolder(getRootFolder)
    ),

    vscode.commands.registerCommand('draftScript.dsmConfirmSuggestedResolution', () =>
      runThreadAction('confirmSuggestedResolution', getRootFolder)
    ),
    vscode.commands.registerCommand('draftScript.dsmRejectSuggestedResolution', () =>
      runThreadAction('rejectSuggestedResolution', getRootFolder)
    ),
    vscode.commands.registerCommand('draftScript.dsmMarkThreadResolved', () =>
      runThreadAction('markResolved', getRootFolder)
    ),
    vscode.commands.registerCommand('draftScript.dsmReopenThread', () =>
      runThreadAction('reopen', getRootFolder)
    ),
    vscode.commands.registerCommand('draftScript.dsmMarkThreadActive', () =>
      runThreadAction('markActive', getRootFolder)
    ),
    vscode.commands.registerCommand('draftScript.dsmLinkParentThread', () =>
      runThreadAction('linkParent', getRootFolder)
    ),

    vscode.commands.registerCommand('draftScript.previewPrompt', (item) =>
      previewPrompt(item, promptRegistry, promptPreviewProvider, getRootFolder)
    ),
    vscode.commands.registerCommand('draftScript.copyPrompt', (item) =>
      copyPrompt(item, promptRegistry, getRootFolder)
    ),
    vscode.commands.registerCommand('draftScript.runPrompt', (item) =>
      runPrompt(item, promptRegistry, promptResultProvider, getRootFolder)
    ),
    vscode.commands.registerCommand('draftScript.runAndSavePrompt', (() => {
      let running = false;
      return async (item) => {
        if (running) return;
        running = true;
        try { await runAndSavePrompt(item, promptRegistry, getRootFolder); }
        finally { running = false; }
      };
    })()),

    vscode.commands.registerCommand('draftScript.dsmMarkChapterScanned', (item) =>
      markChapterScanned(item, navigatorProvider, getRootFolder)
    ),

    vscode.commands.registerCommand('draftScript.openStoryNavigator', () =>
      StoryNavigatorPanel.open(context, getRootFolder)
    ),

    vscode.commands.registerCommand('draftScript.dsmRegenerateIndexes', async () => {
      const rebuilt = await regenerateIndexes(getRootFolder);
      if (rebuilt) {
        navigatorProvider.refresh();
        dsmDashboardProvider.refresh();
        DsmDashboardPanel.refresh();
      }
    }),

    vscode.commands.registerCommand('draftScript.dsmRescanChanged', () => {
      if (dsmScanRunning) {
        vscode.window.showWarningMessage('DSM: A scan is already running — wait until it finishes.');
        return;
      }
      dsmScanRunning = true;
      dsmRescanChanged(getRootFolder, getNovelFolder).finally(() => {
        dsmScanRunning = false;
        dsmDashboardProvider.refresh();
        DsmDashboardPanel.refresh();
      });
    }),

    vscode.commands.registerCommand('draftScript.openCharactersFile', () => {
      const charPath = path.join(getRootFolder(), 'characters.md');
      if (fs.existsSync(charPath)) {
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(charPath));
      } else {
        vscode.window.showWarningMessage('Draft-Script: characters.md not found in workspace root.');
      }
    }),

    vscode.commands.registerCommand('draftScript.openNotesFile', () => {
      const notesPath = path.join(getRootFolder(), 'notes.md');
      if (fs.existsSync(notesPath)) {
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(notesPath));
      } else {
        vscode.window.showWarningMessage('Draft-Script: notes.md not found in workspace root.');
      }
    }),

    vscode.commands.registerCommand(
      'draftScript.openNote',
      async ({ id, notesPath }: { id: number; notesPath: string }) => {
        let doc: vscode.TextDocument;
        try {
          doc = await vscode.workspace.openTextDocument(vscode.Uri.file(notesPath));
        } catch {
          vscode.window.showWarningMessage('Draft-Script: notes.md not found.');
          return;
        }
        const editor = await vscode.window.showTextDocument(doc);
        const lineIndex = doc.getText().split('\n')
          .findIndex(l => l.trim() === `<!-- Link-${id} -->`);
        if (lineIndex >= 0) {
          const pos = new vscode.Position(lineIndex, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
        }
      }
    ),

    vscode.commands.registerCommand('draftScript.selectNovelFolder', () =>
      selectNovelFolder(folder => {
        navigatorProvider.setNovelFolder(folder);
        statisticsProvider.setNovelFolder(folder);
        charactersProvider.setNovelFolder(folder);
        repetitionProvider.setNovelFolder(folder);
      })
    ),

    // Opens a file at a specific heading line.
    // Continuous mode: navigate to that line in the source file.
    // Focus mode:      show just that section's text in the single draft-focus tab.
    //                  The tab URI never changes so VS Code always reuses it.
    vscode.commands.registerCommand(
      'draftScript.openAtLine',
      async (filePath: string, line: number, headingText?: string, headingLevel?: number) => {
        const cfg = vscode.workspace.getConfiguration('draftScript');
        const focusMode = cfg.get<string>('viewMode', 'continuous') === 'focus';

        if (focusMode && headingText && headingLevel !== undefined) {
          const uri = chapterFS.registerChapter({ sourcePath: filePath, headingText, headingLevel });

          // Close any other draft-chapter tabs to avoid accumulation; reuse if same chapter.
          const tabsToClose: vscode.Tab[] = [];
          for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
              const input = tab.input as { uri?: vscode.Uri } | undefined;
              if (input?.uri?.scheme === ChapterFileSystemProvider.scheme &&
                  input.uri.toString() !== uri.toString()) {
                tabsToClose.push(tab);
              }
            }
          }
          if (tabsToClose.length) {
            await vscode.window.tabGroups.close(tabsToClose, true);
          }

          // Keep static fields in sync so analytics can reference the source location.
          ChapterContentProvider.currentSourcePath = filePath;
          ChapterContentProvider.currentHeadingLine = line;

          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Active,
            preserveFocus: false,
            preview: false,
          });
        } else {
          // Continuous mode — navigate inside the full source file
          const uri = vscode.Uri.file(filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(doc);
          const pos = new vscode.Position(line, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
        }
      }
    ),

    // Toggle between continuous and chapter-focus view modes
    vscode.commands.registerCommand('draftScript.toggleViewMode', doToggleViewMode),
    vscode.commands.registerCommand('draftScript.enableFocusMode',  doToggleViewMode),
    vscode.commands.registerCommand('draftScript.disableFocusMode', doToggleViewMode),

    // Lock / unlock statistics panel to novel scope
    vscode.commands.registerCommand('draftScript.lockStats',   () => statisticsProvider.toggleLock()),
    vscode.commands.registerCommand('draftScript.unlockStats', () => statisticsProvider.toggleLock()),

    // Chapter management
    vscode.commands.registerCommand('draftScript.insertChapterBefore', async (item) => {
      await insertChapterBefore(item, getNovelFolder());
      navigatorProvider.setNovelFolder(getNovelFolder());
    }),
    vscode.commands.registerCommand('draftScript.insertChapterAfter', async (item) => {
      await insertChapterAfter(item, getNovelFolder());
      navigatorProvider.setNovelFolder(getNovelFolder());
    }),
    vscode.commands.registerCommand('draftScript.moveChapter', async (item) => {
      await moveChapter(item, getNovelFolder());
      navigatorProvider.setNovelFolder(getNovelFolder());
    }),
    vscode.commands.registerCommand('draftScript.renumberChapters', async () => {
      await renumberChapters(getNovelFolder());
      navigatorProvider.setNovelFolder(getNovelFolder());
    }),
    vscode.commands.registerCommand('draftScript.copyChapterToClipboard', (item) => {
      copyChapterToClipboard(item);
    })
  );

  // --- Time Inspector ---
  context.subscriptions.push(
    vscode.commands.registerCommand('draftScript.inspectChapterTime', () =>
      inspectChapterTime(getRootFolder(), getNovelFolder())
    ),
    vscode.commands.registerCommand('draftScript.inspectTimeRange', () =>
      inspectTimeRange(getRootFolder(), getNovelFolder())
    ),
    vscode.commands.registerCommand('draftScript.inspectCurrentChapterTime', () =>
      inspectCurrentChapterTime(getRootFolder(), getNovelFolder())
    ),
  );

  // --- Smart dashes ---
  // Guard prevents the replacement edit from re-triggering itself
  let applyingSmartDash = false;

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      if (applyingSmartDash) return;

      const cfg = vscode.workspace.getConfiguration('draftScript');
      if (!cfg.get<boolean>('enableSmartDashes', true)) return;
      if (event.document.languageId !== 'markdown') return;

      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document !== event.document) return;

      for (const change of event.contentChanges) {
        // Only act on a single '-' typed with no selection
        if (change.text !== '-' || !change.range.isEmpty) continue;

        const pos = change.range.start;
        const lineText = event.document.lineAt(pos.line).text;

        // The new '-' landed at pos.character; check the character before it
        if (pos.character < 1 || lineText[pos.character - 1] !== '-') continue;

        // Skip if inside a code span (odd number of backticks before cursor)
        const before = lineText.substring(0, pos.character);
        const backticks = (before.match(/`/g) ?? []).length;
        if (backticks % 2 !== 0) continue;

        applyingSmartDash = true;
        editor
          .edit(eb => {
            const start = new vscode.Position(pos.line, pos.character - 1);
            const end = new vscode.Position(pos.line, pos.character + 1);
            eb.replace(new vscode.Range(start, end), '—'); // em-dash
          })
          .then(() => { applyingSmartDash = false; });
        return; // one replacement per keystroke
      }
    })
  );

  // --- File-system watcher for auto-refresh ---
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');

  const refreshAll = () => {
    const folder = getNovelFolder();
    navigatorProvider.setNovelFolder(folder);
    statisticsProvider.setNovelFolder(folder);
    charactersProvider.setNovelFolder(folder);
    repetitionProvider.setNovelFolder(folder);
    characterHoverProvider.refresh();
    commentsProvider.refresh();
    updateMultiFileContextForFolder(folder);
  };

  context.subscriptions.push(
    watcher,
    watcher.onDidChange(refreshAll),
    watcher.onDidCreate(refreshAll),
    watcher.onDidDelete(refreshAll),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('draftScript.navigatorExclude') ||
          e.affectsConfiguration('draftScript.novelFolder')) {
        refreshAll();
      }
      if (e.affectsConfiguration('draftScript.enableLLM')) {
        applyLlmContext();
        refreshAll();
      }
    })
  );

  // --- Refresh stats + repetition when the active editor changes ---
  // Pass the editor directly from the event — avoids the race condition where
  // vscode.window.activeTextEditor still reflects the previous editor when the
  // providers' compute methods run.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(editor => {
      statisticsProvider.refreshForEditor(editor);
      repetitionProvider.refreshForEditor(editor);
      if (editor) commentDecorationProvider.updateDecorations(editor);
    })
  );

  // --- Real-time statistics while editing inside a chapter isolation document ---
  let statsDebounce: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.scheme === ChapterContentProvider.scheme) {
        clearTimeout(statsDebounce);
        statsDebounce = setTimeout(() => {
          statisticsProvider.refreshForEditor(vscode.window.activeTextEditor);
        }, 400);
      }
    })
  );

  // --- Statistics + Repetition: update scope as cursor moves through chapters ---
  let selDebounce: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    { dispose() { clearTimeout(selDebounce); } },
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (!e.textEditor.document.uri.fsPath.toLowerCase().endsWith('.md')) return;
      clearTimeout(selDebounce);
      selDebounce = setTimeout(() => {
        statisticsProvider.refreshForEditor(e.textEditor);
        repetitionProvider.refreshForEditor(e.textEditor);
      }, 300);
    })
  );

  // --- Typewriter mode ---
  // After every cursor move in a markdown file, re-center the viewport on the
  // cursor so it feels like paper feeding through a typewriter.
  // Skipped when the user is drag-selecting text (selection not empty).
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(event => {
      const cfg = vscode.workspace.getConfiguration('draftScript');
      if (!cfg.get<boolean>('typewriterMode', false)) return;
      if (event.textEditor.document.languageId !== 'markdown') return;
      if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse) return;
      if (!event.selections[0].isEmpty) return;

      const pos = event.selections[0].active;
      event.textEditor.revealRange(
        new vscode.Range(pos, pos),
        vscode.TextEditorRevealType.InCenter
      );
    })
  );

  // --- Re-read config changes ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('draftScript')) refreshAll();
    })
  );

  // --- Re-apply comment decorations when a markdown document is edited ---
  let decorationDebounce: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId !== 'markdown') return;
      const editor = vscode.window.visibleTextEditors.find(e => e.document === event.document);
      if (!editor) return;
      clearTimeout(decorationDebounce);
      decorationDebounce = setTimeout(() => commentDecorationProvider.updateDecorations(editor), 200);
    })
  );

  // Apply decorations to any markdown editors already open at startup
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.languageId === 'markdown') {
      commentDecorationProvider.updateDecorations(editor);
    }
  }
}

export function deactivate(): void {
  // Nothing to clean up beyond subscriptions managed by context
}
