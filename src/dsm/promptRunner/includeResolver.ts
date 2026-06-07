import * as fs   from 'fs';
import * as path from 'path';

export type IncludeErrorKind = 'missing' | 'circular';

export interface IncludeError {
  kind:  IncludeErrorKind;
  name:  string;     // the include name that failed (without .md)
  chain: string[];   // include names leading to this point
}

export interface IncludeNode {
  name:     string;         // include name (without .md)
  found:    boolean;
  children: IncludeNode[];
}

export interface IncludeResult {
  resolvedBody:      string;
  tree:              IncludeNode[];
  errors:            IncludeError[];
  totalIncludeChars: number;
}

const INCLUDE_RE = /\{\{include:([^}]+)\}\}/g;

function resolveBody(
  text:        string,
  includesDir: string,
  chain:       string[],       // names active in the current call stack (cycle detection)
  errors:      IncludeError[],
  tree:        IncludeNode[],
  stats:       { chars: number },
): string {
  return text.replace(INCLUDE_RE, (_, rawName: string) => {
    const name     = rawName.trim();
    const filePath = path.join(includesDir, name + '.md');

    if (chain.includes(name)) {
      errors.push({ kind: 'circular', name, chain: [...chain, name] });
      return `[CIRCULAR INCLUDE: ${[...chain, name].join(' -> ')}]`;
    }

    if (!fs.existsSync(filePath)) {
      errors.push({ kind: 'missing', name, chain: [...chain] });
      tree.push({ name, found: false, children: [] });
      return `[MISSING INCLUDE: ${name}.md]`;
    }

    const content    = fs.readFileSync(filePath, 'utf-8');
    stats.chars     += content.length;
    const childTree: IncludeNode[] = [];
    const resolved   = resolveBody(content, includesDir, [...chain, name], errors, childTree, stats);
    tree.push({ name, found: true, children: childTree });
    return resolved;
  });
}

export function resolveIncludes(body: string, includesDir: string): IncludeResult {
  const errors: IncludeError[] = [];
  const tree:   IncludeNode[]  = [];
  const stats   = { chars: 0 };
  const resolvedBody = resolveBody(body, includesDir, [], errors, tree, stats);
  return { resolvedBody, tree, errors, totalIncludeChars: stats.chars };
}

// ─── Tree renderer (used by preview doc) ─────────────────────────────────────

export function renderIncludeTree(nodes: IncludeNode[], prefix = ''): string {
  if (!nodes.length) return prefix === '' ? '*No includes used.*' : '';
  return nodes.map((n, i) => {
    const isLast   = i === nodes.length - 1;
    const branch   = prefix ? (isLast ? '└─ ' : '├─ ') : '';
    const icon     = n.found ? '✓' : '✗';
    const tag      = n.found ? '' : ' *(not found)*';
    const line     = `${prefix}${branch}${icon} ${n.name}.md${tag}`;
    const childPfx = prefix + (prefix ? (isLast ? '   ' : '│  ') : '');
    return n.children.length
      ? line + '\n' + renderIncludeTree(n.children, childPfx + '  ')
      : line;
  }).join('\n');
}

// ─── Error formatter (used by preview doc and run-time block) ────────────────

export function formatIncludeErrors(errors: IncludeError[]): string {
  return errors.map(e => {
    if (e.kind === 'circular') {
      return `Circular include:\n  ${e.chain.join('\n   -> ')}`;
    }
    return `Missing include: _includes/${e.name}.md`;
  }).join('\n\n');
}
