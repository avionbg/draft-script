import * as fs   from 'fs';
import * as path from 'path';
import {
  ChapterAnalysis, ChapterEntity, ThreadStatus, ThreadUpdate,
  CharacterIndexItem, ThreadIndexItem, TimelineIndexItem, ContinuityIndexItem,
  SignalIndexEntry, ChapterMapItem, ReferenceIndexItem, TimeIndexItem,
} from './draftScriptTypes';
import { AnalysisStore } from './analysisStore';
import { CanonManager, normalizeId } from './canonManager';
import { OverrideStore } from './overrideStore';

const INDEXES_DIR = path.join('.draft-script', 'indexes');

export class IndexBuilder {
  private readonly indexesDir: string;

  constructor(
    private readonly rootFolder: string,
    private readonly store:      AnalysisStore,
    private readonly canon:      CanonManager,
    private readonly overrides?: OverrideStore,
  ) {
    this.indexesDir = path.join(rootFolder, INDEXES_DIR);
  }

  buildAll(): void {
    const chapters = this.store.readAll();
    this.buildEntityIndex('characters', chapters);
    this.buildEntityIndex('locations',  chapters);
    this.buildEntityIndex('objects',    chapters);
    this.buildEntityIndex('groups',     chapters);
    this.buildTimeline(chapters);
    this.buildThreads(chapters);
    this.buildContinuity(chapters);
    this.buildSignals(chapters);
    this.buildChapterMap(chapters);
    this.buildReference(chapters);
    this.buildTimeIndex(chapters);
  }

  // ---------------------------------------------------------------------------
  // Entity indexes (characters / locations / objects / groups)
  // ---------------------------------------------------------------------------

  private buildEntityIndex(
    category: 'characters' | 'locations' | 'objects' | 'groups',
    chapters: ChapterAnalysis[]
  ): void {
    const map      = new Map<string, CharacterIndexItem>();
    const canonOvrs = this.overrides ? this.overrides.readCanon(category) : {};

    for (const chapter of chapters) {
      const entities = chapter[category] as ChapterEntity[];
      for (const e of entities) {
        const key  = e.canonId ?? e.id;
        let   item = map.get(key);
        if (!item) {
          const canonEntry = e.canonId ? this.canon.findInCategory(category, e.name, e.aliases) : undefined;
          const canonOvr   = canonEntry ? (canonOvrs[canonEntry.id] ?? {}) : {};
          item = {
            id:                    key,
            name:                  canonOvr.title       ?? canonEntry?.name        ?? e.name,
            aliases:               canonOvr.aliases     ?? canonEntry?.aliases     ?? [...e.aliases],
            canonDescription:      canonOvr.description ?? canonEntry?.description,
            appearances:           [],
            generatedDescriptions: [],
          };
          map.set(key, item);
        }

        if (chapter.chapter.number != null) {
          item.appearances.push({
            chapterId:     chapter.chapter.id,
            chapterNumber: chapter.chapter.number,
            roleInChapter: e.roleInChapter,
            confidence:    e.confidence,
          });
        }

        if (e.description && chapter.chapter.number != null) {
          item.generatedDescriptions.push({
            chapterId:   chapter.chapter.id,
            description: e.description,
            confidence:  e.confidence,
          });
        }
      }
    }

    this.write(category, [...map.values()]);
  }

  // ---------------------------------------------------------------------------
  // Timeline
  // ---------------------------------------------------------------------------

  buildTimeline(chapters: ChapterAnalysis[]): void {
    const items: TimelineIndexItem[] = [];
    for (const chapter of chapters) {
      if (chapter.chapter.number == null) continue;
      for (const e of chapter.timelineEvents) {
        items.push({
          id:            e.id,
          title:         e.title,
          chapterId:     chapter.chapter.id,
          chapterNumber: chapter.chapter.number,
          order:         e.order,
          description:   e.description,
          confidence:    e.confidence,
          signals:       e.signals,
        });
      }
    }
    items.sort((a, b) =>
      a.chapterNumber !== b.chapterNumber
        ? a.chapterNumber - b.chapterNumber
        : (a.order ?? 999) - (b.order ?? 999)
    );
    this.write('timeline', items);
  }

  // ---------------------------------------------------------------------------
  // Threads
  // ---------------------------------------------------------------------------

  buildThreads(chapters: ChapterAnalysis[]): void {
    const map = new Map<string, ThreadIndexItem>();
    const titleToId = new Map<string, string>();
    const overrides = this.overrides ? this.overrides.readIndex('threads') : {};

    for (const chapter of chapters) {
      if (chapter.chapter.number == null) continue;
      for (const t of chapter.threads) {
        const normTitle = normalizeId(t.title);
        const key = map.has(t.id) ? t.id : titleToId.get(normTitle) ?? t.id;
        let item = map.get(key);
        if (!item) {
          item = createThreadIndexItem(t, chapter.chapter.number, chapter.chapter.title);
          map.set(key, item);
          titleToId.set(normTitle, key);
        } else {
          mergeThreadUpdate(item, t, chapter.chapter.number, chapter.chapter.title, Boolean(overrides[item.id]?.status));
        }

        const ovr = overrides[item.id];
        if (ovr?.title)  item.title  = ovr.title;
        if (ovr?.status && isThreadStatus(ovr.status)) item.status = ovr.status;

        if (t.parentThread) {
          const parentId = titleToId.get(normalizeId(t.parentThread));
          item.parentThread = parentId ?? t.parentThread;
        }

        item.appearances.push({
          chapterId:     chapter.chapter.id,
          chapterNumber: chapter.chapter.number,
          description:   t.description,
          confidence:    t.confidence,
          status:        t.status,
          updateType:    t.updateType,
          resolutionType: t.resolutionType,
          reference:     t.reference,
        });
      }
    }

    // Detect possible duplicates (Levenshtein ≤ 2 on normalized titles)
    const items = [...map.values()];
    for (const item of items) applyThreadOverride(item, overrides[item.id]);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (levenshtein(normalizeId(items[i].title), normalizeId(items[j].title)) <= 2) {
          items[i].possibleDuplicates = [...(items[i].possibleDuplicates ?? []), items[j].id];
          items[j].possibleDuplicates = [...(items[j].possibleDuplicates ?? []), items[i].id];
        }
      }
    }

    this.write('threads', items);
  }

  // ---------------------------------------------------------------------------
  // Continuity
  // ---------------------------------------------------------------------------

  buildContinuity(chapters: ChapterAnalysis[]): void {
    const map = new Map<string, ContinuityIndexItem>();

    for (const chapter of chapters) {
      if (chapter.chapter.number == null) continue;
      for (const n of chapter.continuityNotes) {
        let item = map.get(n.id);
        if (!item) {
          item = {
            id:        n.id,
            title:     n.title,
            type:      n.type,
            status:    n.status,
            firstSeen: { chapterId: chapter.chapter.id, chapterNumber: chapter.chapter.number },
            lastSeen:  { chapterId: chapter.chapter.id, chapterNumber: chapter.chapter.number },
            mentions:  [],
          };
          map.set(n.id, item);
        }
        // Update status and lastSeen
        item.status = n.status;
        item.lastSeen = { chapterId: chapter.chapter.id, chapterNumber: chapter.chapter.number };
        item.mentions.push({
          chapterId:     chapter.chapter.id,
          chapterNumber: chapter.chapter.number,
          description:   n.description,
          reference:     n.reference,
          confidence:    n.confidence,
        });
      }
    }

    this.write('continuity', [...map.values()]);
  }

  // ---------------------------------------------------------------------------
  // Signals index
  // ---------------------------------------------------------------------------

  buildSignals(chapters: ChapterAnalysis[]): void {
    const map = new Map<string, SignalIndexEntry[]>();

    for (const ch of chapters) {
      if (ch.chapter.number == null) continue;
      const num = ch.chapter.number;

      for (const t of ch.threads) {
        for (const sig of (t.signals ?? [])) {
          if (!map.has(sig)) map.set(sig, []);
          map.get(sig)!.push({ chapterNumber: num, sourceType: 'thread', sourceId: t.id });
        }
      }
      for (const e of ch.timelineEvents) {
        for (const sig of (e.signals ?? [])) {
          if (!map.has(sig)) map.set(sig, []);
          map.get(sig)!.push({ chapterNumber: num, sourceType: 'timeline', sourceId: e.id });
        }
      }
      for (const n of ch.continuityNotes) {
        for (const sig of (n.signals ?? [])) {
          if (!map.has(sig)) map.set(sig, []);
          map.get(sig)!.push({ chapterNumber: num, sourceType: 'continuity', sourceId: n.id });
        }
      }
    }

    const result: Record<string, SignalIndexEntry[]> = {};
    for (const [id, entries] of map) {
      result[id] = entries.sort((a, b) => a.chapterNumber - b.chapterNumber);
    }
    this.write('signals', result);
  }

  // ---------------------------------------------------------------------------
  // Chapter map (chapterId → filePath, used by canon editor for navigation)
  // ---------------------------------------------------------------------------

  private buildChapterMap(chapters: ChapterAnalysis[]): void {
    const items: ChapterMapItem[] = chapters
      .filter(ch => ch.chapter.number != null)
      .map(ch => ({
        id:       ch.chapter.id,
        number:   ch.chapter.number!,
        title:    ch.chapter.title,
        filePath: ch.chapter.filePath,
      }));
    this.write('chapters', items);
  }

  // ---------------------------------------------------------------------------
  // Reference index — flat list of all quoted/paraphrased text references
  // ---------------------------------------------------------------------------

  buildReference(chapters: ChapterAnalysis[]): void {
    const items: ReferenceIndexItem[] = [];

    const entityTypes: Array<{
      key: keyof Pick<ChapterAnalysis, 'characters' | 'locations' | 'objects' | 'groups'>;
      sourceType: ReferenceIndexItem['sourceType'];
      category:   string;
    }> = [
      { key: 'characters', sourceType: 'character', category: 'characters' },
      { key: 'locations',  sourceType: 'location',  category: 'locations'  },
      { key: 'objects',    sourceType: 'object',    category: 'objects'    },
      { key: 'groups',     sourceType: 'group',     category: 'groups'     },
    ];

    // Pre-load index overrides so merged source items use the target's id as sourceId
    const entityIdxOvrs: Record<string, Record<string, { canonId?: string }>> = {};
    for (const { category } of entityTypes) {
      entityIdxOvrs[category] = this.overrides ? this.overrides.readIndex(category) : {};
    }

    for (const ch of chapters) {
      if (ch.chapter.number == null) continue;
      const chapterId     = ch.chapter.id;
      const chapterNumber = ch.chapter.number;

      for (const e of ch.timelineEvents) {
        for (const ev of e.reference ?? []) {
          items.push({ sourceType: 'timeline', sourceId: e.id, chapterId, chapterNumber, text: ev.text, kind: ev.kind });
        }
      }
      for (const t of ch.threads) {
        for (const ev of t.reference ?? []) {
          items.push({ sourceType: 'thread', sourceId: t.id, chapterId, chapterNumber, text: ev.text, kind: ev.kind });
        }
      }
      for (const n of ch.continuityNotes) {
        for (const ev of n.reference ?? []) {
          items.push({ sourceType: 'continuity', sourceId: n.id, chapterId, chapterNumber, text: ev.text, kind: ev.kind });
        }
      }
      for (const { key, sourceType, category } of entityTypes) {
        const ovrs = entityIdxOvrs[category];
        for (const entity of ch[key] as ChapterEntity[]) {
          const baseId      = entity.canonId ?? entity.id;
          const effectiveId = ovrs[baseId]?.canonId ?? baseId;
          for (const ev of entity.reference ?? []) {
            items.push({ sourceType, sourceId: effectiveId, chapterId, chapterNumber, text: ev.text, kind: ev.kind });
          }
        }
      }
    }

    this.write('reference', items);
  }

  // ---------------------------------------------------------------------------
  // Time Index
  // ---------------------------------------------------------------------------

  buildTimeIndex(chapters: ChapterAnalysis[]): void {
    const items: TimeIndexItem[] = [];
    for (const ch of chapters) {
      if (ch.chapter.number == null || !ch.timeIndex) continue;
      items.push({
        chapterId:     ch.chapter.id,
        chapterNumber: ch.chapter.number,
        ...ch.timeIndex,
      });
    }
    this.write('timeIndex', items);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private write(name: string, data: unknown): void {
    fs.mkdirSync(this.indexesDir, { recursive: true });
    fs.writeFileSync(
      path.join(this.indexesDir, `${name}.json`),
      JSON.stringify(data, null, 2),
      'utf-8'
    );
  }
}

function createThreadIndexItem(t: ThreadUpdate, chapterNumber: number, chapterTitle?: string): ThreadIndexItem {
  const item: ThreadIndexItem = {
    id:          t.id,
    title:       t.title,
    type:        t.type,
    status:      t.status === 'resolved' || t.status === 'changed' ? 'open' : t.status,
    description: t.description,
    firstSeenChapter: chapterNumber,
    lastSeenChapter:  chapterNumber,
    parentThread:     t.parentThread,
    lastKnownState:   t.description || undefined,
    unresolvedQuestion: unresolvedQuestionFor(t, undefined),
    history:          [],
    lastUpdateType:   t.updateType,
    lastResolutionType: t.resolutionType,
    confidence:       t.confidence,
    references:       t.reference,
    signals:          t.signals,
    relatedEntities:  t.relatedEntities,
    appearances:      [],
  };
  appendThreadHistory(item, t, chapterNumber, chapterTitle);
  mergeThreadSuggestion(item, t, chapterNumber, false);
  return item;
}

function mergeThreadUpdate(
  item: ThreadIndexItem,
  t: ThreadUpdate,
  chapterNumber: number,
  chapterTitle: string | undefined,
  hasUserStatusOverride: boolean,
): void {
  const previousStatus = item.status;
  const previousDescription = item.description;
  item.type = item.type === 'uncertain' ? t.type : item.type;
  item.description = t.description || item.description;
  if (isMeaningfulStateUpdate(t, previousStatus, previousDescription)) {
    item.lastKnownState = t.description || item.lastKnownState;
  }
  if (t.status === 'open' || t.status === 'active' || t.status === 'changed' || t.status === 'uncertain') {
    item.unresolvedQuestion = unresolvedQuestionFor(t, item.unresolvedQuestion);
  }
  appendThreadHistory(item, t, chapterNumber, chapterTitle);
  item.lastSeenChapter = chapterNumber;
  item.lastUpdateType = t.updateType;
  item.lastResolutionType = t.resolutionType;
  item.confidence = t.confidence;
  item.references = mergeReferences(item.references, t.reference);
  item.signals = mergeStrings(item.signals, t.signals);
  item.relatedEntities = mergeStrings(item.relatedEntities, t.relatedEntities);
  if (t.parentThread) item.parentThread = t.parentThread;

  if (t.status === 'open' || t.status === 'active') {
    if (!hasUserStatusOverride || item.status === 'open' || item.status === 'active' || t.updateType === 'reopened') {
      item.status = t.status;
    }
    item.needsReview = item.needsReview || t.confidence < 0.7 || (t.updateType === 'reopened' && previousStatus === 'resolved');
    if (t.updateType === 'reopened' && previousStatus === 'resolved') {
      item.suggestedStatus = 'open';
      item.suggestedUpdateType = 'reopened';
      item.suggestedResolutionType = t.resolutionType;
      item.needsReview = true;
    }
    return;
  }

  mergeThreadSuggestion(item, t, chapterNumber, true);
}

function mergeThreadSuggestion(
  item: ThreadIndexItem,
  t: ThreadUpdate,
  chapterNumber: number,
  existing: boolean,
): void {
  if (t.status === 'resolved') {
    item.suggestedStatus = 'resolved';
    item.suggestedUpdateType = 'resolved';
    item.suggestedResolutionType = t.resolutionType;
    item.needsReview = true;
    if (!existing && item.status === 'resolved') item.resolvedChapter = chapterNumber;
  } else if (t.status === 'changed') {
    item.suggestedStatus = 'changed';
    item.suggestedUpdateType = t.updateType;
    item.suggestedResolutionType = t.resolutionType;
    item.needsReview = true;
  } else if (t.status === 'uncertain') {
    item.suggestedStatus = 'uncertain';
    item.suggestedUpdateType = t.updateType;
    item.suggestedResolutionType = t.resolutionType;
    item.needsReview = true;
  }
}

function isMeaningfulStateUpdate(
  t: ThreadUpdate,
  previousStatus: ThreadStatus,
  previousDescription: string,
): boolean {
  if (!t.description) return false;
  if (t.updateType !== 'reinforced') return true;
  if (t.status !== previousStatus) return true;
  return t.description.trim() !== previousDescription.trim();
}

function unresolvedQuestionFor(t: ThreadUpdate, current: string | undefined): string | undefined {
  if (t.status === 'resolved') return current;
  if (current) return current;
  if (!t.description) return undefined;
  return t.description;
}

function appendThreadHistory(
  item: ThreadIndexItem,
  t: ThreadUpdate,
  chapterNumber: number,
  chapterTitle?: string,
): void {
  if (!t.description) return;
  const history = item.history ?? [];
  const duplicate = history.some(h =>
    h.chapter === chapterNumber &&
    h.status === t.status &&
    h.updateType === t.updateType &&
    h.resolutionType === t.resolutionType &&
    h.summary === t.description
  );
  if (duplicate) {
    item.history = history;
    return;
  }
  history.push({
    chapter: chapterNumber,
    chapterTitle,
    status: t.status,
    updateType: t.updateType,
    resolutionType: t.resolutionType,
    summary: t.description,
    evidence: t.reference,
  });
  item.history = history.slice(-5);
}

function isThreadStatus(v: string): v is ThreadStatus {
  return ['open', 'active', 'resolved', 'changed', 'uncertain'].includes(v);
}

function mergeStrings(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  const merged = [...(a ?? []), ...(b ?? [])].filter(Boolean);
  return merged.length ? [...new Set(merged)] : undefined;
}

function mergeReferences(
  a: ThreadIndexItem['references'] | undefined,
  b: ThreadUpdate['reference'] | undefined,
): ThreadIndexItem['references'] | undefined {
  const merged = [...(a ?? []), ...(b ?? [])];
  if (!merged.length) return undefined;
  const seen = new Set<string>();
  return merged.filter(r => {
    const key = `${r.kind}:${r.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applyThreadOverride(item: ThreadIndexItem, ovr: ReturnType<OverrideStore['readIndex']>[string] | undefined): void {
  if (!ovr) return;
  if (ovr.title) item.title = ovr.title;
  if (ovr.status && isThreadStatus(ovr.status)) item.status = ovr.status;
  if (ovr.resolvedChapter !== undefined) item.resolvedChapter = ovr.resolvedChapter ?? undefined;
  if (ovr.parentThread !== undefined) item.parentThread = ovr.parentThread ?? undefined;
  if (ovr.lastKnownState !== undefined) item.lastKnownState = ovr.lastKnownState ?? undefined;
  if (ovr.unresolvedQuestion !== undefined) item.unresolvedQuestion = ovr.unresolvedQuestion ?? undefined;
  if (ovr.needsReview !== undefined) item.needsReview = ovr.needsReview ?? undefined;
  if (ovr.suggestedStatus !== undefined) {
    if (ovr.suggestedStatus === null) delete item.suggestedStatus;
    else if (isThreadStatus(ovr.suggestedStatus)) item.suggestedStatus = ovr.suggestedStatus;
  }
  if (ovr.suggestedUpdateType !== undefined) {
    if (ovr.suggestedUpdateType === null) delete item.suggestedUpdateType;
    else item.suggestedUpdateType = ovr.suggestedUpdateType as ThreadIndexItem['suggestedUpdateType'];
  }
  if (ovr.suggestedResolutionType !== undefined) {
    if (ovr.suggestedResolutionType === null) delete item.suggestedResolutionType;
    else item.suggestedResolutionType = ovr.suggestedResolutionType as ThreadIndexItem['suggestedResolutionType'];
  }
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
