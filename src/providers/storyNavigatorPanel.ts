import * as vscode from 'vscode';
import * as fs     from 'fs';
import * as path   from 'path';

import {
  ThreadIndexItem, ContinuityIndexItem, CharacterIndexItem,
  TimelineIndexItem, ReferenceIndexItem, Signal, SignalIndexEntry, ChapterMapItem,
} from '../dsm/draftScriptTypes';
import { navigateWithSelection } from '../utils/navigation';

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; }
  catch { return null; }
}

function readIndex<T>(root: string, name: string): T[] {
  return readJson<T[]>(path.join(root, '.draft-script', 'indexes', `${name}.json`)) ?? [];
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export class StoryNavigatorPanel {
  static open(context: vscode.ExtensionContext, getRootFolder: () => string): void {
    const root = getRootFolder();
    if (!root) {
      vscode.window.showWarningMessage('Story Navigator: no workspace folder open.');
      return;
    }

    const threads    = readIndex<ThreadIndexItem>(root, 'threads');
    const continuity = readIndex<ContinuityIndexItem>(root, 'continuity');
    const characters = readIndex<CharacterIndexItem>(root, 'characters');
    const locations  = readIndex<CharacterIndexItem>(root, 'locations');
    const objects    = readIndex<CharacterIndexItem>(root, 'objects');
    const groups     = readIndex<CharacterIndexItem>(root, 'groups');
    const timeline   = readIndex<TimelineIndexItem>(root, 'timeline');
    const reference  = readIndex<ReferenceIndexItem>(root, 'reference');

    const chapterArr = readIndex<ChapterMapItem>(root, 'chapters');
    const chapterMap: Record<string, { number: number; title: string; filePath: string }> = {};
    for (const c of chapterArr) {
      chapterMap[c.id] = { number: c.number, title: c.title, filePath: c.filePath };
    }

    const signalIndex = readJson<Record<string, SignalIndexEntry[]>>(
      path.join(root, '.draft-script', 'indexes', 'signals.json')
    ) ?? {};
    const signalDefs = readJson<Signal[]>(
      path.join(root, '.draft-script', 'canon', 'signals.json')
    ) ?? [];

    const hasData = threads.length + continuity.length + characters.length + timeline.length > 0;

    const panel = vscode.window.createWebviewPanel(
      'dsmStoryNavigator',
      'Story Navigator',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    panel.webview.html = buildHtml({
      threads, continuity, characters, locations, objects, groups,
      timeline, reference, chapterMap, signalIndex, signalDefs, hasData,
    });

    panel.webview.onDidReceiveMessage(
      async (msg: Record<string, unknown>) => {
        if (msg.command === 'navigate') {
          await navigateWithSelection({
            filePath:      msg.filePath as string,
            root,
            referenceText: msg.referenceText as string | undefined,
            title:         msg.title as string | undefined,
            entityName:    msg.entityName as string | undefined,
            entityAliases: msg.entityAliases as string[] | undefined,
          });
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

interface HtmlData {
  threads:     ThreadIndexItem[];
  continuity:  ContinuityIndexItem[];
  characters:  CharacterIndexItem[];
  locations:   CharacterIndexItem[];
  objects:     CharacterIndexItem[];
  groups:      CharacterIndexItem[];
  timeline:    TimelineIndexItem[];
  reference:   ReferenceIndexItem[];
  chapterMap:  Record<string, { number: number; title: string; filePath: string }>;
  signalIndex: Record<string, SignalIndexEntry[]>;
  signalDefs:  Signal[];
  hasData:     boolean;
}

function buildHtml(d: HtmlData): string {
  const data = JSON.stringify({
    threads:     d.threads,
    continuity:  d.continuity,
    characters:  d.characters,
    locations:   d.locations,
    objects:     d.objects,
    groups:      d.groups,
    timeline:    d.timeline,
    reference:   d.reference,
    chapterMap:  d.chapterMap,
    signalIndex: d.signalIndex,
    signalDefs:  d.signalDefs,
  });

  const noDataMsg = d.hasData ? '' : `
    <div class="no-data">No DSM indexes found. Run DSM analysis on at least one chapter first.</div>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Story Navigator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .mode-btn {
    padding: 4px 12px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 12px;
    opacity: 0.7;
  }
  .mode-btn.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    opacity: 1;
  }
  .search-bar {
    flex: 1;
    margin-left: 8px;
  }
  .search-bar input {
    width: 100%;
    padding: 4px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
    font-size: 13px;
    outline: none;
  }
  .browse-tabs {
    display: flex;
    gap: 2px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    overflow-x: auto;
    flex-shrink: 0;
  }
  .browse-tabs::-webkit-scrollbar { height: 3px; }
  .btab {
    padding: 3px 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 11px;
    white-space: nowrap;
    opacity: 0.7;
  }
  .btab.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-color: transparent;
    opacity: 1;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    min-height: 0;
  }
  .filter-group {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }
  .filter-label {
    font-size: 11px;
    opacity: 0.6;
    margin-right: 2px;
  }
  .fpill {
    padding: 2px 8px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 10px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 11px;
    opacity: 0.7;
  }
  .fpill.active {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-color: transparent;
    opacity: 1;
  }
  .results {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }
  .result-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.1));
    cursor: default;
  }
  .result-row:hover { background: var(--vscode-list-hoverBackground); }
  .result-title {
    font-size: 13px;
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    white-space: nowrap;
    flex-shrink: 0;
    opacity: 0.85;
  }
  .badge-thread   { background: #4a3f6b; color: #c9b8ff; }
  .badge-promise  { background: #2d4a3e; color: #7de8b0; }
  .badge-risk     { background: #5a2d2d; color: #ffb3b3; }
  .badge-mystery  { background: #2d3f5a; color: #8fc8ff; }
  .badge-task     { background: #3d4a2d; color: #b3e87d; }
  .badge-question { background: #4a422d; color: #ffe28f; }
  .badge-conflict { background: #5a3d2d; color: #ffcca0; }
  .badge-system   { background: #2d4a4a; color: #8fe8e8; }
  .badge-continuity { background: #3d3d5a; color: #b3b8ff; }
  .badge-character  { background: #3a4a2d; color: #b8e87d; }
  .badge-location   { background: #2d4a45; color: #7de8dc; }
  .badge-object     { background: #4a402d; color: #e8d07d; }
  .badge-group      { background: #4a2d40; color: #e87db8; }
  .badge-timeline   { background: #2d3d4a; color: #7db8e8; }
  .badge-signal     { background: #3a2d4a; color: #c87de8; }
  .badge-open     { color: #f0f0f0; }
  .badge-active   { color: #7de87d; }
  .badge-resolved { color: #888; }
  .badge-changed  { color: #e8c07d; }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    align-items: center;
    flex-shrink: 0;
    max-width: 55%;
  }
  .chip {
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }
  .chip:hover { opacity: 0.8; filter: brightness(1.2); }
  .more-btn {
    padding: 1px 6px;
    border-radius: 3px;
    border: 1px solid var(--vscode-panel-border);
    background: transparent;
    color: var(--vscode-foreground);
    font-size: 11px;
    cursor: pointer;
    opacity: 0.6;
  }
  .more-btn:hover { opacity: 1; }
  .signal-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.1));
  }
  .signal-row:hover { background: var(--vscode-list-hoverBackground); }
  .signal-id {
    font-size: 12px;
    font-family: var(--vscode-editor-font-family);
    color: var(--vscode-textLink-foreground);
    flex: 1;
  }
  .signal-count {
    font-size: 11px;
    opacity: 0.6;
  }
  .signal-desc {
    font-size: 11px;
    opacity: 0.6;
    flex: 2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub-list {
    border-left: 2px solid var(--vscode-textLink-foreground);
    margin: 0 12px 4px 24px;
    padding: 2px 0;
  }
  .sub-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 8px;
  }
  .no-data {
    padding: 24px;
    opacity: 0.6;
    font-style: italic;
  }
  .count-label {
    font-size: 11px;
    opacity: 0.5;
    padding: 4px 12px;
  }
  #browse-filters:empty { display: none; }
  #browse-search-bar { flex: none; margin-left: 0; padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
</style>
</head>
<body>

<div class="toolbar">
  <button class="mode-btn active" id="btn-search" onclick="setMode('search')">Search</button>
  <button class="mode-btn" id="btn-browse" onclick="setMode('browse')">Browse</button>
  <div class="search-bar" id="search-bar">
    <input id="search-input" type="text" placeholder="Search all indexes..." oninput="onSearch(this.value)">
  </div>
</div>

<div id="browse-tabs" class="browse-tabs" style="display:none">
  <button class="btab active" data-tab="threads"    onclick="setBrowseTab(this,'threads')">Threads</button>
  <button class="btab"        data-tab="continuity" onclick="setBrowseTab(this,'continuity')">Continuity</button>
  <button class="btab"        data-tab="characters" onclick="setBrowseTab(this,'characters')">Characters</button>
  <button class="btab"        data-tab="locations"  onclick="setBrowseTab(this,'locations')">Locations</button>
  <button class="btab"        data-tab="objects"    onclick="setBrowseTab(this,'objects')">Objects</button>
  <button class="btab"        data-tab="groups"     onclick="setBrowseTab(this,'groups')">Groups</button>
  <button class="btab"        data-tab="timeline"   onclick="setBrowseTab(this,'timeline')">Timeline</button>
  <button class="btab"        data-tab="signals"    onclick="setBrowseTab(this,'signals')">Signals</button>
</div>

<div id="browse-search-bar" class="search-bar" style="display:none">
  <input id="browse-input" type="text" placeholder="Filter..." oninput="onBrowseSearch(this.value)">
</div>
<div id="browse-filters" class="filters" style="display:none"></div>

<div class="results" id="results">
  ${noDataMsg}
</div>

<script>
const vscode = acquireVsCodeApi();
const DATA   = ${data};

// ── State ──────────────────────────────────────────────────────────────────
let mode          = 'search';
let browseTab     = 'threads';
let searchTimer   = null;
let browseTimer   = null;
let browseQuery   = '';
let chipLimits    = {};          // { resultKey: visibleCount }
let expandedSig   = null;        // signal id currently expanded

const FILTERS = {
  threadType:       'all',
  threadStatus:     'all',
  continuityType:   'all',
  continuityStatus: 'all',
};

const CHIP_PAGE = 20;

// ── Mode ───────────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  document.getElementById('btn-search').classList.toggle('active', m === 'search');
  document.getElementById('btn-browse').classList.toggle('active', m === 'browse');
  document.getElementById('search-bar').style.display      = m === 'search' ? '' : 'none';
  document.getElementById('browse-tabs').style.display      = m === 'browse' ? '' : 'none';
  document.getElementById('browse-search-bar').style.display = m === 'browse' ? '' : 'none';
  const bf = document.getElementById('browse-filters');
  bf.style.display = m === 'browse' ? '' : 'none';
  if (m === 'search') {
    document.getElementById('search-input').focus();
    renderResults([]);
  } else {
    document.getElementById('browse-input').focus();
    renderBrowse();
  }
}

// ── Search ─────────────────────────────────────────────────────────────────
function onSearch(q) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(function() { doSearch(q.trim().toLowerCase()); }, 180);
}

function matches(query) {
  var args = Array.prototype.slice.call(arguments, 1);
  return args.some(function(s) { return s && s.toLowerCase().indexOf(query) >= 0; });
}

function browseMatches() {
  if (!browseQuery) return true;
  var args = Array.prototype.slice.call(arguments);
  return args.some(function(s) { return s && s.toLowerCase().indexOf(browseQuery) >= 0; });
}

function onBrowseSearch(val) {
  clearTimeout(browseTimer);
  browseTimer = setTimeout(function() {
    browseQuery = val.trim().toLowerCase();
    chipLimits  = {};
    expandedSig = null;
    renderBrowse();
  }, 180);
}

function doSearch(q) {
  if (!q) { renderResults([]); return; }

  var results = [];

  DATA.threads.forEach(function(t) {
    if (matches(q, t.title, t.description, t.lastKnownState, t.unresolvedQuestion)) {
      results.push(threadResult(t));
    }
  });

  DATA.continuity.forEach(function(c) {
    if (matches(q, c.title)) {
      results.push(continuityResult(c));
    }
  });

  ['characters','locations','objects','groups'].forEach(function(cat) {
    DATA[cat].forEach(function(e) {
      var descs = (e.generatedDescriptions || []).map(function(d) { return d.description; }).join(' ');
      if (matches(q, e.name, e.canonDescription, descs) ||
          (e.aliases || []).some(function(a) { return a.toLowerCase().indexOf(q) >= 0; })) {
        results.push(entityResult(cat, e));
      }
    });
  });

  DATA.timeline.forEach(function(t) {
    if (matches(q, t.title, t.description)) {
      results.push(timelineResult(t));
    }
  });

  renderResults(results);
}

// ── Browse ─────────────────────────────────────────────────────────────────
function setBrowseTab(btn, tab) {
  browseTab = tab;
  document.querySelectorAll('.btab').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  chipLimits = {};
  expandedSig = null;
  renderBrowse();
}

function renderBrowse() {
  renderFilters();
  var results = [];

  if (browseTab === 'threads') {
    DATA.threads
      .filter(function(t) {
        return (FILTERS.threadType   === 'all' || t.type   === FILTERS.threadType) &&
               (FILTERS.threadStatus === 'all' || t.status === FILTERS.threadStatus) &&
               browseMatches(t.title, t.description, t.lastKnownState, t.unresolvedQuestion);
      })
      .forEach(function(t) { results.push(threadResult(t)); });
  }
  else if (browseTab === 'continuity') {
    DATA.continuity
      .filter(function(c) {
        return (FILTERS.continuityType   === 'all' || c.type   === FILTERS.continuityType) &&
               (FILTERS.continuityStatus === 'all' || c.status === FILTERS.continuityStatus) &&
               browseMatches(c.title, c.description);
      })
      .forEach(function(c) { results.push(continuityResult(c)); });
  }
  else if (browseTab === 'characters') {
    DATA.characters.filter(function(e) {
      return browseMatches(e.name, e.canonDescription) ||
             (e.aliases || []).some(function(a) { return a.toLowerCase().indexOf(browseQuery) >= 0; });
    }).forEach(function(e) { results.push(entityResult('characters', e)); });
  }
  else if (browseTab === 'locations') {
    DATA.locations.filter(function(e) {
      return browseMatches(e.name, e.canonDescription);
    }).forEach(function(e) { results.push(entityResult('locations', e)); });
  }
  else if (browseTab === 'objects') {
    DATA.objects.filter(function(e) {
      return browseMatches(e.name, e.canonDescription);
    }).forEach(function(e) { results.push(entityResult('objects', e)); });
  }
  else if (browseTab === 'groups') {
    DATA.groups.filter(function(e) {
      return browseMatches(e.name, e.canonDescription);
    }).forEach(function(e) { results.push(entityResult('groups', e)); });
  }
  else if (browseTab === 'timeline') {
    DATA.timeline.filter(function(t) {
      return browseMatches(t.title, t.description);
    }).forEach(function(t) { results.push(timelineResult(t)); });
  }
  else if (browseTab === 'signals') {
    renderSignals();
    return;
  }

  renderResults(results);
}

// ── Filters ────────────────────────────────────────────────────────────────
function renderFilters() {
  var el = document.getElementById('browse-filters');
  el.innerHTML = '';
  el.style.display = '';

  if (browseTab === 'threads') {
    el.appendChild(pillGroup('Type', 'threadType',
      ['all','promise','risk','mystery','task','question','conflict','system','uncertain']));
    el.appendChild(pillGroup('Status', 'threadStatus',
      ['all','open','active','resolved','changed','uncertain']));
  } else if (browseTab === 'continuity') {
    el.appendChild(pillGroup('Type', 'continuityType',
      ['all','state','resource','construction','technology','relationship','promise','risk','population','logistics']));
    el.appendChild(pillGroup('Status', 'continuityStatus',
      ['all','active','resolved','changed','uncertain']));
  } else {
    el.style.display = 'none';
  }
}

function pillGroup(label, filterKey, values) {
  var div = document.createElement('div');
  div.className = 'filter-group';
  var lbl = document.createElement('span');
  lbl.className = 'filter-label';
  lbl.textContent = label + ':';
  div.appendChild(lbl);
  values.forEach(function(v) {
    var btn = document.createElement('button');
    btn.className = 'fpill' + (FILTERS[filterKey] === v ? ' active' : '');
    btn.textContent = v;
    btn.onclick = function() {
      FILTERS[filterKey] = v;
      chipLimits = {};
      renderBrowse();
    };
    div.appendChild(btn);
  });
  return div;
}

// ── Result builders ────────────────────────────────────────────────────────
function threadResult(t) {
  var chips = (t.appearances || []).map(function(a) {
    return { chapterNumber: a.chapterNumber, chapterId: a.chapterId };
  });
  return { key: 'thread:' + t.id, id: t.id, title: t.title, badges: [typeBadge('thread'), typeBadge(t.type), statusBadge(t.status)], chips: chips };
}

function continuityResult(c) {
  var chips = (c.mentions || []).map(function(m) {
    return { chapterNumber: m.chapterNumber, chapterId: m.chapterId };
  });
  return { key: 'cont:' + c.id, id: c.id, title: c.title, badges: [typeBadge('continuity'), typeBadge(c.type), statusBadge(c.status)], chips: chips };
}

function entityResult(cat, e) {
  var kind = cat.replace(/s$/, '');
  var chips = (e.appearances || []).map(function(a) {
    return { chapterNumber: a.chapterNumber, chapterId: a.chapterId };
  });
  return { key: cat + ':' + e.id, id: e.id, title: e.name, badges: [typeBadge(kind)], chips: chips };
}

function timelineResult(t) {
  var chip = { chapterNumber: t.chapterNumber, chapterId: t.chapterId };
  return { key: 'tl:' + t.id, id: t.id, title: t.title, badges: [typeBadge('timeline')], chips: [chip] };
}

// ── Rendering ──────────────────────────────────────────────────────────────
function renderResults(results) {
  var el = document.getElementById('results');

  if (!results.length) {
    el.innerHTML = '';
    return;
  }

  var frag = document.createDocumentFragment();
  var lbl  = document.createElement('div');
  lbl.className = 'count-label';
  lbl.textContent = results.length + ' result' + (results.length === 1 ? '' : 's');
  frag.appendChild(lbl);

  results.forEach(function(r) {
    frag.appendChild(buildRow(r));
  });

  el.innerHTML = '';
  el.appendChild(frag);
}

function buildRow(r) {
  var row = document.createElement('div');
  row.className = 'result-row';

  var title = document.createElement('div');
  title.className = 'result-title';
  title.textContent = r.title;
  title.title = r.title;
  row.appendChild(title);

  var badgeWrap = document.createElement('div');
  badgeWrap.style.display = 'flex';
  badgeWrap.style.gap = '3px';
  badgeWrap.style.flexShrink = '0';
  r.badges.forEach(function(b) { badgeWrap.appendChild(b); });
  row.appendChild(badgeWrap);

  row.appendChild(buildChips(r.key, r.id, r.chips));

  return row;
}

function buildChips(key, sourceId, chips) {
  var wrap = document.createElement('div');
  wrap.className = 'chips';

  var limit   = chipLimits[key] || CHIP_PAGE;
  var visible = chips.slice(0, limit);
  var hidden  = chips.length - visible.length;

  visible.forEach(function(c) {
    var chInfo = DATA.chapterMap[c.chapterId];
    if (!chInfo) return;

    var ref = DATA.reference.find(function(r) {
      return r.sourceId === sourceId && r.chapterNumber === c.chapterNumber;
    });

    var chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = 'ch.' + c.chapterNumber;
    chip.title = chInfo.title || ('Chapter ' + c.chapterNumber);
    chip.onclick = (function(fp, rt, ct) {
      return function() {
        vscode.postMessage({ command: 'navigate', filePath: fp, referenceText: rt, title: ct });
      };
    })(chInfo.filePath, ref ? ref.text : undefined, chInfo.title);

    wrap.appendChild(chip);
  });

  if (hidden > 0) {
    var show = Math.min(CHIP_PAGE, hidden);
    var btn  = document.createElement('button');
    btn.className = 'more-btn';
    btn.textContent = '+' + hidden + ' more';
    btn.onclick = (function(k) {
      return function() {
        chipLimits[k] = (chipLimits[k] || CHIP_PAGE) + CHIP_PAGE;
        if (mode === 'search') {
          doSearch(document.getElementById('search-input').value.trim().toLowerCase());
        } else {
          renderBrowse();
        }
      };
    })(key);
    wrap.appendChild(btn);
  }

  return wrap;
}

// ── Signals ────────────────────────────────────────────────────────────────
function renderSignals() {
  var el = document.getElementById('results');
  el.innerHTML = '';

  var defMap = {};
  DATA.signalDefs.forEach(function(s) { defMap[s.id] = s.description || ''; });

  var entries = Object.keys(DATA.signalIndex).map(function(id) {
    return { id: id, count: DATA.signalIndex[id].length, desc: defMap[id] || '' };
  }).filter(function(s) {
    return browseMatches(s.id, s.desc);
  }).sort(function(a, b) { return b.count - a.count; });

  if (!entries.length) {
    el.innerHTML = '<div class="no-data">No signals indexed yet.</div>';
    return;
  }

  var frag = document.createDocumentFragment();

  entries.forEach(function(sig) {
    var row = document.createElement('div');
    row.className = 'signal-row';

    var idSpan = document.createElement('span');
    idSpan.className = 'signal-id';
    idSpan.textContent = sig.id;

    var desc = document.createElement('span');
    desc.className = 'signal-desc';
    desc.textContent = sig.desc;

    var count = document.createElement('span');
    count.className = 'signal-count';
    count.textContent = sig.count + 'x';

    row.appendChild(idSpan);
    row.appendChild(desc);
    row.appendChild(count);

    row.onclick = (function(sigId) {
      return function() {
        expandedSig = expandedSig === sigId ? null : sigId;
        renderSignals();
      };
    })(sig.id);

    frag.appendChild(row);

    if (expandedSig === sig.id) {
      frag.appendChild(buildSignalSubList(sig.id));
    }
  });

  el.appendChild(frag);
}

function buildSignalSubList(sigId) {
  var sub = document.createElement('div');
  sub.className = 'sub-list';

  var entries = DATA.signalIndex[sigId] || [];

  // Build lookup maps for cross-referencing
  var threadMap = {};
  DATA.threads.forEach(function(t) { threadMap[t.id] = t; });
  var contMap = {};
  DATA.continuity.forEach(function(c) { contMap[c.id] = c; });
  var tlMap = {};
  DATA.timeline.forEach(function(t) { tlMap[t.id] = t; });

  // Group by source type
  var byType = { thread: [], continuity: [], timeline: [] };
  entries.forEach(function(e) {
    if (byType[e.sourceType]) byType[e.sourceType].push(e);
  });

  ['thread', 'continuity', 'timeline'].forEach(function(srcType) {
    var group = byType[srcType];
    if (!group.length) return;

    // Deduplicate by sourceId (same entity may appear multiple times)
    var seen = {};
    group.forEach(function(e) {
      if (!seen[e.sourceId]) seen[e.sourceId] = [];
      seen[e.sourceId].push(e.chapterNumber);
    });

    Object.keys(seen).forEach(function(srcId) {
      var entity = srcType === 'thread' ? threadMap[srcId]
                 : srcType === 'continuity' ? contMap[srcId]
                 : tlMap[srcId];
      if (!entity) return;

      var chNums = seen[srcId];
      var title  = entity.title || entity.name || srcId;

      var row = document.createElement('div');
      row.className = 'sub-row';

      var badge = typeBadge(srcType);
      row.appendChild(badge);

      var titleEl = document.createElement('span');
      titleEl.style.fontSize = '12px';
      titleEl.style.flex = '1';
      titleEl.style.overflow = 'hidden';
      titleEl.style.textOverflow = 'ellipsis';
      titleEl.style.whiteSpace = 'nowrap';
      titleEl.textContent = title;
      row.appendChild(titleEl);

      // Build chips for this signal+entity occurrence
      var chipsWrap = document.createElement('div');
      chipsWrap.className = 'chips';

      var key     = 'sig:' + sigId + ':' + srcId;
      var limit   = chipLimits[key] || CHIP_PAGE;
      var visible = chNums.slice(0, limit);
      var hidden  = chNums.length - visible.length;

      // Map chapterNumber -> chapterId (via appearances/mentions)
      var numToId = {};
      var appsArr = entity.appearances || entity.mentions || [];
      appsArr.forEach(function(a) { numToId[a.chapterNumber] = a.chapterId; });

      visible.forEach(function(chNum) {
        var chId   = numToId[chNum];
        var chInfo = chId ? DATA.chapterMap[chId] : null;
        if (!chInfo) return;

        var ref = DATA.reference.find(function(r) {
          return r.sourceId === srcId && r.chapterNumber === chNum;
        });

        var chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = 'ch.' + chNum;
        chip.onclick = (function(fp, rt, ct) {
          return function() {
            vscode.postMessage({ command: 'navigate', filePath: fp, referenceText: rt, title: ct });
          };
        })(chInfo.filePath, ref ? ref.text : undefined, chInfo.title);
        chipsWrap.appendChild(chip);
      });

      if (hidden > 0) {
        var btn = document.createElement('button');
        btn.className = 'more-btn';
        btn.textContent = '+' + hidden + ' more';
        btn.onclick = (function(k) {
          return function(ev) {
            ev.stopPropagation();
            chipLimits[k] = (chipLimits[k] || CHIP_PAGE) + CHIP_PAGE;
            renderSignals();
          };
        })(key);
        chipsWrap.appendChild(btn);
      }

      row.appendChild(chipsWrap);
      sub.appendChild(row);
    });
  });

  return sub;
}

// ── Badge helpers ──────────────────────────────────────────────────────────
function typeBadge(type) {
  var el = document.createElement('span');
  el.className = 'badge badge-' + type;
  el.textContent = type;
  return el;
}

function statusBadge(status) {
  var el = document.createElement('span');
  el.className = 'badge badge-' + status;
  el.textContent = status;
  return el;
}

// ── Init ───────────────────────────────────────────────────────────────────
document.getElementById('search-input').focus();
</script>
</body>
</html>`;
}
