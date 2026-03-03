import * as fs from 'fs';
import * as path from 'path';
import { globby } from 'globby';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

export const globTool: Tool = {
  name: 'glob',
  description: `Fast file pattern matching. Supports glob patterns like "**/*.ts". Respects .gitignore. Returns matching file paths sorted by modification time.`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern to match files (e.g., "**/*.ts", "src/**/*.tsx")' },
      path: { type: 'string', description: 'Directory to search in. Defaults to current working directory.' },
    },
    required: ['pattern'],
  },
  dangerous: false,
  readOnly: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const pattern = String(input['pattern']);
    const searchPath = input['path'] ? String(input['path']) : process.cwd();
    const resolved = path.resolve(searchPath);

    try {
      const files = await globby(pattern, {
        cwd: resolved,
        gitignore: true,
        ignore: ['node_modules/**', '.git/**'],
        absolute: true,
        onlyFiles: true,
      });

      // Sort by modification time (most recent first)
      const withStats = files.map((f) => {
        try {
          const stat = fs.statSync(f);
          return { path: f, mtime: stat.mtimeMs };
        } catch {
          return { path: f, mtime: 0 };
        }
      });
      withStats.sort((a, b) => b.mtime - a.mtime);

      const result = withStats.map((f) => f.path);

      if (result.length === 0) {
        return makeToolResult(`No files matched pattern: ${pattern} in ${resolved}`);
      }

      return makeToolResult(
        `Found ${result.length} file(s):\n${result.join('\n')}`
      );
    } catch (err) {
      return makeToolError(`Glob failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
