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
import { logger } from '../utils/logger.js';
import { t } from '../i18n/index.js';

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
  fallbackProviders?: LlmProvider[];
  onProviderSwitch?: (provider: LlmProvider) => void;
  interactiveModelSelect?: () => Promise<LlmProvider | null>;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000];

export async function agentLoop(
  userMessage: string | ContentBlock[],
  options: AgentLoopOptions
): Promise<string> {
  const {
    registry,
    maxIterations = 50,
    stream = true,
    showOutput = true,
  } = options;

  let currentProvider = options.provider;
  const fallbacks = [...(options.fallbackProviders || [])];

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
    const spinner = showOutput ? startSpinner(t('agent.thinking')) : null;

    try {
      response = await callLlmWithRetry(currentProvider, conversation, registry, stream, options, showOutput);
    } catch (err: any) {
      stopSpinner();

      // Rate limit exhausted — try fallback provider
      const status = err.status || err.statusCode;
      if (status === 429) {
        // Mode A: auto-fallback chain
        if (fallbacks.length > 0) {
          const nextProvider = fallbacks.shift()!;
          if (showOutput) {
            console.log(chalk.yellow(`\n⚠ ${t('agent.rateLimit', currentProvider.name, currentProvider.model, nextProvider.name, nextProvider.model)}`));
          }
          logger.info('Rate limit fallback', {
            from: `${currentProvider.name}/${currentProvider.model}`,
            to: `${nextProvider.name}/${nextProvider.model}`,
            remainingFallbacks: fallbacks.length,
          });
          currentProvider = nextProvider;
          options.onProviderSwitch?.(currentProvider);
          iterations--;
          continue;
        }

        // Mode B: interactive model selection
        if (options.interactiveModelSelect) {
          if (showOutput) {
            console.log(chalk.yellow(`\n⚠ ${t('agent.selectModel')}`));
          }
          const selected = await options.interactiveModelSelect();
          if (selected) {
            logger.info('Interactive model switch', {
              from: `${currentProvider.name}/${currentProvider.model}`,
              to: `${selected.name}/${selected.model}`,
            });
            currentProvider = selected;
            options.onProviderSwitch?.(currentProvider);
            iterations--;
            continue;
          }
        }
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('LLM 호출 실패', { model: currentProvider.model }, err instanceof Error ? err : new Error(errMsg));
      if (showOutput) {
        console.error(chalk.red(`\n${t('agent.llmError', errMsg)}`));
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
      logger.debug('LLM 응답 수신', {
        model: currentProvider.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        stopReason: response.stopReason,
        toolCalls: response.toolCalls?.length ?? 0,
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
    if (response.stopReason === 'max_tokens') {
      // Auto-continue: ask LLM to keep writing
      if (showOutput && !wasStreamed && finalText) {
        console.log('');
        console.log(renderAssistantPrefix());
        console.log(renderMarkdown(finalText));
      }
      conversation.addUserMessage(t('agent.continue'));
      continue;
    }

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

    // Execute tools
    if (response.toolCalls && response.toolCalls.length > 0) {
      if (showOutput) {
        console.log('');
      }

      const results = await executor.executeMany(response.toolCalls);

      // Add tool results to conversation (with image support)
      const toolResults = results.map((r) => {
        // If tool returned image data, send as ContentBlock[] so LLM can actually see it
        if (r.result.metadata?.isImage && r.result.metadata.imageData) {
          const blocks: ContentBlock[] = [
            { type: 'text', text: r.result.output },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: r.result.metadata.imageMimeType || 'image/png',
                data: r.result.metadata.imageData,
              },
            },
          ];
          return {
            tool_use_id: r.toolUseId,
            content: blocks,
            is_error: !r.result.success,
          };
        }
        return {
          tool_use_id: r.toolUseId,
          content: r.result.output,
          is_error: !r.result.success,
        };
      });

      conversation.addToolResults(toolResults);
    }
  }

  if (iterations >= maxIterations) {
    if (showOutput) {
      console.log(chalk.yellow(`\n⚠ ${t('agent.maxIterations', String(maxIterations))}`));
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
  let lastError: any = null;

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
                streamedText += text;
                options.onToken?.(text);
              },
            }
          : undefined,
      });

      // If we streamed text, render with markdown formatting
      if (streamedText) {
        if (showOutput) {
          process.stdout.write('\n' + renderAssistantPrefix() + '\n');
          console.log(renderMarkdown(streamedText));
        }
        // Text was already displayed — do not render again
        return { ...response, _streamed: true } as any;
      }

      return response;
    } catch (err: any) {
      lastError = err;

      // Check if retryable
      const status = err.status || err.statusCode;
      if (status === 429 || (status >= 500 && status < 600)) {
        const delay = RETRY_DELAYS[attempt] || 4000;
        if (showOutput) {
          updateSpinner(t('agent.retrying', String(status), String(delay / 1000)));
        }
        await sleep(delay);
        continue;
      }

      // Non-retryable error
      throw err;
    }
  }

  // Retries exhausted — throw with original error (preserving status code)
  throw lastError || new Error('Max retries exceeded');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { Conversation };
