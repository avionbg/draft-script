import * as vscode from 'vscode';
import { CanonCharacter, loadCanonCharacters, buildCanonRegex } from '../dsm/canonCharacters';
import { DEFAULT_INFLECTION_SUFFIXES, MentionOptions } from '../utils/markdownParser';

export class CharacterHoverProvider implements vscode.HoverProvider {
  private _cache: CanonCharacter[] | undefined;

  constructor(private readonly getRootFolder: () => string) {}

  refresh(): void {
    this._cache = undefined;
  }

  private getCharacters(): CanonCharacter[] {
    if (!this._cache) this._cache = loadCanonCharacters(this.getRootFolder());
    return this._cache;
  }

  private mentionOptions(): MentionOptions {
    const cfg = vscode.workspace.getConfiguration('draftScript');
    return {
      inflections: cfg.get<boolean>('characterInflections', false),
      suffixes: cfg.get<string[]>('inflectionSuffixes', DEFAULT_INFLECTION_SUFFIXES),
      feminineIn: cfg.get<boolean>('inflectionFeminineIn', false),
    };
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    if (document.languageId !== 'markdown') return;

    const cfg = vscode.workspace.getConfiguration('draftScript');
    if (!cfg.get<boolean>('characterHover', true)) return;

    // Unicode-aware word range — covers diacritic characters in Slavic names
    const wordRange = document.getWordRangeAtPosition(position, /[\p{L}-]+/u);
    if (!wordRange) return;

    const word = document.getText(wordRange);
    if (word.length < 2) return;

    for (const char of this.getCharacters()) {
      const re = buildCanonRegex(char.name, char.aliases, this.mentionOptions());
      re.lastIndex = 0;
      if (re.test(word)) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${char.name}**`);
        if (char.description) md.appendMarkdown(`\n\n${char.description}`);
        if (char.aliases.length > 0) {
          md.appendMarkdown(`\n\n*Aliases: ${char.aliases.join(', ')}*`);
        }
        md.isTrusted = true;
        return new vscode.Hover(md, wordRange);
      }
    }
  }
}
