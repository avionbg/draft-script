import * as vscode from 'vscode';
import * as path   from 'path';

export interface NavigateOptions {
  filePath:       string;
  root?:          string;
  referenceText?: string;
  title?:         string;
  entityName?:    string;
  entityAliases?: string[];
}

// Quote code points as hex numbers — no unicode char literals, immune to smart-quote substitution.
const QUOTE_CPS = new Set([
  0x0022,  // " QUOTATION MARK
  0x0027,  // ' APOSTROPHE
  0x00ab,  // LEFT-POINTING DOUBLE ANGLE QUOTATION MARK
  0x00bb,  // RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK
  0x2018,  // LEFT SINGLE QUOTATION MARK
  0x2019,  // RIGHT SINGLE QUOTATION MARK
  0x201a,  // SINGLE LOW-9 QUOTATION MARK
  0x201b,  // SINGLE HIGH-REVERSED-9 QUOTATION MARK
  0x201c,  // LEFT DOUBLE QUOTATION MARK
  0x201d,  // RIGHT DOUBLE QUOTATION MARK
  0x201e,  // DOUBLE LOW-9 QUOTATION MARK
  0x201f,  // DOUBLE HIGH-REVERSED-9 QUOTATION MARK
  0x2039,  // SINGLE LEFT-POINTING ANGLE QUOTATION MARK
  0x203a,  // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
]);

function isQuoteChar(c: string): boolean {
  return QUOTE_CPS.has(c.codePointAt(0) ?? -1);
}

function stripQuotes(s: string): string {
  let r = '';
  for (const c of s) { if (!isQuoteChar(c)) r += c; }
  return r;
}

// Returns array where map[i] = position of stripped[i] in the original string.
// Sentinel map[stripped.length] = original.length.
function buildQuoteStripMap(s: string): number[] {
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (!isQuoteChar(s[i])) map.push(i);
  }
  map.push(s.length);
  return map;
}

export async function navigateWithSelection(opts: NavigateOptions): Promise<void> {
  const { filePath, root, referenceText, title, entityName, entityAliases } = opts;

  try {
    const absPath = (root && !path.isAbsolute(filePath))
      ? path.join(root, filePath)
      : filePath;

    const uri    = vscode.Uri.file(absPath);
    const doc    = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });

    let positioned = false;

    // Try 1: reference text -- exact, unicode-normalised, or quote-stripped; splits on ellipsis
    if (referenceText) {
      const docText = doc.getText();

      // Curly single/double quotes -> straight using codepoint ranges (no unicode literals needed).
      const normalize = (s: string) => {
        let out = '';
        for (const c of s) {
          const cp = c.codePointAt(0) ?? 0;
          if (cp >= 0x2018 && cp <= 0x201b) { out += "'"; continue; }
          if (cp >= 0x201c && cp <= 0x201f) { out += '"'; continue; }
          out += c;
        }
        return out.replace(/\s+/g, ' ').trim();
      };

      // Lazily computed -- only if exact + normalised attempts fail
      let sDocText: string | null = null;
      let sDocMap:  number[] | null = null;

      const findFragment = (fragment: string): { idx: number; len: number } | null => {
        // Attempt 1: exact
        const i = docText.indexOf(fragment);
        if (i >= 0) return { idx: i, len: fragment.length };

        // Attempt 2: unicode-normalised (curly -> straight quotes, whitespace collapsed)
        const nFrag = normalize(fragment);
        const nDoc  = normalize(docText);
        const ni    = nDoc.indexOf(nFrag);
        if (ni >= 0) {
          let origIdx = 0, normPos = 0;
          while (normPos < ni && origIdx < docText.length) {
            const ch = docText[origIdx++];
            normPos += /\s/.test(ch) ? (nDoc[normPos] === ' ' ? 1 : 0) : 1;
            if (normPos > ni) { origIdx--; break; }
          }
          return { idx: origIdx, len: nFrag.length };
        }

        // Attempt 3: strip all quote chars from both sides, remap position.
        // Handles LLM omitting surrounding/internal quotes from the stored reference.
        const sf = stripQuotes(fragment);
        if (sf.length >= 4) {
          if (!sDocText) { sDocText = stripQuotes(docText); sDocMap = buildQuoteStripMap(docText); }
          const si = sDocText.indexOf(sf);
          if (si >= 0) {
            const origStart = sDocMap![si];
            const origEnd   = sDocMap![si + sf.length];
            return { idx: origStart, len: origEnd - origStart };
          }
        }

        return null;
      };

      const fragments = referenceText
        .split(/\.{2,}|\.\.\./)
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

    // Try 2: heading match + optional entity name search within section
    if (!positioned && title) {
      const lines       = doc.getText().split('\n');
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
}
