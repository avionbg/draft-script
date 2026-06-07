import * as fs   from 'fs';
import * as path from 'path';
import { SourceType } from './types';
import type {
  ThreadIndexItem,
  CharacterIndexItem,
  ContinuityIndexItem,
  TimelineIndexItem,
  SignalIndexEntry,
  ReferenceIndexItem,
  TimeIndexItem,
} from '../draftScriptTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

function indexesDir(root: string): string {
  return path.join(root, '.draft-script', 'indexes');
}

interface ChapterMapEntry { id: string; number: number; title: string; filePath: string; }

function loadChapterMeta(root: string): { total: number; byNumber: Map<number, ChapterMapEntry> } {
  const raw = readJson(path.join(indexesDir(root), 'chapters.json'));
  if (!Array.isArray(raw)) return { total: 0, byNumber: new Map() };
  const byNumber = new Map<number, ChapterMapEntry>();
  for (const c of raw as ChapterMapEntry[]) byNumber.set(c.number, c);
  return { total: raw.length, byNumber };
}

// Attach _fp / _title shadow fields for any chapter-number field so link rendering works.
function chapterLink(num: number, byNumber: Map<number, ChapterMapEntry>): { fp: string; title: string } {
  const e = byNumber.get(num);
  return { fp: e?.filePath ?? '', title: e?.title ?? '' };
}


// key: "sourceType:sourceId:chapterId"  →  first reference text for that combo
function loadReferenceMap(root: string): Map<string, string> {
  const dir = indexesDir(root);
  const raw = readJson(path.join(dir, 'reference.json'));
  const map = new Map<string, string>();
  if (!Array.isArray(raw)) return map;
  for (const item of raw as ReferenceIndexItem[]) {
    const key = `${item.sourceType}:${item.sourceId}:${item.chapterId}`;
    if (!map.has(key)) map.set(key, item.text);
  }
  return map;
}

function increment(map: Map<number, number>, chapterNumber: number | undefined): void {
  if (chapterNumber == null) return;
  map.set(chapterNumber, (map.get(chapterNumber) ?? 0) + 1);
}

function chapterDensityRows(root: string, total: number, byNumber: Map<number, ChapterMapEntry>): Record<string, unknown>[] {
  const dir = indexesDir(root);
  const threads = readJson(path.join(dir, 'threads.json'));
  const continuity = readJson(path.join(dir, 'continuity.json'));
  const timeline = readJson(path.join(dir, 'timeline.json'));
  const references = readJson(path.join(dir, 'reference.json'));
  const signals = readJson(path.join(dir, 'signals.json'));

  const threadCounts = new Map<number, number>();
  const continuityCounts = new Map<number, number>();
  const timelineCounts = new Map<number, number>();
  const referenceCounts = new Map<number, number>();
  const signalCounts = new Map<number, number>();

  if (Array.isArray(threads)) {
    for (const thread of threads as ThreadIndexItem[]) {
      for (const app of thread.appearances ?? []) increment(threadCounts, app.chapterNumber);
    }
  }
  if (Array.isArray(continuity)) {
    for (const item of continuity as ContinuityIndexItem[]) {
      for (const mention of item.mentions ?? []) increment(continuityCounts, mention.chapterNumber);
    }
  }
  if (Array.isArray(timeline)) {
    for (const event of timeline as TimelineIndexItem[]) increment(timelineCounts, event.chapterNumber);
  }
  if (Array.isArray(references)) {
    for (const ref of references as ReferenceIndexItem[]) increment(referenceCounts, ref.chapterNumber);
  }
  if (signals && typeof signals === 'object' && !Array.isArray(signals)) {
    for (const entries of Object.values(signals as Record<string, SignalIndexEntry[]>)) {
      for (const entry of entries) increment(signalCounts, entry.chapterNumber);
    }
  }

  return [...byNumber.values()]
    .sort((a, b) => a.number - b.number)
    .map(ch => ({
      ...ch,
      chapterNumber: ch.number,
      threadCount: threadCounts.get(ch.number) ?? 0,
      continuityCount: continuityCounts.get(ch.number) ?? 0,
      timelineCount: timelineCounts.get(ch.number) ?? 0,
      referenceCount: referenceCounts.get(ch.number) ?? 0,
      signalCount: signalCounts.get(ch.number) ?? 0,
      totalDensity:
        (threadCounts.get(ch.number) ?? 0) +
        (continuityCounts.get(ch.number) ?? 0) +
        (timelineCounts.get(ch.number) ?? 0) +
        (signalCounts.get(ch.number) ?? 0),
      _chapterNumber_fp: ch.filePath,
      _chapterNumber_title: ch.title,
      _totalChapters: total,
    }));
}

// ---------------------------------------------------------------------------
// Enrichers — add computed fields for transform/filter use
// ---------------------------------------------------------------------------

function enrichEntity(
  item: CharacterIndexItem,
  sourceType: 'character' | 'location' | 'object' | 'group',
  total: number,
  ev: Map<string, string>,
  byNumber: Map<number, ChapterMapEntry>,
): Record<string, unknown> {
  const nums       = item.appearances.map(a => a.chapterNumber);
  const firstNum   = nums.length ? Math.min(...nums) : 0;
  const lastNum    = nums.length ? Math.max(...nums) : 0;
  const firstChId  = item.appearances.find(a => a.chapterNumber === firstNum)?.chapterId ?? '';
  const lastChId   = item.appearances.find(a => a.chapterNumber === lastNum)?.chapterId  ?? '';
  const first      = chapterLink(firstNum, byNumber);
  const last       = chapterLink(lastNum,  byNumber);
  return {
    ...item,
    firstSeenChapter:        firstNum,
    lastSeenChapter:         lastNum,
    appearanceCount:         nums.length,
    referenceText:           ev.get(`${sourceType}:${item.id}:${lastChId}`) ?? '',
    _firstSeenChapter_fp:    first.fp,
    _firstSeenChapter_title: first.title,
    _firstSeenChapter_ref:   ev.get(`${sourceType}:${item.id}:${firstChId}`) ?? '',
    _lastSeenChapter_fp:     last.fp,
    _lastSeenChapter_title:  last.title,
    _lastSeenChapter_ref:    ev.get(`${sourceType}:${item.id}:${lastChId}`) ?? '',
    _totalChapters:          total,
  };
}

function enrichThread(
  item: ThreadIndexItem,
  total: number,
  ev: Map<string, string>,
  byNumber: Map<number, ChapterMapEntry>,
): Record<string, unknown> {
  const nums     = item.appearances.map(a => a.chapterNumber);
  const firstNum = nums.length ? Math.min(...nums) : 0;
  const lastNum  = nums.length ? Math.max(...nums) : 0;
  const firstApp = item.appearances.find(a => a.chapterNumber === firstNum);
  const lastApp  = item.appearances.find(a => a.chapterNumber === lastNum);
  const first    = chapterLink(firstNum, byNumber);
  const last     = chapterLink(lastNum,  byNumber);
  const suggestedStatusLabel = item.suggestedStatus
    ? item.status === item.suggestedStatus ? item.suggestedStatus : `suggested ${item.suggestedStatus}`
    : '';
  const isCleanActive =
    (item.status === 'open' || item.status === 'active') &&
    item.needsReview !== true &&
    item.suggestedStatus !== 'resolved' &&
    item.suggestedStatus !== 'changed';
  return {
    ...item,
    firstSeenChapter:        firstNum,
    lastSeenChapter:         lastNum,
    appearanceCount:         nums.length,
    hasDuplicates:           (item.possibleDuplicates?.length ?? 0) > 0,
    isCleanActive,
    suggestedStatusLabel,
    referenceText:           lastApp ? ev.get(`thread:${item.id}:${lastApp.chapterId}`) ?? '' : '',
    _firstSeenChapter_fp:    first.fp,
    _firstSeenChapter_title: first.title,
    _firstSeenChapter_ref:   firstApp ? ev.get(`thread:${item.id}:${firstApp.chapterId}`) ?? '' : '',
    _lastSeenChapter_fp:     last.fp,
    _lastSeenChapter_title:  last.title,
    _lastSeenChapter_ref:    lastApp  ? ev.get(`thread:${item.id}:${lastApp.chapterId}`)  ?? '' : '',
    _totalChapters:          total,
  };
}

function enrichContinuity(
  item: ContinuityIndexItem,
  total: number,
  ev: Map<string, string>,
  byNumber: Map<number, ChapterMapEntry>,
): Record<string, unknown> {
  const firstNum = item.firstSeen.chapterNumber;
  const lastNum  = item.lastSeen.chapterNumber;
  const first    = chapterLink(firstNum, byNumber);
  const last     = chapterLink(lastNum,  byNumber);
  return {
    ...item,
    firstSeenChapter:        firstNum,
    lastSeenChapter:         lastNum,
    appearanceCount:         item.mentions.length,
    referenceText:           ev.get(`continuity:${item.id}:${item.lastSeen.chapterId}`) ?? '',
    _firstSeenChapter_fp:    first.fp,
    _firstSeenChapter_title: first.title,
    _firstSeenChapter_ref:   ev.get(`continuity:${item.id}:${item.firstSeen.chapterId}`) ?? '',
    _lastSeenChapter_fp:     last.fp,
    _lastSeenChapter_title:  last.title,
    _lastSeenChapter_ref:    ev.get(`continuity:${item.id}:${item.lastSeen.chapterId}`)  ?? '',
    _totalChapters:          total,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const ENTITY_SOURCE_TYPES: Record<string, 'character' | 'location' | 'object' | 'group'> = {
  characters: 'character',
  locations:  'location',
  objects:    'object',
  groups:     'group',
};

export function loadSource(rootPath: string, source: SourceType): Record<string, unknown>[] {
  const dir              = indexesDir(rootPath);
  const { total, byNumber } = loadChapterMeta(rootPath);
  const ev               = loadReferenceMap(rootPath);

  switch (source) {
    case 'chapters':
      return chapterDensityRows(rootPath, total, byNumber);

    case 'characters':
    case 'locations':
    case 'objects':
    case 'groups': {
      const raw        = readJson(path.join(dir, `${source}.json`));
      const sourceType = ENTITY_SOURCE_TYPES[source];
      if (!Array.isArray(raw)) return [];
      return (raw as CharacterIndexItem[]).map(i => enrichEntity(i, sourceType, total, ev, byNumber));
    }

    case 'threads': {
      const raw = readJson(path.join(dir, 'threads.json'));
      if (!Array.isArray(raw)) return [];
      return (raw as ThreadIndexItem[]).map(i => enrichThread(i, total, ev, byNumber));
    }

    case 'continuity': {
      const raw = readJson(path.join(dir, 'continuity.json'));
      if (!Array.isArray(raw)) return [];
      return (raw as ContinuityIndexItem[]).map(i => enrichContinuity(i, total, ev, byNumber));
    }

    case 'timeline': {
      const raw = readJson(path.join(dir, 'timeline.json'));
      if (!Array.isArray(raw)) return [];
      return (raw as TimelineIndexItem[]).map(i => {
        const ch = chapterLink(i.chapterNumber, byNumber);
        return {
          ...i,
          referenceText:        ev.get(`timeline:${i.id}:${i.chapterId}`) ?? '',
          _chapterNumber_fp:    ch.fp,
          _chapterNumber_title: ch.title,
          _chapterNumber_ref:   ev.get(`timeline:${i.id}:${i.chapterId}`) ?? '',
          _totalChapters:       total,
        };
      });
    }

    case 'signals': {
      const raw = readJson(path.join(dir, 'signals.json'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      return Object.entries(raw as Record<string, SignalIndexEntry[]>).map(([id, entries]) => ({
        id,
        count:          entries.length,
        entries,
        _totalChapters: total,
      }));
    }

    case 'timeIndex': {
      const raw = readJson(path.join(dir, 'timeIndex.json'));
      if (!Array.isArray(raw)) return [];
      return (raw as TimeIndexItem[]).map(i => {
        // currentSeasonValue: chapterAnchor → endSeason → startSeason (fallback chain)
        const anchor = i.chapterAnchor ?? i.endSeason ?? i.startSeason;
        return {
          ...i,
          startSeasonValue:      i.startSeason?.value      ?? '',
          startSeasonConfidence: i.startSeason?.confidence ?? 0,
          endSeasonValue:        i.endSeason?.value        ?? '',
          endSeasonConfidence:   i.endSeason?.confidence   ?? 0,
          chapterAnchorValue:    i.chapterAnchor?.value    ?? '',
          chapterAnchorConfidence: i.chapterAnchor?.confidence ?? 0,
          currentSeasonValue:    anchor?.value ?? '',
          refCount:              i.references?.length      ?? 0,
          likelySceneDuration:   i.sceneDuration?.likelyDays            ?? null,
          likelyCoveredSpan:     i.coveredTimeSpan?.likelyDays          ?? null,
          likelyGap:             i.estimatedGapFromPrevious?.likelyDays ?? null,
          _totalChapters:        total,
        };
      });
    }

    default:
      return [];
  }
}
