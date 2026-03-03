import { execSync } from 'child_process';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

export const gitTool: Tool = {
  name: 'git',
  description: `Execute git commands with safety checks. Blocks dangerous operations like force push, hard reset, and amend. Use for status, diff, log, commit, branch operations.`,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Git subcommand and arguments (e.g., "status", "diff HEAD", "log --oneline -10")' },
    },
    required: ['command'],
  },
  dangerous: true,
  readOnly: false,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const command = String(input['command']).trim();

    // Safety checks
    const blocked = [
      { pattern: /push\s+.*--force/, msg: 'Force push is blocked for safety. Use regular push.' },
      { pattern: /push\s+.*-f\b/, msg: 'Force push (-f) is blocked for safety.' },
      { pattern: /reset\s+--hard/, msg: 'Hard reset is blocked. Use soft reset or create a new commit.' },
      { pattern: /clean\s+-f/, msg: 'git clean -f is blocked. Manually review files to remove.' },
      { pattern: /checkout\s+\.\s*$/, msg: 'git checkout . discards all changes. Use more specific paths.' },
      { pattern: /branch\s+-D/, msg: 'Force branch deletion is blocked. Use -d for safe deletion.' },
      { pattern: /\b-i\b/, msg: 'Interactive mode (-i) is not supported in non-interactive context.' },
      { pattern: /commit\s+.*--amend/, msg: 'Amending commits is blocked. Create a new commit instead.' },
      { pattern: /--no-verify/, msg: 'Skipping hooks (--no-verify) is blocked.' },
    ];

    for (const check of blocked) {
      if (check.pattern.test(command)) {
        return makeToolError(check.msg);
      }
    }

    // Read-only commands don't need special handling
    const readOnlyPrefixes = ['status', 'diff', 'log', 'show', 'branch', 'tag', 'remote', 'stash list', 'ls-files'];
    const isReadOnly = readOnlyPrefixes.some((p) => command.startsWith(p));

    try {
      const result = execSync(`git ${command}`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
        cwd: process.cwd(),
      });

      return makeToolResult(result || '(no output)');
    } catch (err: any) {
      const output = [err.stdout, err.stderr].filter(Boolean).join('\n');
      return makeToolError(`git ${command} failed:\n${output || err.message}`);
    }
  },
};
