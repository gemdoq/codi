import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

export const listDirTool: Tool = {
  name: 'list_dir',
  description: `List directory contents with file/folder distinction and basic metadata.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list (defaults to cwd)' },
    },
    required: [],
  },
  dangerous: false,
  readOnly: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const dirPath = path.resolve(input['path'] ? String(input['path']) : process.cwd());

    if (!fs.existsSync(dirPath)) {
      return makeToolError(`Directory not found: ${dirPath}`);
    }

    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return makeToolError(`Not a directory: ${dirPath}`);
    }

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const IGNORE = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.next', 'dist', 'build']);

      const lines: string[] = [];
      const dirs: string[] = [];
      const files: string[] = [];

      for (const entry of entries) {
        if (IGNORE.has(entry.name)) continue;

        if (entry.isDirectory()) {
          dirs.push(`${entry.name}/`);
        } else if (entry.isSymbolicLink()) {
          try {
            const target = fs.readlinkSync(path.join(dirPath, entry.name));
            files.push(`${entry.name} -> ${target}`);
          } catch {
            files.push(`${entry.name} -> (broken link)`);
          }
        } else {
          files.push(entry.name);
        }
      }

      // Directories first, then files
      dirs.sort();
      files.sort();
      lines.push(...dirs, ...files);

      if (lines.length === 0) {
        return makeToolResult(`Directory is empty: ${dirPath}`);
      }

      return makeToolResult(`${dirPath}\n${lines.join('\n')}`);
    } catch (err) {
      return makeToolError(`Failed to list directory: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
