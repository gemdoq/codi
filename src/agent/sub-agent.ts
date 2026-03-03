import type { LlmProvider } from '../llm/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/tool.js';
import { makeToolResult, makeToolError } from '../tools/tool.js';
import { agentLoop } from './agent-loop.js';
import { Conversation } from './conversation.js';
import { EXPLORE_SYSTEM_PROMPT, PLAN_SYSTEM_PROMPT, GENERAL_SYSTEM_PROMPT } from './system-prompt.js';
import chalk from 'chalk';

export interface SubAgentConfig {
  type: 'explore' | 'plan' | 'general';
  task: string;
  tools?: string[];
  model?: string;
  maxIterations?: number;
  background?: boolean;
}

const AGENT_PRESETS: Record<string, {
  tools: string[];
  systemPrompt: string;
  maxIterations: number;
}> = {
  explore: {
    tools: ['read_file', 'glob', 'grep', 'list_dir'],
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    maxIterations: 15,
  },
  plan: {
    tools: ['read_file', 'glob', 'grep', 'list_dir', 'web_fetch'],
    systemPrompt: PLAN_SYSTEM_PROMPT,
    maxIterations: 20,
  },
  general: {
    tools: [], // Empty means all tools except sub_agent
    systemPrompt: GENERAL_SYSTEM_PROMPT,
    maxIterations: 25,
  },
};

// Background tasks
const backgroundAgents: Map<string, { promise: Promise<string>; status: string; result?: string }> = new Map();
let bgCounter = 0;

export function createSubAgentHandler(
  provider: LlmProvider,
  mainRegistry: ToolRegistry
): (input: Record<string, unknown>) => Promise<ToolResult> {
  return async (input: Record<string, unknown>): Promise<ToolResult> => {
    const type = String(input['type']) as SubAgentConfig['type'];
    const task = String(input['task']);
    const background = input['background'] === true;

    const preset = AGENT_PRESETS[type];
    if (!preset) {
      return makeToolError(`Unknown agent type: ${type}. Use 'explore', 'plan', or 'general'.`);
    }

    // Create restricted registry
    let registry: ToolRegistry;
    if (preset.tools.length > 0) {
      registry = mainRegistry.subset(preset.tools);
    } else {
      // General: all tools except sub_agent (prevent nesting)
      registry = mainRegistry.clone();
      registry.remove('sub_agent');
    }

    const conversation = new Conversation();
    const maxIterations = (input['maxIterations'] as number) || preset.maxIterations;

    console.log(chalk.dim(`\n  ▸ Launching ${type} agent: ${task.slice(0, 80)}...`));

    const runAgent = async (): Promise<string> => {
      const result = await agentLoop(task, {
        provider,
        conversation,
        registry,
        systemPrompt: preset.systemPrompt,
        maxIterations,
        stream: false,
        showOutput: false,
      });
      return result;
    };

    if (background) {
      const taskId = `agent_${++bgCounter}`;
      const entry: { promise: Promise<string>; status: string; result?: string } = { promise: runAgent(), status: 'running', result: undefined };
      backgroundAgents.set(taskId, entry);

      entry.promise
        .then((result) => {
          entry.status = 'done';
          entry.result = result;
        })
        .catch((err) => {
          entry.status = 'error';
          entry.result = String(err);
        });

      return makeToolResult(`Background agent started with ID: ${taskId}. Use task output to check results.`);
    }

    try {
      const result = await runAgent();
      console.log(chalk.dim(`  ▸ ${type} agent completed.`));
      return makeToolResult(result);
    } catch (err) {
      return makeToolError(`Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

export function getBackgroundAgentResult(taskId: string): { status: string; result?: string } | null {
  const entry = backgroundAgents.get(taskId);
  if (!entry) return null;
  return { status: entry.status, result: entry.result };
}
