import { execSync } from 'child_process';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

/** 충돌 마커가 포함된 파일에서 충돌 섹션을 파싱한다 */
export interface ConflictSection {
  file: string;
  startLine: number;
  ours: string;
  theirs: string;
}

/** git 명령 결과에서 충돌 파일 목록을 감지한다 */
export function detectConflictFiles(cwd: string): string[] {
  try {
    const output = execSync('git diff --name-only --diff-filter=U', {
      encoding: 'utf-8',
      cwd,
      timeout: 10_000,
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** 충돌 파일의 충돌 마커를 파싱하여 구조화된 결과를 반환한다 */
export function parseConflictMarkers(fileContent: string, filePath: string): ConflictSection[] {
  const sections: ConflictSection[] = [];
  const lines = fileContent.split('\n');

  let inConflict = false;
  let startLine = 0;
  let oursLines: string[] = [];
  let theirsLines: string[] = [];
  let inTheirs = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      inTheirs = false;
      startLine = i + 1;
      oursLines = [];
      theirsLines = [];
    } else if (line.startsWith('=======') && inConflict) {
      inTheirs = true;
    } else if (line.startsWith('>>>>>>>') && inConflict) {
      sections.push({
        file: filePath,
        startLine,
        ours: oursLines.join('\n'),
        theirs: theirsLines.join('\n'),
      });
      inConflict = false;
      inTheirs = false;
    } else if (inConflict) {
      if (inTheirs) {
        theirsLines.push(line);
      } else {
        oursLines.push(line);
      }
    }
  }

  return sections;
}

/** 충돌 감지 결과를 읽기 쉬운 문자열로 포맷한다 */
export function formatConflictReport(cwd: string): string | null {
  const conflictFiles = detectConflictFiles(cwd);
  if (conflictFiles.length === 0) return null;

  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const lines: string[] = [
    `⚠ Merge conflicts detected in ${conflictFiles.length} file(s):`,
    '',
  ];

  for (const file of conflictFiles) {
    const fullPath = path.join(cwd, file);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      lines.push(`  - ${file} (cannot read)`);
      continue;
    }

    const sections = parseConflictMarkers(content, file);
    lines.push(`  - ${file} (${sections.length} conflict(s))`);

    for (let i = 0; i < sections.length; i++) {
      const s = sections[i]!;
      lines.push(`    [Conflict ${i + 1} at line ${s.startLine}]`);
      lines.push(`      OURS:`);
      for (const l of s.ours.split('\n').slice(0, 5)) {
        lines.push(`        ${l}`);
      }
      if (s.ours.split('\n').length > 5) lines.push(`        ... (${s.ours.split('\n').length} lines)`);
      lines.push(`      THEIRS:`);
      for (const l of s.theirs.split('\n').slice(0, 5)) {
        lines.push(`        ${l}`);
      }
      if (s.theirs.split('\n').length > 5) lines.push(`        ... (${s.theirs.split('\n').length} lines)`);
    }
  }

  return lines.join('\n');
}

export const gitTool: Tool = {
  name: 'git',
  description: `Execute git commands with safety checks. Blocks dangerous operations like force push, hard reset, and amend. Use for status, diff, log, commit, branch operations. When merge/pull results in conflicts, automatically detects and reports them.`,
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
    const _isReadOnly = readOnlyPrefixes.some((p) => command.startsWith(p));

    // Commands that may cause merge conflicts
    const mergeCommands = /^(merge|pull|rebase|cherry-pick)\b/;
    const isMergeCommand = mergeCommands.test(command);

    try {
      const result = execSync(`git ${command}`, {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
        cwd: process.cwd(),
      });

      // 머지 계열 명령 성공 후에도 충돌이 남아있을 수 있으므로 감지
      if (isMergeCommand) {
        const conflictReport = formatConflictReport(process.cwd());
        if (conflictReport) {
          return makeToolResult(`${result}\n\n${conflictReport}`);
        }
      }

      return makeToolResult(result || '(no output)');
    } catch (err: any) {
      const output = [err.stdout, err.stderr].filter(Boolean).join('\n');

      // 머지 충돌로 인한 실패 시 구조화된 충돌 정보 제공
      if (isMergeCommand) {
        const conflictReport = formatConflictReport(process.cwd());
        if (conflictReport) {
          return makeToolError(`git ${command} failed with conflicts:\n${output}\n\n${conflictReport}`);
        }
      }

      return makeToolError(`git ${command} failed:\n${output || err.message}`);
    }
  },
};
