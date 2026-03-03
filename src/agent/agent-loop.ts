import type { LlmProvider } from '../llm/provider.js';
import type { ContentBlock, ToolCall, LlmResponse } from '../llm/types.js';
import { Conversation } from './conversation.js';
import { ToolExecutor } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import { tokenTracker } from './token-tracker.js';
import { statusLine } from '../ui/status-line.js';
import { startSpinner, stopSpinner, updateSpinner } from '../ui/spinner.js';
import { renderMarkdown, renderAssistantPrefix } from '../ui/renderer.js';
import chalk from 'chalk';

export interface AgentLoopOptions {
  provider: LlmProvider;
  conversation?: Conversation;
  registry: ToolRegistry;
  systemPrompt?: string;
  maxIterations?: number;
  stream?: boolean;
  showOutput?: boolean;
  onToken?: (text: string) => void;
  permissionCheck?: (tool: any, input: Record<string, unknown>) => Promise<boolean>;
  preHook?: (toolName: string, input: Record<string, unknown>) => Promise<{ proceed: boolean; updatedInput?: Record<string, unknown> }>;
  postHook?: (toolName: string, input: Record<string, unknown>, result: any) => Promise<void>;
  planMode?: boolean;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

export async function agentLoop(
  userMessage: string | ContentBlock[],
  options: AgentLoopOptions
): Promise<string> {
  const {
    provider,
    registry,
    maxIterations = 25,
    stream = true,
    showOutput = true,
  } = options;

  const conversation = options.conversation ?? new Conversation();
  if (options.systemPrompt) {
    conversation.setSystemPrompt(options.systemPrompt);
  }

  const executor = new ToolExecutor(registry, {
    permissionCheck: options.permissionCheck,
    preHook: options.preHook,
    postHook: options.postHook,
    planMode: options.planMode,
    showToolCalls: showOutput,
  });

  // Add user message
  conversation.addUserMessage(userMessage);

  let iterations = 0;
  let finalText = '';

  while (iterations < maxIterations) {
    iterations++;

    // Call LLM
    let response: LlmResponse;
    const spinner = showOutput ? startSpinner('Thinking...') : null;

    try {
      response = await callLlmWithRetry(provider, conversation, registry, stream, options, showOutput);
    } catch (err) {
      stopSpinner();
      const errMsg = err instanceof Error ? err.message : String(err);
      if (showOutput) {
        console.error(chalk.red(`\nLLM Error: ${errMsg}`));
      }
      return `Error communicating with LLM: ${errMsg}`;
    }

    stopSpinner();

    // Track tokens
    if (response.usage) {
      tokenTracker.track(response.usage);
      const stats = tokenTracker.getStats();
      statusLine.update({
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cost: stats.cost,
      });
    }

    // Add assistant message to conversation
    conversation.addAssistantMessage(response.content);

    // Collect text
    const wasStreamed = (response as any)._streamed === true;
    if (response.text) {
      finalText = response.text;
    }

    // Check stop reason
    if (response.stopReason === 'end_turn' || !response.toolCalls || response.toolCalls.length === 0) {
      // Only render if not already streamed to terminal
      if (showOutput && finalText && !wasStreamed) {
        console.log('');
        console.log(renderAssistantPrefix());
        console.log(renderMarkdown(finalText));
        console.log('');
      }
      if (wasStreamed && showOutput) {
        console.log('');
      }
      break;
    }

    if (response.stopReason === 'max_tokens') {
      if (showOutput) {
        console.log(chalk.yellow('\n⚠ Response truncated (max tokens reached)'));
      }
    }

    // Execute tools
    if (response.toolCalls && response.toolCalls.length > 0) {
      if (showOutput) {
        console.log('');
      }

      const results = await executor.executeMany(response.toolCalls);

      // Add tool results to conversation
      const toolResults = results.map((r) => ({
        tool_use_id: r.toolUseId,
        content: r.result.output,
        is_error: !r.result.success,
      }));

      conversation.addToolResults(toolResults);
    }
  }

  if (iterations >= maxIterations) {
    if (showOutput) {
      console.log(chalk.yellow(`\n⚠ Agent loop reached maximum iterations (${maxIterations})`));
    }
  }

  return finalText;
}

async function callLlmWithRetry(
  provider: LlmProvider,
  conversation: Conversation,
  registry: ToolRegistry,
  stream: boolean,
  options: AgentLoopOptions,
  showOutput: boolean
): Promise<LlmResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      let streamedText = '';

      const response = await provider.chat({
        messages: conversation.getMessages(),
        systemPrompt: conversation.getSystemPrompt(),
        tools: registry.getToolDefinitions(options.planMode ? { readOnly: true } : undefined),
        stream,
        callbacks: stream
          ? {
              onToken: (text) => {
                stopSpinner();
                if (showOutput && !streamedText) {
                  process.stdout.write('\n' + renderAssistantPrefix() + '\n');
                }
                streamedText += text;
                if (showOutput) {
                  process.stdout.write(text);
                }
                options.onToken?.(text);
              },
            }
          : undefined,
      });

      // If we streamed text, add newline
      if (streamedText && showOutput) {
        process.stdout.write('\n');
      }

      // If streamed, we already showed the text, so mark it
      if (streamedText && response.text) {
        // Text was already displayed during streaming
        return { ...response, _streamed: true } as any;
      }

      return response;
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check if retryable
      const status = err.status || err.statusCode;
      if (status === 429 || (status >= 500 && status < 600)) {
        const delay = RETRY_DELAYS[attempt] || 4000;
        if (showOutput) {
          updateSpinner(`API error (${status}), retrying in ${delay / 1000}s...`);
        }
        await sleep(delay);
        continue;
      }

      // Non-retryable error
      throw lastError;
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { Conversation };
