import * as fs from 'fs';
import * as path from 'path';
import {
  ChapterAnalysis, ChapterEntity, ThreadIndexItem, ThreadUpdate, ThreadUpdateType, ThreadResolutionType, TimelineEvent, ContinuityNote, Reference,
  ChapterTimeIndex, TimeReference, TimeRefType, TimeReferenceRole, DayEstimate,
} from './draftScriptTypes';
import { LlmProvider, ChapterSource, DsmParseError } from './types';
import { CanonEntry, CanonManager, normalizeId } from './canonManager';
import { RawLlmEntity, resolveEntities } from './statusResolver';
import { AnalysisStore } from './analysisStore';
import { extractCandidates } from './localExtractor';
import { buildPrompt } from './promptBuilder';
import { SignalManager } from './signalManager';

export interface AnalysisOutcome {
  analysis:       ChapterAnalysis;
  promptSource:   string;
  sourceChapter?: ChapterSource;
}

export interface AnalysisPromptPreview {
  prompt:       string;
  promptSource: string;
}

export function buildAnalysisPromptPreview(
  text:   string,
  store:  AnalysisStore,
  sigMgr: SignalManager,
): AnalysisPromptPreview {
  const candidates = extractCandidates(text);

  // Ensure signals.json and LLM_analysis.md exist; create from defaults if not.
  sigMgr.ensureExists();
  sigMgr.ensurePromptFile();

  const signals  = sigMgr.read();
  const template = sigMgr.readPromptTemplate();

  // Pass existing analyses as context (threads/timeline only)
  const existingAnalyses = store.readAll();

  return {
    prompt:       buildPrompt(text, candidates, template, existingAnalyses, signals, readIndexedThreads(store.rootPath())),
    promptSource: 'LLM_analysis.md',
  };
}

function readIndexedThreads(rootFolder: string): ThreadIndexItem[] {
  const file = path.join(rootFolder, '.draft-script', 'indexes', 'threads.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(raw) ? raw as ThreadIndexItem[] : [];
  } catch {
    return [];
  }
}

export async function analyzeText(
  text:          string,
  provider:      LlmProvider,
  store:         AnalysisStore,
  canon:         CanonManager,
  sigMgr:        SignalManager,
  sourceChapter?: ChapterSource,
): Promise<AnalysisOutcome> {
  const { prompt, promptSource } = buildAnalysisPromptPreview(text, store, sigMgr);
  const signals = sigMgr.read();
  const raw          = await provider.complete(prompt);

  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new DsmParseError(
      'DSM: LLM returned non-JSON output. See the review panel for the raw response.',
      raw
    );
  }

  const validSignalIds = new Set(signals.map(s => s.id));
  const analysis = buildChapterAnalysis(
    parsed, raw, text, provider, store, canon, sourceChapter, validSignalIds
  );

  return { analysis, promptSource, sourceChapter };
}

// ---------------------------------------------------------------------------
// Build full ChapterAnalysis from raw LLM output
// ---------------------------------------------------------------------------

function buildChapterAnalysis(
  raw:             unknown,
  rawStr:          string,
  text:            string,
  provider:        LlmProvider,
  store:           AnalysisStore,
  canon:           CanonManager,
  sourceChapter?:  ChapterSource,
  validSignalIds?: Set<string>,
): ChapterAnalysis {
  if (typeof raw !== 'object' || raw === null) {
    throw new DsmParseError('DSM: LLM response is not a JSON object.', rawStr);
  }

  const obj = raw as Record<string, unknown>;
  const num  = sourceChapter?.chapterNum;
  const id   = num != null ? store.chapterId(num) : `chapter-unknown-${Date.now()}`;

  return {
    schemaVersion: 2,
    chapter: {
      id,
      number:      num,
      title:       sourceChapter?.title ?? id,
      filePath:    sourceChapter?.filePath ?? '',
      contentHash: store.computeContentHash(text),
      analyzedAt:  new Date().toISOString(),
      model:       provider.id,
    },
    characters:      resolveEntities(parseRawEntities(obj['characters']), canon.read('characters')),
    locations:       resolveEntities(parseRawEntities(obj['locations']),  canon.read('locations')),
    objects:         resolveEntities(parseRawEntities(obj['objects']),    canon.read('objects')),
    groups:          resolveEntities(parseRawEntities(obj['groups']),     canon.read('groups')),
    threads:         parseThreads(obj['threads'], validSignalIds, rawStr),
    timelineEvents:  parseTimeline(obj['timelineEvents'], validSignalIds),
    continuityNotes: parseContinuity(obj['continuityNotes'], validSignalIds),
    timeIndex:       parseTimeIndex(obj['timeIndex']),
  };
}

// ---------------------------------------------------------------------------
// LLM output parsers
// ---------------------------------------------------------------------------

function parseRawEntities(arr: unknown): RawLlmEntity[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map(e => ({
      name:           String(e['name']          ?? ''),
      aliases:        strArr(e, 'aliases'),
      description:    str(e, 'description'),
      roleInChapter:  str(e, 'roleInChapter'),
      confidence:     num(e, 'confidence'),
      reference:      parseReference(e['reference']),
    }))
    .filter(e => e.name.length > 0);
}

function filterSignals(raw: unknown, valid: Set<string> | undefined): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = (raw as unknown[]).map(String).filter(id => !valid || valid.has(id));
  return ids.length ? ids : undefined;
}

function parseThreads(arr: unknown, validSignals?: Set<string>, rawStr?: string): ThreadUpdate[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map(e => {
      const title = String(e['title'] ?? '').trim();
      const id    = normalizeId(String(e['id'] ?? title));
      const updateType = threadUpdateType(e['updateType']);
      const resolutionType = threadResolutionType(e['resolutionType']);
      if (!updateType || !resolutionType) {
        throw new DsmParseError(
          'DSM: LLM thread output is missing required lifecycle fields updateType/resolutionType.',
          rawStr ?? JSON.stringify(arr, null, 2)
        );
      }
      return {
        id,
        title,
        description:      String(e['description'] ?? ''),
        type:             threadType(e['type']),
        status:           threadStatus(e['status']),
        updateType,
        resolutionType,
        confidence:       num(e, 'confidence'),
        reference:        parseReference(e['reference']),
        relatedEntities:  strArr(e, 'relatedEntities'),
        parentThread:     str(e, 'parentThread'),
        signals:          filterSignals(e['signals'], validSignals),
      };
    })
    .filter(e => e.title.length > 0);
}

function parseTimeline(arr: unknown, validSignals?: Set<string>): TimelineEvent[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e, idx) => ({
      id:          normalizeId(String(e['title'] ?? '')),
      title:       String(e['title']       ?? ''),
      description: str(e, 'description'),
      order:       typeof e['order'] === 'number' ? e['order'] : idx,
      confidence:  num(e, 'confidence'),
      reference:   parseReference(e['reference']),
      signals:     filterSignals(e['signals'], validSignals),
    }))
    .filter(e => e.title.length > 0);
}

function parseContinuity(arr: unknown, validSignals?: Set<string>): ContinuityNote[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map(e => ({
      id:               normalizeId(String(e['title'] ?? '')),
      title:            String(e['title']       ?? ''),
      description:      String(e['description'] ?? ''),
      type:             continuityType(e['type']),
      status:           continuityStatus(e['status']),
      confidence:       num(e, 'confidence'),
      reference:        parseReference(e['reference']),
      relatedEntities:  strArr(e, 'relatedEntities'),
      signals:          filterSignals(e['signals'], validSignals),
    }))
    .filter(e => e.title.length > 0);
}

function parseTimeIndex(raw: unknown): ChapterTimeIndex | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;

  const startSeason   = parseSeasonField(obj['startSeason']);
  const endSeason     = parseSeasonField(obj['endSeason']);
  const chapterAnchor = parseSeasonField(obj['chapterAnchor']);

  const references: TimeReference[] = (() => {
    if (!Array.isArray(obj['references'])) return [];
    return (obj['references'] as unknown[])
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .map(r => {
        const role = timeRefRole(r['role']);
        const ref: TimeReference = {
          type:        timeRefType(r['type']),
          text:        String(r['text'] ?? '').trim(),
          normalized:  str(r, 'normalized'),
          description: str(r, 'description'),
          confidence:  num(r, 'confidence'),
        };
        if (role) ref.role = role;
        return ref;
      })
      .filter(r => r.text.length > 0);
  })();

  if (!startSeason && !endSeason && !chapterAnchor && !references.length) return undefined;

  return {
    startSeason,
    endSeason,
    chapterAnchor,
    references,
    sceneDuration:            parseDayEstimate(obj['sceneDuration']),
    coveredTimeSpan:          parseDayEstimate(obj['coveredTimeSpan']),
    estimatedGapFromPrevious: parseDayEstimate(obj['estimatedGapFromPrevious']),
  };
}

function parseSeasonField(raw: unknown): ChapterTimeIndex['startSeason'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  const value = typeof obj['value'] === 'string' ? obj['value'].trim() : '';
  return value ? { value, confidence: num(obj, 'confidence') } : undefined;
}

function parseDayEstimate(raw: unknown): DayEstimate | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['likelyDays'] !== 'number') return undefined;
  return {
    minDays:    typeof obj['minDays'] === 'number' ? obj['minDays'] : 0,
    likelyDays: obj['likelyDays'],
    maxDays:    typeof obj['maxDays'] === 'number' ? obj['maxDays'] : obj['likelyDays'],
  };
}

function timeRefType(v: unknown): TimeRefType {
  const valid: TimeRefType[] = ['exact', 'elapsed', 'duration', 'season', 'deadline', 'daypart', 'routine'];
  return valid.includes(v as TimeRefType) ? (v as TimeRefType) : 'elapsed';
}

function timeRefRole(v: unknown): TimeReferenceRole | undefined {
  const valid: TimeReferenceRole[] = ['current', 'flashback', 'dream', 'history', 'projection'];
  return valid.includes(v as TimeReferenceRole) ? (v as TimeReferenceRole) : undefined;
}

function parseReference(arr: unknown): Reference[] | undefined {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  const result = arr
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map(e => ({
      text: String(e['text'] ?? ''),
      kind: e['kind'] === 'paraphrase' ? 'paraphrase' as const : 'quote' as const,
    }))
    .filter(e => e.text.length > 0);
  return result.length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

function str(e: Record<string, unknown>, key: string): string | undefined {
  const v = e[key];
  return (typeof v === 'string' && v.trim()) ? v.trim() : undefined;
}

function strArr(e: Record<string, unknown>, key: string): string[] {
  return Array.isArray(e[key]) ? (e[key] as unknown[]).map(String).filter(s => s.trim()) : [];
}

function num(e: Record<string, unknown>, key: string): number {
  return typeof e[key] === 'number' ? (e[key] as number) : 0.5;
}

function threadType(v: unknown): ThreadUpdate['type'] {
  const valid: ThreadUpdate['type'][] = ['promise', 'risk', 'mystery', 'task', 'question', 'conflict', 'system', 'uncertain'];
  return valid.includes(v as ThreadUpdate['type']) ? (v as ThreadUpdate['type']) : 'uncertain';
}

function threadStatus(v: unknown): ThreadUpdate['status'] {
  const valid: ThreadUpdate['status'][] = ['open', 'active', 'resolved', 'changed', 'uncertain'];
  return valid.includes(v as ThreadUpdate['status']) ? (v as ThreadUpdate['status']) : 'uncertain';
}

function threadUpdateType(v: unknown): ThreadUpdateType | undefined {
  const valid: ThreadUpdateType[] = ['new', 'progressed', 'reinforced', 'changed', 'partially_resolved', 'resolved', 'reopened'];
  return valid.includes(v as ThreadUpdateType) ? (v as ThreadUpdateType) : undefined;
}

function threadResolutionType(v: unknown): ThreadResolutionType | undefined {
  const valid: ThreadResolutionType[] = ['none', 'explicit', 'implicit', 'partial'];
  return valid.includes(v as ThreadResolutionType) ? (v as ThreadResolutionType) : undefined;
}

function continuityType(v: unknown): ContinuityNote['type'] {
  const valid = ['state', 'resource', 'construction', 'technology', 'relationship', 'promise', 'risk', 'population', 'logistics'];
  return valid.includes(String(v)) ? (v as ContinuityNote['type']) : 'state';
}

function continuityStatus(v: unknown): ContinuityNote['status'] {
  const valid = ['active', 'resolved', 'changed'];
  return valid.includes(String(v)) ? (v as ContinuityNote['status']) : 'uncertain';
}
