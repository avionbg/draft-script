import { RenderedContextBlock } from './types';

const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

export function assemblePrompt(
  body: string,
  blocks: RenderedContextBlock[],
  overrides: Record<string, string> = {}
): string {
  // Aggregate all non-main-text blocks into {{context}}
  // chapterMeta IS included so prompts using {{context}} get chapter info alongside index data
  const contextText = blocks
    .filter(b => b.id !== 'chapterText' && b.id !== 'selectedText')
    .map(b => `### ${b.heading}\n\n${b.content}`)
    .join('\n\n---\n\n');

  const blockMap = new Map<string, string>(blocks.map(b => [b.id, b.content]));

  return body.replace(PLACEHOLDER_RE, (_, key: string) => {
    if (key in overrides)        return overrides[key];
    if (key === 'context')       return contextText;
    return blockMap.get(key) ?? `[${key}: not available]`;
  });
}
