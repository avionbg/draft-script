import * as path from 'path';
import { PromptDefinition, PromptRunContext, RenderedPrompt, RenderedPromptBlockStats } from './types';
import { buildContextBlocks } from './contextBuilder';
import { assemblePrompt }     from './promptAssembler';
import { resolveIncludes }    from './includeResolver';

const INCLUDES_DIR = path.join('.draft-script', 'prompts', '_includes');

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export function buildPrompt(def: PromptDefinition, ctx: PromptRunContext): RenderedPrompt {
  // ── Step 1: resolve {{include:name}} directives ────────────────────────────
  const includesDir = path.join(ctx.rootFolder, INCLUDES_DIR);
  const { resolvedBody, tree, errors, totalIncludeChars } = resolveIncludes(def.body, includesDir);

  // ── Step 2: build context blocks ──────────────────────────────────────────
  const blocks = buildContextBlocks(def, ctx);

  // ── Step 3: substitute {{placeholders}} ───────────────────────────────────
  const overrides: Record<string, string> = {};
  if (ctx.chapterNumber != null) overrides['nextChapterNumber'] = String(ctx.chapterNumber + 1);
  overrides['userBrief'] = ctx.userBrief?.trim() ?? '';
  const finalPrompt = assemblePrompt(resolvedBody, blocks, overrides);

  // ── Step 4: compute stats ─────────────────────────────────────────────────
  const blockStats: RenderedPromptBlockStats[] = blocks.map(b => {
    const chars  = b.content.length;
    const words  = countWords(b.content);
    const tokens = estimateTokens(chars);
    return { id: b.id, title: b.heading, chars, words, tokens };
  });

  const totalChars  = finalPrompt.length;
  const totalWords  = countWords(finalPrompt);
  const totalTokens = estimateTokens(totalChars);

  return {
    promptId:        def.id,
    promptTitle:     def.title,
    finalPrompt,
    estimatedChars:  totalChars,
    estimatedWords:  totalWords,
    estimatedTokens: totalTokens,
    contextBlocks:   blockStats,
    includeTree:     tree,
    includeErrors:   errors,
    includeTokens:   estimateTokens(totalIncludeChars),
    generatedAt:     new Date().toISOString(),
  };
}
