import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

export const notebookEditTool: Tool = {
  name: 'notebook_edit',
  description: `Edit Jupyter notebook (.ipynb) cells. Supports replacing, inserting, and deleting cells.`,
  inputSchema: {
    type: 'object',
    properties: {
      notebook_path: { type: 'string', description: 'Path to the .ipynb file' },
      cell_number: { type: 'number', description: 'Cell index (0-based)' },
      new_source: { type: 'string', description: 'New source content for the cell' },
      cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Cell type (for insert)' },
      edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Edit mode (default: replace)' },
    },
    required: ['notebook_path', 'new_source'],
  },
  dangerous: true,
  readOnly: false,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const nbPath = path.resolve(String(input['notebook_path']));
    const cellNumber = input['cell_number'] as number | undefined;
    const newSource = String(input['new_source']);
    const cellType = (input['cell_type'] as string) || 'code';
    const editMode = (input['edit_mode'] as string) || 'replace';

    if (!fs.existsSync(nbPath)) {
      return makeToolError(`Notebook not found: ${nbPath}`);
    }

    try {
      const content = fs.readFileSync(nbPath, 'utf-8');
      const nb = JSON.parse(content);

      if (!nb.cells || !Array.isArray(nb.cells)) {
        return makeToolError('Invalid notebook format: no cells array');
      }

      const sourceLines = newSource.split('\n').map((l, i, arr) =>
        i < arr.length - 1 ? l + '\n' : l
      );

      switch (editMode) {
        case 'replace': {
          const idx = cellNumber ?? 0;
          if (idx < 0 || idx >= nb.cells.length) {
            return makeToolError(`Cell index ${idx} out of range (0-${nb.cells.length - 1})`);
          }
          nb.cells[idx].source = sourceLines;
          if (input['cell_type']) {
            nb.cells[idx].cell_type = cellType;
          }
          break;
        }
        case 'insert': {
          const idx = cellNumber !== undefined ? cellNumber + 1 : nb.cells.length;
          const newCell: Record<string, unknown> = {
            cell_type: cellType,
            source: sourceLines,
            metadata: {},
          };
          if (cellType === 'code') {
            newCell['execution_count'] = null;
            newCell['outputs'] = [];
          }
          nb.cells.splice(idx, 0, newCell);
          break;
        }
        case 'delete': {
          const idx = cellNumber ?? 0;
          if (idx < 0 || idx >= nb.cells.length) {
            return makeToolError(`Cell index ${idx} out of range (0-${nb.cells.length - 1})`);
          }
          nb.cells.splice(idx, 1);
          break;
        }
        default:
          return makeToolError(`Unknown edit_mode: ${editMode}`);
      }

      fs.writeFileSync(nbPath, JSON.stringify(nb, null, 1), 'utf-8');
      return makeToolResult(`Notebook ${editMode}d cell in ${nbPath} (${nb.cells.length} cells total)`);
    } catch (err) {
      return makeToolError(`Notebook edit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};
