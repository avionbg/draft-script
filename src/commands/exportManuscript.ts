import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { getAllMarkdownFiles } from '../utils/markdownParser';

type ExportFormat = 'docx' | 'epub' | 'html' | 'pdf';

interface ExportFormatConfig {
  enabled?: boolean;
  referenceDoc?: string;
  cover?: string;
  engine?: string;
  template?: string;
}

interface ProjectExportConfig {
  title?: string;
  subtitle?: string;
  author?: string;
  language?: string;
  outputDir?: string;
  formats?: Partial<Record<ExportFormat, ExportFormatConfig>>;
}

interface ResolvedExportConfig {
  title: string;
  subtitle: string;
  author: string;
  language: string;
  outputDir: string;
  pandocPath: string;
  defaultFormat: ExportFormat;
  pdfEngine: string;
  openAfterExport: boolean;
  referenceDocx: string;
  epubCover: string;
  template: string;
  project: ProjectExportConfig;
}

interface BuildResult {
  outputPath: string;
  sourceFiles: string[];
  uncertainOrder: boolean;
}

const OUTPUT_CHANNEL_NAME = 'Draft-Script Export';
const SUPPORTED_FORMATS: ExportFormat[] = ['docx', 'epub', 'html', 'pdf'];
let outputChannel: vscode.OutputChannel | undefined;

function output(): vscode.OutputChannel {
  outputChannel ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  return outputChannel;
}

function log(message: string): void {
  output().appendLine(message);
}

function readProjectConfig(rootFolder: string): ProjectExportConfig {
  const file = path.join(rootFolder, '.draft-script', 'export.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as ProjectExportConfig
      : {};
  } catch {
    return {};
  }
}

function setting<T>(name: string, fallback: T): T {
  return vscode.workspace.getConfiguration('draftScript').get<T>(name, fallback);
}

function normalizeFormat(value: string | undefined): ExportFormat {
  const lower = (value ?? '').toLowerCase();
  return SUPPORTED_FORMATS.includes(lower as ExportFormat) ? lower as ExportFormat : 'docx';
}

function resolveExportConfig(rootFolder: string): ResolvedExportConfig {
  const project = readProjectConfig(rootFolder);
  const docx = project.formats?.docx ?? {};
  const epub = project.formats?.epub ?? {};
  const pdf = project.formats?.pdf ?? {};
  const configuredOutputDir = project.outputDir || setting<string>('export.outputDir', 'exports');

  return {
    title: project.title?.trim() || deriveProjectTitle(rootFolder),
    subtitle: project.subtitle?.trim() || '',
    author: project.author?.trim() || '',
    language: project.language?.trim() || '',
    outputDir: configuredOutputDir.trim() || 'exports',
    pandocPath: setting<string>('export.pandocPath', 'pandoc').trim() || 'pandoc',
    defaultFormat: normalizeFormat(setting<string>('export.defaultFormat', 'docx')),
    pdfEngine: pdf.engine?.trim() || setting<string>('export.pdfEngine', 'xelatex').trim() || 'xelatex',
    openAfterExport: setting<boolean>('export.openAfterExport', true),
    referenceDocx: docx.referenceDoc?.trim() || setting<string>('export.referenceDocx', '').trim(),
    epubCover: epub.cover?.trim() || setting<string>('export.epubCover', '').trim(),
    template: pdf.template?.trim() || setting<string>('export.template', '').trim(),
    project,
  };
}

function deriveProjectTitle(rootFolder: string): string {
  return path.basename(rootFolder) || 'manuscript';
}

function resolveProjectPath(rootFolder: string, value: string): string {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.join(rootFolder, value);
}

function outputDirPath(rootFolder: string, cfg: ResolvedExportConfig): string {
  return resolveProjectPath(rootFolder, cfg.outputDir);
}

function outputManuscriptPath(rootFolder: string, cfg: ResolvedExportConfig): string {
  return path.join(outputDirPath(rootFolder, cfg), 'manuscript.md');
}

function firstPathSegment(rootFolder: string, filePath: string): string {
  const rel = path.relative(rootFolder, filePath);
  return rel.split(path.sep)[0] ?? '';
}

function discoverManuscriptFiles(rootFolder: string, outputDir: string): { files: string[]; uncertainOrder: boolean } {
  const excluded = new Set<string>(setting<string[]>('navigatorExclude', []));
  const outputSegment = firstPathSegment(rootFolder, outputDir);
  if (outputSegment) excluded.add(outputSegment);

  const files = getAllMarkdownFiles(rootFolder).filter(file => {
    const base = path.basename(file);
    if (base === 'characters.md') return false;
    if (base === 'notes.md') return false;
    const firstSegment = firstPathSegment(rootFolder, file);
    return !excluded.has(firstSegment);
  });

  return { files, uncertainOrder: hasUncertainMultiFileOrder(files) };
}

function hasUncertainMultiFileOrder(files: string[]): boolean {
  if (files.length <= 1) return false;
  return files.some(file => !/(?:^|[^\d])\d{1,4}(?:[^\d]|$)/.test(path.basename(file)));
}

function joinMarkdownParts(parts: string[]): string {
  return parts
    .map(part => part.trim())
    .filter(Boolean)
    .join('\n\n')
    .trimEnd() + '\n';
}

export async function buildManuscriptMarkdown(rootFolder: string, showDoneMessage = true): Promise<BuildResult | undefined> {
  const channel = output();
  channel.clear();

  if (!rootFolder || !fs.existsSync(rootFolder)) {
    vscode.window.showErrorMessage('Draft-Script: No novel folder configured or folder does not exist.');
    return undefined;
  }

  const cfg = resolveExportConfig(rootFolder);
  const outDir = outputDirPath(rootFolder, cfg);
  const outFile = outputManuscriptPath(rootFolder, cfg);
  const { files, uncertainOrder } = discoverManuscriptFiles(rootFolder, outDir);

  log(`[build] root: ${rootFolder}`);
  log(`[build] output: ${outFile}`);
  log(`[build] source files: ${files.length}`);
  for (const file of files) log(`  - ${path.relative(rootFolder, file)}`);

  if (!files.length) {
    vscode.window.showWarningMessage('Draft-Script: No manuscript Markdown files found.');
    return undefined;
  }

  if (uncertainOrder) {
    vscode.window.showWarningMessage('Draft-Script: Manuscript file order may be uncertain; using navigator filename order.');
    log('[build] warning: order may be uncertain; using discovered filename order.');
  }

  const parts: string[] = [];
  for (const file of files) {
    try {
      parts.push(fs.readFileSync(file, 'utf-8'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[build] skipped ${file}: ${msg}`);
      vscode.window.showWarningMessage(`Draft-Script: Could not read ${path.basename(file)}, skipping.`);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, joinMarkdownParts(parts), 'utf-8');
  log(`[build] complete: ${outFile}`);

  if (showDoneMessage) {
    const action = await vscode.window.showInformationMessage(
      `Draft-Script: Built manuscript Markdown: ${path.relative(rootFolder, outFile)}`,
      'Open File'
    );
    if (action === 'Open File') {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outFile));
    }
  }

  return { outputPath: outFile, sourceFiles: files, uncertainOrder };
}

export async function configurePandocPath(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Select Pandoc Executable',
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: process.platform === 'win32'
      ? { Executable: ['exe'], All: ['*'] }
      : { All: ['*'] },
  });

  const file = picked?.[0]?.fsPath;
  if (!file) return;

  await vscode.workspace
    .getConfiguration('draftScript')
    .update('export.pandocPath', file, vscode.ConfigurationTarget.Workspace);

  vscode.window.showInformationMessage(`Draft-Script: Pandoc path set to ${file}`);
}

function safeFileName(name: string): string {
  return (name || 'manuscript')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'manuscript';
}

function exportBaseName(cfg: ResolvedExportConfig): string {
  return safeFileName([cfg.title, cfg.subtitle].filter(Boolean).join(' - ') || 'manuscript');
}

function formatConfig(cfg: ResolvedExportConfig, format: ExportFormat): ExportFormatConfig {
  return cfg.project.formats?.[format] ?? {};
}

function pandocArgs(rootFolder: string, inputPath: string, outputPath: string, format: ExportFormat, cfg: ResolvedExportConfig): string[] {
  const args = [inputPath];
  const metadata: Record<string, string> = {
    title: cfg.title,
    subtitle: cfg.subtitle,
    author: cfg.author,
    lang: cfg.language,
  };

  for (const [key, value] of Object.entries(metadata)) {
    if (value) args.push('--metadata', `${key}=${value}`);
  }

  if (format === 'docx' && cfg.referenceDocx) {
    args.push('--reference-doc', resolveProjectPath(rootFolder, cfg.referenceDocx));
  }
  if (format === 'epub' && cfg.epubCover) {
    args.push('--epub-cover-image', resolveProjectPath(rootFolder, cfg.epubCover));
  }
  if (format === 'html') {
    args.push('-s');
  }
  if (format === 'pdf') {
    args.push(`--pdf-engine=${cfg.pdfEngine}`);
    if (cfg.template) {
      args.push('--template', resolveProjectPath(rootFolder, cfg.template));
    }
  }

  args.push('-o', outputPath);
  return args;
}

function execFilePromise(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function ensurePandoc(cfg: ResolvedExportConfig, rootFolder: string): Promise<boolean> {
  try {
    const result = await execFilePromise(cfg.pandocPath, ['--version'], rootFolder);
    log(`[pandoc] detected: ${result.stdout.split(/\r?\n/)[0] ?? cfg.pandocPath}`);
    return true;
  } catch (err) {
    log(`[pandoc] detection failed: ${formatError(err)}`);
    const action = await vscode.window.showErrorMessage(
      'Pandoc is required for DOCX/EPUB/PDF export. Install Pandoc or configure draftScript.export.pandocPath.',
      'Open Pandoc Install Page',
      'Configure Pandoc Path'
    );
    if (action === 'Open Pandoc Install Page') {
      await vscode.env.openExternal(vscode.Uri.parse('https://pandoc.org/installing.html'));
    } else if (action === 'Configure Pandoc Path') {
      await configurePandocPath();
    }
    return false;
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isPdfEngineFailure(stderr: string, err: unknown): boolean {
  const text = `${stderr}\n${formatError(err)}`.toLowerCase();
  return text.includes('xelatex') || text.includes('lualatex') || text.includes('pdf engine') || text.includes('not found');
}

async function pickFormat(defaultFormat: ExportFormat): Promise<ExportFormat | undefined> {
  const picked = await vscode.window.showQuickPick(
    SUPPORTED_FORMATS.map(format => ({
      label: format.toUpperCase(),
      description: format === defaultFormat ? 'Default' : undefined,
      format,
    })),
    { placeHolder: 'Export Draft-Script manuscript with Pandoc' }
  );
  return picked?.format;
}

export async function exportWithPandoc(rootFolder: string): Promise<void> {
  const channel = output();
  channel.clear();

  if (!rootFolder || !fs.existsSync(rootFolder)) {
    vscode.window.showErrorMessage('Draft-Script: No novel folder configured or folder does not exist.');
    return;
  }

  const cfg = resolveExportConfig(rootFolder);
  const format = await pickFormat(cfg.defaultFormat);
  if (!format) return;

  const fmtCfg = formatConfig(cfg, format);
  if (fmtCfg.enabled === false) {
    vscode.window.showWarningMessage(`Draft-Script: ${format.toUpperCase()} export is disabled in .draft-script/export.json.`);
    return;
  }

  const built = await buildManuscriptMarkdown(rootFolder, false);
  if (!built) return;

  if (!(await ensurePandoc(cfg, rootFolder))) return;

  const outDir = outputDirPath(rootFolder, cfg);
  const outputPath = path.join(outDir, `${exportBaseName(cfg)}.${format}`);
  const args = pandocArgs(rootFolder, built.outputPath, outputPath, format, cfg);

  log(`[export] format: ${format}`);
  log(`[export] command: ${cfg.pandocPath}`);
  log(`[export] args: ${args.map(a => JSON.stringify(a)).join(' ')}`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Exporting Draft-Script book to ${format.toUpperCase()}...`,
      cancellable: false,
    },
    async () => {
      try {
        const result = await execFilePromise(cfg.pandocPath, args, rootFolder);
        if (result.stdout) log(`[pandoc stdout]\n${result.stdout.trimEnd()}`);
        if (result.stderr) log(`[pandoc stderr]\n${result.stderr.trimEnd()}`);
        log(`[export] complete: ${outputPath}`);

        const action = await vscode.window.showInformationMessage(
          `Draft-Script: Export complete: ${path.relative(rootFolder, outputPath)}`,
          'Open File',
          'Reveal in Explorer'
        );
        if (action === 'Open File' || (cfg.openAfterExport && !action)) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outputPath));
        } else if (action === 'Reveal in Explorer') {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(outputPath));
        }
      } catch (err) {
        const stderr = typeof (err as { stderr?: unknown }).stderr === 'string'
          ? (err as { stderr: string }).stderr
          : '';
        const stdout = typeof (err as { stdout?: unknown }).stdout === 'string'
          ? (err as { stdout: string }).stdout
          : '';
        if (stdout) log(`[pandoc stdout]\n${stdout.trimEnd()}`);
        if (stderr) log(`[pandoc stderr]\n${stderr.trimEnd()}`);
        log(`[export] failed: ${formatError(err)}`);
        channel.show(true);

        if (format === 'pdf' && isPdfEngineFailure(stderr, err)) {
          vscode.window.showErrorMessage('PDF export requires a PDF engine such as xelatex. Install a TeX distribution or choose DOCX/EPUB export.');
        } else {
          vscode.window.showErrorMessage(`Draft-Script: Export failed. See ${OUTPUT_CHANNEL_NAME} output for details.`);
        }
      }
    }
  );
}
