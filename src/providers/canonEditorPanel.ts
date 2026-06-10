import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import { CanonManager, ENTITY_CATEGORIES } from '../dsm/canonManager';
import {
  CanonEntry, CanonOverride, IndexOverride,
  CharacterIndexItem, Signal, ChapterAnalysis, ReferenceIndexItem,
} from '../dsm/draftScriptTypes';
import { AnalysisStore } from '../dsm/analysisStore';
import { IndexBuilder } from '../dsm/indexBuilder';
import { SignalManager } from '../dsm/signalManager';
import { OverrideStore } from '../dsm/overrideStore';
import { openTextDocumentPreferVisible, selectAndReveal } from '../utils/navigation';

// ---------------------------------------------------------------------------
// Effective entry type (canon + override composed)
// ---------------------------------------------------------------------------

interface EffectiveEntry extends CanonEntry {
  notes?: string;
  tags?:  string[];
}

function composeEntry(entry: CanonEntry, override?: CanonOverride): EffectiveEntry {
  return {
    ...entry,
    name:        override?.title       ?? entry.name,
    aliases:     override?.aliases     ?? entry.aliases,
    description: override?.description ?? entry.description,
    notes:       override?.notes,
    tags:        override?.tags,
  };
}

function composeEntries(
  entries:  CanonEntry[],
  overrides: Record<string, CanonOverride>,
): EffectiveEntry[] {
  return entries.map(e => composeEntry(e, overrides[e.id]));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class CanonEditorPanel {
  static open(context: vscode.ExtensionContext): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      vscode.window.showWarningMessage('DSM Canon Editor: no workspace folder open.');
      return;
    }

    const canonMgr  = new CanonManager(root);
    const store     = new AnalysisStore(root);
    const sigMgr    = new SignalManager(root);
    const overrides = new OverrideStore(root);

    sigMgr.ensureExists();

    rebuildIndexes(root, store, canonMgr, overrides);

    // Compose effective entries (canon + overrides)
    const allEntries: Record<string, EffectiveEntry[]> = {};
    for (const cat of ENTITY_CATEGORIES) {
      const ovrs = overrides.readCanon(cat);
      allEntries[cat] = composeEntries(canonMgr.readEffective(cat, ovrs), ovrs);
    }

    const signals: Signal[] = sigMgr.read();

    // Entity index items (for appearances display)
    const entityIndexes: Record<string, CharacterIndexItem[]> = {};
    for (const cat of ENTITY_CATEGORIES) {
      entityIndexes[cat] = readIndexArray<CharacterIndexItem>(root, cat);
    }

    // Index overrides (for composing merged appearances in webview)
    const entityIdxOverrides: Record<string, Record<string, IndexOverride>> = {};
    for (const cat of ENTITY_CATEGORIES) {
      entityIdxOverrides[cat] = overrides.readIndex(cat);
    }

    // Chapter map keyed by chapterId
    const chapterMapArr = readIndexArray<{ id: string; number: number; title: string; filePath: string }>(root, 'chapters');
    const chapterMap: Record<string, { number: number; title: string; filePath: string }> = {};
    for (const item of chapterMapArr) {
      chapterMap[item.id] = { number: item.number, title: item.title, filePath: item.filePath };
    }

    const refItems = readIndexArray<ReferenceIndexItem>(root, 'reference');

    const activeEditor = vscode.window.activeTextEditor;
    const openBesideManuscript =
      activeEditor?.document.uri.scheme === 'file' &&
      activeEditor.document.uri.fsPath.toLowerCase().endsWith('.md') &&
      isInsidePath(activeEditor.document.uri.fsPath, root);

    const panel = vscode.window.createWebviewPanel(
      'dsmCanonEditor',
      'DSM Canon Editor',
      openBesideManuscript ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const cfg      = vscode.workspace.getConfiguration('draftScript');
    const fontSize = cfg.get<number>('dsmReviewFontSize', 13);
    panel.webview.html = buildHtml(
      allEntries, signals, fontSize,
      entityIndexes, entityIdxOverrides, chapterMap, refItems,
    );

    panel.webview.onDidReceiveMessage(
      async (msg: Record<string, unknown>) => {
        const category = msg.category as string;

        switch (msg.command) {
          case 'save': {
            overrides.writeCanon(category, msg.id as string, {
              title:       msg.name        as string,
              aliases:     msg.aliases     as string[],
              description: msg.description as string,
              notes:       (msg.notes as string | undefined) || undefined,
            });
            rebuildIndexes(root, store, canonMgr, overrides);
            panel.webview.postMessage({
              command:  'updated',
              category,
              entries:  composeEntries(canonMgr.readEffective(category, overrides.readCanon(category)), overrides.readCanon(category)),
              idxOverrides: overrides.readIndex(category),
              selectId: msg.id,
            });
            break;
          }
          case 'new': {
            const id = msg.id as string;
            overrides.writeCanon(category, id, {
              title:       msg.name        as string,
              aliases:     msg.aliases     as string[],
              description: msg.description as string,
              notes:       (msg.notes as string | undefined) || undefined,
              userCreated: true,
            });
            rebuildIndexes(root, store, canonMgr, overrides);
            panel.webview.postMessage({
              command:  'updated',
              category,
              entries:  composeEntries(canonMgr.readEffective(category, overrides.readCanon(category)), overrides.readCanon(category)),
              idxOverrides: overrides.readIndex(category),
              selectId: id,
            });
            break;
          }
          case 'checkRefs': {
            const result = store.referencesCanonId(category, msg.id as string);
            panel.webview.postMessage({ command: 'refsResult', ...result });
            break;
          }
          case 'delete': {
            canonMgr.removeEntry(category, msg.id as string);
            overrides.clearCanon(category, msg.id as string);
            rebuildIndexes(root, store, canonMgr, overrides);
            panel.webview.postMessage({
              command:  'updated',
              category,
              entries:  composeEntries(canonMgr.readEffective(category, overrides.readCanon(category)), overrides.readCanon(category)),
              idxOverrides: overrides.readIndex(category),
            });
            break;
          }
          case 'merge': {
            const effectiveEntries = composeEntries(canonMgr.readEffective(category, overrides.readCanon(category)), overrides.readCanon(category));
            const source = effectiveEntries.find(e => e.id === msg.sourceId);
            const target = effectiveEntries.find(e => e.id === msg.targetId);
            if (!source || !target) break;

            const combined = new Set([...target.aliases, source.name, ...source.aliases]);
            combined.delete(target.name);

            const targetPatch: Partial<CanonOverride> = { aliases: [...combined] };
            if (msg.mergeDescription) {
              targetPatch.description = [target.description, source.description]
                .filter(Boolean).join('\n').trim();
            }
            overrides.writeCanon(category, msg.targetId as string, targetPatch);

            // Remove source from canon (membership removal)
            canonMgr.removeEntry(category, msg.sourceId as string);
            overrides.clearCanon(category, msg.sourceId as string);

            // Map source index item to target via override (no analysis file mutations)
            overrides.writeIndex(category, msg.sourceId as string, { canonId: msg.targetId as string });

            rebuildIndexes(root, store, canonMgr, overrides);
            panel.webview.postMessage({
              command:  'updated',
              category,
              entries:  composeEntries(canonMgr.readEffective(category, overrides.readCanon(category)), overrides.readCanon(category)),
              idxOverrides: overrides.readIndex(category),
              selectId: msg.targetId,
            });
            break;
          }

          case 'navigateToChapter': {
            const filePath      = msg.filePath      as string;
            const chapterId     = msg.chapterId     as string | undefined;
            const canonId       = msg.canonId       as string | undefined;
            const category2     = msg.category      as string | undefined;
            const title         = msg.title         as string | undefined;
            const entityName    = msg.entityName    as string | undefined;
            const entityAliases = msg.entityAliases as string[] | undefined;
            const referenceText = (msg.referenceText as string | undefined)?.trim();
            if (!filePath) break;
            try {
              const absPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
              const uri = vscode.Uri.file(absPath);
              const { doc, editor } = await openTextDocumentPreferVisible(uri);

              let positioned = false;

              // Try 1: exact reference text from the reference index
              if (!positioned && referenceText) {
                const docText = doc.getText();
                const idx     = docText.indexOf(referenceText);
                if (idx >= 0) {
                  const pos    = doc.positionAt(idx);
                  const endPos = doc.positionAt(idx + referenceText.length);
                  const range  = new vscode.Range(pos, endPos);
                  selectAndReveal(editor, range);
                  positioned = true;
                }
              }

              // Try 2: entity evidence quote from analysis JSON (safety net)
              if (!positioned && chapterId && canonId && category2) {
                const snippet = findEvidenceText(root, chapterId, category2, canonId);
                if (snippet) {
                  const docText = doc.getText();
                  const idx     = docText.indexOf(snippet);
                  if (idx >= 0) {
                    const pos    = doc.positionAt(idx);
                    const endPos = doc.positionAt(idx + snippet.length);
                    const range  = new vscode.Range(pos, endPos);
                    selectAndReveal(editor, range);
                    positioned = true;
                  }
                }
              }

              // Try 3: heading search + entity name / item title selection
              if (!positioned && title) {
                const lines = doc.getText().split('\n');
                const headingLine = lines.findIndex(l => {
                  const m = l.match(/^#{1,6}\s+(.*)/);
                  return m && m[1].trim() === title.trim();
                });
                if (headingLine >= 0) {
                  const headingPos    = new vscode.Position(headingLine, 0);
                  const headingOffset = doc.offsetAt(headingPos);
                  const docText       = doc.getText();
                  let nameFound = false;
                  if (entityName) {
                    const candidates = [entityName, ...(entityAliases ?? [])].filter(s => s.trim());
                    let bestIdx = -1;
                    let bestLen = 0;
                    for (const n of candidates) {
                      const idx = docText.indexOf(n, headingOffset);
                      if (idx >= 0 && (bestIdx === -1 || idx < bestIdx)) {
                        bestIdx = idx;
                        bestLen = n.length;
                      }
                    }
                    if (bestIdx >= 0) {
                      const startPos = doc.positionAt(bestIdx);
                      const endPos   = doc.positionAt(bestIdx + bestLen);
                      selectAndReveal(editor, new vscode.Range(startPos, endPos));
                      nameFound = true;
                    }
                  }
                  if (!nameFound) {
                    selectAndReveal(editor, new vscode.Range(headingPos, headingPos), vscode.TextEditorRevealType.AtTop);
                  }
                }
              }
            } catch {
              vscode.window.showErrorMessage('DSM: cannot open chapter file.');
            }
            break;
          }

          // ── Signals ─────────────────────────────────────────────────────────
          case 'saveSignals': {
            const updated = msg.signals as Signal[];
            sigMgr.write(updated);
            rebuildIndexes(root, store, canonMgr, overrides);
            panel.webview.postMessage({ command: 'signalsSaved', signals: updated });
            break;
          }
          case 'discoverSignals': {
            const count   = sigMgr.importOrphans(store);
            const updated = sigMgr.read();
            panel.webview.postMessage({ command: 'signalsSaved', signals: updated });
            vscode.window.showInformationMessage(
              count > 0
                ? `DSM Signals: added ${count} ID${count === 1 ? '' : 's'} found in analyses. Fill in descriptions in the Signals tab.`
                : 'DSM Signals: no new signal IDs found in chapter analyses.'
            );
            break;
          }
        }
      },
      undefined,
      context.subscriptions,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findEvidenceText(root: string, chapterId: string, category: string, canonId: string): string | undefined {
  const file = path.join(root, '.draft-script', 'analysis', 'chapters', `${chapterId}.json`);
  try {
    const analysis = JSON.parse(fs.readFileSync(file, 'utf-8')) as ChapterAnalysis;
    const entities = (analysis as unknown as Record<string, unknown>)[category] as
      Array<{ canonId?: string; possibleCanonId?: string; reference?: Array<{ text: string; kind: string }> }> | undefined;
    if (!entities) return undefined;
    const entity = entities.find(e => e.canonId === canonId || e.possibleCanonId === canonId);
    const refs   = entity?.reference;
    const quotes = refs?.filter(e => e.kind === 'quote');
    return quotes?.[0]?.text?.trim() ?? refs?.[0]?.text?.trim();
  } catch { return undefined; }
}

function readIndexArray<T>(root: string, name: string): T[] {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(root, '.draft-script', 'indexes', `${name}.json`), 'utf-8')
    ) as T[];
  } catch { return []; }
}

function rebuildIndexes(root: string, store: AnalysisStore, canonMgr: CanonManager, overrides: OverrideStore): void {
  try { new IndexBuilder(root, store, canonMgr, overrides).buildAll(); } catch { /* non-fatal */ }
}

function isInsidePath(filePath: string, root: string): boolean {
  const rel = path.relative(root, filePath);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function buildHtml(
  allEntries:          Record<string, EffectiveEntry[]>,
  signals:             Signal[],
  fontSize:            number,
  entityIndexes:       Record<string, CharacterIndexItem[]>,
  entityIdxOverrides:  Record<string, Record<string, IndexOverride>>,
  chapterMap:          Record<string, { number: number; title: string; filePath: string }>,
  refItems:            ReferenceIndexItem[],
): string {
  const entriesJson    = JSON.stringify(allEntries).replace(/<\/script>/gi, '<\\/script>');
  const signalsJson    = JSON.stringify(signals).replace(/<\/script>/gi, '<\\/script>');
  const idxJson        = JSON.stringify(entityIndexes).replace(/<\/script>/gi, '<\\/script>');
  const idxOvrJson     = JSON.stringify(entityIdxOverrides).replace(/<\/script>/gi, '<\\/script>');
  const chMapJson      = JSON.stringify(chapterMap).replace(/<\/script>/gi, '<\\/script>');
  const refJson        = JSON.stringify(refItems).replace(/<\/script>/gi, '<\\/script>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family);
  font-size: ${fontSize}px;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tab-bar {
  display: flex;
  align-items: stretch;
  padding: 0 8px;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border));
  flex-shrink: 0;
  gap: 0;
  overflow-x: auto;
}
.tab-bar::-webkit-scrollbar { height: 3px; }
.tab-bar::-webkit-scrollbar-thumb { background: var(--vscode-widget-border); }
.tab {
  padding: 7px 10px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  color: var(--vscode-panelTitle-inactiveForeground, var(--vscode-foreground));
  font-size: 1em;
  font-family: inherit;
  white-space: nowrap;
  flex-shrink: 0;
  margin-bottom: -1px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tab:hover { color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground)); }
.tab.active {
  color: var(--vscode-panelTitle-activeForeground, var(--vscode-foreground));
  border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--vscode-focusBorder));
}
.tab-spacer { flex: 1; min-width: 8px; }
.btn-new {
  font-size: 1em;
  padding: 0 12px;
  cursor: pointer;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 3px;
  margin: 6px 0 6px 4px;
  font-family: inherit;
  flex-shrink: 0;
}
.btn-new:hover { background: var(--vscode-button-hoverBackground); }
.columns {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.col-list {
  width: 290px;
  flex-shrink: 0;
  border-right: 1px solid var(--vscode-widget-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.list-toolbar {
  padding: 8px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--vscode-widget-border);
}
.search {
  width: 100%;
  padding: 5px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  font-size: 1em;
  font-family: inherit;
}
.search:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
.merge-banner {
  padding: 6px 10px;
  background: rgba(255,180,0,0.1);
  border-bottom: 1px solid rgba(255,180,0,0.3);
  font-size: 1em;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.merge-banner button {
  margin-left: auto;
  font-size: 1em;
  padding: 2px 8px;
  cursor: pointer;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 3px;
  font-family: inherit;
}
.hidden { display: none !important; }
.entry-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.entry-item {
  display: flex;
  align-items: flex-start;
  padding: 7px 10px;
  cursor: pointer;
  gap: 6px;
  border-left: 3px solid transparent;
}
.entry-item:hover { background: var(--vscode-list-hoverBackground); }
.entry-item.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
  border-left-color: var(--vscode-button-background);
}
.entry-item.merge-source { opacity: 0.35; cursor: default; pointer-events: none; }
.entry-info { flex: 1; min-width: 0; }
.entry-name { font-weight: 600; font-size: 1em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.entry-aliases { font-size: 1em; opacity: 0.6; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.entry-actions { flex-shrink: 0; }
.btn-merge {
  font-size: 1em;
  padding: 2px 7px;
  cursor: pointer;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 3px;
  white-space: nowrap;
  font-family: inherit;
}
.btn-merge:hover { background: var(--vscode-button-secondaryHoverBackground); }
.btn-merge-into {
  font-size: 1em;
  padding: 2px 7px;
  cursor: pointer;
  background: rgba(255,180,0,0.18);
  color: var(--vscode-foreground);
  border: 1px solid rgba(255,180,0,0.5);
  border-radius: 3px;
  font-family: inherit;
}
.btn-merge-into:hover { background: rgba(255,180,0,0.32); }
.col-editor { flex: 1; overflow-y: auto; padding: 20px 24px; }
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  opacity: 0.4;
  font-size: 1em;
  text-align: center;
  padding: 32px;
}
.field-group { margin-bottom: 16px; }
.field-label {
  font-size: 0.75em;
  opacity: 0.55;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 5px;
  display: block;
}
.field-input {
  width: 100%;
  padding: 6px 10px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  font-family: inherit;
  font-size: 1em;
}
.field-input:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
.field-readonly { padding: 4px 0; font-size: 1em; opacity: 0.45; font-family: var(--vscode-editor-font-family, monospace); }
.alias-field {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 5px 8px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  min-height: 34px;
  cursor: text;
  align-items: center;
}
.alias-field:focus-within { outline: 1px solid var(--vscode-focusBorder); }
.alias-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 3px;
  font-size: 1em;
  border: 1px solid transparent;
}
.alias-chip-warn { border-color: rgba(255,180,0,0.6); background: rgba(255,180,0,0.12); color: var(--vscode-foreground); }
.alias-chip-remove {
  cursor: pointer;
  opacity: 0.7;
  background: none;
  border: none;
  color: inherit;
  font-size: 1em;
  padding: 0;
  line-height: 1;
}
.alias-chip-remove:hover { opacity: 1; }
.alias-input {
  border: none;
  background: transparent;
  outline: none;
  color: var(--vscode-input-foreground);
  font-family: inherit;
  font-size: 1em;
  flex: 1;
  min-width: 80px;
  padding: 1px 0;
}
.alias-hint { font-size: 1em; opacity: 0.45; margin-top: 3px; }
.alias-warning { font-size: 1em; color: #c8a034; margin-top: 4px; }
.desc-textarea {
  width: 100%;
  min-height: 140px;
  padding: 8px 10px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  font-family: inherit;
  font-size: 1em;
  resize: vertical;
  line-height: 1.55;
}
.notes-textarea {
  width: 100%;
  min-height: 80px;
  padding: 8px 10px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  font-family: inherit;
  font-size: 1em;
  resize: vertical;
  line-height: 1.55;
}
.desc-textarea:focus, .notes-textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
.meta-row { display: flex; gap: 20px; font-size: 1em; opacity: 0.45; margin-bottom: 20px; }
.editor-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 20px; }
.btn-delete {
  padding: 6px 14px;
  cursor: pointer;
  background: transparent;
  color: var(--vscode-errorForeground, #e05252);
  border: 1px solid currentColor;
  border-radius: 3px;
  font-size: 1em;
  opacity: 0.7;
  font-family: inherit;
}
.btn-delete:hover { opacity: 1; }
.btn-save {
  padding: 6px 22px;
  cursor: pointer;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 3px;
  font-size: 1em;
  font-family: inherit;
}
.btn-save:hover { background: var(--vscode-button-hoverBackground); }
/* Modal */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal-box {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 6px;
  padding: 20px 24px;
  max-width: 480px;
  width: 92%;
  box-shadow: 0 6px 32px rgba(0,0,0,0.35);
}
.modal-title { font-size: 1em; font-weight: 600; margin-bottom: 10px; }
.modal-body { font-size: 1em; line-height: 1.55; opacity: 0.85; margin-bottom: 16px; }
.modal-list { margin: 8px 0 0 18px; line-height: 1.75; }
.modal-check { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 1em; cursor: pointer; }
.modal-check input { cursor: pointer; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
.modal-btn {
  padding: 6px 16px;
  cursor: pointer;
  border-radius: 3px;
  font-size: 1em;
  font-family: inherit;
  border: 1px solid transparent;
}
.modal-btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.modal-btn-primary:hover { background: var(--vscode-button-hoverBackground); }
.modal-btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-color: var(--vscode-button-border, transparent); }
.modal-btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.modal-btn-danger { background: transparent; color: var(--vscode-errorForeground, #e05252); border-color: currentColor; }
.modal-btn-danger:hover { background: rgba(224,82,82,0.1); }
.modal-warning { color: #c8a034; font-size: 1em; margin-top: 8px; }
/* Signals tab */
.signals-pane { flex: 1; overflow-y: auto; padding: 16px 20px; display: flex; flex-direction: column; gap: 0; }
.signal-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--vscode-widget-border);
}
.signal-row:last-child { border-bottom: none; }
.signal-grip { cursor: grab; opacity: 0.35; font-size: 1.1em; padding-top: 2px; flex-shrink: 0; user-select: none; }
.signal-grip:active { cursor: grabbing; }
.signal-fields { flex: 1; display: flex; flex-direction: column; gap: 5px; }
.signal-id-row { display: flex; align-items: center; gap: 8px; }
.signal-id {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.88em;
  padding: 3px 8px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  color: var(--vscode-input-foreground);
  flex: 0 0 auto;
  width: 200px;
}
.signal-id:focus { outline: 1px solid var(--vscode-focusBorder); }
.signal-id[readonly] { opacity: 0.6; cursor: default; background: transparent; border-color: transparent; }
.signal-desc {
  width: 100%;
  padding: 4px 8px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  color: var(--vscode-input-foreground);
  font-family: inherit;
  font-size: 0.88em;
  resize: none;
  line-height: 1.4;
}
.signal-desc:focus { outline: 1px solid var(--vscode-focusBorder); }
.signal-del {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--vscode-errorForeground, #e05252);
  cursor: pointer;
  font-size: 1.1em;
  opacity: 0.5;
  padding: 2px 4px;
}
.signal-del:hover { opacity: 1; }
.signals-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  border-top: 1px solid var(--vscode-widget-border);
  flex-shrink: 0;
}
.btn-add-signal {
  padding: 5px 14px;
  cursor: pointer;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 3px;
  font-size: 0.88em;
  font-family: inherit;
}
.btn-add-signal:hover { background: var(--vscode-button-secondaryHoverBackground); }
.signals-saved { font-size: 0.82em; opacity: 0; transition: opacity 0.4s; color: var(--vscode-charts-green, #4ec94e); }
.signals-saved.show { opacity: 1; }
/* Chapter appearance links */
.appearances-row { display: flex; flex-wrap: wrap; gap: 3px; min-height: 24px; align-items: center; }
.chapter-link {
  display: inline-block;
  padding: 1px 6px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 3px;
  cursor: pointer;
  font-size: 0.88em;
  font-family: var(--vscode-editor-font-family, monospace);
  line-height: 1.6;
  transition: background 0.1s;
}
.chapter-link:hover {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
/* Override indicator */
.override-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vscode-button-background);
  margin-left: 5px;
  vertical-align: middle;
  opacity: 0.7;
  title: 'Has overrides';
}
</style>
</head>
<body>

<div class="tab-bar">
  <button class="tab active" data-cat="characters" onclick="switchTab('characters')">Characters</button>
  <button class="tab" data-cat="locations"   onclick="switchTab('locations')">Locations</button>
  <button class="tab" data-cat="objects"     onclick="switchTab('objects')">Objects</button>
  <button class="tab" data-cat="groups"      onclick="switchTab('groups')">Groups</button>
  <button class="tab" data-cat="signals"     onclick="switchTab('signals')">Signals</button>
  <span class="tab-spacer"></span>
  <button class="btn-new" id="btnNew" onclick="openNew()">+ New</button>
</div>

<div class="columns" id="entityColumns">
  <div class="col-list">
    <div class="list-toolbar">
      <input class="search" id="searchInput" placeholder="Filter entries…" oninput="onFilter(this.value)">
    </div>
    <div class="merge-banner hidden" id="mergeBanner">
      Merging: <strong id="mergeSourceName"></strong>
      <button onclick="cancelMerge()">Cancel</button>
    </div>
    <div class="entry-list" id="entryList"></div>
  </div>
  <div class="col-editor" id="editorPane">
    <div class="empty-state">Select an entry to edit, or click <strong>+ New</strong>.</div>
  </div>
</div>

<!-- Signals pane (hidden when entity tab active) -->
<div id="signalsPanel" class="hidden" style="flex:1;display:flex;flex-direction:column;overflow:hidden;">
  <div class="signals-pane" id="signalsList"></div>
  <div class="signals-footer">
    <button class="btn-add-signal" onclick="addSignal()">+ Add Signal</button>
    <button class="btn-add-signal" onclick="discoverSignals()" title="Find signal IDs used in chapter analyses that are not yet defined">Discover from analyses</button>
    <button class="btn-save" onclick="saveSignals()">Save</button>
    <span class="signals-saved" id="signalsSavedMsg">Saved.</span>
  </div>
</div>

<div class="modal-backdrop hidden" id="modalBackdrop">
  <div class="modal-box" id="modalBox"></div>
</div>

<script>
const vscode        = acquireVsCodeApi();
const allEntries    = ${entriesJson};
const entityIndexes = ${idxJson};
var   idxOverrides  = ${idxOvrJson};
const chapterMap    = ${chMapJson};
var   signals       = ${signalsJson};
const refIndex      = ${refJson};

// Build reference lookup: "sourceType:sourceId:chapterId" -> best quote text
var refMap = {};
refIndex.forEach(function(r) {
  var key = r.sourceType + ':' + r.sourceId + ':' + r.chapterId;
  if (!refMap[key]) refMap[key] = [];
  refMap[key].push(r);
});
function findRef(sourceType, sourceId, chapterId) {
  var refs = refMap[sourceType + ':' + sourceId + ':' + chapterId];
  if (!refs || !refs.length) return '';
  var quote = refs.find(function(r) { return r.kind === 'quote'; });
  return quote ? quote.text.trim() : '';
}
var catToSourceType = { characters: 'character', locations: 'location', objects: 'object', groups: 'group' };

let currentCat    = 'characters';
let filterText    = '';
let selectedId    = null;
let mergeSourceId = null;
let isNewEntry    = false;
let pendingRefsCb = null;
let editorAliases = [];

// Messages from extension
window.addEventListener('message', function(e) {
  var msg = e.data;
  if (msg.command === 'updated') {
    allEntries[msg.category] = msg.entries;
    if (msg.idxOverrides) idxOverrides[msg.category] = msg.idxOverrides;
    if (currentCat === msg.category) {
      mergeSourceId = null;
      isNewEntry    = false;
      if (msg.selectId) {
        selectedId = msg.selectId;
        renderList();
        renderEditor(getEntry(msg.selectId));
      } else {
        selectedId = null;
        renderList();
        renderEditor(null);
      }
    }
  } else if (msg.command === 'refsResult') {
    if (pendingRefsCb) { pendingRefsCb(msg); pendingRefsCb = null; }
  } else if (msg.command === 'signalsSaved') {
    signals = msg.signals;
    var el = document.getElementById('signalsSavedMsg');
    if (el) { el.classList.add('show'); setTimeout(function() { el.classList.remove('show'); }, 2000); }
  }
});

// Data helpers
function currentEntries() { return allEntries[currentCat] || []; }
function getEntry(id) { return currentEntries().find(function(e) { return e.id === id; }) || null; }

function normalizeId(name) {
  return name.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase().trim().replace(/\\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function uniqueId(name, existing) {
  var base = normalizeId(name) || 'entry';
  if (!existing.some(function(e) { return e.id === base; })) return base;
  var n = 2;
  while (existing.some(function(e) { return e.id === base + '_' + n; })) n++;
  return base + '_' + n;
}

function aliasCollision(alias, currentId) {
  var norm = normalizeId(alias);
  var entries = currentEntries();
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.id === currentId) continue;
    if (normalizeId(e.name) === norm) return e.name;
    for (var j = 0; j < e.aliases.length; j++) {
      if (normalizeId(e.aliases[j]) === norm) return e.name;
    }
  }
  return null;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-CA');
}

function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Chapter navigation
function navigateToChapter(chapterId, canonId, category, searchText, refText) {
  var info = chapterMap[chapterId];
  if (!info || !info.filePath) return;
  var msg = { command: 'navigateToChapter', filePath: info.filePath, chapterId: chapterId, title: info.title };
  if (refText) { msg.referenceText = refText; }
  if (canonId) {
    msg.canonId  = canonId;
    msg.category = category;
    var entries = allEntries[category];
    var entry   = entries && entries.find(function(e) { return e.id === canonId; });
    if (entry) {
      msg.entityName    = entry.name;
      msg.entityAliases = entry.aliases || [];
    }
  } else if (searchText) {
    msg.entityName = searchText;
  }
  vscode.postMessage(msg);
}

function renderChapterLinks(appearances, canonId, category, getRef) {
  if (!appearances || !appearances.length) {
    return '<span style="opacity:0.4;font-size:0.9em">none</span>';
  }
  return appearances.map(function(a) {
    var info   = chapterMap[a.chapterId];
    var label  = 'Ch. ' + a.chapterNumber + (info && info.title ? ': ' + info.title : '');
    var extra  = canonId ? ' data-eid="' + esc(canonId) + '" data-cat="' + esc(category) + '"' : '';
    var refTxt = getRef ? getRef(a) : '';
    var ref    = refTxt ? ' data-ref="' + esc(refTxt) + '"' : '';
    return '<span class="chapter-link" title="' + esc(label) + '"' +
           ' data-cid="' + esc(a.chapterId) + '"' + extra + ref +
           ' onclick="navigateToChapter(this.dataset.cid,this.dataset.eid,this.dataset.cat,null,this.dataset.ref)">' +
           a.chapterNumber + '</span>';
  }).join('');
}

function switchTab(cat) {
  currentCat    = cat;
  filterText    = '';
  selectedId    = null;
  mergeSourceId = null;
  isNewEntry    = false;
  editorAliases = [];
  document.querySelectorAll('.tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.cat === cat);
  });

  var isSignals = cat === 'signals';
  var isEntity  = !isSignals;

  document.getElementById('entityColumns').classList.toggle('hidden', !isEntity);
  document.getElementById('signalsPanel').classList.toggle('hidden', !isSignals);
  document.getElementById('btnNew').classList.toggle('hidden', !isEntity);

  if (isSignals) {
    renderSignals();
  } else {
    document.getElementById('searchInput').value = '';
    renderList();
    renderEditor(null);
  }
}

// Filter
function onFilter(val) {
  filterText = val.toLowerCase();
  renderList();
}

// Entry list
function renderList() {
  var entries  = currentEntries();
  var filtered = filterText
    ? entries.filter(function(e) {
        return e.name.toLowerCase().includes(filterText) ||
               e.aliases.some(function(a) { return a.toLowerCase().includes(filterText); });
      })
    : entries;

  var banner = document.getElementById('mergeBanner');
  if (mergeSourceId) {
    var src = getEntry(mergeSourceId);
    document.getElementById('mergeSourceName').textContent = src ? src.name : '';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  var list = document.getElementById('entryList');
  if (filtered.length === 0) {
    list.innerHTML = '<div style="padding:16px 12px;opacity:0.5;font-size:1em;">No entries' +
      (filterText ? ' matching filter.' : ' in this category.') + '</div>';
    return;
  }

  list.innerHTML = filtered.map(function(e) {
    var isSelected = e.id === selectedId && !isNewEntry;
    var isMergeSrc = e.id === mergeSourceId;
    var aliasText  = e.aliases.length ? e.aliases.join(', ') : '';
    var hasOvr     = !!(e.notes || (e.aliases && e.aliases.length));
    var actionHtml = '';

    if (mergeSourceId && !isMergeSrc) {
      actionHtml = '<button class="btn-merge-into">&larr; Merge into</button>';
    } else if (!mergeSourceId) {
      actionHtml = '<button class="btn-merge">Merge&nearr;</button>';
    }

    return '<div class="entry-item' + (isSelected ? ' selected' : '') + (isMergeSrc ? ' merge-source' : '') +
           '" data-id="' + esc(e.id) + '">' +
           '<div class="entry-info">' +
           '<div class="entry-name">' + esc(e.name) + '</div>' +
           (aliasText ? '<div class="entry-aliases">' + esc(aliasText) + '</div>' : '') +
           '</div>' +
           '<div class="entry-actions">' + actionHtml + '</div>' +
           '</div>';
  }).join('');
}

// Entry selection
function selectEntry(id) {
  isNewEntry    = false;
  selectedId    = id;
  mergeSourceId = null;
  renderList();
  renderEditor(getEntry(id));
}

// Editor
function renderEditor(entry) {
  var pane = document.getElementById('editorPane');
  if (!entry && !isNewEntry) {
    pane.innerHTML = '<div class="empty-state">Select an entry to edit, or click <strong>+ New</strong>.</div>';
    return;
  }

  editorAliases = entry ? entry.aliases.slice() : [];
  var currentId = isNewEntry ? null : (entry ? entry.id : null);

  // Collect appearances from primary index item + items overridden to point to this entry
  var appearances = [];
  if (entry && !isNewEntry) {
    var idxArr  = entityIndexes[currentCat] || [];
    var ovrs    = idxOverrides[currentCat]  || {};
    var idxItem = idxArr.find(function(x) { return x.id === entry.id; });
    if (idxItem) appearances = idxItem.appearances.slice();
    // Merged appearances from source items overridden to point to this entry
    idxArr.forEach(function(x) {
      var o = ovrs[x.id];
      if (o && o.canonId === entry.id) {
        appearances = appearances.concat(x.appearances);
      }
    });
    // Deduplicate by chapterId, sort by chapter number
    var seen = {};
    appearances = appearances.filter(function(a) {
      if (seen[a.chapterId]) return false;
      seen[a.chapterId] = true;
      return true;
    });
    appearances.sort(function(a, b) { return a.chapterNumber - b.chapterNumber; });
  }

  var appearancesHtml = entry && !isNewEntry
    ? '<div class="field-group">' +
        '<span class="field-label">Appearances</span>' +
        '<div class="appearances-row">' + renderChapterLinks(appearances, entry.id, currentCat, function(a) {
          return findRef(catToSourceType[currentCat] || currentCat, entry.id, a.chapterId);
        }) + '</div>' +
      '</div>'
    : '';

  pane.innerHTML =
    '<div class="field-group">' +
      '<span class="field-label">ID</span>' +
      '<div class="field-readonly">' + (isNewEntry ? '<em>generated from name on save</em>' : esc(entry.id)) + '</div>' +
    '</div>' +
    '<div class="field-group">' +
      '<label class="field-label" for="fieldName">Name</label>' +
      '<input class="field-input" id="fieldName" value="' + esc(entry ? entry.name : '') + '" placeholder="Name&hellip;">' +
    '</div>' +
    '<div class="field-group">' +
      '<span class="field-label">Aliases</span>' +
      '<div class="alias-field" id="aliasField" onclick="focusAliasInput()">' +
        renderAliasChips(editorAliases, currentId) +
        '<input class="alias-input" id="aliasInput" placeholder="add alias, press Enter&hellip;"' +
               ' onkeydown="onAliasKeydown(event)" oninput="onAliasInputChange()">' +
      '</div>' +
      '<div class="alias-warning hidden" id="aliasWarning"></div>' +
      '<div class="alias-hint">Press Enter or comma to add &middot; Backspace to remove last</div>' +
    '</div>' +
    '<div class="field-group">' +
      '<label class="field-label" for="fieldDesc">Description</label>' +
      '<textarea class="desc-textarea" id="fieldDesc" rows="8" placeholder="Description (plain text / markdown)&hellip;">' +
        esc(entry ? entry.description : '') +
      '</textarea>' +
    '</div>' +
    appearancesHtml +
    '<div class="field-group">' +
      '<label class="field-label" for="fieldNotes">Notes</label>' +
      '<textarea class="notes-textarea" id="fieldNotes" rows="3" placeholder="Personal notes (author-only, not exported)&hellip;">' +
        esc(entry ? (entry.notes || '') : '') +
      '</textarea>' +
    '</div>' +
    '<div class="meta-row">' +
      '<span>Approved: ' + fmtDate(entry ? entry.approvedAt : null) + '</span>' +
      '<span>Modified: ' + fmtDate(entry ? entry.modifiedAt : null) + '</span>' +
    '</div>' +
    '<div class="editor-footer">' +
      (entry ? '<button class="btn-delete" onclick="confirmDelete()">Delete</button>' : '<span></span>') +
      '<button class="btn-save" onclick="saveEntry(' + (isNewEntry ? 'true' : 'false') + ')">Save</button>' +
    '</div>';
}

function renderAliasChips(aliases, currentId) {
  return aliases.map(function(a, i) {
    var collision = aliasCollision(a, currentId);
    return '<span class="alias-chip' + (collision ? ' alias-chip-warn' : '') + '"' +
           (collision ? ' title="Conflicts with: ' + esc(collision) + '"' : '') + '>' +
           esc(a) +
           '<button class="alias-chip-remove" onclick="removeAlias(' + i + ')">&times;</button>' +
           '</span>';
  }).join('');
}

function focusAliasInput() {
  var inp = document.getElementById('aliasInput');
  if (inp) inp.focus();
}

function onAliasKeydown(e) {
  var input = e.target;
  if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
    e.preventDefault();
    addAlias(input.value.trim().replace(/,$/, ''));
    input.value = '';
    updateAliasWarning('');
  } else if (e.key === 'Backspace' && !input.value && editorAliases.length) {
    e.preventDefault();
    removeAlias(editorAliases.length - 1);
  }
}

function onAliasInputChange() {
  var input = document.getElementById('aliasInput');
  if (!input) return;
  var val = input.value.trim().replace(/,$/, '');
  if (val) {
    var currentId = isNewEntry ? null : selectedId;
    var collision = aliasCollision(val, currentId);
    updateAliasWarning(collision ? '&#9888; "' + val + '" already exists in: ' + collision : '');
  } else {
    updateAliasWarning('');
  }
}

function updateAliasWarning(msg) {
  var el = document.getElementById('aliasWarning');
  if (!el) return;
  if (msg) { el.innerHTML = msg; el.classList.remove('hidden'); }
  else      { el.classList.add('hidden'); }
}

function addAlias(value) {
  if (!value || editorAliases.indexOf(value) !== -1) return;
  editorAliases.push(value);
  refreshAliasField();
}

function removeAlias(index) {
  editorAliases.splice(index, 1);
  refreshAliasField();
}

function refreshAliasField() {
  var currentId = isNewEntry ? null : selectedId;
  var field = document.getElementById('aliasField');
  if (!field) return;
  field.innerHTML =
    renderAliasChips(editorAliases, currentId) +
    '<input class="alias-input" id="aliasInput" placeholder="add alias, press Enter&hellip;"' +
           ' onkeydown="onAliasKeydown(event)" oninput="onAliasInputChange()">';
  var collisions = editorAliases
    .map(function(a) { return aliasCollision(a, currentId); })
    .filter(Boolean);
  var unique = collisions.filter(function(v, i, arr) { return arr.indexOf(v) === i; });
  updateAliasWarning(unique.length ? '&#9888; Some aliases conflict with existing entries: ' + unique.join(', ') : '');
  focusAliasInput();
}

// Save
function saveEntry(isNew) {
  var nameEl = document.getElementById('fieldName');
  var name   = nameEl ? nameEl.value.trim() : '';
  if (!name) { nameEl && (nameEl.style.outline = '2px solid var(--vscode-inputValidation-errorBorder, #f44)'); return; }

  var aliasInp = document.getElementById('aliasInput');
  var pending  = aliasInp ? aliasInp.value.trim().replace(/,$/, '') : '';
  if (pending) addAlias(pending);

  var desc  = (document.getElementById('fieldDesc')  || {}).value || '';
  var notes = (document.getElementById('fieldNotes') || {}).value || '';

  if (isNew) {
    vscode.postMessage({ command: 'new', category: currentCat,
      id: uniqueId(name, currentEntries()), name: name,
      aliases: editorAliases.slice(), description: desc, notes: notes || undefined });
  } else {
    vscode.postMessage({ command: 'save', category: currentCat,
      id: selectedId, name: name,
      aliases: editorAliases.slice(), description: desc, notes: notes || undefined });
  }
}

// New entry
function openNew() {
  selectedId    = null;
  isNewEntry    = true;
  mergeSourceId = null;
  editorAliases = [];
  renderList();
  renderEditor(null);
}

// Merge
function startMerge(id) {
  mergeSourceId = id;
  selectedId    = null;
  isNewEntry    = false;
  renderList();
  document.getElementById('editorPane').innerHTML =
    '<div class="empty-state">Click <strong>&larr; Merge into</strong> next to the target entry in the list.</div>';
}

function cancelMerge() {
  mergeSourceId = null;
  renderList();
  renderEditor(selectedId ? getEntry(selectedId) : null);
}

function pickMergeTarget(targetId) {
  var source = getEntry(mergeSourceId);
  var target = getEntry(targetId);
  if (!source || !target) return;
  showMergeModal(source, target);
}

var pendingMerge = null;

function showMergeModal(source, target) {
  pendingMerge = { sourceId: source.id, targetId: target.id };
  var box = document.getElementById('modalBox');
  box.innerHTML =
    '<div class="modal-title">Merge entries</div>' +
    '<div class="modal-body">' +
      '<strong>' + esc(source.name) + '</strong> will be merged into <strong>' + esc(target.name) + '</strong>.<br><br>' +
      'This will:' +
      '<ul class="modal-list">' +
        '<li>Add <em>' + esc(source.name) + '</em> and its aliases to <em>' + esc(target.name) + '</em>&rsquo;s aliases</li>' +
        '<li>Delete <em>' + esc(source.name) + '</em> from canon</li>' +
        '<li>Map all detections of <em>' + esc(source.name) + '</em> to <em>' + esc(target.name) + '</em> via override</li>' +
      '</ul>' +
      '<label class="modal-check">' +
        '<input type="checkbox" id="mergeDescCheck" checked>' +
        'Append <em>' + esc(source.name) + '</em>&rsquo;s description to <em>' + esc(target.name) + '</em>&rsquo;s' +
      '</label>' +
    '</div>' +
    '<div class="modal-actions">' +
      '<button class="modal-btn modal-btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="modal-btn modal-btn-primary" onclick="doMerge()">Merge</button>' +
    '</div>';
  document.getElementById('modalBackdrop').classList.remove('hidden');
}

function doMerge() {
  if (!pendingMerge) return;
  var mergeDesc = !!(document.getElementById('mergeDescCheck') || {}).checked;
  var src = pendingMerge.sourceId;
  var tgt = pendingMerge.targetId;
  pendingMerge  = null;
  mergeSourceId = null;
  closeModal();
  vscode.postMessage({ command: 'merge', category: currentCat,
    sourceId: src, targetId: tgt, mergeDescription: mergeDesc });
}

// Delete
function confirmDelete() {
  if (!selectedId) return;
  var id = selectedId;
  pendingRefsCb = function(result) { showDeleteModal(getEntry(id), result.count, result.chapters); };
  vscode.postMessage({ command: 'checkRefs', category: currentCat, id: id });
}

function showDeleteModal(entry, refCount, chapters) {
  var warning = '';
  if (refCount > 0) {
    var shown = chapters.slice(0, 3).map(esc).join(', ');
    if (chapters.length > 3) shown += ', &hellip;';
    warning = '<p class="modal-warning">&#9888; ' + refCount + ' chapter' +
      (refCount !== 1 ? 's' : '') + ' reference this entry (' + shown + '). ' +
      'Override mappings pointing to it will become orphaned.</p>';
  }
  var box = document.getElementById('modalBox');
  box.innerHTML =
    '<div class="modal-title">Delete entry</div>' +
    '<div class="modal-body">' +
      'Delete <strong>' + esc(entry.name) + '</strong> from canon? This cannot be undone.' +
      warning +
    '</div>' +
    '<div class="modal-actions">' +
      '<button class="modal-btn modal-btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="modal-btn modal-btn-danger" onclick="doDelete()">Delete</button>' +
    '</div>';
  document.getElementById('modalBackdrop').classList.remove('hidden');
}

function doDelete() {
  if (!selectedId) return;
  var id = selectedId;
  closeModal();
  vscode.postMessage({ command: 'delete', category: currentCat, id: id });
}

// Modal
function closeModal() {
  document.getElementById('modalBackdrop').classList.add('hidden');
}
document.getElementById('modalBackdrop').addEventListener('click', function(e) {
  if (e.target === document.getElementById('modalBackdrop')) closeModal();
});

// Entry list event delegation
document.getElementById('entryList').addEventListener('click', function(e) {
  var item = e.target.closest && e.target.closest('.entry-item');
  if (!item || item.classList.contains('merge-source')) return;
  var id = item.dataset.id;
  if (e.target.closest('.btn-merge-into')) {
    pickMergeTarget(id);
  } else if (e.target.closest('.btn-merge')) {
    startMerge(id);
  } else {
    selectEntry(id);
  }
});

// Signals
function renderSignals() {
  var list = document.getElementById('signalsList');
  if (!list) return;
  if (signals.length === 0) {
    list.innerHTML = '<div class="empty-state" style="margin-top:40px;">No signals defined. Click <strong>+ Add Signal</strong> to create one.</div>';
    return;
  }
  list.innerHTML = signals.map(function(s, i) {
    return '<div class="signal-row" draggable="true" data-idx="' + i + '">' +
      '<span class="signal-grip" title="Drag to reorder">&#x28BF;</span>' +
      '<div class="signal-fields">' +
        '<div class="signal-id-row">' +
          '<input class="signal-id" data-idx="' + i + '" data-field="id" value="' + esc(s.id) + '"' +
                 ' placeholder="signal_id" oninput="onSignalField(this)">' +
        '</div>' +
        '<textarea class="signal-desc" data-idx="' + i + '" data-field="description"' +
                  ' rows="2" placeholder="One-sentence description&hellip;"' +
                  ' oninput="onSignalField(this)">' + esc(s.description) + '</textarea>' +
      '</div>' +
      '<button class="signal-del" title="Delete" onclick="deleteSignal(' + i + ')">&times;</button>' +
    '</div>';
  }).join('');
  wireSignalDrag();
}

function onSignalField(el) {
  var idx   = parseInt(el.dataset.idx);
  var field = el.dataset.field;
  if (field === 'id') {
    signals[idx].id = el.value.trim().replace(/\\s+/g, '_').replace(/[^a-z0-9_]/gi, '');
    el.value = signals[idx].id;
  } else {
    signals[idx].description = el.value;
  }
}

function addSignal() {
  signals.push({ id: '', description: '' });
  renderSignals();
  var rows = document.querySelectorAll('.signal-id');
  var last = rows[rows.length - 1];
  if (last) last.focus();
}

function deleteSignal(idx) {
  signals.splice(idx, 1);
  renderSignals();
}

function saveSignals() {
  var clean = signals.filter(function(s) { return s.id.trim(); });
  signals = clean;
  vscode.postMessage({ command: 'saveSignals', signals: signals });
}

function discoverSignals() {
  vscode.postMessage({ command: 'discoverSignals' });
}

function wireSignalDrag() {
  var rows = document.querySelectorAll('.signal-row');
  var dragIdx = null;
  rows.forEach(function(row) {
    row.addEventListener('dragstart', function(e) {
      dragIdx = parseInt(row.dataset.idx);
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    row.addEventListener('drop', function(e) {
      e.preventDefault();
      var targetIdx = parseInt(row.dataset.idx);
      if (dragIdx === null || dragIdx === targetIdx) return;
      var moved = signals.splice(dragIdx, 1)[0];
      signals.splice(targetIdx, 0, moved);
      dragIdx = null;
      renderSignals();
    });
  });
}

renderList();
</script>
</body>
</html>`;
}
