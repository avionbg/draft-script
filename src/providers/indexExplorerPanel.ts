import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';
import { CanonManager, ENTITY_CATEGORIES } from '../dsm/canonManager';
import {
  CanonEntry, CanonOverride, IndexOverride,
  CharacterIndexItem, ThreadIndexItem, TimelineIndexItem, ContinuityIndexItem,
  ChapterAnalysis, ReferenceIndexItem,
} from '../dsm/draftScriptTypes';
import { AnalysisStore } from '../dsm/analysisStore';
import { IndexBuilder } from '../dsm/indexBuilder';
import { SignalManager } from '../dsm/signalManager';
import { OverrideStore } from '../dsm/overrideStore';

// ---------------------------------------------------------------------------
// Helpers shared with display
// ---------------------------------------------------------------------------

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

function composeCanonEntry(entry: CanonEntry, override?: CanonOverride): CanonEntry & { notes?: string } {
  return {
    ...entry,
    name:        override?.title       ?? entry.name,
    aliases:     override?.aliases     ?? entry.aliases,
    description: override?.description ?? entry.description,
    notes:       override?.notes,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class IndexExplorerPanel {
  static open(context: vscode.ExtensionContext): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      vscode.window.showWarningMessage('DSM Index Explorer: no workspace folder open.');
      return;
    }

    const canonMgr  = new CanonManager(root);
    const store     = new AnalysisStore(root);
    const sigMgr    = new SignalManager(root);
    const overrides = new OverrideStore(root);

    sigMgr.ensureExists();
    rebuildIndexes(root, store, canonMgr, overrides);

    // Entity indexes (names already reflect overrides — built with OverrideStore)
    const entityIndexes: Record<string, CharacterIndexItem[]> = {};
    for (const cat of ENTITY_CATEGORIES) {
      entityIndexes[cat] = readIndexArray<CharacterIndexItem>(root, cat);
    }

    // Effective canon entries (override applied) per category
    const allCanonEntries: Record<string, (CanonEntry & { notes?: string })[]> = {};
    for (const cat of ENTITY_CATEGORIES) {
      const ovrs = overrides.readCanon(cat);
      allCanonEntries[cat] = canonMgr.read(cat).map(e => composeCanonEntry(e, ovrs[e.id]));
    }

    // Index overrides for all types
    const allIndexOverrides: Record<string, Record<string, IndexOverride>> = {};
    for (const cat of ENTITY_CATEGORIES) {
      allIndexOverrides[cat] = overrides.readIndex(cat);
    }
    allIndexOverrides['threads']    = overrides.readIndex('threads');
    allIndexOverrides['timeline']   = overrides.readIndex('timeline');
    allIndexOverrides['continuity'] = overrides.readIndex('continuity');

    // Chapter map
    const chapterMapArr = readIndexArray<{ id: string; number: number; title: string; filePath: string }>(root, 'chapters');
    const chapterMap: Record<string, { number: number; title: string; filePath: string }> = {};
    for (const item of chapterMapArr) {
      chapterMap[item.id] = { number: item.number, title: item.title, filePath: item.filePath };
    }

    const threads    = readIndexArray<ThreadIndexItem>(root, 'threads');
    const timeline   = readIndexArray<TimelineIndexItem>(root, 'timeline');
    const continuity = readIndexArray<ContinuityIndexItem>(root, 'continuity');
    const refItems   = readIndexArray<ReferenceIndexItem>(root, 'reference');

    const panel = vscode.window.createWebviewPanel(
      'dsmIndexExplorer',
      'DSM Index Explorer',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    const cfg      = vscode.workspace.getConfiguration('draftScript');
    const fontSize = cfg.get<number>('dsmReviewFontSize', 13);
    const debug    = cfg.get<boolean>('debugMode', false);

    panel.webview.html = buildHtml(
      entityIndexes, allCanonEntries, allIndexOverrides,
      threads, timeline, continuity, chapterMap, refItems,
      fontSize, debug,
    );

    panel.webview.onDidReceiveMessage(
      async (msg: Record<string, unknown>) => {
        switch (msg.command) {

          case 'overrideIndex': {
            const indexName = msg.indexName as string;
            const id        = msg.id        as string;
            const patch     = msg.patch     as Partial<IndexOverride>;
            overrides.writeIndex(indexName, id, patch);
            panel.webview.postMessage({
              command:   'overrideSaved',
              indexName,
              id,
              override:  overrides.readIndex(indexName)[id] ?? {},
            });
            break;
          }

          case 'clearIndexOverride': {
            const indexName = msg.indexName as string;
            const id        = msg.id        as string;
            overrides.clearIndex(indexName, id);
            panel.webview.postMessage({
              command:   'overrideSaved',
              indexName,
              id,
              override:  {},
            });
            break;
          }

          case 'threadReviewAction': {
            const id = msg.id as string;
            const patch = msg.patch as Partial<IndexOverride>;
            overrides.writeIndex('threads', id, patch);
            panel.webview.postMessage({
              command:   'overrideSaved',
              indexName: 'threads',
              id,
              override:  overrides.readIndex('threads')[id] ?? {},
            });
            break;
          }

          case 'openCanonEditor': {
            vscode.commands.executeCommand('draftScript.dsmOpenCanonEditor');
            break;
          }

          case 'navigateToChapter': {
            const filePath      = msg.filePath      as string;
            const chapterId     = msg.chapterId     as string | undefined;
            const title         = msg.title         as string | undefined;
            const entityName    = msg.entityName    as string | undefined;
            const entityAliases = msg.entityAliases as string[] | undefined;
            const referenceText = (msg.referenceText as string | undefined)?.trim();
            if (!filePath) break;
            try {
              const absPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
              const uri     = vscode.Uri.file(absPath);
              const doc     = await vscode.workspace.openTextDocument(uri);
              const editor  = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });

              let positioned = false;

              if (!positioned && referenceText) {
                const docText = doc.getText();

                const normalize = (s: string) =>
                  s.replace(/[\u2018\u2019\u201a\u201b]/g, "'")
                   .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
                   .replace(/\s+/g, ' ')
                   .trim();

                // Returns the document offset of `fragment` in `doc`, or -1.
                // Tries exact match then normalized match.
                const findFragment = (fragment: string): { idx: number; len: number } | null => {
                  let i = docText.indexOf(fragment);
                  if (i >= 0) return { idx: i, len: fragment.length };
                  const nFrag = normalize(fragment);
                  const nDoc  = normalize(docText);
                  const ni    = nDoc.indexOf(nFrag);
                  if (ni < 0) return null;
                  // Walk original text to recover real offset
                  let origIdx = 0, normPos = 0;
                  while (normPos < ni && origIdx < docText.length) {
                    const ch = docText[origIdx++];
                    normPos += /\s/.test(ch) ? (nDoc[normPos] === ' ' ? 1 : 0) : 1;
                    if (normPos > ni) { origIdx--; break; }
                  }
                  return { idx: origIdx, len: nFrag.length };
                };

                // Split on ellipsis markers (LLM elision). Try each fragment ≥ 8 chars,
                // use the first one found. Falling through all fragments is fine — the
                // chapter-heading fallback picks up afterwards.
                const fragments = referenceText
                  .split(/\.{2,}|\u2026/)
                  .map(f => f.trim())
                  .filter(f => f.length >= 8);
                if (!fragments.length) fragments.push(referenceText);

                for (const frag of fragments) {
                  const hit = findFragment(frag);
                  if (hit) {
                    const pos    = doc.positionAt(hit.idx);
                    const endPos = doc.positionAt(hit.idx + hit.len);
                    editor.selection = new vscode.Selection(pos, endPos);
                    editor.revealRange(new vscode.Range(pos, endPos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                    positioned = true;
                    break;
                  }
                }
              }

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
                    let bestIdx = -1, bestLen = 0;
                    for (const n of candidates) {
                      const idx = docText.indexOf(n, headingOffset);
                      if (idx >= 0 && (bestIdx === -1 || idx < bestIdx)) { bestIdx = idx; bestLen = n.length; }
                    }
                    if (bestIdx >= 0) {
                      const startPos = doc.positionAt(bestIdx);
                      const endPos   = doc.positionAt(bestIdx + bestLen);
                      editor.selection = new vscode.Selection(startPos, endPos);
                      editor.revealRange(new vscode.Range(startPos, endPos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                      nameFound = true;
                    }
                  }
                  if (!nameFound) {
                    editor.selection = new vscode.Selection(headingPos, headingPos);
                    editor.revealRange(new vscode.Range(headingPos, headingPos), vscode.TextEditorRevealType.AtTop);
                  }
                }
              }
            } catch {
              vscode.window.showErrorMessage('DSM: cannot open chapter file.');
            }
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
// HTML
// ---------------------------------------------------------------------------

function buildHtml(
  entityIndexes:    Record<string, CharacterIndexItem[]>,
  allCanonEntries:  Record<string, (CanonEntry & { notes?: string })[]>,
  allIndexOverrides: Record<string, Record<string, IndexOverride>>,
  threads:          ThreadIndexItem[],
  timeline:         TimelineIndexItem[],
  continuity:       ContinuityIndexItem[],
  chapterMap:       Record<string, { number: number; title: string; filePath: string }>,
  refItems:         ReferenceIndexItem[],
  fontSize:         number,
  debug:            boolean,
): string {
  const entityIdxJson   = JSON.stringify(entityIndexes).replace(/<\/script>/gi, '<\\/script>');
  const canonJson       = JSON.stringify(allCanonEntries).replace(/<\/script>/gi, '<\\/script>');
  const idxOvrJson      = JSON.stringify(allIndexOverrides).replace(/<\/script>/gi, '<\\/script>');
  const threadsJson     = JSON.stringify(threads).replace(/<\/script>/gi, '<\\/script>');
  const timelineJson    = JSON.stringify(timeline).replace(/<\/script>/gi, '<\\/script>');
  const continuityJson  = JSON.stringify(continuity).replace(/<\/script>/gi, '<\\/script>');
  const chMapJson       = JSON.stringify(chapterMap).replace(/<\/script>/gi, '<\\/script>');
  const refJson         = JSON.stringify(refItems).replace(/<\/script>/gi, '<\\/script>');

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
.hidden { display: none !important; }
/* Entity view (list + detail) */
.columns { display: flex; flex: 1; overflow: hidden; }
.col-list {
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid var(--vscode-widget-border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.list-toolbar { padding: 8px; flex-shrink: 0; border-bottom: 1px solid var(--vscode-widget-border); }
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
.entry-item.hidden-item { opacity: 0.4; }
.entry-info { flex: 1; min-width: 0; }
.entry-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.entry-sub { font-size: 0.88em; opacity: 0.6; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Detail pane */
.col-detail { flex: 1; overflow-y: auto; padding: 20px 24px; }
.empty-state {
  display: flex; align-items: center; justify-content: center;
  height: 100%; opacity: 0.4; font-size: 1em; text-align: center; padding: 32px;
}
.detail-section { margin-bottom: 18px; }
.detail-label {
  font-size: 0.75em; opacity: 0.55; text-transform: uppercase;
  letter-spacing: 0.06em; margin-bottom: 5px; display: block;
}
.detail-value { font-size: 1em; line-height: 1.5; }
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
.notes-textarea {
  width: 100%;
  min-height: 70px;
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
.notes-textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: transparent; }
.detail-footer { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; align-items: center; }
.btn {
  padding: 5px 14px;
  cursor: pointer;
  border-radius: 3px;
  font-size: 1em;
  font-family: inherit;
  border: 1px solid transparent;
}
.btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn-primary:hover { background: var(--vscode-button-hoverBackground); }
.btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-color: var(--vscode-button-border, transparent); }
.btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.btn-danger { background: transparent; color: var(--vscode-errorForeground, #e05252); border-color: currentColor; opacity: 0.7; }
.btn-danger:hover { opacity: 1; }
.save-notice { font-size: 0.82em; opacity: 0; transition: opacity 0.4s; color: var(--vscode-charts-green, #4ec94e); }
.save-notice.show { opacity: 1; }
/* Chapter links */
.appearances-row { display: flex; flex-wrap: wrap; gap: 3px; min-height: 24px; align-items: center; }
.chapter-link {
  display: inline-block; padding: 1px 6px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  border-radius: 3px; cursor: pointer; font-size: 0.88em;
  font-family: var(--vscode-editor-font-family, monospace); line-height: 1.6; transition: background 0.1s;
}
.chapter-link:hover { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
/* Canon mapping section */
.canon-box {
  padding: 10px 12px;
  background: rgba(128,128,128,0.08);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 4px;
  margin-bottom: 4px;
}
.canon-name { font-weight: 600; margin-bottom: 6px; }
.canon-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.canon-select {
  width: 100%;
  padding: 5px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  font-family: inherit;
  font-size: 1em;
  margin-top: 8px;
}
.canon-select:focus { outline: 1px solid var(--vscode-focusBorder); }
.orphan-warning { color: #c8a034; font-size: 0.9em; margin-top: 4px; }
/* Badges */
.badge {
  display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 0.78em;
  font-family: var(--vscode-editor-font-family, monospace); text-transform: uppercase;
  letter-spacing: 0.04em; flex-shrink: 0; background: rgba(128,128,128,0.15);
  color: var(--vscode-foreground); opacity: 0.8;
}
.badge-mystery  { background: rgba(130,100,200,0.22); color: #b08fde; opacity: 1; }
.badge-promise  { background: rgba(70,130,220,0.22);  color: #7bb3f0; opacity: 1; }
.badge-risk     { background: rgba(220,70,70,0.22);   color: #e07878; opacity: 1; }
.badge-task     { background: rgba(70,180,70,0.22);   color: #7abe7a; opacity: 1; }
.badge-conflict { background: rgba(220,140,50,0.22);  color: #e0a050; opacity: 1; }
.badge-question { background: rgba(200,190,50,0.22);  color: #d4c050; opacity: 1; }
.badge-uncertain { background: rgba(140,140,140,0.15); color: #999; opacity: 1; }
.badge-open     { background: rgba(70,180,70,0.2);    color: #6db86d; opacity: 1; }
.badge-active   { background: rgba(70,180,70,0.2);    color: #6db86d; opacity: 1; }
.badge-resolved { background: rgba(140,140,140,0.15); color: #888; opacity: 1; }
.badge-changed  { background: rgba(220,140,50,0.2);   color: #e0a050; opacity: 1; }
.badge-dismissed { background: rgba(140,140,140,0.1); color: #777; opacity: 1; }
.badge-state    { background: rgba(70,130,220,0.15);  color: #7bb3f0; opacity: 1; }
.badge-resource { background: rgba(70,130,220,0.15);  color: #7bb3f0; opacity: 1; }
.badge-relationship { background: rgba(130,100,200,0.15); color: #b08fde; opacity: 1; }
/* Full panels (Threads / Timeline / Continuity) */
.full-panel { flex: 1; overflow-y: auto; padding: 16px 24px; display: flex; flex-direction: column; }
.card-list { display: flex; flex-direction: column; }
.review-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 10px;
  border: 1px solid var(--vscode-widget-border);
  background: rgba(128,128,128,0.05);
  border-radius: 4px;
  flex-wrap: wrap;
}
.review-count { font-weight: 600; margin-right: auto; }
.review-hint { opacity: 0.55; font-size: 0.86em; }
.review-empty { padding: 28px 0; opacity: 0.55; text-align: center; }
.thread-card { padding: 12px 0; border-bottom: 1px solid var(--vscode-widget-border); }
.thread-card:last-child { border-bottom: none; }
.thread-card.review-focus { background: rgba(128,128,128,0.05); margin-left: -10px; margin-right: -10px; padding-left: 10px; padding-right: 10px; border-radius: 4px; }
.thread-header { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 5px; }
.thread-title { font-weight: 600; flex: 1; min-width: 120px; }
.thread-desc { font-size: 0.9em; opacity: 0.65; line-height: 1.45; margin-bottom: 6px; }
.thread-appearances { display: flex; align-items: center; flex-wrap: wrap; gap: 3px; }
.thread-appearances-label { font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.5; margin-right: 4px; }
.review-reason { font-size: 0.84em; opacity: 0.68; margin-top: 4px; }
/* Override edit section */
.ovr-section {
  margin-top: 10px;
  padding: 10px 12px;
  background: rgba(128,128,128,0.06);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 4px;
}
.ovr-row { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.ovr-label { font-size: 0.78em; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.05em; width: 60px; flex-shrink: 0; }
.ovr-status {
  padding: 4px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  font-family: inherit;
  font-size: 0.9em;
}
.ovr-status:focus { outline: 1px solid var(--vscode-focusBorder); }
.ovr-notes {
  width: 100%;
  min-height: 56px;
  padding: 6px 8px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 3px;
  font-family: inherit;
  font-size: 0.88em;
  resize: vertical;
  line-height: 1.45;
}
.ovr-notes:focus { outline: 1px solid var(--vscode-focusBorder); }
.ovr-actions { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
.review-actions { display: flex; gap: 6px; margin-top: 8px; align-items: center; flex-wrap: wrap; }
.ovr-note-display { font-size: 0.88em; color: var(--vscode-foreground); opacity: 0.7; line-height: 1.45; font-style: italic; margin-top: 4px; }
/* Toggle edit button */
.btn-toggle-edit {
  font-size: 0.78em;
  padding: 2px 8px;
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--vscode-widget-border);
  border-radius: 3px;
  color: var(--vscode-foreground);
  opacity: 0.6;
  font-family: inherit;
  margin-left: auto;
}
.btn-toggle-edit:hover { opacity: 1; }
.btn-review {
  font-size: 0.78em;
  padding: 3px 9px;
  cursor: pointer;
  background: var(--vscode-button-secondaryBackground, transparent);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 3px;
  color: var(--vscode-foreground);
  font-family: inherit;
}
.btn-review:hover { background: var(--vscode-list-hoverBackground); }
/* Timeline */
.timeline-group { margin-bottom: 14px; }
.tl-chapter-hd {
  font-size: 0.78em; text-transform: uppercase; letter-spacing: 0.07em; opacity: 0.5;
  cursor: pointer; display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 0; margin-bottom: 5px; transition: opacity 0.15s;
}
.tl-chapter-hd:hover { opacity: 0.9; }
.tl-event {
  padding: 5px 10px; border-left: 2px solid var(--vscode-widget-border);
  margin-left: 4px; margin-bottom: 4px; cursor: pointer; transition: border-left-color 0.1s;
}
.tl-event:hover { border-left-color: var(--vscode-button-background); }
.tl-event-title { font-size: 0.95em; font-weight: 500; }
.tl-event-desc { font-size: 0.85em; opacity: 0.65; margin-top: 2px; line-height: 1.4; }
</style>
</head>
<body>

<div class="tab-bar">
  <button class="tab active" data-cat="characters"  onclick="switchTab('characters')">Characters</button>
  <button class="tab" data-cat="locations"   onclick="switchTab('locations')">Locations</button>
  <button class="tab" data-cat="objects"     onclick="switchTab('objects')">Objects</button>
  <button class="tab" data-cat="groups"      onclick="switchTab('groups')">Groups</button>
  <button class="tab" data-cat="threads"     onclick="switchTab('threads')">Threads</button>
  <button class="tab" data-cat="timeline"    onclick="switchTab('timeline')">Timeline</button>
  <button class="tab" data-cat="continuity"  onclick="switchTab('continuity')">Continuity</button>
  <span class="tab-spacer"></span>
</div>

<!-- Entity tabs (list + detail) -->
<div class="columns" id="entityColumns">
  <div class="col-list">
    <div class="list-toolbar">
      <input class="search" id="searchInput" placeholder="Filter&hellip;" oninput="onFilter(this.value)">
    </div>
    <div class="entry-list" id="entryList"></div>
  </div>
  <div class="col-detail" id="detailPane">
    <div class="empty-state">Select an item to view details.</div>
  </div>
</div>

<!-- Threads panel -->
<div id="threadsPanel" class="hidden full-panel">
  <div id="threadReviewBar"></div>
  <div class="card-list" id="threadsList"></div>
</div>

<!-- Timeline panel -->
<div id="timelinePanel" class="hidden full-panel">
  <div id="timelineList"></div>
</div>

<!-- Continuity panel -->
<div id="continuityPanel" class="hidden full-panel">
  <div class="card-list" id="continuityList"></div>
</div>

<script>
const vscode          = acquireVsCodeApi();
const entityIndexes   = ${entityIdxJson};
const allCanonEntries = ${canonJson};
var   allIdxOverrides = ${idxOvrJson};
const threads         = ${threadsJson};
const timeline        = ${timelineJson};
const continuity      = ${continuityJson};
const chapterMap      = ${chMapJson};
const refIndex        = ${refJson};

var refMap = {};
refIndex.forEach(function(r) {
  var key = r.sourceType + ':' + r.sourceId + ':' + r.chapterId;
  if (!refMap[key]) refMap[key] = [];
  refMap[key].push(r);
});
function findRef(sourceType, sourceId, chapterId) {
  var refs = refMap[sourceType + ':' + sourceId + ':' + chapterId];
  if (!refs || !refs.length) return '';
  var q = refs.find(function(r) { return r.kind === 'quote'; });
  return q ? q.text.trim() : '';
}
var catToSourceType = { characters: 'character', locations: 'location', objects: 'object', groups: 'group' };
var ENTITY_CATS = ['characters', 'locations', 'objects', 'groups'];
var FULL_CATS   = ['threads', 'timeline', 'continuity'];

var currentCat  = 'characters';
var filterText  = '';
var selectedId  = null;
var threadReviewOnly = false;
var threadReviewCursor = 0;

// Messages from extension
window.addEventListener('message', function(e) {
  var msg = e.data;
  if (msg.command === 'overrideSaved') {
    if (!allIdxOverrides[msg.indexName]) allIdxOverrides[msg.indexName] = {};
    if (msg.override && Object.keys(msg.override).length > 0) {
      allIdxOverrides[msg.indexName][msg.id] = msg.override;
    } else {
      delete allIdxOverrides[msg.indexName][msg.id];
    }
    // Re-render current view
    if (ENTITY_CATS.indexOf(currentCat) !== -1) {
      renderList();
      if (selectedId === msg.id) renderDetail(getItem(selectedId));
    } else if (currentCat === msg.indexName || msg.indexName === currentCat) {
      renderFullPanel(currentCat);
    } else {
      renderFullPanel(currentCat);
    }
    flashSaveNotice(msg.id);
  }
});

function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  if (!iso) return '&mdash;';
  return new Date(iso).toLocaleDateString('en-CA');
}

function switchTab(cat) {
  currentCat = cat;
  filterText = '';
  selectedId = null;
  document.querySelectorAll('.tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.cat === cat);
  });
  var isEntity = ENTITY_CATS.indexOf(cat) !== -1;
  document.getElementById('entityColumns').classList.toggle('hidden', !isEntity);
  document.getElementById('threadsPanel').classList.toggle('hidden',   cat !== 'threads');
  document.getElementById('timelinePanel').classList.toggle('hidden',  cat !== 'timeline');
  document.getElementById('continuityPanel').classList.toggle('hidden', cat !== 'continuity');

  if (isEntity) {
    document.getElementById('searchInput').value = '';
    renderList();
    renderDetail(null);
  } else {
    renderFullPanel(cat);
  }
}

function onFilter(val) {
  filterText = val.toLowerCase();
  renderList();
}

// ── Helpers ──

function currentItems() { return entityIndexes[currentCat] || []; }

function getItem(id) {
  return currentItems().find(function(x) { return x.id === id; }) || null;
}

function effectiveTitle(item) {
  var ovrs = allIdxOverrides[currentCat] || {};
  return (ovrs[item.id] && ovrs[item.id].title) || item.name;
}

function isHidden(id, cat) {
  var ovrs = allIdxOverrides[cat || currentCat] || {};
  return !!(ovrs[id] && ovrs[id].hidden);
}

function resolvedCanonId(item) {
  var ovrs = allIdxOverrides[currentCat] || {};
  return (ovrs[item.id] && ovrs[item.id].canonId) || item.id;
}

function findCanonEntry(canonId, cat) {
  var list = allCanonEntries[cat || currentCat] || [];
  return list.find(function(e) { return e.id === canonId; }) || null;
}

// ── Entity list ──

function renderList() {
  var items    = currentItems();
  var filtered = filterText
    ? items.filter(function(x) { return effectiveTitle(x).toLowerCase().includes(filterText); })
    : items;

  var list = document.getElementById('entryList');
  if (!filtered.length) {
    list.innerHTML = '<div style="padding:16px 12px;opacity:0.5;">No index items' + (filterText ? ' matching filter.' : '.') + '</div>';
    return;
  }

  list.innerHTML = filtered.map(function(item) {
    var isSelected = item.id === selectedId;
    var hidden     = isHidden(item.id);
    var title      = effectiveTitle(item);
    var canonId    = resolvedCanonId(item);
    var canon      = findCanonEntry(canonId);
    var subLine    = '';

    if (canon && canon.id !== item.id) {
      subLine = 'remapped &rarr; ' + esc(canon.name);
    } else if (canon) {
      subLine = 'canon: ' + esc(canon.name);
    } else {
      subLine = '<span style="opacity:0.5">unmapped</span>';
    }

    return '<div class="entry-item' + (isSelected ? ' selected' : '') + (hidden ? ' hidden-item' : '') + '"' +
           ' data-id="' + esc(item.id) + '" onclick="selectItem(this.dataset.id)">' +
           '<div class="entry-info">' +
           '<div class="entry-name">' + esc(title) + '</div>' +
           '<div class="entry-sub">' + subLine + '</div>' +
           '</div>' +
           '</div>';
  }).join('');
}

function selectItem(id) {
  selectedId = id;
  renderList();
  renderDetail(getItem(id));
}

// ── Entity detail pane ──

function renderDetail(item) {
  var pane = document.getElementById('detailPane');
  if (!item) {
    pane.innerHTML = '<div class="empty-state">Select an item to view details.</div>';
    return;
  }

  var ovrs      = allIdxOverrides[currentCat] || {};
  var ovr       = ovrs[item.id] || {};
  var title     = ovr.title || item.name;
  var notes     = ovr.notes || '';
  var hidden    = !!ovr.hidden;
  var canonId   = ovr.canonId || item.id;
  var canon     = findCanonEntry(canonId);
  var isOrphan  = !!ovr.canonId && !canon;
  var isRemapped = !!ovr.canonId && canon;
  var srcType   = catToSourceType[currentCat] || currentCat;

  // Canon section
  var canonHtml = '';
  if (isOrphan) {
    canonHtml =
      '<div class="canon-box">' +
      '<div class="orphan-warning">&#9888; Mapped to missing canon entry: <code>' + esc(ovr.canonId || '') + '</code></div>' +
      '<div class="canon-actions">' +
        '<button class="btn btn-secondary" onclick="unmapItem()">Remove mapping</button>' +
      '</div>' +
      '</div>';
  } else if (canon) {
    var remapNote = isRemapped ? '<div style="font-size:0.82em;opacity:0.55;margin-top:3px;">Remapped via override</div>' : '';
    canonHtml =
      '<div class="canon-box">' +
      '<div class="canon-name">' + esc(canon.name) + '</div>' +
      (canon.notes ? '<div style="font-size:0.82em;opacity:0.65;margin-top:2px;">' + esc(canon.notes) + '</div>' : '') +
      remapNote +
      '<div class="canon-actions">' +
        '<button class="btn btn-secondary" onclick="openCanonEditor()">Open Canon Editor</button>' +
        (isRemapped ? '<button class="btn btn-secondary" onclick="unmapItem()">Unmap</button>' : '') +
      '</div>' +
      '</div>';
  } else {
    canonHtml = '<div style="opacity:0.5;font-size:0.9em;">No canon entry found for id <code>' + esc(item.id) + '</code>.</div>';
  }

  // Canon remap select
  var canonList = allCanonEntries[currentCat] || [];
  var selectOpts = canonList.map(function(e) {
    var sel = (e.id === canonId && !isOrphan) ? ' selected' : '';
    return '<option value="' + esc(e.id) + '"' + sel + '>' + esc(e.name) + '</option>';
  }).join('');
  var remapHtml =
    '<div class="detail-section">' +
    '<span class="detail-label">Remap to canon</span>' +
    '<select class="canon-select" id="canonSelect" data-current="' + esc(canonId) + '" onchange="updateRemapBtn(this)">' +
      '<option value="">— keep current —</option>' +
      selectOpts +
    '</select>' +
    '<div style="margin-top:6px;display:flex;gap:6px;">' +
      '<button class="btn btn-secondary" id="applyRemapBtn" disabled onclick="applyRemap()">Apply Remap</button>' +
    '</div>' +
    '</div>';

  // Appearances
  var appearances = item.appearances || [];
  var appHtml =
    '<div class="detail-section">' +
    '<span class="detail-label">Appearances</span>' +
    '<div class="appearances-row">' +
      renderChapterLinks(appearances, item.id, srcType) +
    '</div>' +
    '</div>';

  pane.innerHTML =
    '<div class="detail-section">' +
    '<span class="detail-label">ID</span>' +
    '<div class="detail-value" style="font-family:var(--vscode-editor-font-family,monospace);font-size:0.9em;opacity:0.55;">' + esc(item.id) + '</div>' +
    '</div>' +
    '<div class="detail-section">' +
    '<span class="detail-label">Title</span>' +
    '<input class="field-input" id="titleInput" value="' + esc(title) + '" placeholder="Override title&hellip;">' +
    '</div>' +
    '<div class="detail-section">' +
    '<span class="detail-label">Canon mapping</span>' +
    canonHtml +
    '</div>' +
    appHtml +
    remapHtml +
    '<div class="detail-section">' +
    '<span class="detail-label">Notes</span>' +
    '<textarea class="notes-textarea" id="notesInput" placeholder="Author notes (stored in overrides)&hellip;">' + esc(notes) + '</textarea>' +
    '</div>' +
    '<div class="detail-footer">' +
    '<button class="btn btn-primary" onclick="saveEntityOverride()">Save Override</button>' +
    '<button class="btn btn-secondary" onclick="toggleHideItem(' + (hidden ? 'false' : 'true') + ')">' +
      (hidden ? 'Show' : 'Hide') + ' item</button>' +
    '<span class="save-notice" id="saveNotice">Saved.</span>' +
    '</div>';
}

function renderChapterLinks(appearances, itemId, srcType) {
  if (!appearances || !appearances.length) return '<span style="opacity:0.4;font-size:0.9em">none</span>';
  return appearances.map(function(a) {
    var info   = chapterMap[a.chapterId];
    var label  = 'Ch. ' + a.chapterNumber + (info && info.title ? ': ' + info.title : '');
    var refTxt = findRef(srcType, itemId, a.chapterId);
    var ref    = refTxt ? ' data-ref="' + esc(refTxt) + '"' : '';
    return '<span class="chapter-link" title="' + esc(label) + '"' +
           ' data-cid="' + esc(a.chapterId) + '" data-fp="' + esc((info && info.filePath) || '') + '"' +
           ' data-title="' + esc((info && info.title) || '') + '"' + ref +
           ' onclick="navigateToChapter(this)">' + a.chapterNumber + '</span>';
  }).join('');
}

function navigateToChapter(el) {
  var fp    = el.dataset.fp;
  var cid   = el.dataset.cid;
  var title = el.dataset.title;
  var ref   = el.dataset.ref;
  if (!fp) return;
  vscode.postMessage({ command: 'navigateToChapter', filePath: fp, chapterId: cid, title: title, referenceText: ref || undefined });
}

function saveEntityOverride() {
  var titleEl = document.getElementById('titleInput');
  var notesEl = document.getElementById('notesInput');
  var t = titleEl ? titleEl.value.trim() : '';
  var n = notesEl ? notesEl.value.trim() : '';
  vscode.postMessage({
    command: 'overrideIndex', indexName: currentCat, id: selectedId,
    patch: { title: t || undefined, notes: n || undefined }
  });
}

function toggleHideItem(hide) {
  vscode.postMessage({
    command: 'overrideIndex', indexName: currentCat, id: selectedId,
    patch: { hidden: !!hide }
  });
}

function unmapItem() {
  var ovrs = allIdxOverrides[currentCat] || {};
  var ovr  = ovrs[selectedId] || {};
  var patch = Object.assign({}, ovr);
  delete patch.canonId;
  if (Object.keys(patch).length > 0) {
    vscode.postMessage({ command: 'overrideIndex', indexName: currentCat, id: selectedId, patch: patch });
  } else {
    vscode.postMessage({ command: 'clearIndexOverride', indexName: currentCat, id: selectedId });
  }
}

function updateRemapBtn(sel) {
  var btn = document.getElementById('applyRemapBtn');
  if (!btn) return;
  var changed = sel.value && sel.value !== sel.dataset.current;
  btn.disabled = !changed;
}

function applyRemap() {
  var sel = document.getElementById('canonSelect');
  if (!sel || !sel.value) return;
  vscode.postMessage({ command: 'overrideIndex', indexName: currentCat, id: selectedId, patch: { canonId: sel.value } });
}

function openCanonEditor() {
  vscode.postMessage({ command: 'openCanonEditor' });
}

function flashSaveNotice(id) {
  var el = document.getElementById('saveNotice');
  if (el && selectedId === id) {
    el.classList.add('show');
    setTimeout(function() { el.classList.remove('show'); }, 2000);
  }
}

// ── Threads ──

function renderFullPanel(cat) {
  if (cat === 'threads')    renderThreads();
  else if (cat === 'timeline')   renderTimeline();
  else if (cat === 'continuity') renderContinuity();
}

function getThreadStatusOptions(current) {
  return ['open','active','resolved','changed','uncertain'].map(function(s) {
    return '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' + s + '</option>';
  }).join('');
}

function getContinuityStatusOptions(current) {
  return ['active','resolved','changed','uncertain','dismissed'].map(function(s) {
    return '<option value="' + s + '"' + (s === current ? ' selected' : '') + '>' + s + '</option>';
  }).join('');
}

function effectiveThread(t) {
  var ovr = (allIdxOverrides['threads'] || {})[t.id] || {};
  return {
    id:     t.id,
    title:  ovr.title  || t.title,
    type:   t.type,
    status: ovr.status || t.status,
    suggestedStatus: ovr.suggestedStatus === null ? '' : (ovr.suggestedStatus || t.suggestedStatus || ''),
    needsReview: ovr.needsReview === null ? false : (ovr.needsReview !== undefined ? !!ovr.needsReview : !!t.needsReview),
    notes:  ovr.notes  || '',
    hidden: !!ovr.hidden,
    appearances: t.appearances,
  };
}

function isThreadReview(t, et) {
  return !et.hidden && (!!et.needsReview || !!et.suggestedStatus || et.status === 'uncertain');
}

function threadReviewReasons(t, et) {
  var reasons = [];
  if (et.status === 'uncertain') reasons.push('uncertain status');
  if (et.suggestedStatus) reasons.push('suggested ' + et.suggestedStatus);
  if (et.needsReview) reasons.push('needs review');
  if (typeof t.confidence === 'number' && t.confidence < 0.7) reasons.push('low confidence');
  if (t.lastUpdateType === 'reopened') reasons.push('reopened');
  return reasons.filter(function(v, i, arr) { return arr.indexOf(v) === i; });
}

function getThreadById(id) {
  return threads.find(function(t) { return t.id === id; });
}

function threadReviewItems() {
  return threads.filter(function(t) { return isThreadReview(t, effectiveThread(t)); });
}

function renderThreadReviewBar() {
  var bar = document.getElementById('threadReviewBar');
  if (!bar) return;
  var count = threadReviewItems().length;
  var filterLabel = threadReviewOnly ? 'Show all threads' : 'Show only review';
  bar.innerHTML =
    '<div class="review-bar">' +
      '<span class="review-count">' + count + ' need review</span>' +
      '<span class="review-hint">Review uncertain threads and suggested lifecycle changes.</span>' +
      '<button class="btn-review" onclick="toggleThreadReviewOnly()">' + filterLabel + '</button>' +
      '<button class="btn-review" onclick="nextThreadReview()">Next</button>' +
    '</div>';
}

function toggleThreadReviewOnly() {
  threadReviewOnly = !threadReviewOnly;
  threadReviewCursor = 0;
  renderThreads();
}

function nextThreadReview() {
  var ids = threadReviewItems().map(function(t) { return t.id; });
  if (!ids.length) return;
  if (!threadReviewOnly) threadReviewOnly = true;
  renderThreads();
  var id = ids[threadReviewCursor % ids.length];
  threadReviewCursor = (threadReviewCursor + 1) % ids.length;
  var card = document.getElementById('card-' + id);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('review-focus');
    setTimeout(function() { card.classList.remove('review-focus'); }, 1400);
  }
}

function effectiveContinuity(c) {
  var ovr = (allIdxOverrides['continuity'] || {})[c.id] || {};
  return {
    id:      c.id,
    title:   ovr.title  || c.title,
    type:    c.type,
    status:  ovr.status || c.status,
    notes:   ovr.notes  || '',
    hidden:  !!ovr.hidden,
    mentions: c.mentions,
  };
}

function renderThreads() {
  var list = document.getElementById('threadsList');
  if (!list) return;
  renderThreadReviewBar();
  if (!threads || !threads.length) {
    list.innerHTML = '<div style="padding:32px;opacity:0.5;text-align:center;">No threads indexed yet.</div>';
    return;
  }
  var visibleThreads = threads.filter(function(t) {
    var et = effectiveThread(t);
    if (et.hidden) return false;
    return !threadReviewOnly || isThreadReview(t, et);
  });
  if (!visibleThreads.length) {
    list.innerHTML = '<div class="review-empty">' + (threadReviewOnly ? 'No threads need review.' : 'No visible threads indexed yet.') + '</div>';
    return;
  }
  list.innerHTML = visibleThreads.map(function(t) {
    var et   = effectiveThread(t);
    if (et.hidden) return '';
    var needsReview = isThreadReview(t, et);
    var reason = threadReviewReasons(t, et).join(' | ');
    var lastDesc = et.appearances.length ? et.appearances[et.appearances.length - 1].description : '';
    var chLinks  = et.appearances.map(function(a) {
      var info   = chapterMap[a.chapterId];
      var label  = 'Ch. ' + a.chapterNumber + (info && info.title ? ': ' + info.title : '');
      var refTxt = findRef('thread', t.id, a.chapterId);
      var ref    = refTxt ? ' data-ref="' + esc(refTxt) + '"' : '';
      return '<span class="chapter-link" title="' + esc(label) + '"' +
             ' data-cid="' + esc(a.chapterId) + '"' +
             ' data-fp="'  + esc((info && info.filePath) || '') + '"' +
             ' data-title="' + esc((info && info.title) || '') + '"' + ref +
             ' onclick="navigateToChapter(this)">' + a.chapterNumber + '</span>';
    }).join('');

    var ovr = (allIdxOverrides['threads'] || {})[t.id] || {};
    return '<div class="thread-card" id="card-' + esc(t.id) + '">' +
      '<div class="thread-header">' +
        '<span class="thread-title">' + esc(et.title) + '</span>' +
        '<span class="badge badge-' + esc(et.type)   + '">' + esc(et.type)   + '</span>' +
        '<span class="badge badge-' + esc(et.status) + '">' + esc(et.status) + '</span>' +
        (et.suggestedStatus ? '<span class="badge badge-uncertain">suggested: ' + esc(et.suggestedStatus) + '</span>' : '') +
        (et.needsReview ? '<span class="badge badge-changed">review</span>' : '') +
        (needsReview ? '<button class="btn-review" onclick="toggleReviewSection(\\'' + esc(t.id) + '\\')">Review</button>' : '') +
        '<button class="btn-toggle-edit" onclick="toggleOvrSection(\\'' + esc(t.id) + '\\')">&hellip;</button>' +
      '</div>' +
      (reason ? '<div class="review-reason">Review: ' + esc(reason) + '</div>' : '') +
      (lastDesc ? '<div class="thread-desc">' + esc(lastDesc) + '</div>' : '') +
      '<div class="thread-appearances"><span class="thread-appearances-label">Ch:</span>' + chLinks + '</div>' +
      (et.notes ? '<div class="ovr-note-display">' + esc(et.notes) + '</div>' : '') +
      renderThreadReviewSection(t, et) +
      '<div class="ovr-section hidden" id="ovr-' + esc(t.id) + '">' +
        '<div class="ovr-row">' +
          '<span class="ovr-label">Status</span>' +
          '<select class="ovr-status" id="thr-status-' + esc(t.id) + '">' + getThreadStatusOptions(et.status) + '</select>' +
        '</div>' +
        '<div class="ovr-row"><span class="ovr-label">Notes</span></div>' +
        '<textarea class="ovr-notes" id="thr-notes-' + esc(t.id) + '" placeholder="Author notes&hellip;">' + esc(et.notes) + '</textarea>' +
        '<div class="ovr-actions">' +
          '<button class="btn btn-secondary" onclick="saveThreadOvr(\\'' + esc(t.id) + '\\')">Save</button>' +
          '<button class="btn btn-secondary" onclick="clearOvr(\\'threads\\',\\'' + esc(t.id) + '\\')">Clear override</button>' +
          '<span class="save-notice" id="tn-' + esc(t.id) + '">Saved.</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).filter(Boolean).join('');
}

function renderThreadReviewSection(t, et) {
  if (!isThreadReview(t, et)) return '';
  var id = esc(t.id);
  return '<div class="ovr-section hidden" id="review-' + id + '">' +
    '<div class="ovr-row">' +
      '<span class="ovr-label">Decision</span>' +
      '<select class="ovr-status" id="review-status-' + id + '">' + getThreadStatusOptions(et.status === 'uncertain' ? 'active' : et.status) + '</select>' +
      '<button class="btn btn-secondary" onclick="applyThreadReviewStatus(\\'' + id + '\\')">Apply status</button>' +
    '</div>' +
    '<div class="ovr-row"><span class="ovr-label">Notes</span></div>' +
    '<textarea class="ovr-notes" id="review-notes-' + id + '" placeholder="Review notes&hellip;">' + esc(et.notes) + '</textarea>' +
    '<div class="review-actions">' +
      (et.suggestedStatus ? '<button class="btn btn-secondary" onclick="threadReviewAction(\\'' + id + '\\',\\'confirm\\')">Confirm suggestion</button>' : '') +
      (et.suggestedStatus ? '<button class="btn btn-secondary" onclick="threadReviewAction(\\'' + id + '\\',\\'reject\\')">Reject suggestion</button>' : '') +
      '<button class="btn btn-secondary" onclick="threadReviewAction(\\'' + id + '\\',\\'open\\')">Set Open</button>' +
      '<button class="btn btn-secondary" onclick="threadReviewAction(\\'' + id + '\\',\\'active\\')">Set Active</button>' +
      '<button class="btn btn-secondary" onclick="threadReviewAction(\\'' + id + '\\',\\'resolved\\')">Set Resolved</button>' +
      '<button class="btn btn-secondary" onclick="threadReviewAction(\\'' + id + '\\',\\'changed\\')">Set Changed</button>' +
      '<button class="btn btn-secondary" onclick="threadReviewAction(\\'' + id + '\\',\\'dismiss\\')">Dismiss</button>' +
    '</div>' +
    '<span class="save-notice" id="rn-' + id + '">Saved.</span>' +
  '</div>';
}

function toggleOvrSection(id) {
  var el = document.getElementById('ovr-' + id);
  if (el) el.classList.toggle('hidden');
}

function toggleReviewSection(id) {
  var el = document.getElementById('review-' + id);
  if (el) el.classList.toggle('hidden');
}

function saveThreadOvr(id) {
  var status = (document.getElementById('thr-status-' + id) || {}).value || '';
  var notes  = (document.getElementById('thr-notes-'  + id) || {}).value || '';
  vscode.postMessage({ command: 'overrideIndex', indexName: 'threads', id: id,
    patch: { status: status || undefined, notes: notes || undefined }});
  var el = document.getElementById('tn-' + id);
  if (el) { el.classList.add('show'); setTimeout(function() { el.classList.remove('show'); }, 2000); }
}

function applyThreadReviewStatus(id) {
  var status = (document.getElementById('review-status-' + id) || {}).value || 'active';
  threadReviewAction(id, status);
}

function threadReviewAction(id, action) {
  var t = getThreadById(id);
  if (!t) return;
  var et = effectiveThread(t);
  var notesEl = document.getElementById('review-notes-' + id);
  var notes = notesEl ? notesEl.value : '';
  var patch = {
    needsReview: false,
    suggestedStatus: null,
    suggestedUpdateType: null,
    suggestedResolutionType: null,
    notes: notes || undefined
  };

  if (action === 'confirm') {
    if (!et.suggestedStatus) return;
    patch.status = et.suggestedStatus;
  } else if (action === 'reject') {
    patch.status = et.status === 'uncertain' ? undefined : et.status;
  } else if (action === 'dismiss') {
    patch.hidden = true;
  } else {
    patch.status = action;
  }

  if (patch.status === 'resolved') {
    patch.resolvedChapter = t.lastSeenChapter || t.resolvedChapter || null;
    patch.unresolvedQuestion = null;
  } else if (patch.status === 'open' || patch.status === 'active') {
    patch.resolvedChapter = null;
  }

  vscode.postMessage({ command: 'threadReviewAction', id: id, patch: patch });
}

function clearOvr(indexName, id) {
  vscode.postMessage({ command: 'clearIndexOverride', indexName: indexName, id: id });
}

// ── Timeline ──

function renderTimeline() {
  var list = document.getElementById('timelineList');
  if (!list) return;
  if (!timeline || !timeline.length) {
    list.innerHTML = '<div style="padding:32px;opacity:0.5;text-align:center;">No timeline events indexed yet.</div>';
    return;
  }
  var groups  = [];
  var byChId  = {};
  timeline.forEach(function(e) {
    if (!byChId[e.chapterId]) {
      byChId[e.chapterId] = { chapterId: e.chapterId, num: e.chapterNumber, events: [] };
      groups.push(byChId[e.chapterId]);
    }
    byChId[e.chapterId].events.push(e);
  });
  list.innerHTML = groups.map(function(g) {
    var info    = chapterMap[g.chapterId];
    var chLabel = 'Ch. ' + g.num + (info && info.title ? ' ' + info.title : '');
    return '<div class="timeline-group">' +
      '<span class="tl-chapter-hd"' +
            ' data-fp="' + esc((info && info.filePath) || '') + '"' +
            ' data-title="' + esc((info && info.title) || '') + '"' +
            ' onclick="navChapter(this)" title="Open chapter">' +
        esc(chLabel) + '<span style="font-size:0.85em;opacity:0.6"> &rarr;</span>' +
      '</span>' +
      g.events.map(function(ev) {
        var ovr   = (allIdxOverrides['timeline'] || {})[ev.id] || {};
        var title = ovr.title || ev.title;
        var notes = ovr.notes || '';
        var ref   = findRef('timeline', ev.id, g.chapterId);
        return '<div class="tl-event" id="tl-' + esc(ev.id) + '"' +
          ' data-cid="' + esc(g.chapterId) + '"' +
          ' data-fp="' + esc((info && info.filePath) || '') + '"' +
          ' data-title="' + esc((info && info.title) || '') + '"' +
          (ref ? ' data-ref="' + esc(ref) + '"' : '') +
          ' onclick="navChapterEl(this)">' +
          '<div class="tl-event-title">' + esc(title) + '</div>' +
          (ev.description ? '<div class="tl-event-desc">' + esc(ev.description) + '</div>' : '') +
          (notes ? '<div class="ovr-note-display" onclick="event.stopPropagation()">' + esc(notes) + '</div>' : '') +
          '<div class="ovr-section hidden" id="tlovr-' + esc(ev.id) + '" onclick="event.stopPropagation()">' +
            '<textarea class="ovr-notes" id="tl-notes-' + esc(ev.id) + '" placeholder="Author notes&hellip;">' + esc(notes) + '</textarea>' +
            '<div class="ovr-actions">' +
              '<button class="btn btn-secondary" onclick="saveTlOvr(\\'' + esc(ev.id) + '\\')">Save note</button>' +
              '<button class="btn btn-secondary" onclick="clearOvr(\\'timeline\\',\\'' + esc(ev.id) + '\\')">Clear</button>' +
              '<span class="save-notice" id="tln-' + esc(ev.id) + '">Saved.</span>' +
            '</div>' +
          '</div>' +
          '<button class="btn-toggle-edit" style="float:right;margin-top:2px;" onclick="event.stopPropagation();toggleOvrSection(\\'tlovr-' + esc(ev.id) + '\\')">notes</button>' +
        '</div>';
      }).join('') +
    '</div>';
  }).join('');
}

function navChapter(el) {
  vscode.postMessage({ command: 'navigateToChapter', filePath: el.dataset.fp, title: el.dataset.title });
}
function navChapterEl(el) {
  var ref = el.dataset.ref;
  vscode.postMessage({ command: 'navigateToChapter', filePath: el.dataset.fp, title: el.dataset.title, referenceText: ref || undefined });
}

function saveTlOvr(id) {
  var notes = (document.getElementById('tl-notes-' + id) || {}).value || '';
  vscode.postMessage({ command: 'overrideIndex', indexName: 'timeline', id: id, patch: { notes: notes || undefined } });
  var el = document.getElementById('tln-' + id);
  if (el) { el.classList.add('show'); setTimeout(function() { el.classList.remove('show'); }, 2000); }
}

function toggleOvrSection(id) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('hidden');
}

// ── Continuity ──

function renderContinuity() {
  var list = document.getElementById('continuityList');
  if (!list) return;
  if (!continuity || !continuity.length) {
    list.innerHTML = '<div style="padding:32px;opacity:0.5;text-align:center;">No continuity items indexed yet.</div>';
    return;
  }
  list.innerHTML = continuity.map(function(c) {
    var ec      = effectiveContinuity(c);
    if (ec.hidden) return '';
    var lastMention = ec.mentions.length ? ec.mentions[ec.mentions.length - 1] : null;
    var chLinks = ec.mentions.map(function(m) {
      var info   = chapterMap[m.chapterId];
      var label  = 'Ch. ' + m.chapterNumber + (info && info.title ? ': ' + info.title : '');
      var refTxt = findRef('continuity', c.id, m.chapterId);
      var ref    = refTxt ? ' data-ref="' + esc(refTxt) + '"' : '';
      return '<span class="chapter-link" title="' + esc(label) + '"' +
             ' data-fp="' + esc((info && info.filePath) || '') + '"' +
             ' data-title="' + esc((info && info.title) || '') + '"' + ref +
             ' onclick="navigateToChapter(this)">' + m.chapterNumber + '</span>';
    }).join('');

    return '<div class="thread-card" id="card-' + esc(c.id) + '">' +
      '<div class="thread-header">' +
        '<span class="thread-title">' + esc(ec.title) + '</span>' +
        '<span class="badge badge-' + esc(ec.type)   + '">' + esc(ec.type)   + '</span>' +
        '<span class="badge badge-' + esc(ec.status) + '">' + esc(ec.status) + '</span>' +
        '<button class="btn-toggle-edit" onclick="toggleOvrSection(\\'covr-' + esc(c.id) + '\\')">&hellip;</button>' +
      '</div>' +
      (lastMention ? '<div class="thread-desc">' + esc(lastMention.description) + '</div>' : '') +
      '<div class="thread-appearances"><span class="thread-appearances-label">Ch:</span>' + chLinks + '</div>' +
      (ec.notes ? '<div class="ovr-note-display">' + esc(ec.notes) + '</div>' : '') +
      '<div class="ovr-section hidden" id="covr-' + esc(c.id) + '">' +
        '<div class="ovr-row">' +
          '<span class="ovr-label">Status</span>' +
          '<select class="ovr-status" id="con-status-' + esc(c.id) + '">' + getContinuityStatusOptions(ec.status) + '</select>' +
        '</div>' +
        '<div class="ovr-row"><span class="ovr-label">Notes</span></div>' +
        '<textarea class="ovr-notes" id="con-notes-' + esc(c.id) + '" placeholder="Author notes&hellip;">' + esc(ec.notes) + '</textarea>' +
        '<div class="ovr-actions">' +
          '<button class="btn btn-secondary" onclick="saveContOvr(\\'' + esc(c.id) + '\\')">Save</button>' +
          '<button class="btn btn-secondary" onclick="clearOvr(\\'continuity\\',\\'' + esc(c.id) + '\\')">Clear override</button>' +
          '<span class="save-notice" id="cn-' + esc(c.id) + '">Saved.</span>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).filter(Boolean).join('');
}

function saveContOvr(id) {
  var status = (document.getElementById('con-status-' + id) || {}).value || '';
  var notes  = (document.getElementById('con-notes-'  + id) || {}).value || '';
  vscode.postMessage({ command: 'overrideIndex', indexName: 'continuity', id: id,
    patch: { status: status || undefined, notes: notes || undefined }});
  var el = document.getElementById('cn-' + id);
  if (el) { el.classList.add('show'); setTimeout(function() { el.classList.remove('show'); }, 2000); }
}

// Init
renderList();
</script>
</body>
</html>`;
}
