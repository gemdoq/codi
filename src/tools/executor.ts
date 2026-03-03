import type { Tool, ToolResult } from './tool.js';
import type { ToolRegistry } from './registry.js';
import type { ToolCall } from '../llm/types.js';
import { makeToolError } from './tool.js';
import { renderToolCall, renderToolResult } from '../ui/renderer.js';
import chalk from 'chalk';

export interface ExecutorOptions {
  permissionCheck?: (tool: Tool, input: Record<string, unknown>) => Promise<boolean>;
  preHook?: (toolName: string, input: Record<string, unknown>) => Promise<{ proceed: boolean; updatedInput?: Record<string, unknown> }>;
  postHook?: (toolName: string, input: Record<string, unknown>, result: ToolResult) => Promise<void>;
  planMode?: boolean;
  showToolCalls?: boolean;
}

export interface ExecutionResult {
  toolUseId: string;
  toolName: string;
  result: ToolResult;
}

export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private options: ExecutorOptions = {}
  ) {}

  async executeOne(toolCall: ToolCall): Promise<ExecutionResult> {
    const tool = this.registry.get(toolCall.name);

    if (!tool) {
      return {
        toolUseId: toolCall.id,
        toolName: toolCall.name,
        result: makeToolError(`Unknown tool: ${toolCall.name}. Available tools: ${this.registry.listNames().join(', ')}`),
      };
    }

    // Plan mode check
    if (this.options.planMode && !tool.readOnly) {
      return {
        toolUseId: toolCall.id,
        toolName: toolCall.name,
        result: makeToolError(`Tool '${toolCall.name}' is not available in plan mode (read-only). Use only read-only tools.`),
      };
    }

    // Permission check
    if (tool.dangerous && this.options.permissionCheck) {
      const allowed = await this.options.permissionCheck(tool, toolCall.input);
      if (!allowed) {
        return {
          toolUseId: toolCall.id,
          toolName: toolCall.name,
          result: makeToolError(`Permission denied for tool: ${toolCall.name}`),
        };
      }
    }

    // Pre-hook
    let input = toolCall.input;
    if (this.options.preHook) {
      try {
        const hookResult = await this.options.preHook(toolCall.name, input);
        if (!hookResult.proceed) {
          return {
            toolUseId: toolCall.id,
            toolName: toolCall.name,
            result: makeToolError(`Tool execution blocked by hook for: ${toolCall.name}`),
          };
        }
        if (hookResult.updatedInput) {
          input = hookResult.updatedInput;
        }
      } catch (err) {
        // Hook errors don't block execution, just warn
        console.error(chalk.yellow(`Hook error for ${toolCall.name}: ${err}`));
      }
    }

    // Display tool call
    if (this.options.showToolCalls) {
      console.log(renderToolCall(toolCall.name, input));
    }

    // Execute
    let result: ToolResult;
    try {
      result = await tool.execute(input);
    } catch (err) {
      result = makeToolError(
        `Tool '${toolCall.name}' threw an error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Display result
    if (this.options.showToolCalls) {
      console.log(renderToolResult(toolCall.name, result.output, !result.success));
    }

    // Post-hook
    if (this.options.postHook) {
      try {
        await this.options.postHook(toolCall.name, input, result);
      } catch {
        // Post-hook errors are silently ignored
      }
    }

    return {
      toolUseId: toolCall.id,
      toolName: toolCall.name,
      result,
    };
  }

  async executeMany(toolCalls: ToolCall[]): Promise<ExecutionResult[]> {
    // Separate safe and dangerous tools
    const safeCalls: ToolCall[] = [];
    const dangerousCalls: ToolCall[] = [];

    for (const tc of toolCalls) {
      const tool = this.registry.get(tc.name);
      if (tool?.dangerous) {
        dangerousCalls.push(tc);
      } else {
        safeCalls.push(tc);
      }
    }

    // Execute safe tools in parallel
    const safePromises = safeCalls.map((tc) => this.executeOne(tc));

    // Execute dangerous tools sequentially
    const dangerousResults: ExecutionResult[] = [];
    for (const tc of dangerousCalls) {
      const result = await this.executeOne(tc);
      dangerousResults.push(result);
    }

    const safeResults = await Promise.allSettled(safePromises);

    const results: ExecutionResult[] = [];

    // Collect safe results
    for (let i = 0; i < safeResults.length; i++) {
      const r = safeResults[i]!;
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        results.push({
          toolUseId: safeCalls[i]!.id,
          toolName: safeCalls[i]!.name,
          result: makeToolError(`Tool execution failed: ${r.reason}`),
        });
      }
    }

    results.push(...dangerousResults);

    // Sort by original order
    const orderMap = new Map(toolCalls.map((tc, i) => [tc.id, i]));
    results.sort((a, b) => (orderMap.get(a.toolUseId) ?? 0) - (orderMap.get(b.toolUseId) ?? 0));

    return results;
  }

  setOptions(options: Partial<ExecutorOptions>): void {
    Object.assign(this.options, options);
  }
}
