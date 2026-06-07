import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** Returns the next unused link ID by scanning notes.md for existing <!-- Link-N --> markers. */
function nextLinkId(notesContent: string): number {
  const ids = [...notesContent.matchAll(/^<!-- Link-(\d+) -->/gm)]
    .map(m => parseInt(m[1], 10));
  return ids.length === 0 ? 1 : Math.max(...ids) + 1;
}

/**
 * Command: wrap selected text with <!--link-N-->...<!--/link-N-->
 * and append a corresponding entry to notes.md in the workspace root folder.
 */
export async function addComment(rootFolder: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Draft-Script: No active editor.');
    return;
  }
  if (editor.selection.isEmpty) {
    vscode.window.showWarningMessage('Draft-Script: Select the text you want to annotate first.');
    return;
  }

  const selectedText = editor.document.getText(editor.selection);

  const comment = await vscode.window.showInputBox({
    title: 'Draft-Script: Add Comment',
    prompt: 'Enter your note for the selected passage',
    placeHolder: 'Your comment…',
  });
  if (comment === undefined) return; // cancelled

  const notesPath = path.join(rootFolder, 'notes.md');
  let existing = '';
  try { existing = fs.readFileSync(notesPath, 'utf-8'); }
  catch { existing = '# Notes\n'; }

  const id = nextLinkId(existing);
  const open  = `<!--link-${id}-->`;
  const close = `<!--/link-${id}-->`;

  // Wrap the selection in the source document
  await editor.edit(eb => eb.replace(editor.selection, `${open}${selectedText}${close}`));

  // Truncate the excerpt for the notes entry
  const excerpt = selectedText.length > 100
    ? selectedText.slice(0, 100).trimEnd() + '…'
    : selectedText;

  const entry = [
    ``,
    `<!-- Link-${id} -->`,
    ``,
    `> ${excerpt.replace(/\n/g, '\n> ')}`,
    ``,
    comment || '*(no comment)*',
    ``,
    `---`,
  ].join('\n');

  fs.writeFileSync(notesPath, existing.trimEnd() + '\n' + entry + '\n', 'utf-8');

  const action = await vscode.window.showInformationMessage(
    `Draft-Script: Saved as Link ${id} in notes.md.`,
    'Open Notes'
  );
  if (action === 'Open Notes') {
    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(notesPath));
  }
}
