import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

export const fileWriteTool: Tool = {
  name: 'write_file',
  description: `Create a new file or overwrite an existing file. Creates parent directories if needed. For modifying existing files, prefer edit_file instead.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or relative path to the file' },
      content: { type: 'string', description: 'The content to write to the file' },
    },
    required: ['file_path', 'content'],
  },
  dangerous: true,
  readOnly: false,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = String(input['file_path']);
    const content = String(input['content']);
    const resolved = path.resolve(filePath);

    try {
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const existed = fs.existsSync(resolved);
      fs.writeFileSync(resolved, content, 'utf-8');

      const lines = content.split('\n').length;
      const action = existed ? 'Overwrote' : 'Created';
      return makeToolResult(`${action} ${resolved} (${lines} lines)`, {
        filePath: resolved,
        linesChanged: lines,
      });
    } catch (err) {
      return makeToolError(`Failed to write file: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
