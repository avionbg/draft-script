import * as fs   from 'fs';
import * as path from 'path';
import { CharacterIndexItem, CanonOverride } from './draftScriptTypes';

export interface CanonCharacter {
  id:          string;
  name:        string;
  description: string;
  aliases:     string[];
}

/** Read characters from the DSM index + manual overrides.
 *  Index entries already have overrides merged by IndexBuilder.
 *  Override-only entries are characters added via Canon Editor before any analysis. */
export function loadCanonCharacters(root: string): CanonCharacter[] {
  const indexPath     = path.join(root, '.draft-script', 'indexes', 'characters.json');
  const overridesPath = path.join(root, '.draft-script', 'overrides', 'canon.characters.json');

  let indexItems: CharacterIndexItem[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    if (Array.isArray(raw)) indexItems = raw as CharacterIndexItem[];
  } catch { /* no index yet — project not analyzed */ }

  let overrides: Record<string, CanonOverride> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(overridesPath, 'utf-8'));
    if (raw && typeof raw === 'object') overrides = raw as Record<string, CanonOverride>;
  } catch { /* no overrides yet */ }

  const seen   = new Set<string>();
  const result: CanonCharacter[] = [];

  for (const item of indexItems) {
    seen.add(item.id);
    result.push({
      id:          item.id,
      name:        item.name,
      description: item.canonDescription
        ?? item.generatedDescriptions.at(-1)?.description
        ?? '',
      aliases: item.aliases ?? [],
    });
  }

  // Characters created via Canon Editor "New" before any DSM analysis
  for (const [id, override] of Object.entries(overrides)) {
    if (seen.has(id) || !override.title) continue;
    result.push({
      id,
      name:        override.title,
      description: override.description ?? '',
      aliases:     override.aliases ?? [],
    });
  }

  return result;
}

/** Build a Unicode word-boundary regex matching the character's name and all aliases.
 *  Aliases replace suffix-based inflection — explicit beats guessed. */
export function buildCanonRegex(name: string, aliases: string[]): RegExp {
  const terms = [name, ...aliases]
    .map(t => t.trim())
    .filter(t => t.length > 0)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length); // longer alternatives first
  if (terms.length === 0) return /(?!)/giu;
  return new RegExp(
    `(?<![\\p{L}\\d-])(${terms.join('|')})(?![\\p{L}\\d-])`,
    'giu',
  );
}
