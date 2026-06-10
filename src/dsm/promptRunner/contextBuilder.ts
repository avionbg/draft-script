import * as fs   from 'fs';
import * as path from 'path';
import {
  ChapterAnalysis, ChapterOverview, CharacterIndexItem, ThreadIndexItem, TimelineIndexItem,
  ContinuityIndexItem, ReferenceIndexItem, SignalIndexEntry, Signal,
} from '../draftScriptTypes';
import { isCurrentAnalysisSchema, normalizeAnalysis } from '../analysisStore';
import { PromptContextBlockId, PromptDefinition, PromptRunContext, RenderedContextBlock, VisibilityMode } from './types';

const INDEXES_DIR = path.join('.draft-script', 'indexes');
const CANON_DIR   = path.join('.draft-script', 'canon');
const ANALYSIS_CHAPTERS_DIR = path.join('.draft-script', 'analysis', 'chapters');

function readJson<T>(filePath: string): T | null {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T; }
  catch { return null; }
}

// ─── Visibility predicate ─────────────────────────────────────────────────────
//
// Returns a function that tests whether a chapter number falls inside the
// visibility horizon. Applied to EVERY row, appearance, mention, and occurrence
// so that all derived fields (lastSeenChapter, count, description) are computed
// from the visible window only — not from global index state.

export function visiblePredicate(mode: VisibilityMode, current: number): (ch: number) => boolean {
  switch (mode) {
    case 'upToChapter':        return ch => ch <= current;
    case 'previousChapters':   return ch => ch < current;
    case 'currentChapterOnly': return ch => ch === current;
    default:                   return () => true;
  }
}

function defaultContextIds(scope: string): PromptContextBlockId[] {
  switch (scope) {
    case 'selection':  return ['selectedText', 'chapterMeta'];
    case 'sentence':   return [];
    case 'chapter':    return ['chapterText', 'chapterMeta', 'overview', 'characters', 'activeThreads', 'activeContinuity', 'signals'];
    case 'manuscript': return ['characters', 'locations', 'objects', 'groups', 'activeThreads', 'activeContinuity', 'timeline', 'signals'];
    default:           return ['chapterText', 'chapterMeta', 'characters', 'activeThreads'];
  }
}

// Internal type: block + optional IDs for cross-referencing
interface BlockResult {
  block:    RenderedContextBlock;
  rawIds?:  string[];
}

interface Bctx {
  indexesDir:       string;
  canonDir:         string;
  limits:           NonNullable<PromptDefinition['limits']>;
  dormantThreshold: number;
  currentChapter:   number;
  isVisible:        (ch: number) => boolean;
  ctx:              PromptRunContext;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function buildContextBlocks(def: PromptDefinition, ctx: PromptRunContext): RenderedContextBlock[] {
  const indexesDir       = path.join(ctx.rootFolder, INDEXES_DIR);
  const canonDir         = path.join(ctx.rootFolder, CANON_DIR);
  const limits           = def.limits ?? {};
  const dormantThreshold = limits.dormantThreshold ?? 10;
  const currentChapter   = ctx.chapterNumber ?? 9999;
  const ids              = def.context ?? defaultContextIds(def.scope);

  const visibility = def.visibility ?? 'all';
  if (visibility !== 'all' && ctx.chapterNumber == null) {
    console.warn(`[PromptRunner] visibility="${visibility}" requires a resolved chapter number but none was found — filtering disabled. Check that the chapter file is in chapters.json.`);
  }

  const isVisible = visiblePredicate(visibility, currentChapter);
  const bctx: Bctx = { indexesDir, canonDir, limits, dormantThreshold, currentChapter, isVisible, ctx };

  const blocks: RenderedContextBlock[] = [];
  const threadIds: string[]            = [];
  const continuityIds: string[]        = [];

  for (const id of ids) {
    if (id === 'references') continue; // built in second pass

    const result = buildBlock(id, bctx);
    if (!result) continue;

    if (id === 'activeThreads' || id === 'dormantThreads') threadIds.push(...(result.rawIds ?? []));
    if (id === 'activeContinuity')                         continuityIds.push(...(result.rawIds ?? []));

    blocks.push(result.block);
  }

  if (ids.includes('references')) {
    const ref = buildReferencesBlock(bctx, threadIds, continuityIds);
    if (ref) blocks.push(ref);
  }

  return blocks;
}

// ─── Per-block builders ───────────────────────────────────────────────────────

function buildBlock(id: PromptContextBlockId, bctx: Bctx): BlockResult | null {
  const { indexesDir, canonDir, limits, dormantThreshold, currentChapter, isVisible, ctx } = bctx;

  switch (id) {

    // ─── Inline text ─────────────────────────────────────────────────────────

    case 'selectedText': {
      if (!ctx.selectedText?.trim()) return null;
      return { block: { id, heading: 'Selected Text', content: ctx.selectedText } };
    }
    case 'chapterText': {
      if (!ctx.chapterText?.trim()) return null;
      return { block: { id, heading: 'Chapter Text', content: ctx.chapterText } };
    }
    case 'chapterMeta': {
      if (!ctx.chapterId) return null;
      const lines: string[] = [];
      if (ctx.chapterNumber != null) lines.push(`Chapter: ${ctx.chapterNumber}`);
      if (ctx.chapterTitle)          lines.push(`Title: ${ctx.chapterTitle}`);
      if (ctx.chapterPath)           lines.push(`File: ${path.basename(ctx.chapterPath)}`);
      return lines.length ? { block: { id, heading: 'Chapter Info', content: lines.join('\n') } } : null;
    }
    case 'chapterSummary':
      return null; // v1: not implemented
    case 'overview':
      return buildOverviewBlock(bctx, 0, 'Chapter Overview', id);
    case 'previousChapterOverview':
      return buildOverviewBlock(bctx, -1, 'Previous Chapter Overview', id);
    case 'nextChapterOverview':
      return buildOverviewBlock(bctx, 1, 'Next Chapter Overview', id);

    // ─── Entities ────────────────────────────────────────────────────────────
    //
    // For each entity, filter its appearances array to the visible window first.
    // Include the entity only if it has at least one visible appearance.
    // Compute lastSeenChapter and appearanceCount from visible appearances only.

    case 'characters': {
      const items = readJson<CharacterIndexItem[]>(path.join(indexesDir, 'characters.json'));
      if (!items?.length) return null;
      type Row = { e: CharacterIndexItem; visApps: CharacterIndexItem['appearances'] };
      const rows: Row[] = [];
      for (const e of items) {
        const visApps = e.appearances.filter(a => isVisible(a.chapterNumber));
        if (visApps.length) rows.push({ e, visApps });
      }
      if (!rows.length) return null;
      const content = rows.slice(0, limits.characters ?? 50).map(({ e, visApps }) => {
        const lastSeen = Math.max(...visApps.map(a => a.chapterNumber));
        const count    = visApps.length;
        const desc     = e.canonDescription ?? e.generatedDescriptions.at(-1)?.description ?? '';
        return `- **${e.name}** (last seen Ch.${lastSeen}, ${count}x)${desc ? ': ' + desc : ''}`;
      }).join('\n');
      return { block: { id, heading: 'Characters', content } };
    }

    case 'locations': {
      const items = readJson<CharacterIndexItem[]>(path.join(indexesDir, 'locations.json'));
      if (!items?.length) return null;
      type Row = { e: CharacterIndexItem; visApps: CharacterIndexItem['appearances'] };
      const rows: Row[] = [];
      for (const e of items) {
        const visApps = e.appearances.filter(a => isVisible(a.chapterNumber));
        if (visApps.length) rows.push({ e, visApps });
      }
      if (!rows.length) return null;
      const content = rows.slice(0, limits.locations ?? 30).map(({ e, visApps }) =>
        `- **${e.name}** (${visApps.length}x)${e.canonDescription ? ': ' + e.canonDescription : ''}`
      ).join('\n');
      return { block: { id, heading: 'Locations', content } };
    }

    case 'objects': {
      const items = readJson<CharacterIndexItem[]>(path.join(indexesDir, 'objects.json'));
      if (!items?.length) return null;
      type Row = { e: CharacterIndexItem; visApps: CharacterIndexItem['appearances'] };
      const rows: Row[] = [];
      for (const e of items) {
        const visApps = e.appearances.filter(a => isVisible(a.chapterNumber));
        if (visApps.length) rows.push({ e, visApps });
      }
      if (!rows.length) return null;
      const content = rows.slice(0, limits.objects ?? 20).map(({ e, visApps }) =>
        `- **${e.name}** (${visApps.length}x)${e.canonDescription ? ': ' + e.canonDescription : ''}`
      ).join('\n');
      return { block: { id, heading: 'Objects', content } };
    }

    case 'groups': {
      const items = readJson<CharacterIndexItem[]>(path.join(indexesDir, 'groups.json'));
      if (!items?.length) return null;
      type Row = { e: CharacterIndexItem; visApps: CharacterIndexItem['appearances'] };
      const rows: Row[] = [];
      for (const e of items) {
        const visApps = e.appearances.filter(a => isVisible(a.chapterNumber));
        if (visApps.length) rows.push({ e, visApps });
      }
      if (!rows.length) return null;
      const content = rows.slice(0, limits.groups ?? 20).map(({ e, visApps }) =>
        `- **${e.name}** (${visApps.length}x)${e.canonDescription ? ': ' + e.canonDescription : ''}`
      ).join('\n');
      return { block: { id, heading: 'Groups / Factions', content } };
    }

    // ─── Threads ─────────────────────────────────────────────────────────────
    //
    // Filter appearances to the visibility window, derive lastSeen from filtered
    // appearances, then apply the active/dormant threshold on that derived value.

    case 'activeThreads': {
      const items = readJson<ThreadIndexItem[]>(path.join(indexesDir, 'threads.json'));
      if (!items?.length) return null;
      type Row = { t: ThreadIndexItem; visApps: ThreadIndexItem['appearances']; lastSeen: number };
      const rows: Row[] = [];
      for (const t of items) {
        if (t.status !== 'open' && t.status !== 'active') continue;
        const visApps = t.appearances.filter(a => isVisible(a.chapterNumber));
        if (!visApps.length) continue;
        rows.push({ t, visApps, lastSeen: Math.max(...visApps.map(a => a.chapterNumber)) });
      }
      const active = rows
        .filter(r => currentChapter - r.lastSeen <= dormantThreshold)
        .slice(0, limits.threads ?? 30);
      if (!active.length) return null;
      const content = active.map(({ t, visApps }) => {
        const last = visApps.at(-1);
        return `- **[${t.type}]** ${t.title}${last ? ` (Ch.${last.chapterNumber}: ${last.description})` : ''}`;
      }).join('\n');
      return { block: { id, heading: 'Active Threads', content }, rawIds: active.map(r => r.t.id) };
    }

    case 'dormantThreads': {
      const items = readJson<ThreadIndexItem[]>(path.join(indexesDir, 'threads.json'));
      if (!items?.length) return null;
      type Row = { t: ThreadIndexItem; lastSeen: number };
      const rows: Row[] = [];
      for (const t of items) {
        if (t.status !== 'open' && t.status !== 'active') continue;
        const visApps = t.appearances.filter(a => isVisible(a.chapterNumber));
        if (!visApps.length) continue;
        rows.push({ t, lastSeen: Math.max(...visApps.map(a => a.chapterNumber)) });
      }
      const dormant = rows
        .filter(r => currentChapter - r.lastSeen > dormantThreshold)
        .slice(0, limits.threads ?? 20);
      if (!dormant.length) return null;
      const content = dormant.map(({ t, lastSeen }) =>
        `- **[${t.type}]** ${t.title} (last seen Ch.${lastSeen})`
      ).join('\n');
      return { block: { id, heading: 'Dormant Threads', content }, rawIds: dormant.map(r => r.t.id) };
    }

    // ─── Continuity ──────────────────────────────────────────────────────────
    //
    // Filter mentions to the visibility window. Include item if it has any
    // visible mentions. Display last visible mention — not the global last.

    case 'activeContinuity': {
      const items = readJson<ContinuityIndexItem[]>(path.join(indexesDir, 'continuity.json'));
      if (!items?.length) return null;
      type Row = { n: ContinuityIndexItem; visMentions: ContinuityIndexItem['mentions'] };
      const rows: Row[] = [];
      for (const n of items) {
        if (n.status !== 'active') continue;
        const visMentions = n.mentions.filter(m => isVisible(m.chapterNumber));
        if (!visMentions.length) continue;
        rows.push({ n, visMentions });
      }
      const active = rows.slice(0, limits.continuity ?? 30);
      if (!active.length) return null;
      const content = active.map(({ n, visMentions }) => {
        const last = visMentions.at(-1);
        return `- **[${n.type}]** ${n.title}${last ? ` (Ch.${last.chapterNumber}: ${last.description})` : ''}`;
      }).join('\n');
      return { block: { id, heading: 'Active Continuity Items', content }, rawIds: active.map(r => r.n.id) };
    }

    // ─── Signals ─────────────────────────────────────────────────────────────
    //
    // Filter each signal's occurrence list to the visible window, recompute
    // the count from the filtered list. Global project totals are never shown
    // when visibility is not 'all'.

    case 'signals': {
      const index = readJson<Record<string, SignalIndexEntry[]>>(path.join(indexesDir, 'signals.json'));
      if (!index) return null;
      const defs   = readJson<Signal[]>(path.join(canonDir, 'signals.json')) ?? [];
      const defMap = new Map(defs.map(s => [s.id, s.description]));
      const entries = Object.entries(index)
        .map(([sigId, occ]) => ({
          sigId,
          count: occ.filter(o => isVisible(o.chapterNumber)).length,
          desc:  defMap.get(sigId) ?? '',
        }))
        .filter(e => e.count > 0)
        .sort((a, b) => b.count - a.count);
      if (!entries.length) return null;
      const content = entries.map(e =>
        `- **${e.sigId}** (${e.count}x)${e.desc ? ': ' + e.desc : ''}`
      ).join('\n');
      return { block: { id, heading: 'Signal Frequency', content } };
    }

    // ─── Timeline ────────────────────────────────────────────────────────────

    case 'timeline': {
      const items = readJson<TimelineIndexItem[]>(path.join(indexesDir, 'timeline.json'));
      if (!items?.length) return null;
      const visible = items.filter(e => isVisible(e.chapterNumber));
      if (!visible.length) return null;
      const capped  = visible.slice(-(limits.timeline ?? 50));
      const content = capped.map(e =>
        `- Ch.${e.chapterNumber}${e.order != null ? `.${e.order}` : ''}: **${e.title}**${e.description ? ' — ' + e.description : ''}`
      ).join('\n');
      return { block: { id, heading: 'Timeline', content } };
    }

    case 'references':
      return null; // handled in second pass

    // ─── Project instructions ─────────────────────────────────────────────────

    case 'projectInstructions': {
      for (const name of ['project.md', 'instructions.md']) {
        const p = path.join(ctx.rootFolder, '.draft-script', name);
        if (fs.existsSync(p)) {
          const text = fs.readFileSync(p, 'utf-8').trim();
          if (text) return { block: { id, heading: 'Project Instructions', content: text } };
        }
      }
      return null;
    }

    default:
      return null;
  }
}

// ─── References (second pass — enriched with thread/continuity IDs) ───────────

function buildOverviewBlock(
  bctx: Bctx,
  chapterOffset: number,
  heading: string,
  id: PromptContextBlockId,
): BlockResult | null {
  const analysis = readChapterAnalysisForOffset(bctx.ctx, chapterOffset);
  if (!analysis) return null;
  const content = renderOverview(analysis.overview);
  return content ? { block: { id, heading, content } } : null;
}

function readChapterAnalysisForOffset(ctx: PromptRunContext, chapterOffset: number): ChapterAnalysis | null {
  if (ctx.chapterNumber == null) return null;
  const chapterNumber = ctx.chapterNumber + chapterOffset;
  if (chapterNumber < 1) return null;
  const chapterId = `chapter-${String(chapterNumber).padStart(4, '0')}`;
  const filePath = path.join(ctx.rootFolder, ANALYSIS_CHAPTERS_DIR, `${chapterId}.json`);
  const raw = readJson<unknown>(filePath);
  if (!isCurrentAnalysisSchema(raw)) return null;
  return normalizeAnalysis(raw);
}

function renderOverview(overview: ChapterOverview): string {
  const lines: string[] = [];
  if (overview.purpose) lines.push(`Purpose: ${overview.purpose}`);
  if (overview.emotionalBeat) lines.push(`Emotional Beat: ${overview.emotionalBeat}`);
  lines.push(`Function: ${overview.chapterFunction}`);
  appendList(lines, 'Summary', overview.summary);
  appendList(lines, 'Setups', overview.setups);
  appendList(lines, 'Payoffs', overview.payoffs);
  appendList(lines, 'Human Focus', overview.humanFocus);
  appendList(lines, 'Technical Focus', overview.technicalFocus);
  appendList(lines, 'Risk Flags', overview.riskFlags);
  if (overview.bookImpact) lines.push(`Book Impact: ${overview.bookImpact}`);
  return lines.join('\n');
}

function appendList(lines: string[], label: string, items: string[]): void {
  if (!items.length) return;
  lines.push(`${label}:`);
  for (const item of items) lines.push(`- ${item}`);
}

function buildReferencesBlock(
  bctx: Bctx,
  includedThreadIds: string[],
  includedContinuityIds: string[],
): RenderedContextBlock | null {
  const { indexesDir, limits, isVisible, ctx } = bctx;
  const items = readJson<ReferenceIndexItem[]>(path.join(indexesDir, 'reference.json'));
  if (!items?.length) return null;

  const threadSet     = new Set(includedThreadIds);
  const continuitySet = new Set(includedContinuityIds);

  const filtered = items.filter(r =>
    isVisible(r.chapterNumber) && (
      (ctx.chapterId && r.chapterId === ctx.chapterId) ||
      (r.sourceType === 'thread'     && threadSet.has(r.sourceId)) ||
      (r.sourceType === 'continuity' && continuitySet.has(r.sourceId))
    )
  );

  if (!filtered.length) return null;

  filtered.sort((a, b) =>
    a.chapterNumber !== b.chapterNumber ? a.chapterNumber - b.chapterNumber :
    a.sourceType    !== b.sourceType    ? a.sourceType.localeCompare(b.sourceType) :
    a.sourceId.localeCompare(b.sourceId)
  );

  const capped  = filtered.slice(0, limits.references ?? 30);
  const content = capped.map(r =>
    `- [${r.sourceType}/${r.sourceId}] Ch.${r.chapterNumber} (${r.kind}): "${r.text}"`
  ).join('\n');

  return { id: 'references', heading: 'References', content };
}
