import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

// Forward reference - will be connected in stage 10
let subAgentHandler: ((input: Record<string, unknown>) => Promise<ToolResult>) | null = null;

export function setSubAgentHandler(handler: (input: Record<string, unknown>) => Promise<ToolResult>): void {
  subAgentHandler = handler;
}

export const subAgentTool: Tool = {
  name: 'sub_agent',
  description: `Launch a sub-agent to handle complex tasks autonomously. Types: 'explore' (read-only codebase exploration), 'plan' (architecture planning), 'general' (full capabilities). Sub-agents run in independent contexts.`,
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['explore', 'plan', 'general'],
        description: 'Agent type: explore (fast, read-only), plan (analysis), general (full access)',
      },
      task: { type: 'string', description: 'Detailed task description for the agent' },
      model: { type: 'string', description: 'Optional model override' },
      background: { type: 'boolean', description: 'Run in background and return task ID' },
    },
    required: ['type', 'task'],
  },
  dangerous: false,
  readOnly: true,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    if (!subAgentHandler) {
      return makeToolError('Sub-agent system not initialized. This feature will be available after setup.');
    }
    return subAgentHandler(input);
  },
};
