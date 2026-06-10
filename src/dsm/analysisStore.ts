import * as fs     from 'fs';
import * as path   from 'path';
import * as crypto from 'crypto';
import { ChapterAnalysis, ChapterFunction, ChapterOverview, ThreadResolutionType, ThreadUpdate, ThreadUpdateType } from './draftScriptTypes';

const BASE_DIR      = '.draft-script';
const CHAPTERS_DIR  = path.join(BASE_DIR, 'analysis', 'chapters');
export const ANALYSIS_SCHEMA_VERSION = 3;

export class AnalysisStore {
  private readonly chaptersDir: string;

  constructor(private readonly rootFolder: string) {
    this.chaptersDir = path.join(rootFolder, CHAPTERS_DIR);
  }

  rootPath(): string {
    return this.rootFolder;
  }

  chapterId(num: number): string {
    return `chapter-${String(num).padStart(4, '0')}`;
  }

  computeContentHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  }

  read(chapterNum: number): ChapterAnalysis | undefined {
    const file = path.join(this.chaptersDir, `${this.chapterId(chapterNum)}.json`);
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!isCurrentAnalysisSchema(raw)) return undefined;
      return normalizeAnalysis(raw);
    } catch {
      return undefined;
    }
  }

  write(analysis: ChapterAnalysis): void {
    fs.mkdirSync(this.chaptersDir, { recursive: true });
    const file = path.join(this.chaptersDir, `${analysis.chapter.id}.json`);
    fs.writeFileSync(file, JSON.stringify(analysis, null, 2), 'utf-8');
  }

  /** Returns how many chapters have entities in `category` that reference `canonId`. */
  referencesCanonId(category: string, id: string): { count: number; chapters: string[] } {
    const chapters: string[] = [];
    for (const ch of this.readAll()) {
      const entities = (ch as Record<string, unknown> & ChapterAnalysis)[category] as Array<{ canonId?: string; possibleCanonId?: string }> | undefined;
      if (entities?.some(e => e.canonId === id || e.possibleCanonId === id)) {
        chapters.push(ch.chapter.title || ch.chapter.id);
      }
    }
    return { count: chapters.length, chapters };
  }

  /** Rewrites all canonId / possibleCanonId references from `oldId` to `newId` in every chapter file. */
  rewriteCanonId(category: string, oldId: string, newId: string): void {
    if (!fs.existsSync(this.chaptersDir)) return;
    for (const name of fs.readdirSync(this.chaptersDir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.chaptersDir, name);
      try {
        const analysis = JSON.parse(fs.readFileSync(file, 'utf-8')) as ChapterAnalysis;
        const entities = (analysis as Record<string, unknown> & ChapterAnalysis)[category] as Array<{ canonId?: string; possibleCanonId?: string }> | undefined;
        if (!entities) continue;
        let changed = false;
        for (const e of entities) {
          if (e.canonId === oldId)         { e.canonId         = newId; changed = true; }
          if (e.possibleCanonId === oldId) { e.possibleCanonId = newId; changed = true; }
        }
        if (changed) fs.writeFileSync(file, JSON.stringify(analysis, null, 2), 'utf-8');
      } catch { /* skip corrupt files */ }
    }
  }

  readAll(): ChapterAnalysis[] {
    if (!fs.existsSync(this.chaptersDir)) return [];
    const results: ChapterAnalysis[] = [];
    for (const name of fs.readdirSync(this.chaptersDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(this.chaptersDir, name), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!isCurrentAnalysisSchema(parsed)) continue;
        results.push(normalizeAnalysis(parsed));
      } catch { /* skip corrupt files */ }
    }
    return results.sort((a, b) => (a.chapter.number ?? 0) - (b.chapter.number ?? 0));
  }
}

type StoredAnalysis = Omit<ChapterAnalysis, 'schemaVersion' | 'threads' | 'overview'> & {
  schemaVersion?: number;
  threads?: unknown;
  overview?: unknown;
};

export const DEFAULT_CHAPTER_OVERVIEW: ChapterOverview = {
  summary:         [],
  purpose:         '',
  emotionalBeat:   '',
  chapterFunction: 'mixed',
  setups:          [],
  payoffs:         [],
  humanFocus:      [],
  technicalFocus:  [],
  riskFlags:       [],
  bookImpact:      '',
};

export function isCurrentAnalysisSchema(raw: unknown): boolean {
  return typeof raw === 'object' &&
    raw !== null &&
    (raw as { schemaVersion?: unknown }).schemaVersion === ANALYSIS_SCHEMA_VERSION;
}

export function normalizeAnalysis(raw: unknown): ChapterAnalysis {
  const obj = raw as StoredAnalysis;
  const { threads: _rawThreads, overview: _rawOverview, ...rest } = obj;
  const rawThreads = Array.isArray(obj.threads) ? obj.threads : [];

  const threads = rawThreads
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map(t => {
      const thread = normalizeThreadUpdate(t);
      if (!thread) return undefined;
      return thread;
    })
    .filter((t): t is ThreadUpdate => t !== undefined);

  return {
    ...rest,
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    overview: normalizeChapterOverview(obj.overview),
    threads,
  } as ChapterAnalysis;
}

export function normalizeChapterOverview(raw: unknown): ChapterOverview {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_CHAPTER_OVERVIEW };
  const obj = raw as Record<string, unknown>;
  return {
    summary:         stringArray(obj['summary']),
    purpose:         stringValue(obj['purpose']),
    emotionalBeat:   stringValue(obj['emotionalBeat']),
    chapterFunction: parseChapterFunction(obj['chapterFunction']),
    setups:          stringArray(obj['setups']),
    payoffs:         stringArray(obj['payoffs']),
    humanFocus:      stringArray(obj['humanFocus']),
    technicalFocus:  stringArray(obj['technicalFocus']),
    riskFlags:       stringArray(obj['riskFlags']),
    bookImpact:      stringValue(obj['bookImpact']),
  };
}

function stringValue(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function stringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map(String).map(s => s.trim()).filter(Boolean)
    : [];
}

function parseChapterFunction(raw: unknown): ChapterFunction {
  const valid: ChapterFunction[] = ['setup', 'development', 'payoff', 'aftermath', 'transition', 'climax', 'resolution', 'mixed'];
  return valid.includes(raw as ChapterFunction) ? raw as ChapterFunction : 'mixed';
}

function normalizeThreadUpdate(raw: Record<string, unknown>): ThreadUpdate | undefined {
  const updateType = parseThreadUpdateType(raw['updateType']);
  const resolutionType = parseThreadResolutionType(raw['resolutionType']);
  if (!updateType || !resolutionType) return undefined;
  return {
    id:               String(raw['id'] ?? ''),
    title:            String(raw['title'] ?? ''),
    description:      String(raw['description'] ?? ''),
    type:             parseThreadType(raw['type']),
    status:           parseThreadStatus(raw['status']),
    updateType,
    resolutionType,
    confidence:       typeof raw['confidence'] === 'number' ? raw['confidence'] : 0.5,
    reference:        Array.isArray(raw['reference']) ? raw['reference'] as ThreadUpdate['reference'] : undefined,
    relatedEntities:  Array.isArray(raw['relatedEntities']) ? raw['relatedEntities'].map(String) : undefined,
    parentThread:     typeof raw['parentThread'] === 'string' && raw['parentThread'].trim() ? raw['parentThread'].trim() : undefined,
    signals:          Array.isArray(raw['signals']) ? raw['signals'].map(String) : undefined,
  };
}

function parseThreadType(v: unknown): ThreadUpdate['type'] {
  const valid: ThreadUpdate['type'][] = ['promise', 'risk', 'mystery', 'task', 'question', 'conflict', 'system', 'uncertain'];
  return valid.includes(v as ThreadUpdate['type']) ? v as ThreadUpdate['type'] : 'uncertain';
}

function parseThreadStatus(v: unknown): ThreadUpdate['status'] {
  const valid: ThreadUpdate['status'][] = ['open', 'active', 'resolved', 'changed', 'uncertain'];
  return valid.includes(v as ThreadUpdate['status']) ? v as ThreadUpdate['status'] : 'uncertain';
}

function parseThreadUpdateType(v: unknown): ThreadUpdateType | undefined {
  const valid: ThreadUpdateType[] = ['new', 'progressed', 'reinforced', 'changed', 'partially_resolved', 'resolved', 'reopened'];
  return valid.includes(v as ThreadUpdateType) ? v as ThreadUpdateType : undefined;
}

function parseThreadResolutionType(v: unknown): ThreadResolutionType | undefined {
  const valid: ThreadResolutionType[] = ['none', 'explicit', 'implicit', 'partial'];
  return valid.includes(v as ThreadResolutionType) ? v as ThreadResolutionType : undefined;
}
