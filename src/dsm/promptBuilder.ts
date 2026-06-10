import { Candidate } from './localExtractor';
import { ChapterAnalysis, Signal, ThreadIndexItem, ThreadUpdate } from './draftScriptTypes';
import { readDsmPromptResource } from './promptResources';

const MAX_CONTEXT_ITEMS = 20;

function buildSchema(signals: Signal[]): string {
  const signalsField = signals.length
    ? '\n      "signals": ["signal_id_here"],'
    : '';

  return readDsmPromptResource('analysis-schema.md')
    .split('{{signalsField}}')
    .join(signalsField);
}

function buildSignalsBlock(signals: Signal[]): string {
  if (!signals.length) return '';
  const list = signals.map(s => `- ${s.id}\n  ${s.description}`).join('\n');
  return `Available Signals

Signals are semantic labels for recurring narrative patterns, themes, or behaviors.
You MUST only assign signals from the list below - never invent, modify, or abbreviate an ID.
Assign zero or more signals to threads, timelineEvents, and continuityNotes when applicable.
If no signal from the list fits, omit the signals field entirely.

Available signals (use ONLY these exact IDs):
${list}`;
}

function renderAnalysisTemplate(
  template:     string,
  text:         string,
  hints:        string,
  contextBlock: string,
  signalsBlock: string,
  schema:       string,
): string {
  let result = template;
  if (result.includes('{{candidates}}')) {
    result = result.replace('{{candidates}}', hints);
  } else {
    result += `\n\nPre-extracted name candidates:\n${hints}`;
  }
  if (result.includes('{{context}}')) {
    result = result.replace('{{context}}', contextBlock);
  } else if (contextBlock) {
    result += `\n\n${contextBlock}`;
  }
  if (result.includes('{{signals}}')) {
    result = result.replace('{{signals}}', signalsBlock);
  } else if (signalsBlock) {
    result += `\n\n${signalsBlock}`;
  }
  if (result.includes('{{text}}')) {
    result = result.replace('{{text}}', text);
  } else {
    result += `\n\nText:\n"""\n${text}\n"""`;
  }
  if (result.includes('{{schema}}')) {
    result = result.replace('{{schema}}', schema);
  } else {
    result += `\n\n${schema}`;
  }
  return result;
}

export function buildPrompt(
  text:              string,
  candidates:        Candidate[],
  customTemplate?:   string,
  existingAnalyses?: Pick<ChapterAnalysis, 'threads' | 'timelineEvents'>[],
  signals:           Signal[] = [],
  knownThreads:      ThreadIndexItem[] = [],
): string {
  const hints = candidates.length
    ? candidates
        .map(c => `  - "${c.candidate}" (${c.mentions}x) - e.g.: "${c.contexts[0] ?? ''}"`)
        .join('\n')
    : '  (none detected)';

  const contextBlock  = buildContextBlock(existingAnalyses, knownThreads);
  const schema        = buildSchema(signals);
  const signalsBlock  = buildSignalsBlock(signals);

  if (customTemplate) {
    return renderAnalysisTemplate(customTemplate, text, hints, contextBlock, signalsBlock, schema);
  }

  return renderAnalysisTemplate(
    readDsmPromptResource('analysis.md'),
    text,
    hints,
    contextBlock,
    signalsBlock,
    schema,
  );
}

function buildContextBlock(
  analyses?: Pick<ChapterAnalysis, 'threads' | 'timelineEvents'>[],
  knownThreads: ThreadIndexItem[] = [],
): string {
  if (!analyses?.length && !knownThreads.length) return '';
  const lines: string[] = [];

  const allThreads = knownThreads.length
    ? knownThreads
        .filter(t => t.status === 'open' || t.status === 'active' || t.needsReview)
        .slice(0, MAX_CONTEXT_ITEMS)
    : analyses
        ?.flatMap(a => a.threads)
        .filter(t => t.status === 'open' || t.status === 'active')
        .slice(0, MAX_CONTEXT_ITEMS) ?? [];

  if (allThreads.length) {
    lines.push('Known active/open threads (already indexed - reference by exact title if relevant, and return lifecycle updates when this chapter changes them):');
    for (const t of allThreads) {
      lines.push(renderKnownThread(t));
    }
  }

  const allEvents = (analyses?.flatMap(a => a.timelineEvents) ?? [])
    .slice(0, MAX_CONTEXT_ITEMS);

  if (allEvents.length) {
    lines.push('Known timeline events (already indexed):');
    for (const e of allEvents) {
      lines.push(`  - "${e.title}"`);
    }
  }

  return lines.join('\n');
}

function renderKnownThread(t: ThreadIndexItem | ThreadUpdate): string {
  if ('appearances' in t) {
    const lines = [`  - "${t.title}" [${t.type}, ${t.status}]`];
    lines.push(`    Description: ${t.description}`);
    if (t.lastSeenChapter != null) lines.push(`    Last seen: Ch. ${t.lastSeenChapter}`);
    if (t.lastKnownState) lines.push(`    Last known state: ${t.lastKnownState}`);
    if (t.unresolvedQuestion) lines.push(`    Unresolved question: ${t.unresolvedQuestion}`);
    if (t.parentThread) lines.push(`    Parent thread: ${t.parentThread}`);
    const history = (t.history ?? []).slice(-3);
    if (history.length) {
      lines.push('    Recent history:');
      for (const h of history) {
        lines.push(`    - Ch. ${h.chapter}: ${h.summary}`);
      }
    }
    return lines.join('\n');
  }
  return `  - "${t.title}" [${t.type}, ${t.status}]\n    Description: ${t.description}`;
}
