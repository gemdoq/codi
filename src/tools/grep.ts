import { execFile } from 'child_process';
import * as path from 'path';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

export const grepTool: Tool = {
  name: 'grep',
  description: `Search file contents using regex patterns. Uses ripgrep (rg) if available, falls back to grep. Supports context lines, file type filters, and multiple output modes.`,
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

    const args: string[] = [];

    // Try ripgrep first, fall back to grep
    const useRg = await hasCommand('rg');
    const cmd = useRg ? 'rg' : 'grep';

    if (!useRg) {
      args.push('-r'); // recursive for grep
    }

    // Output mode
    if (outputMode === 'files_with_matches') {
      args.push(useRg ? '-l' : '-l');
    } else if (outputMode === 'count') {
      args.push(useRg ? '-c' : '-c');
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
    if (input['multiline'] && useRg) {
      args.push('-U', '--multiline-dotall');
    }

    // File type filter
    if (input['type'] && useRg) {
      args.push('--type', String(input['type']));
    }

    // Glob filter
    if (input['glob'] && useRg) {
      args.push('--glob', String(input['glob']));
    }

    // Ignore common dirs
    if (useRg) {
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
  return new Promise((resolve) => {
    execFile('which', [cmd], (err) => resolve(!err));
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
