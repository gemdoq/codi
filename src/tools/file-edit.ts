import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';
import { backupFile } from './file-backup.js';

export const fileEditTool: Tool = {
  name: 'edit_file',
  description: `Perform exact string replacement in a file. The old_string must be unique in the file unless replace_all is true. Preserves indentation exactly.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file to edit' },
      old_string: { type: 'string', description: 'The exact text to find and replace' },
      new_string: { type: 'string', description: 'The replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default: false)', default: false },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  dangerous: true,
  readOnly: false,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = String(input['file_path']);
    const oldString = String(input['old_string']);
    const newString = String(input['new_string']);
    const replaceAll = input['replace_all'] === true;

    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
      return makeToolError(`File not found: ${resolved}`);
    }

    try {
      const raw = fs.readFileSync(resolved, 'utf-8');
      const hasCrlf = raw.includes('\r\n');
      // Normalize CRLF → LF for matching, preserve original line endings on write
      let content = hasCrlf ? raw.replace(/\r\n/g, '\n') : raw;

      if (oldString === newString) {
        return makeToolError('old_string and new_string are identical. No changes needed.');
      }

      if (!content.includes(oldString)) {
        // Try to find similar text for helpful error
        const lines = content.split('\n');
        const oldLines = oldString.split('\n');
        const firstOldLine = oldLines[0]?.trim();
        const similar = firstOldLine
          ? lines.find((l) => l.trim().includes(firstOldLine))
          : undefined;

        let errMsg = `old_string not found in ${resolved}.`;
        if (similar) {
          errMsg += `\nDid you mean this line?\n  ${similar.trim()}`;
        }
        errMsg += '\nMake sure old_string matches exactly including whitespace and indentation.';
        return makeToolError(errMsg);
      }

      if (!replaceAll) {
        const count = content.split(oldString).length - 1;
        if (count > 1) {
          return makeToolError(
            `old_string appears ${count} times in the file. Use replace_all: true to replace all, or provide more context to make it unique.`
          );
        }
      }

      if (replaceAll) {
        content = content.split(oldString).join(newString);
      } else {
        const idx = content.indexOf(oldString);
        content = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
      }

      // 쓰기 전에 백업 생성
      backupFile(resolved);

      // Restore original line endings if file used CRLF
      const output = hasCrlf ? content.replace(/\n/g, '\r\n') : content;
      fs.writeFileSync(resolved, output, 'utf-8');

      const linesChanged = Math.max(
        oldString.split('\n').length,
        newString.split('\n').length
      );

      return makeToolResult(`Edited ${resolved}`, {
        filePath: resolved,
        linesChanged,
      });
    } catch (err) {
      return makeToolError(`Failed to edit file: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
