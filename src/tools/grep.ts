import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

export const grepTool: Tool = {
  name: 'grep',
  description: `Search file contents using regex patterns. Uses ripgrep (rg) if available, falls back to grep, then to a built-in Node.js search. Supports context lines, file type filters, and multiple output modes.`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search in' },
      glob: { type: 'string', description: 'Glob pattern to filter files (e.g., "*.ts")' },
      type: { type: 'string', description: 'File type filter (e.g., "ts", "py", "js")' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output mode: content (matching lines), files_with_matches (file paths only), count (match counts)',
      },
      '-A': { type: 'number', description: 'Lines to show after match' },
      '-B': { type: 'number', description: 'Lines to show before match' },
      '-C': { type: 'number', description: 'Context lines (before and after)' },
      '-i': { type: 'boolean', description: 'Case insensitive search' },
      '-n': { type: 'boolean', description: 'Show line numbers' },
      multiline: { type: 'boolean', description: 'Enable multiline matching' },
      head_limit: { type: 'number', description: 'Limit output to first N entries' },
    },
    required: ['pattern'],
  },
  dangerous: false,
  readOnly: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(input['pattern']);
    const searchPath = path.resolve(input['path'] ? String(input['path']) : process.cwd());
    const outputMode = (input['output_mode'] as string) || 'files_with_matches';
    const headLimit = (input['head_limit'] as number) || 0;

    // Try ripgrep first, then grep, then built-in fallback
    const hasRg = await hasCommand('rg');
    const hasGrep = !hasRg && await hasCommand('grep');

    if (!hasRg && !hasGrep) {
      // Pure Node.js fallback — works on all platforms without external tools
      return builtinSearch(pattern, searchPath, input, outputMode, headLimit);
    }

    const cmd = hasRg ? 'rg' : 'grep';
    const args: string[] = [];

    if (!hasRg) {
      args.push('-r'); // recursive for grep
    }

    // Output mode
    if (outputMode === 'files_with_matches') {
      args.push('-l');
    } else if (outputMode === 'count') {
      args.push('-c');
    }

    // Case insensitive
    if (input['-i']) args.push('-i');

    // Line numbers
    if (input['-n'] !== false && outputMode === 'content') {
      args.push('-n');
    }

    // Context
    if (input['-C']) args.push('-C', String(input['-C']));
    else if (input['-A']) args.push('-A', String(input['-A']));
    if (input['-B']) args.push('-B', String(input['-B']));

    // Multiline (rg only)
    if (input['multiline'] && hasRg) {
      args.push('-U', '--multiline-dotall');
    }

    // File type filter
    if (input['type'] && hasRg) {
      args.push('--type', String(input['type']));
    }

    // Glob filter
    if (input['glob'] && hasRg) {
      args.push('--glob', String(input['glob']));
    }

    // Ignore common dirs
    if (hasRg) {
      args.push('--no-ignore-vcs');
      args.push('-g', '!node_modules');
      args.push('-g', '!.git');
    }

    args.push(pattern, searchPath);

    try {
      const result = await runCommand(cmd, args);

      if (!result.trim()) {
        return makeToolResult(`No matches found for pattern: ${pattern}`);
      }

      let output = result;
      if (headLimit > 0) {
        const lines = output.split('\n');
        output = lines.slice(0, headLimit).join('\n');
        if (lines.length > headLimit) {
          output += `\n... (${lines.length - headLimit} more results)`;
        }
      }

      return makeToolResult(output);
    } catch (err: any) {
      // grep/rg exit 1 means no matches
      if (err.code === 1) {
        return makeToolResult(`No matches found for pattern: ${pattern}`);
      }
      return makeToolError(`Search failed: ${err.message || String(err)}`);
    }
  },
};

function hasCommand(cmd: string): Promise<boolean> {
  const checkCmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(checkCmd, [cmd], (err) => resolve(!err));
  });
}

function runCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        (err as any).code = err.code;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

// ─── Built-in Node.js search fallback ────────────────────────────────

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.cache', 'coverage']);
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib']);

const TYPE_EXTENSIONS: Record<string, string[]> = {
  ts: ['.ts', '.tsx'],
  js: ['.js', '.jsx', '.mjs', '.cjs'],
  py: ['.py'],
  java: ['.java'],
  kt: ['.kt', '.kts'],
  go: ['.go'],
  rs: ['.rs'],
  rb: ['.rb'],
  css: ['.css', '.scss', '.less'],
  html: ['.html', '.htm'],
  json: ['.json'],
  yaml: ['.yaml', '.yml'],
  md: ['.md'],
  xml: ['.xml'],
};

async function builtinSearch(
  pattern: string,
  searchPath: string,
  input: Record<string, unknown>,
  outputMode: string,
  headLimit: number,
): Promise<ToolResult> {
  const caseInsensitive = input['-i'] === true;
  const showLineNumbers = input['-n'] !== false && outputMode === 'content';
  const contextBefore = Number(input['-C'] || input['-B'] || 0);
  const contextAfter = Number(input['-C'] || input['-A'] || 0);
  const typeFilter = input['type'] ? String(input['type']) : undefined;
  const globFilter = input['glob'] ? String(input['glob']) : undefined;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g');
  } catch {
    return makeToolError(`Invalid regex pattern: ${pattern}`);
  }

  const files = collectFiles(searchPath, typeFilter, globFilter);
  const results: string[] = [];
  const fileCounts: Map<string, number> = new Map();
  let entryCount = 0;

  for (const filePath of files) {
    if (headLimit > 0 && entryCount >= headLimit) break;

    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const matchedLineIndices: Set<number> = new Set();
    let fileMatchCount = 0;

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i]!)) {
        matchedLineIndices.add(i);
        fileMatchCount++;
      }
      regex.lastIndex = 0; // Reset regex state for global flag
    }

    if (fileMatchCount === 0) continue;

    if (outputMode === 'files_with_matches') {
      results.push(filePath);
      entryCount++;
    } else if (outputMode === 'count') {
      fileCounts.set(filePath, fileMatchCount);
      entryCount++;
    } else {
      // content mode — collect matched lines with context
      const outputLines: Set<number> = new Set();
      for (const idx of matchedLineIndices) {
        for (let j = Math.max(0, idx - contextBefore); j <= Math.min(lines.length - 1, idx + contextAfter); j++) {
          outputLines.add(j);
        }
      }

      const sortedIndices = [...outputLines].sort((a, b) => a - b);
      let lastIdx = -2;
      for (const idx of sortedIndices) {
        if (headLimit > 0 && entryCount >= headLimit) break;

        if (idx > lastIdx + 1 && lastIdx >= 0) {
          results.push('--'); // separator between non-contiguous groups
        }
        const prefix = showLineNumbers ? `${filePath}:${idx + 1}:` : `${filePath}:`;
        results.push(`${prefix}${lines[idx]}`);
        entryCount++;
        lastIdx = idx;
      }
    }
  }

  if (outputMode === 'count') {
    for (const [file, count] of fileCounts) {
      results.push(`${file}:${count}`);
    }
  }

  if (results.length === 0) {
    return makeToolResult(`No matches found for pattern: ${pattern}`);
  }

  return makeToolResult(results.join('\n'));
}

function collectFiles(dirPath: string, typeFilter?: string, globFilter?: string): string[] {
  const files: string[] = [];
  const allowedExtensions = typeFilter && TYPE_EXTENSIONS[typeFilter] ? new Set(TYPE_EXTENSIONS[typeFilter]) : null;

  // Convert simple glob to regex (e.g., "*.ts" → /\.ts$/)
  let globRegex: RegExp | null = null;
  if (globFilter) {
    const escaped = globFilter
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    globRegex = new RegExp(`^${escaped}$`);
  }

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;
        if (allowedExtensions && !allowedExtensions.has(ext)) continue;
        if (globRegex && !globRegex.test(entry.name)) continue;
        files.push(fullPath);
      }
    }
  }

  // If searchPath is a file, just search that file
  try {
    const stat = fs.statSync(dirPath);
    if (stat.isFile()) {
      return [dirPath];
    }
  } catch {
    return [];
  }

  walk(dirPath);
  return files;
}
