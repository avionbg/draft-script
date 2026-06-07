export interface Candidate {
  candidate: string;
  mentions: number;
  contexts: string[];
}

// Context window around each mention (chars)
const CTX = 50;
const MAX_CANDIDATES = 30;

export function extractCandidates(text: string): Candidate[] {
  const counts = new Map<string, number>();
  const ctxMap  = new Map<string, string[]>();

  // Match one or more consecutive capitalized words that are NOT at sentence start.
  // Sentence starts: line beginning OR after . / ! / ? followed by whitespace.
  // We scan manually so we can check the character before the match.
  const wordRe = /[A-ZČĆŠĐŽ][a-zA-ZČčĆćŠšĐđŽž'-]*/g;
  let m: RegExpExecArray | null;

  while ((m = wordRe.exec(text)) !== null) {
    // Check if this is a sentence-start position (skip those)
    const before = text.slice(Math.max(0, m.index - 2), m.index);
    if (isSentenceStart(text, m.index)) continue;

    // Greedily collect consecutive capitalized words (multi-word names)
    let name = m[0];
    let end  = m.index + m[0].length;

    // Peek ahead for more capitalized words separated by single space
    const peekRe = /^ ([A-ZČĆŠĐŽ][a-zA-ZČčĆćŠšĐđŽž'-]*)/y;
    peekRe.lastIndex = end;
    let p: RegExpExecArray | null;
    while ((p = peekRe.exec(text)) !== null) {
      name += ` ${p[1]}`;
      end  += p[0].length;
      peekRe.lastIndex = end;
    }

    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);

    if (count <= 3) {
      const snippets = ctxMap.get(name) ?? [];
      if (snippets.length < 3) {
        const start  = Math.max(0, m.index - CTX);
        const finish = Math.min(text.length, end + CTX);
        snippets.push(text.slice(start, finish).replace(/\s+/g, ' ').trim());
        ctxMap.set(name, snippets);
      }
    }

    // Advance past the full (possibly multi-word) match to avoid re-processing
    wordRe.lastIndex = end;
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CANDIDATES)
    .map(([candidate, mentions]) => ({
      candidate,
      mentions,
      contexts: ctxMap.get(candidate) ?? [],
    }));
}

function isSentenceStart(text: string, index: number): boolean {
  if (index === 0) return true;
  // Walk back over whitespace
  let i = index - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  if (i < 0) return true;
  const ch = text[i];
  return ch === '\n' || ch === '.' || ch === '!' || ch === '?';
}
