import * as vscode from 'vscode';
import * as fs   from 'fs';
import * as path from 'path';
import { parseCharacterGroups } from '../utils/markdownParser';
import { CanonManager, normalizeId } from '../dsm/canonManager';

export async function importDsmCharacters(getRootFolder: () => string): Promise<void> {
  const rootFolder = getRootFolder();
  if (!rootFolder) {
    vscode.window.showWarningMessage('Draft-Script: No workspace folder found.');
    return;
  }

  // Read canon characters
  const canon       = new CanonManager(rootFolder);
  const canonChars  = canon.read('characters');

  if (canonChars.length === 0) {
    vscode.window.showInformationMessage(
      'DSM: No characters in canon yet. Analyze chapters and approve entities first.'
    );
    return;
  }

  // Read existing characters.md names (normalized for comparison)
  const charPath = path.join(rootFolder, 'characters.md');
  const existing = new Set<string>();
  if (fs.existsSync(charPath)) {
    try {
      const content = fs.readFileSync(charPath, 'utf-8');
      for (const group of parseCharacterGroups(content)) {
        for (const c of group.characters) existing.add(normalizeId(c.name));
      }
    } catch { /* ignore */ }
  }

  // Find canon chars not yet in characters.md
  const candidates = canonChars.filter(c => !existing.has(normalizeId(c.name)));

  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      'DSM: All canon characters are already in characters.md.'
    );
    return;
  }

  // Show QuickPick — all pre-checked
  const items: vscode.QuickPickItem[] = candidates.map(c => ({
    label:       c.name,
    description: c.aliases.length ? c.aliases.join(', ') : undefined,
    detail:      c.description   || undefined,
    picked:      true,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    canPickMany:        true,
    title:              `Import characters from DSM canon (${candidates.length} new)`,
    placeHolder:        'All selected — uncheck to exclude. Press Enter to import.',
    matchOnDescription: true,
    matchOnDetail:      true,
  });

  if (!selected || selected.length === 0) return;

  const toImport = candidates.filter(c => selected.some(s => s.label === c.name));
  appendToCharactersMd(charPath, toImport);

  vscode.window.showInformationMessage(
    `Draft-Script: Imported ${toImport.length} character${toImport.length === 1 ? '' : 's'} into characters.md.`
  );

  await vscode.commands.executeCommand('draftScript.refreshCharacters');
}

function appendToCharactersMd(
  charPath: string,
  entries:  { name: string; description: string; aliases: string[] }[]
): void {
  const block = entries
    .map(e => {
      const aliasLine = e.aliases.length ? `*Also known as: ${e.aliases.join(', ')}*\n\n` : '';
      return `## ${e.name}\n\n${aliasLine}${e.description || ''}`.trimEnd();
    })
    .join('\n\n');

  if (!fs.existsSync(charPath)) {
    fs.writeFileSync(charPath, `# Imported\n\n${block}\n`, 'utf-8');
    return;
  }

  const existing  = fs.readFileSync(charPath, 'utf-8');
  const hasGroup  = /^#\s/m.test(existing);
  const separator = hasGroup ? '' : '\n\n# Imported\n\n';
  fs.writeFileSync(charPath, `${existing.trimEnd()}\n${separator}\n${block}\n`, 'utf-8');
}
