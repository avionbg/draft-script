import * as fs from 'fs';
import * as path from 'path';

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const DSM_PROMPT_RESOURCE_DIR = path.join(EXTENSION_ROOT, 'resources', 'prompts', 'dsm');
const BUNDLED_DSM_ANALYSIS_PROMPT = path.join(EXTENSION_ROOT, 'prompts', 'dsm-analysis.md');

export function stripPromptFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart();
}

export function readDsmPromptResource(name: string): string {
  if (name === 'analysis.md') {
    return stripPromptFrontmatter(fs.readFileSync(BUNDLED_DSM_ANALYSIS_PROMPT, 'utf-8'));
  }
  return fs.readFileSync(path.join(DSM_PROMPT_RESOURCE_DIR, name), 'utf-8');
}

export function readBundledDsmAnalysisPromptFile(): string {
  return fs.readFileSync(BUNDLED_DSM_ANALYSIS_PROMPT, 'utf-8');
}
