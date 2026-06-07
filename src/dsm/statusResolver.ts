import { ChapterEntity } from './draftScriptTypes';
import { CanonEntry, normalizeId } from './canonManager';

type StatusResult = Pick<ChapterEntity, 'status' | 'canonId' | 'possibleCanonId'>;

/** Determines whether a raw LLM entity is new, already in canon, or an uncertain match. */
export function resolveEntityStatus(
  entity: { name: string; aliases: string[] },
  canon:  CanonEntry[]
): StatusResult {
  const entityIds = [entity.name, ...entity.aliases].map(normalizeId);

  // Exact match: normalized name or any alias matches a canon entry's name or aliases
  for (const entry of canon) {
    const canonIds = [entry.name, ...entry.aliases].map(normalizeId);
    if (entityIds.some(id => canonIds.includes(id))) {
      return { status: 'already_indexed', canonId: entry.id };
    }
  }

  // Uncertain match: distance-1 for any length; distance-2 only for names ≥ 6 chars
  // (avoids false positives like "tarn" ↔ "skarn" at distance 2 on 4-letter names)
  const primaryId = normalizeId(entity.name);
  for (const entry of canon) {
    const canonId = normalizeId(entry.name);
    const dist    = levenshtein(primaryId, canonId);
    const minLen  = Math.min(primaryId.length, canonId.length);
    if (dist <= 1 || (dist === 2 && minLen >= 6)) {
      return { status: 'uncertain', possibleCanonId: entry.id };
    }
  }

  return { status: 'new' };
}

/** Applies status resolution to a list of raw LLM entities within a given canon category. */
export function resolveEntities(
  rawEntities: RawLlmEntity[],
  canon:       CanonEntry[]
): ChapterEntity[] {
  return rawEntities.map(e => {
    const id     = normalizeId(e.name);
    const status = resolveEntityStatus(e, canon);
    return {
      id,
      name:            e.name,
      aliases:         e.aliases,
      description:     e.description,
      roleInChapter:   e.roleInChapter,
      confidence:      e.confidence,
      reference:       e.reference,
      ...status,
    };
  });
}

// ---------------------------------------------------------------------------
// Raw LLM entity (before status resolution)
// ---------------------------------------------------------------------------

export interface RawLlmEntity {
  name:           string;
  aliases:        string[];
  description?:   string;
  roleInChapter?: string;
  confidence:     number;
  reference?:     { text: string; kind: 'quote' | 'paraphrase' }[];
}

// ---------------------------------------------------------------------------
// Levenshtein distance (simple O(nm) impl, sufficient for short names)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
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
