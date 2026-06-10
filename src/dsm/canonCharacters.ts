import * as fs   from 'fs';
import * as path from 'path';
import { CharacterIndexItem } from './draftScriptTypes';
import { CanonManager } from './canonManager';
import { OverrideStore } from './overrideStore';
import { buildMentionRegex, MentionOptions } from '../utils/markdownParser';

export interface CanonCharacter {
  id:          string;
  name:        string;
  description: string;
  aliases:     string[];
}

/** Read effective canon characters. Index data contributes appearances/descriptions only. */
export function loadCanonCharacters(root: string): CanonCharacter[] {
  const indexPath     = path.join(root, '.draft-script', 'indexes', 'characters.json');

  let indexItems: CharacterIndexItem[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    if (Array.isArray(raw)) indexItems = raw as CharacterIndexItem[];
  } catch { /* no index yet — project not analyzed */ }

  const byId = new Map(indexItems.map(item => [item.id, item]));
  const canon = new CanonManager(root);
  const overrides = new OverrideStore(root).readCanon('characters');

  return canon.readEffective('characters', overrides).map(entry => {
    const indexed = byId.get(entry.id);
    return {
      id:          entry.id,
      name:        entry.name,
      description: entry.description
        || indexed?.canonDescription
        || indexed?.generatedDescriptions.at(-1)?.description
        || '',
      aliases: entry.aliases ?? [],
    };
  });
}

/** Build a Unicode word-boundary regex matching the character's name and all aliases.
 *  Aliases replace suffix-based inflection — explicit beats guessed. */
export function buildCanonRegex(name: string, aliases: string[], options: MentionOptions = {}): RegExp {
  const terms = [name, ...aliases].map(t => t.trim()).filter(t => t.length > 0);
  if (terms.length === 0) return /(?!)/giu;

  const parts = terms
    .map(term => buildMentionRegex(term, options).source)
    .sort((a, b) => b.length - a.length);

  return new RegExp(`(?:${parts.join('|')})`, 'giu');
}
