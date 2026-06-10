import * as vscode from 'vscode';
import { ChapterAnalysis, ChapterEntity, ChapterOverview, ThreadUpdate, TimelineEvent, ContinuityNote } from '../dsm/draftScriptTypes';
import { CanonManager, normalizeId } from '../dsm/canonManager';
import { AnalysisStore } from '../dsm/analysisStore';
import { IndexBuilder } from '../dsm/indexBuilder';
import { OverrideStore } from '../dsm/overrideStore';
import { ChapterSource } from '../dsm/types';

export interface ChapterListItem {
  filePath:     string;
  title:        string;
  headingLevel: number;
  headingLine:  number;
  chapterNum:   number;
}

interface SaveMessage {
  command:          string;
  approvedNew:      { category: string; entity: ChapterEntity }[];
  linkedEntities:   { category: string; entityId: string; canonId: string }[];
  mergedEntities?:  { category: string; entity: ChapterEntity }[];
  sourceChapter?:   ChapterSource;
  autoScan?:        boolean;
  mergeAlways?:     boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class DsmReviewPanel {
  static create(
    analysis:       ChapterAnalysis,
    canon:          CanonManager,
    context:        vscode.ExtensionContext,
    promptSource:   string = 'built-in prompt',
    sourceChapter?: ChapterSource,
    nextChapter?:   ChapterListItem,
    autoScan:       boolean = false,
    mergeAlways:    boolean = false,
    onNext?:        (next: ChapterListItem, autoScan: boolean, mergeAlways: boolean) => void,
  ): void {
    const tabTitle = sourceChapter?.title ? `DSM — ${sourceChapter.title}` : 'DSM Review';
    const panel = makePanel(context, tabTitle);
    const cfg         = vscode.workspace.getConfiguration('draftScript');
    const fontSize    = cfg.get<number>('dsmReviewFontSize', 13);
    const minCertainty = cfg.get<number>('dsmAutoScanMinCertainty', 80);
    panel.webview.html = buildReviewHtml(analysis, canon, promptSource, sourceChapter, !!nextChapter, autoScan, mergeAlways, fontSize, minCertainty);

    panel.webview.onDidReceiveMessage(
      async (msg: SaveMessage) => {
        if (msg.command !== 'save' && msg.command !== 'saveAndNext') return;

        const root    = getRootFolderFromSourceChapter(msg.sourceChapter);
        let addedCount = 0;

        let mergedCount = 0;

        if (root) {
          const canonMgr = new CanonManager(root);
          const store    = new AnalysisStore(root);
          const overrides = new OverrideStore(root);

          // Approve new entities → write to canon
          for (const { category, entity } of (msg.approvedNew ?? [])) {
            canonMgr.addEntry(category, {
              id:          entity.id,
              name:        entity.name,
              aliases:     entity.aliases,
              description: entity.description ?? entity.roleInChapter ?? '',
            });
            addedCount++;
          }

          // Merge uncertain entities → confirm link to possibleCanonId in the analysis file
          if (msg.mergedEntities && msg.mergedEntities.length > 0 && msg.sourceChapter?.chapterNum != null) {
            const saved = store.read(msg.sourceChapter.chapterNum);
            if (saved) {
              let dirty = false;
              for (const { category, entity } of msg.mergedEntities) {
                const list = (saved as unknown as Record<string, ChapterEntity[]>)[category];
                const idx  = list?.findIndex(e => e.id === entity.id) ?? -1;
                if (idx !== -1 && entity.possibleCanonId) {
                  list[idx].status  = 'already_indexed';
                  list[idx].canonId = entity.possibleCanonId;
                  delete list[idx].possibleCanonId;
                  dirty = true;
                  mergedCount++;
                }
              }
              if (dirty) store.write(saved);
            }
          }

          // Rebuild indexes after any changes
          if (addedCount > 0 || mergedCount > 0) {
            new IndexBuilder(root, store, canonMgr, overrides).buildAll();
          }
        }

        const label   = sourceChapter?.title ?? 'chapter';
        const parts: string[] = [];
        if (addedCount > 0) parts.push(`${addedCount} new ${addedCount === 1 ? 'entity' : 'entities'} added`);
        if (mergedCount > 0) parts.push(`${mergedCount} uncertain ${mergedCount === 1 ? 'entity' : 'entities'} merged`);
        vscode.window.showInformationMessage(
          `DSM: "${label}" — ${parts.length ? parts.join(', ') + '.' : 'no changes.'}`
        );
        panel.dispose();

        if (msg.command === 'saveAndNext' && nextChapter && onNext) {
          onNext(nextChapter, msg.autoScan ?? false, msg.mergeAlways ?? false);
        }
      },
      undefined,
      context.subscriptions
    );
  }

  static createError(
    message: string,
    raw:     string,
    context: vscode.ExtensionContext
  ): void {
    const panel = makePanel(context);
    panel.webview.html = buildErrorHtml(message, raw);
  }
}

// ---------------------------------------------------------------------------
// Panel factory
// ---------------------------------------------------------------------------

function makePanel(context: vscode.ExtensionContext, title: string = 'DSM Review'): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(
    'dsmReview', title,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: false }
  );
}

function getRootFolderFromSourceChapter(chapter?: ChapterSource): string | undefined {
  if (!chapter?.filePath) return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // Walk up until we find .draft-script or workspace root
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const ENTITY_CATEGORIES: { key: keyof ChapterAnalysis; label: string }[] = [
  { key: 'characters', label: 'Characters' },
  { key: 'locations',  label: 'Locations'  },
  { key: 'objects',    label: 'Objects'    },
  { key: 'groups',     label: 'Groups'     },
];

function buildReviewHtml(
  analysis:      ChapterAnalysis,
  canon:         CanonManager,
  promptSource:  string,
  sourceChapter: ChapterSource | undefined,
  hasNext:       boolean,
  autoScan:      boolean,
  mergeAlways:   boolean,
  fontSize:      number,
  minCertainty:  number = 80,
): string {
  const chapterBadge = sourceChapter?.chapterNum != null
    ? `<span class="badge chapter-badge">#${sourceChapter.chapterNum}</span>`
    : '';

  const sections: string[] = [];
  sections.push(overviewSection(analysis.overview));

  // Entity sections grouped by status
  for (const { key, label } of ENTITY_CATEGORIES) {
    const entities = analysis[key] as ChapterEntity[];
    if (entities.length) sections.push(entitySection(label, key as string, entities, chapterBadge));
  }

  // Threads
  if (analysis.threads.length)
    sections.push(threadSection(analysis.threads));

  // Timeline
  if (analysis.timelineEvents.length)
    sections.push(timelineSection(analysis.timelineEvents));

  // Continuity
  if (analysis.continuityNotes.length)
    sections.push(continuitySection(analysis.continuityNotes));

  const body = sections.length
    ? sections.join('')
    : '<p class="empty">No entities detected in this chapter.</p>';

  return page(`
<div class="toolbar">
  <div class="toolbar-left">
    <h2 title="${sourceChapter?.title ?? 'DSM Analysis Review'}">${esc(sourceChapter?.title ?? 'DSM Analysis Review')}</h2>
    <span class="prompt-source">prompt: ${esc(promptSource)}</span>
  </div>
  <div class="toolbar-right">
    <label class="auto-scan-label">
      <input type="checkbox" id="autoScanCheck" ${autoScan ? 'checked' : ''} onchange="onAutoScanChange()">
      Scan automatically
    </label>
    <div id="certaintyRow" class="certainty-row" style="${autoScan ? '' : 'display:none'}">
      <span class="certainty-label">Min certainty</span>
      <input type="range" id="certaintySlider" min="0" max="100" value="${minCertainty}" oninput="onCertaintyChange(this)" class="certainty-slider">
      <span id="certaintyPct" class="certainty-pct">${minCertainty}%</span>
      <span class="certainty-sep">|</span>
      <label class="auto-scan-label">
        <input type="checkbox" id="mergeAlwaysCheck" ${mergeAlways ? 'checked' : ''} onchange="onMergeAlwaysChange()">
        Merge uncertain
      </label>
    </div>
    <button class="btn-approve-all" onclick="approveAllNew()">Approve All New</button>
  </div>
</div>
${body}
<div class="footer">
  <div class="footer-inner">
    ${hasNext ? `<button id="nextBtn" class="btn-next" onclick="saveAndNext()" disabled>Save &amp; scan next</button>` : '<span></span>'}
    <button id="saveBtn" class="btn-save" onclick="save()" disabled>Save to Canon</button>
  </div>
</div>
<script>
const vscode        = acquireVsCodeApi();
const analysis      = ${JSON.stringify(analysis)};
const sourceChapter = ${sourceChapter ? JSON.stringify(sourceChapter) : 'null'};
const hasNext       = ${JSON.stringify(hasNext)};
let   autoScan      = ${JSON.stringify(autoScan)};
let   mergeAlways   = ${JSON.stringify(mergeAlways)};
let   minCertainty  = ${JSON.stringify(minCertainty)};

function onAutoScanChange() {
  autoScan = document.getElementById('autoScanCheck').checked;
  document.getElementById('certaintyRow').style.display = autoScan ? '' : 'none';
}

function onMergeAlwaysChange() {
  mergeAlways = document.getElementById('mergeAlwaysCheck').checked;
}

function onCertaintyChange(slider) {
  minCertainty = parseInt(slider.value);
  document.getElementById('certaintyPct').textContent = minCertainty + '%';
}

function approveAllNew(useThreshold) {
  document.querySelectorAll('.row.status-new .approve-btn:not(.active)')
    .forEach(b => {
      if (useThreshold) {
        const row  = b.closest('.row');
        const conf = Math.round(analysis[row.dataset.cat][parseInt(row.dataset.idx)].confidence * 100);
        if (conf < minCertainty) return;
      }
      b.click();
    });
}

function approveAllUncertain(useThreshold) {
  document.querySelectorAll('.row.status-uncertain .approve-btn:not(.active)')
    .forEach(b => {
      if (useThreshold) {
        const row  = b.closest('.row');
        const conf = Math.round(analysis[row.dataset.cat][parseInt(row.dataset.idx)].confidence * 100);
        if (conf < minCertainty) return;
      }
      b.click();
    });
}

function toggleApprove(btn) {
  const row = btn.closest('.row');
  const on  = row.classList.toggle('approved');
  btn.textContent = on ? '✓ Approved' : '✓ Approve';
  btn.classList.toggle('active', on);
  updateSaveBtn();
}

function updateSaveBtn() {
  const any = document.querySelectorAll('.row.approved').length > 0;
  document.getElementById('saveBtn').disabled = !any;
  const nb = document.getElementById('nextBtn');
  if (nb) nb.disabled = !any;
}

function collectApproved() {
  const approvedNew    = [];
  const mergedEntities = [];

  document.querySelectorAll('.row.approved').forEach(row => {
    const cat    = row.dataset.cat;
    const idx    = parseInt(row.dataset.idx);
    const status = row.dataset.status;
    const entity = analysis[cat][idx];

    if (status === 'new') {
      approvedNew.push({ category: cat, entity });
    } else if (status === 'uncertain') {
      if (mergeAlways && entity.possibleCanonId) {
        mergedEntities.push({ category: cat, entity });
      } else {
        approvedNew.push({ category: cat, entity });
      }
    }
  });

  return { approvedNew, mergedEntities };
}

function save() {
  const { approvedNew, mergedEntities } = collectApproved();
  vscode.postMessage({ command: 'save', approvedNew, linkedEntities: [], mergedEntities, sourceChapter, mergeAlways });
}

function saveAndNext() {
  const { approvedNew, mergedEntities } = collectApproved();
  vscode.postMessage({ command: 'saveAndNext', approvedNew, linkedEntities: [], mergedEntities, sourceChapter, autoScan, mergeAlways });
}

if (autoScan) {
  setTimeout(() => {
    approveAllNew(true);
    if (mergeAlways) approveAllUncertain(true);
    if (hasNext) { saveAndNext(); } else { save(); }
  }, 600);
}
</script>
`, fontSize);
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function overviewSection(overview: ChapterOverview): string {
  const list = (items: string[]) => items.length
    ? `<ul>${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`
    : '<div class="row-role muted">none</div>';

  return `<section>
  <h3>Chapter Overview</h3>
  <div class="overview-grid">
    <div><strong>Purpose</strong><div class="row-role">${esc(overview.purpose || 'none')}</div></div>
    <div><strong>Emotional Beat</strong><div class="row-role">${esc(overview.emotionalBeat || 'none')}</div></div>
    <div><strong>Function</strong><div class="row-role">${esc(overview.chapterFunction)}</div></div>
    <div><strong>Book Impact</strong><div class="row-role">${esc(overview.bookImpact || 'none')}</div></div>
  </div>
  <div class="overview-columns">
    <div><strong>Summary</strong>${list(overview.summary)}</div>
    <div><strong>Setups</strong>${list(overview.setups)}</div>
    <div><strong>Payoffs</strong>${list(overview.payoffs)}</div>
    <div><strong>Human Focus</strong>${list(overview.humanFocus)}</div>
    <div><strong>Technical Focus</strong>${list(overview.technicalFocus)}</div>
    <div><strong>Risk Flags</strong>${list(overview.riskFlags)}</div>
  </div>
</section>`;
}

function entitySection(
  label:    string,
  cat:      string,
  entities: ChapterEntity[],
  chapterBadge: string
): string {
  const rows = entities.map((e, i) => {
    const statusClass = `status-${e.status}`;
    const statusBadge = statusBadgeHtml(e);
    const aliases     = e.aliases.length ? `<span class="alias">(${e.aliases.join(', ')})</span>` : '';
    const conf        = Math.round(e.confidence * 100);
    const role        = e.roleInChapter ? `<div class="row-role">${esc(e.roleInChapter)}</div>` : '';
    const approveBtn  = e.status === 'new'
      ? `<button class="approve-btn" onclick="toggleApprove(this)">✓ Approve</button>`
      : e.status === 'uncertain'
        ? `<button class="approve-btn" onclick="toggleApprove(this)">✓ Approve as new</button>`
        : '';

    return `<div class="row ${statusClass}" data-cat="${cat}" data-idx="${i}" data-status="${e.status}">
  <div class="row-left">
    <span class="name">${esc(e.name)}</span>${aliases ? ' ' + aliases : ''}
    ${statusBadge}
    ${chapterBadge}
    <span class="badge conf-badge">${conf}%</span>
  </div>
  ${role}
  <div class="row-actions">${approveBtn}</div>
</div>`;
  }).join('');

  return `<section><h3>${esc(label)}</h3>${rows}</section>`;
}

function threadSection(threads: ThreadUpdate[]): string {
  const rows = threads.map((t, i) => {
    const conf        = Math.round(t.confidence * 100);
    const statusColor = t.status === 'resolved' ? 'badge-resolved' : (t.status === 'open' || t.status === 'active') ? 'badge-open' : 'badge-changed';
    return `<div class="row info-row" data-cat="threads" data-idx="${i}">
  <div class="row-left">
    <span class="name">${esc(t.title)}</span>
    <span class="badge badge-type">${esc(t.type)}</span>
    <span class="badge ${statusColor}">${esc(t.status)}</span>
    <span class="badge badge-type">${esc(t.updateType)}</span>
    <span class="badge badge-type">${esc(t.resolutionType)}</span>
    <span class="badge conf-badge">${conf}%</span>
  </div>
  <div class="row-role">${esc(t.description)}</div>
</div>`;
  }).join('');

  return `<section><h3>Threads</h3>${rows}</section>`;
}

function timelineSection(events: TimelineEvent[]): string {
  const rows = events.map((e, i) => {
    const conf = Math.round(e.confidence * 100);
    return `<div class="row info-row" data-cat="timelineEvents" data-idx="${i}">
  <div class="row-left">
    <span class="name">${esc(e.title)}</span>
    <span class="badge conf-badge">${conf}%</span>
  </div>
  ${e.description ? `<div class="row-role">${esc(e.description)}</div>` : ''}
</div>`;
  }).join('');

  return `<section><h3>Timeline Events</h3>${rows}</section>`;
}

function continuitySection(notes: ContinuityNote[]): string {
  const rows = notes.map((n, i) => {
    const conf        = Math.round(n.confidence * 100);
    const statusColor = n.status === 'resolved' ? 'badge-resolved' : n.status === 'active' ? 'badge-open' : 'badge-changed';
    return `<div class="row info-row" data-cat="continuityNotes" data-idx="${i}">
  <div class="row-left">
    <span class="name">${esc(n.title)}</span>
    <span class="badge badge-type">${esc(n.type)}</span>
    <span class="badge ${statusColor}">${esc(n.status)}</span>
    <span class="badge conf-badge">${conf}%</span>
  </div>
  <div class="row-role">${esc(n.description)}</div>
</div>`;
  }).join('');

  return `<section><h3>Continuity Notes</h3>${rows}</section>`;
}

function statusBadgeHtml(e: ChapterEntity): string {
  if (e.status === 'already_indexed') {
    return `<span class="badge badge-indexed" title="Canon ID: ${esc(e.canonId ?? '')}">indexed</span>`;
  }
  if (e.status === 'uncertain') {
    return `<span class="badge badge-uncertain" title="Possible match: ${esc(e.possibleCanonId ?? '')}">uncertain</span>`;
  }
  return '<span class="badge badge-new">new</span>';
}

function buildErrorHtml(message: string, raw: string): string {
  return page(`
<div class="toolbar"><h2>DSM: Parse Error</h2></div>
<p class="error-msg">${esc(message)}</p>
<h3>Raw LLM Output</h3>
<pre class="raw-output">${esc(raw)}</pre>
`);
}

// ---------------------------------------------------------------------------
// Page template
// ---------------------------------------------------------------------------

function page(body: string, fontSize?: number): string {
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
  font-size: ${fontSize ?? 13}px;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0; padding: 0 16px 80px;
}
.toolbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 0 8px; border-bottom: 1px solid var(--vscode-widget-border);
  position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 10;
}
.toolbar-left  { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; overflow: hidden; }
.toolbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
h2 { margin: 0; font-size: 1.05em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.prompt-source { font-size: 0.72em; opacity: 0.5; font-style: italic; flex-shrink: 0; }
.auto-scan-label { display: flex; align-items: center; gap: 5px; font-size: 0.82em; opacity: 0.75; cursor: pointer; user-select: none; }
.auto-scan-label input { cursor: pointer; }
.certainty-row { display: flex; align-items: center; gap: 6px; font-size: 0.78em; opacity: 0.8; }
.certainty-label { white-space: nowrap; }
.certainty-slider { width: 90px; cursor: pointer; accent-color: var(--vscode-button-background); }
.certainty-pct { min-width: 2.6em; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.certainty-sep { opacity: 0.3; margin: 0 2px; }
h3 { font-size: 0.9em; margin: 16px 0 4px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.05em; }
section { margin-bottom: 6px; }
.row {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 5px 8px; border-radius: 4px; margin-bottom: 2px;
  border: 1px solid transparent;
}
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.approved { border-color: var(--vscode-inputValidation-infoBorder, #3794ff); background: var(--vscode-inputValidation-infoBackground, rgba(55,148,255,0.08)); }
.status-already_indexed { opacity: 0.5; }
.status-uncertain { border-left: 2px solid rgba(255,180,0,0.6); }
.info-row { opacity: 0.8; }
.row-left { flex: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.row-role { flex-basis: 100%; font-size: 0.83em; opacity: 0.7; margin-top: 2px; padding-left: 2px; }
.muted { opacity: 0.45; }
.overview-grid, .overview-columns {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 8px; padding: 8px; border: 1px solid var(--vscode-widget-border);
  border-radius: 4px; margin-bottom: 6px;
}
.overview-columns { align-items: start; }
.overview-grid strong, .overview-columns strong { font-size: 0.78em; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.04em; }
.overview-columns ul { margin: 4px 0 0 16px; padding: 0; font-size: 0.84em; opacity: 0.78; }
.overview-columns li { margin-bottom: 2px; }
.row-actions { flex-shrink: 0; }
.name { font-weight: 600; white-space: nowrap; }
.alias { font-size: 0.82em; opacity: 0.6; }
.badge { font-size: 0.7em; padding: 1px 5px; border-radius: 3px; font-weight: 600; }
.badge-new      { background: rgba(80,200,80,0.2);  color: var(--vscode-foreground); }
.badge-indexed  { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.badge-uncertain { background: rgba(255,180,0,0.2); color: var(--vscode-foreground); }
.badge-type     { background: rgba(120,120,200,0.2); color: var(--vscode-foreground); }
.badge-open     { background: rgba(255,100,100,0.2); color: var(--vscode-foreground); }
.badge-resolved { background: rgba(80,200,80,0.2);  color: var(--vscode-foreground); }
.badge-changed  { background: rgba(255,180,0,0.2);  color: var(--vscode-foreground); }
.chapter-badge  { background: rgba(55,148,255,0.15); color: var(--vscode-foreground); }
.conf-badge     { background: rgba(55,148,255,0.1); color: var(--vscode-foreground); opacity: 0.75; }
.approve-btn {
  font-size: 0.78em; padding: 2px 9px;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; cursor: pointer;
}
.approve-btn:hover  { background: var(--vscode-button-secondaryHoverBackground); }
.approve-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn-approve-all {
  font-size: 0.82em; padding: 3px 12px; cursor: pointer;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px;
}
.btn-approve-all:hover { background: var(--vscode-button-secondaryHoverBackground); }
.footer {
  position: fixed; bottom: 0; left: 0; right: 0;
  padding: 10px 16px; background: var(--vscode-editor-background);
  border-top: 1px solid var(--vscode-widget-border);
}
.footer-inner { display: flex; gap: 8px; }
.btn-save {
  flex: 1; padding: 6px; cursor: pointer; font-size: 0.9em;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  border: none; border-radius: 4px;
}
.btn-save:hover:not(:disabled)  { background: var(--vscode-button-hoverBackground); }
.btn-save:disabled { opacity: 0.4; cursor: default; }
.btn-next {
  flex: 1; padding: 6px; cursor: pointer; font-size: 0.9em;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px;
}
.btn-next:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.btn-next:disabled { opacity: 0.4; cursor: default; }
.empty { opacity: 0.6; padding: 24px 0; }
.error-msg { color: var(--vscode-errorForeground); margin: 12px 0; }
.raw-output {
  white-space: pre-wrap; word-break: break-all; font-size: 0.8em;
  background: var(--vscode-textCodeBlock-background); padding: 12px;
  border-radius: 4px; max-height: 400px; overflow: auto;
}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
