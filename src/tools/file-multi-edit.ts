import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

export const fileMultiEditTool: Tool = {
  name: 'multi_edit',
  description: `Apply multiple edits to a single file atomically. Each edit is an old_string → new_string replacement. All edits are validated before any are applied.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file to edit' },
      edits: {
        type: 'array',
        description: 'Array of edits to apply',
        items: {
          type: 'object',
          properties: {
            old_string: { type: 'string', description: 'Text to find' },
            new_string: { type: 'string', description: 'Replacement text' },
          },
          required: ['old_string', 'new_string'],
        },
      },
    },
    required: ['file_path', 'edits'],
  },
  dangerous: true,
  readOnly: false,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = String(input['file_path']);
    const edits = input['edits'] as Array<{ old_string: string; new_string: string }>;
    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
      return makeToolError(`File not found: ${resolved}`);
    }

    if (!Array.isArray(edits) || edits.length === 0) {
      return makeToolError('edits must be a non-empty array of {old_string, new_string} objects');
    }

    try {
      const raw = fs.readFileSync(resolved, 'utf-8');
      const hasCrlf = raw.includes('\r\n');
      // Normalize CRLF → LF for matching, preserve original line endings on write
      let content = hasCrlf ? raw.replace(/\r\n/g, '\n') : raw;

      // Validate all edits first
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i]!;
        if (!content.includes(edit.old_string)) {
          return makeToolError(
            `Edit ${i + 1}/${edits.length}: old_string not found in file. No edits applied.\nSearching for: ${edit.old_string.slice(0, 100)}...`
          );
        }
      }

      // Apply edits sequentially
      let totalLinesChanged = 0;
      for (const edit of edits) {
        const idx = content.indexOf(edit.old_string);
        if (idx === -1) {
          return makeToolError(`Edit validation passed but old_string disappeared during application. This may happen if edits overlap.`);
        }
        content = content.slice(0, idx) + edit.new_string + content.slice(idx + edit.old_string.length);
        totalLinesChanged += Math.max(
          edit.old_string.split('\n').length,
          edit.new_string.split('\n').length
        );
      }

      // Restore original line endings if file used CRLF
      const output = hasCrlf ? content.replace(/\n/g, '\r\n') : content;
      fs.writeFileSync(resolved, output, 'utf-8');

      return makeToolResult(`Applied ${edits.length} edits to ${resolved}`, {
        filePath: resolved,
        linesChanged: totalLinesChanged,
      });
    } catch (err) {
      return makeToolError(`Failed to multi-edit: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
