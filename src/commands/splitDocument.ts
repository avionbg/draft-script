import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

interface Section {
  title: string;
  level: number;
  /** Raw body text (everything between this heading and the next heading). */
  body: string;
  children: Section[];
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a nested section tree from raw markdown lines. */
function parseSections(lines: string[]): { sections: Section[]; preamble: string } {
  const sections: Section[] = [];
  const stack: Section[] = [];
  const preambleLines: string[] = [];
  let currentSection: Section | null = null;
  let bodyBuffer: string[] = [];
  let beforeFirstHeading = true;

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+)/);

    if (m) {
      // Flush body buffer to the previous section
      if (currentSection) {
        currentSection.body = bodyBuffer.join('\n').trim();
        bodyBuffer = [];
      }
      beforeFirstHeading = false;

      const level = m[1].length;
      const title = m[2].trim();
      const newSection: Section = { title, level, body: '', children: [] };

      // Pop until we find a parent with strictly lower level
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      if (stack.length === 0) {
        sections.push(newSection);
      } else {
        stack[stack.length - 1].children.push(newSection);
      }
      stack.push(newSection);
      currentSection = newSection;
    } else {
      if (beforeFirstHeading) {
        preambleLines.push(line);
      } else {
        bodyBuffer.push(line);
      }
    }
  }

  // Flush final buffer
  if (currentSection && bodyBuffer.length > 0) {
    currentSection.body = bodyBuffer.join('\n').trim();
  }

  return { sections, preamble: preambleLines.join('\n').trim() };
}

function countTotalSections(sections: Section[]): number {
  let n = sections.length;
  for (const s of sections) n += countTotalSections(s.children);
  return n;
}

/**
 * Write sections recursively.
 *
 * Rules:
 *  - A section with NO children → written as `<basePath>/<title>.md`
 *  - A section WITH children    → folder `<basePath>/<title>/` is created;
 *    if the section has its own body it is saved as `<basePath>/<title>/<title>.md`;
 *    children are then written inside that folder.
 */
async function writeSections(sections: Section[], basePath: string): Promise<void> {
  for (const section of sections) {
    const safeName = sanitizeFilename(section.title);

    if (section.children.length > 0) {
      const folderPath = path.join(basePath, safeName);
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }
      // Save this section's own body as an index file if it has content
      if (section.body) {
        const indexPath = path.join(folderPath, `${safeName}.md`);
        const heading = '#'.repeat(section.level);
        fs.writeFileSync(indexPath, `${heading} ${section.title}\n\n${section.body}\n`, 'utf-8');
      }
      await writeSections(section.children, folderPath);
    } else {
      const filePath = path.join(basePath, `${safeName}.md`);
      const heading = '#'.repeat(section.level);
      const content = section.body
        ? `${heading} ${section.title}\n\n${section.body}\n`
        : `${heading} ${section.title}\n`;
      fs.writeFileSync(filePath, content, 'utf-8');
    }
  }
}

/**
 * Command: split the active Markdown file into per-heading files/folders
 * inside the novel folder.
 */
export async function splitDocument(novelFolder: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Draft-Script: No active editor.');
    return;
  }
  if (editor.document.languageId !== 'markdown') {
    vscode.window.showWarningMessage('Draft-Script: Active file is not a Markdown file.');
    return;
  }

  if (!novelFolder) {
    vscode.window.showErrorMessage('Draft-Script: No novel folder configured.');
    return;
  }

  const content = editor.document.getText();
  const lines = content.split('\n');
  const { sections, preamble } = parseSections(lines);

  if (sections.length === 0) {
    vscode.window.showWarningMessage('Draft-Script: No headings found in the document.');
    return;
  }

  const totalSections = countTotalSections(sections);
  const answer = await vscode.window.showInformationMessage(
    `Split "${path.basename(editor.document.fileName)}" into ${totalSections} section(s) inside the novel folder?`,
    { modal: true },
    'Split'
  );
  if (answer !== 'Split') return;

  // Write any pre-heading preamble
  if (preamble) {
    fs.writeFileSync(path.join(novelFolder, '_preamble.md'), preamble + '\n', 'utf-8');
  }

  await writeSections(sections, novelFolder);
  vscode.window.showInformationMessage(
    `Draft-Script: Split into ${totalSections} section(s) successfully.`
  );
}
