import * as vscode from 'vscode';
import * as fs    from 'fs';
import * as path  from 'path';
import { TimeIndexItem, DayEstimate, TimeReference } from '../dsm/draftScriptTypes';

// ── Output channel ────────────────────────────────────────────────────────────

let _channel: vscode.OutputChannel | undefined;
function getChannel(): vscode.OutputChannel {
  if (!_channel) _channel = vscode.window.createOutputChannel('Draft-Script Time Inspector');
  return _channel;
}

// ── Data loading ──────────────────────────────────────────────────────────────

function readTimeIndex(root: string): TimeIndexItem[] {
  const filePath = path.join(root, '.draft-script', 'indexes', 'timeIndex.json');
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(raw) ? (raw as TimeIndexItem[]) : [];
  } catch {
    return [];
  }
}

function readFirstHeading(filePath: string): string | undefined {
  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    if (lines[0]?.trim() === '---') {
      for (let i = 1; i < Math.min(lines.length, 40); i++) {
        if (lines[i].trim() === '---') break;
        const m = lines[i].match(/^title:\s*(.+)/);
        if (m) return m[1].trim().replace(/^["']|["']$/g, '');
      }
    }
    for (const l of lines) {
      const m = l.match(/^#{1,6}\s+(.+)/);
      if (m) return m[1].trim();
    }
  } catch { /* ignore */ }
  return undefined;
}

function scanMarkdownFiles(dir: string, skip = new Set(['characters.md', 'notes.md'])): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanMarkdownFiles(full, skip));
      } else if (entry.name.endsWith('.md') && !skip.has(entry.name.toLowerCase())) {
        results.push(full);
      }
    }
  } catch { /* ignore */ }
  return results;
}

function buildTitleMap(novelFolder: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const f of scanMarkdownFiles(novelFolder)) {
    const m = path.basename(f).match(/(\d+)/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!map.has(n)) {
      const title = readFirstHeading(f);
      if (title) map.set(n, title);
    }
  }
  return map;
}

// ── Exported math utilities ───────────────────────────────────────────────────

const ZERO: DayEstimate = { minDays: 0, likelyDays: 0, maxDays: 0 };

export function normalizeDurationRange(
  r: Partial<DayEstimate> | undefined | null,
): DayEstimate | null {
  if (!r || typeof r !== 'object') return null;
  const min    = typeof r.minDays    === 'number' ? r.minDays    : null;
  const likely = typeof r.likelyDays === 'number' ? r.likelyDays : null;
  const max    = typeof r.maxDays    === 'number' ? r.maxDays    : null;
  if (min === null && likely === null && max === null) return null;
  const l = likely ?? min ?? max ?? 0;
  return { minDays: min ?? l, likelyDays: l, maxDays: max ?? l };
}

export function addDurationRanges(a: DayEstimate, b: DayEstimate): DayEstimate {
  return {
    minDays:    a.minDays    + b.minDays,
    likelyDays: a.likelyDays + b.likelyDays,
    maxDays:    a.maxDays    + b.maxDays,
  };
}

// ── Exported formatting ───────────────────────────────────────────────────────

export function formatDurationRange(d: DayEstimate): string {
  if (d.minDays === d.maxDays) {
    return `~${d.likelyDays} day${d.likelyDays === 1 ? '' : 's'}`;
  }
  return `${d.minDays}–${d.maxDays} days, likely ${d.likelyDays}`;
}

export function formatStoryDayRange(start: DayEstimate, end: DayEstimate): string {
  if (start.minDays === start.maxDays && end.minDays === end.maxDays) {
    return `Day ${start.likelyDays} to Day ${end.likelyDays}`;
  }
  return `Day ${start.minDays}–${end.maxDays}, likely Day ${start.likelyDays}–${end.likelyDays}`;
}

export function formatSeason(
  season: { value: string; confidence: number } | undefined,
): string {
  return season ? `${season.value} (${season.confidence.toFixed(2)})` : '(unknown)';
}

export function formatReference(ref: TimeReference): string {
  const role = ref.role ? `/${ref.role}` : '';
  const text = ref.text.length > 70 ? `${ref.text.slice(0, 67)}...` : ref.text;
  return `"${text}" [${ref.type}${role}, confidence ${ref.confidence.toFixed(2)}]`;
}

// Single point: "Day 310–420, likely Day 334" or just "Day 5"
function fmtDayPoint(d: DayEstimate): string {
  if (d.minDays === d.maxDays) return `Day ${d.likelyDays}`;
  return `Day ${d.minDays}–${d.maxDays}, likely Day ${d.likelyDays}`;
}

// ── Exported calculations ─────────────────────────────────────────────────────

export interface ChapterStoryPosition {
  chapter:                 TimeIndexItem;
  cumulativeBeforeChapter: DayEstimate;
  approxStartDay:          DayEstimate;
  approxEndDay:            DayEstimate;
  warnings:                string[];
}

export function calculateChapterStoryPosition(
  chapters: TimeIndexItem[],
  selectedChapterNumber: number,
): ChapterStoryPosition | null {
  const sorted = [...chapters].sort((a, b) => a.chapterNumber - b.chapterNumber);
  const target = sorted.find(c => c.chapterNumber === selectedChapterNumber);
  if (!target) return null;

  const warnings: string[] = [];
  let cum: DayEstimate = { ...ZERO };

  for (const ch of sorted) {
    if (ch.chapterNumber >= selectedChapterNumber) break;
    if (ch.chapterNumber > 1) {
      const g = normalizeDurationRange(ch.estimatedGapFromPrevious);
      if (g) cum = addDurationRanges(cum, g);
    }
    const sp = normalizeDurationRange(ch.coveredTimeSpan);
    if (sp) {
      cum = addDurationRanges(cum, sp);
    } else {
      warnings.push(`Ch${ch.chapterNumber}: missing coveredTimeSpan (treated as 0)`);
    }
  }

  let startDay = { ...cum };
  if (target.chapterNumber > 1) {
    const g = normalizeDurationRange(target.estimatedGapFromPrevious);
    if (g) {
      startDay = addDurationRanges(startDay, g);
    } else {
      warnings.push(`Ch${target.chapterNumber}: missing estimatedGapFromPrevious`);
    }
  }

  const sp = normalizeDurationRange(target.coveredTimeSpan);
  if (!sp) warnings.push(`Ch${target.chapterNumber}: missing coveredTimeSpan`);
  const endDay = addDurationRanges(startDay, sp ?? { ...ZERO });

  // Field-level validation
  if (!target.startSeason)   warnings.push(`Ch${target.chapterNumber}: missing startSeason`);
  if (!target.endSeason)     warnings.push(`Ch${target.chapterNumber}: missing endSeason`);
  if (!target.chapterAnchor) warnings.push(`Ch${target.chapterNumber}: missing chapterAnchor`);
  if (target.startSeason && target.startSeason.confidence < 0.7) {
    warnings.push(`Ch${target.chapterNumber}: startSeason confidence low (${target.startSeason.confidence.toFixed(2)})`);
  }
  if (target.endSeason && target.endSeason.confidence < 0.7) {
    warnings.push(`Ch${target.chapterNumber}: endSeason confidence low (${target.endSeason.confidence.toFixed(2)})`);
  }
  if (target.chapterAnchor && target.chapterAnchor.confidence < 0.7) {
    warnings.push(`Ch${target.chapterNumber}: chapterAnchor confidence low (${target.chapterAnchor.confidence.toFixed(2)})`);
  }
  const scene = normalizeDurationRange(target.sceneDuration);
  if (sp && scene && scene.likelyDays > sp.likelyDays) {
    warnings.push(`Ch${target.chapterNumber}: sceneDuration (${scene.likelyDays}d) exceeds coveredTimeSpan (${sp.likelyDays}d)`);
  }
  if (sp && sp.likelyDays === 0 && (target.references?.length ?? 0) > 1) {
    warnings.push(`Ch${target.chapterNumber}: coveredTimeSpan is 0 but ${target.references?.length} temporal references exist`);
  }
  if (!target.references?.length) {
    warnings.push(`Ch${target.chapterNumber}: no temporal references found`);
  }

  return { chapter: target, cumulativeBeforeChapter: cum, approxStartDay: startDay, approxEndDay: endDay, warnings };
}

export interface RangeChapterDetail {
  chapter:     TimeIndexItem;
  coveredSpan: DayEstimate | null;
  sceneTime:   DayEstimate | null;
}

export interface TimeRangeResult {
  startChapter:     TimeIndexItem;
  endChapter:       TimeIndexItem;
  swapped:          boolean;
  rangeStartDay:    DayEstimate;
  rangeEndDay:      DayEstimate;
  coveredStoryTime: DayEstimate;
  sceneTimeShown:   DayEstimate;
  startSeason:      { value: string; confidence: number } | undefined;
  endSeason:        { value: string; confidence: number } | undefined;
  includedChapters: RangeChapterDetail[];
  warnings:         string[];
}

export function calculateTimeRange(
  chapters: TimeIndexItem[],
  startChapterNumber: number,
  endChapterNumber: number,
): TimeRangeResult {
  const sorted = [...chapters].sort((a, b) => a.chapterNumber - b.chapterNumber);
  const warnings: string[] = [];
  let startN = startChapterNumber;
  let endN   = endChapterNumber;
  let swapped = false;

  if (startN > endN) {
    [startN, endN] = [endN, startN];
    swapped = true;
    warnings.push(`Chapter order swapped to Ch${startN} → Ch${endN}`);
  }

  const startCh = sorted.find(c => c.chapterNumber === startN);
  const endCh   = sorted.find(c => c.chapterNumber === endN);
  if (!startCh) warnings.push(`Ch${startN}: no timeIndex data`);
  if (!endCh)   warnings.push(`Ch${endN}: no timeIndex data`);

  const startPos = calculateChapterStoryPosition(chapters, startN);
  const endPos   = calculateChapterStoryPosition(chapters, endN);

  const rangeChs = sorted.filter(c => c.chapterNumber >= startN && c.chapterNumber <= endN);
  let covered:    DayEstimate = { ...ZERO };
  let sceneTotal: DayEstimate = { ...ZERO };
  const includedChapters: RangeChapterDetail[] = [];

  for (let i = 0; i < rangeChs.length; i++) {
    const ch = rangeChs[i];
    const sp = normalizeDurationRange(ch.coveredTimeSpan);
    const sc = normalizeDurationRange(ch.sceneDuration);

    if (!sp) warnings.push(`Ch${ch.chapterNumber}: missing coveredTimeSpan`);
    if (!sc) warnings.push(`Ch${ch.chapterNumber}: missing sceneDuration`);
    if (sp) covered    = addDurationRanges(covered, sp);
    if (sc) sceneTotal = addDurationRanges(sceneTotal, sc);
    if (sp && sc && sc.likelyDays > sp.likelyDays) {
      warnings.push(`Ch${ch.chapterNumber}: sceneDuration exceeds coveredTimeSpan`);
    }
    if (i > 0) {
      const g = normalizeDurationRange(ch.estimatedGapFromPrevious);
      if (g) {
        covered = addDurationRanges(covered, g);
      } else {
        warnings.push(`Ch${ch.chapterNumber}: missing estimatedGapFromPrevious (internal chapter)`);
      }
    }

    includedChapters.push({ chapter: ch, coveredSpan: sp, sceneTime: sc });
  }

  return {
    startChapter:     startCh ?? rangeChs[0],
    endChapter:       endCh   ?? rangeChs[rangeChs.length - 1],
    swapped,
    rangeStartDay:    startPos?.approxStartDay ?? { ...ZERO },
    rangeEndDay:      endPos?.approxEndDay     ?? { ...ZERO },
    coveredStoryTime: covered,
    sceneTimeShown:   sceneTotal,
    startSeason:      startCh?.startSeason,
    endSeason:        endCh?.endSeason,
    includedChapters,
    warnings,
  };
}

// ── QuickPick helpers ─────────────────────────────────────────────────────────

interface ChapterPickItem extends vscode.QuickPickItem {
  chapterNumber: number;
}

function buildPickItems(
  chapters: TimeIndexItem[],
  titleMap: Map<number, string>,
): ChapterPickItem[] {
  return [...chapters]
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
    .map(ch => {
      const title = titleMap.get(ch.chapterNumber);
      const label = title
        ? `Ch. ${ch.chapterNumber} — ${title}`
        : `Ch. ${ch.chapterNumber}`;
      const parts: string[] = [];
      if (ch.chapterAnchor) parts.push(ch.chapterAnchor.value);
      const sp = normalizeDurationRange(ch.coveredTimeSpan);
      if (sp) parts.push(formatDurationRange(sp));
      return { label, description: parts.join(' · '), chapterNumber: ch.chapterNumber };
    });
}

// ── Report builders ───────────────────────────────────────────────────────────

function buildChapterReport(
  pos: ChapterStoryPosition,
  titleMap: Map<number, string>,
): string {
  const { chapter: ch, approxStartDay, approxEndDay, warnings } = pos;
  const title   = titleMap.get(ch.chapterNumber);
  const heading = title
    ? `Chapter ${ch.chapterNumber}: ${title}`
    : `Chapter ${ch.chapterNumber}`;
  const sp  = normalizeDurationRange(ch.coveredTimeSpan);
  const sc  = normalizeDurationRange(ch.sceneDuration);
  const gap = normalizeDurationRange(ch.estimatedGapFromPrevious);
  const gapStr = gap
    ? formatDurationRange(gap)
    : ch.chapterNumber === 1 ? 'Day 0 (story start)' : '(missing)';

  const lines: string[] = [
    '# Draft-Script Time Inspector',
    '',
    `## ${heading}`,
    '',
    '### Story position',
    `  Approx start : ${fmtDayPoint(approxStartDay)}`,
    `  Approx end   : ${fmtDayPoint(approxEndDay)}`,
    '',
    '### Season',
    `  Start  : ${formatSeason(ch.startSeason)}`,
    `  End    : ${formatSeason(ch.endSeason)}`,
    `  Anchor : ${formatSeason(ch.chapterAnchor)}`,
    '',
    '### Durations',
    `  Covered story time : ${sp  ? formatDurationRange(sp)  : '(missing)'}`,
    `  Scene time shown   : ${sc  ? formatDurationRange(sc)  : '(missing)'}`,
    `  Gap from previous  : ${gapStr}`,
    '',
    '### Temporal references',
  ];

  if (ch.references?.length) {
    for (const r of ch.references) lines.push(`  ${formatReference(r)}`);
  } else {
    lines.push('  (none)');
  }

  lines.push('', '### Warnings');
  if (warnings.length) {
    for (const w of warnings) lines.push(`  ! ${w}`);
  } else {
    lines.push('  (none)');
  }

  return lines.join('\n');
}

function chLabel(ch: TimeIndexItem, titleMap: Map<number, string>): string {
  const t = titleMap.get(ch.chapterNumber);
  return t ? `Ch${ch.chapterNumber} — ${t}` : `Ch${ch.chapterNumber}`;
}

function buildRangeReport(
  result: TimeRangeResult,
  titleMap: Map<number, string>,
): string {
  const lines: string[] = [
    '# Draft-Script Time Inspector',
    '',
    `## Range: ${chLabel(result.startChapter, titleMap)} → ${chLabel(result.endChapter, titleMap)}`,
  ];
  if (result.swapped) lines.push('  (chapter order was swapped)');

  lines.push(
    '',
    '### Story position',
    `  Start : ${fmtDayPoint(result.rangeStartDay)}`,
    `  End   : ${fmtDayPoint(result.rangeEndDay)}`,
    '',
    '### Season movement',
    `  Start : ${formatSeason(result.startSeason)}`,
    `  End   : ${formatSeason(result.endSeason)}`,
    '',
    '### Time totals',
    `  Covered story time : ${formatDurationRange(result.coveredStoryTime)}`,
    `  Scene time shown   : ${formatDurationRange(result.sceneTimeShown)}`,
    '',
    '### Included chapters',
  );

  for (const { chapter, coveredSpan, sceneTime } of result.includedChapters) {
    const t   = titleMap.get(chapter.chapterNumber);
    const lbl = t ? `Ch${chapter.chapterNumber} (${t})` : `Ch${chapter.chapterNumber}`;
    const cov = coveredSpan ? formatDurationRange(coveredSpan) : '(missing)';
    const sc  = sceneTime   ? formatDurationRange(sceneTime)   : '(missing)';
    lines.push(`  ${lbl} : covered ${cov}, scene ${sc}`);
  }

  lines.push('', '### Warnings');
  if (result.warnings.length) {
    for (const w of result.warnings) lines.push(`  ! ${w}`);
  } else {
    lines.push('  (none)');
  }

  return lines.join('\n');
}

// ── Public commands ───────────────────────────────────────────────────────────

export async function inspectChapterTime(root: string, novelFolder: string): Promise<void> {
  if (!root) { vscode.window.showErrorMessage('DSM: No project folder open.'); return; }
  const chapters = readTimeIndex(root);
  if (!chapters.length) {
    vscode.window.showErrorMessage('DSM: No time index data found. Run DSM analysis first.');
    return;
  }
  const titleMap = buildTitleMap(novelFolder || root);
  const items    = buildPickItems(chapters, titleMap);
  const picked   = await vscode.window.showQuickPick(items, {
    title: 'Draft-Script: Inspect Chapter Time',
    placeHolder: 'Select a chapter...',
    matchOnDescription: true,
  });
  if (!picked) return;

  const pos = calculateChapterStoryPosition(chapters, picked.chapterNumber);
  if (!pos) {
    vscode.window.showErrorMessage(`DSM: No time index data for chapter ${picked.chapterNumber}.`);
    return;
  }
  const ch = getChannel();
  ch.clear();
  ch.appendLine(buildChapterReport(pos, titleMap));
  ch.show(true);
}

export async function inspectTimeRange(root: string, novelFolder: string): Promise<void> {
  if (!root) { vscode.window.showErrorMessage('DSM: No project folder open.'); return; }
  const chapters = readTimeIndex(root);
  if (!chapters.length) {
    vscode.window.showErrorMessage('DSM: No time index data found. Run DSM analysis first.');
    return;
  }
  const titleMap = buildTitleMap(novelFolder || root);
  const items    = buildPickItems(chapters, titleMap);

  const start = await vscode.window.showQuickPick(items, {
    title: 'Draft-Script: Inspect Time Range — Start Chapter',
    placeHolder: 'Select start chapter...',
    matchOnDescription: true,
  });
  if (!start) return;

  const end = await vscode.window.showQuickPick(items, {
    title: 'Draft-Script: Inspect Time Range — End Chapter',
    placeHolder: 'Select end chapter...',
    matchOnDescription: true,
  });
  if (!end) return;

  const result = calculateTimeRange(chapters, start.chapterNumber, end.chapterNumber);
  const ch = getChannel();
  ch.clear();
  ch.appendLine(buildRangeReport(result, titleMap));
  ch.show(true);
}

export async function inspectCurrentChapterTime(root: string, novelFolder: string): Promise<void> {
  if (!root) { vscode.window.showErrorMessage('DSM: No project folder open.'); return; }
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document.fileName.endsWith('.md')) {
    vscode.window.showErrorMessage('DSM: Open a Markdown chapter file first.');
    return;
  }
  const chapters = readTimeIndex(root);
  if (!chapters.length) {
    vscode.window.showErrorMessage('DSM: No time index data found. Run DSM analysis first.');
    return;
  }
  const numMatch = path.basename(editor.document.fileName).match(/(\d+)/);
  if (!numMatch) {
    vscode.window.showErrorMessage('DSM: Cannot determine chapter number from filename.');
    return;
  }
  const chapterNumber = parseInt(numMatch[1], 10);
  const pos = calculateChapterStoryPosition(chapters, chapterNumber);
  if (!pos) {
    vscode.window.showErrorMessage(`DSM: No time index data for chapter ${chapterNumber}.`);
    return;
  }
  const titleMap = buildTitleMap(novelFolder || root);
  const ch = getChannel();
  ch.clear();
  ch.appendLine(buildChapterReport(pos, titleMap));
  ch.show(true);
}
