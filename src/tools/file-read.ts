import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

export const fileReadTool: Tool = {
  name: 'read_file',
  description: `Read a file from the filesystem. Supports text files with line numbers (cat -n format), PDF files, images (returns base64 for multimodal), and Jupyter notebooks (.ipynb). Use offset/limit for large files.`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or relative path to the file' },
      offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
      limit: { type: 'number', description: 'Number of lines to read' },
      pages: { type: 'string', description: 'Page range for PDF files (e.g., "1-5")' },
    },
    required: ['file_path'],
  },
  dangerous: false,
  readOnly: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const filePath = String(input['file_path']);
    const offset = input['offset'] as number | undefined;
    const limit = input['limit'] as number | undefined;

    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
      return makeToolError(`File not found: ${resolved}`);
    }

    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return makeToolError(`Path is a directory, not a file: ${resolved}. Use list_dir instead.`);
    }

    const ext = path.extname(resolved).toLowerCase();

    // Image files
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) {
      const data = fs.readFileSync(resolved);
      const base64 = data.toString('base64');
      const mimeMap: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml',
      };
      return makeToolResult(`[Image: ${path.basename(resolved)}]`, {
        filePath: resolved,
        isImage: true,
        imageData: base64,
        imageMimeType: mimeMap[ext] || 'image/png',
      });
    }

    // PDF files
    if (ext === '.pdf') {
      try {
        const pdfModule = await import('pdf-parse');
        const pdfParse = (pdfModule as any).default || pdfModule;
        const buffer = fs.readFileSync(resolved);
        const data = await pdfParse(buffer);
        const pages = input['pages'] as string | undefined;

        let text = data.text;
        if (pages) {
          // Basic page range support - split by form feeds
          const allPages = text.split('\f');
          const [start, end] = pages.split('-').map(Number);
          const s = (start || 1) - 1;
          const e = end || start || allPages.length;
          text = allPages.slice(s, e).join('\n\n--- Page Break ---\n\n');
        }

        return makeToolResult(text, { filePath: resolved });
      } catch (err) {
        return makeToolError(`Failed to parse PDF: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Jupyter notebooks
    if (ext === '.ipynb') {
      try {
        const content = fs.readFileSync(resolved, 'utf-8');
        const nb = JSON.parse(content);
        const output: string[] = [];

        for (let i = 0; i < (nb.cells || []).length; i++) {
          const cell = nb.cells[i];
          const cellType = cell.cell_type || 'code';
          const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source || '';

          output.push(`--- Cell ${i + 1} [${cellType}] ---`);
          output.push(source);

          if (cell.outputs && cell.outputs.length > 0) {
            output.push('--- Output ---');
            for (const out of cell.outputs) {
              if (out.text) {
                output.push(Array.isArray(out.text) ? out.text.join('') : out.text);
              } else if (out.data?.['text/plain']) {
                const plain = out.data['text/plain'];
                output.push(Array.isArray(plain) ? plain.join('') : plain);
              }
            }
          }
          output.push('');
        }

        return makeToolResult(output.join('\n'), { filePath: resolved });
      } catch (err) {
        return makeToolError(`Failed to parse notebook: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Text files
    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      const lines = content.split('\n');
      const totalLines = lines.length;

      const startLine = Math.max(1, offset || 1);
      const endLine = limit ? Math.min(startLine + limit - 1, totalLines) : Math.min(startLine + 1999, totalLines);

      const selectedLines = lines.slice(startLine - 1, endLine);
      const numbered = selectedLines.map((line, i) => {
        const lineNum = startLine + i;
        const numStr = String(lineNum).padStart(String(endLine).length, ' ');
        return `${numStr}\t${line}`;
      });

      let result = numbered.join('\n');
      if (endLine < totalLines) {
        result += `\n\n... (${totalLines - endLine} more lines)`;
      }

      return makeToolResult(result, { filePath: resolved });
    } catch (err) {
      return makeToolError(`Failed to read file: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
