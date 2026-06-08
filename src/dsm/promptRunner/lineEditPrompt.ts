import { buildPrompt } from './promptBuilder';
import { PromptDefinition, PromptRunContext, RenderedPrompt } from './types';
import { PromptRegistry } from './promptRegistry';

export const LINE_EDIT_PROMPT_MISSING =
  'No line edit prompt found. Add a prompt with line-edit: true in YAML frontmatter.';

const REQUIRED_PLACEHOLDERS = ['context', 'phrase', 'itemsJson'] as const;

export interface LineEditPromptInput {
  rootFolder: string;
  context: string;
  phrase: string;
  sentence: string;
  itemsJson?: string;
  chapterTitle?: string;
  chapterNumber?: number;
  filePath?: string;
  before?: string;
  after?: string;
  language?: string;
}

export interface RenderedLineEditPrompt {
  definition: PromptDefinition;
  rendered: RenderedPrompt;
  warnings: string[];
}

export function findLineEditPrompt(registry: PromptRegistry): PromptDefinition | undefined {
  return registry.getLineEditPrompt();
}

export function renderLineEditPrompt(
  registry: PromptRegistry,
  input: LineEditPromptInput,
): RenderedLineEditPrompt | null {
  const definition = findLineEditPrompt(registry);
  if (!definition) return null;

  const warnings = validateLineEditPrompt(definition);
  const ctx: PromptRunContext = {
    rootFolder: input.rootFolder,
    chapterTitle: input.chapterTitle,
    chapterNumber: input.chapterNumber,
    chapterPath: input.filePath,
    promptVariables: {
      context: input.context,
      phrase: input.phrase,
      sentence: input.sentence,
      itemsJson: input.itemsJson ?? '',
      chapterTitle: input.chapterTitle ?? '',
      chapterNumber: input.chapterNumber != null ? String(input.chapterNumber) : '',
      filePath: input.filePath ?? '',
      before: input.before ?? '',
      after: input.after ?? '',
      language: input.language ?? '',
    },
  };

  const rendered = buildPrompt(definition, ctx);
  for (const key of REQUIRED_PLACEHOLDERS) {
    const value = input[key];
    if (value && !rendered.finalPrompt.includes(value)) {
      warnings.push(`Rendered line edit prompt does not include {{${key}}}.`);
    }
  }

  return { definition, rendered, warnings };
}

export function validateLineEditPrompt(definition: PromptDefinition): string[] {
  const warnings: string[] = [];
  for (const key of REQUIRED_PLACEHOLDERS) {
    if (!definition.body.includes(`{{${key}}}`)) {
      warnings.push(`Line edit prompt "${definition.id}" is missing {{${key}}}.`);
    }
  }
  return warnings;
}
