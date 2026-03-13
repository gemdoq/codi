import OpenAI from 'openai';
import type { LlmProvider } from './provider.js';
import type {
  LlmRequestOptions,
  LlmResponse,
  ContentBlock,
  ToolCall,
  Message,
} from './types.js';

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  model: string;
  private client: OpenAI;
  private maxTokens: number;
  private isGemini: boolean;

  constructor(config: { apiKey?: string; model?: string; maxTokens?: number; baseUrl?: string }) {
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env['OPENAI_API_KEY'],
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.model = config.model || 'gpt-4o';
    this.maxTokens = config.maxTokens || 8192;
    this.isGemini = !!(config.baseUrl && config.baseUrl.includes('generativelanguage.googleapis.com'));
  }

  setModel(model: string): void {
    this.model = model;
  }

  async listModels(): Promise<string[]> {
    try {
      const models = await this.client.models.list();
      return models.data
        .filter((m) => m.id.startsWith('gpt-'))
        .map((m) => m.id)
        .sort();
    } catch {
      return ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'];
    }
  }

  async chat(options: LlmRequestOptions): Promise<LlmResponse> {
    const messages = this.convertMessages(options.messages, options.systemPrompt);
    const tools = options.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: this.cleanSchema(t.input_schema),
      },
    }));

    try {
      if (options.stream && options.callbacks) {
        return await this.streamChat(messages, tools, options);
      }

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: options.maxTokens || this.maxTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
      });

      return this.parseResponse(response);
    } catch (err: any) {
      // Extract detailed error info for better debugging
      const status = err.status || err.statusCode || '';
      const body = err.error || err.body || err.response?.body || '';
      const detail = body ? JSON.stringify(body) : err.message || String(err);
      throw new Error(`${status} ${detail}`.trim());
    }
  }

  private async streamChat(
    messages: OpenAI.ChatCompletionMessageParam[],
    tools: OpenAI.ChatCompletionTool[] | undefined,
    options: LlmRequestOptions
  ): Promise<LlmResponse> {
    let stream;
    try {
      stream = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: options.maxTokens || this.maxTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        stream: true,
      });
    } catch (err: any) {
      const status = err.status || err.statusCode || '';
      const body = err.error || err.body || err.response?.body || '';
      const detail = body ? JSON.stringify(body) : err.message || String(err);
      throw new Error(`${status} ${detail}`.trim());
    }

    const content: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let text = '';
    const toolCallAccumulator: Map<number, { id: string; name: string; args: string }> = new Map();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        options.callbacks?.onToken?.(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallAccumulator.has(idx)) {
            toolCallAccumulator.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: '' });
          }
          const acc = toolCallAccumulator.get(idx)!;
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
        }
      }
    }

    if (text) {
      content.push({ type: 'text', text });
    }

    for (const [, acc] of toolCallAccumulator) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(acc.args);
      } catch {}
      const tc: ToolCall = { id: acc.id, name: acc.name, input };
      toolCalls.push(tc);
      content.push({ type: 'tool_use', id: acc.id, name: acc.name, input });
    }

    return {
      content,
      text: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  }

  /**
   * Clean JSON Schema for Gemini compatibility.
   * Gemini's OpenAI-compatible API rejects some valid JSON Schema features:
   * - Empty `required` arrays
   * - `default` values in properties
   * - `additionalProperties` at top level
   */
  private cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
    const cleaned = { ...schema };

    // Remove empty required arrays
    if (Array.isArray(cleaned['required']) && (cleaned['required'] as unknown[]).length === 0) {
      delete cleaned['required'];
    }

    // Clean properties recursively
    if (cleaned['properties'] && typeof cleaned['properties'] === 'object') {
      const props = { ...cleaned['properties'] as Record<string, unknown> };
      for (const [key, val] of Object.entries(props)) {
        if (val && typeof val === 'object') {
          const prop = { ...val as Record<string, unknown> };
          // Remove default values (Gemini doesn't support them in tool schemas)
          delete prop['default'];
          props[key] = prop;
        }
      }
      cleaned['properties'] = props;
    }

    return cleaned;
  }

  private convertMessages(
    messages: Message[],
    systemPrompt?: string
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const m of messages) {
      if (m.role === 'system') {
        result.push({ role: 'system', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
        continue;
      }

      if (typeof m.content === 'string') {
        result.push({ role: m.role as 'user' | 'assistant', content: m.content });
        continue;
      }

      // Handle content blocks
      const hasToolResults = m.content.some((b) => b.type === 'tool_result');
      if (hasToolResults) {
        for (const block of m.content) {
          if (block.type === 'tool_result') {
            result.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            });
          }
        }
        continue;
      }

      const hasToolUse = m.content.some((b) => b.type === 'tool_use');
      if (hasToolUse) {
        const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
        let textContent = '';
        for (const block of m.content) {
          if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          } else if (block.type === 'text') {
            textContent += block.text;
          }
        }
        result.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls,
        });
        continue;
      }

      // Regular content blocks
      const parts: OpenAI.ChatCompletionContentPart[] = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' | 'image' }> =>
          b.type === 'text' || b.type === 'image'
        )
        .map((b) => {
          if (b.type === 'text') return { type: 'text' as const, text: b.text };
          return {
            type: 'image_url' as const,
            image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
          };
        });

      if (m.role === 'user') {
        result.push({ role: 'user' as const, content: parts });
      } else {
        const textContent = parts.filter((p): p is OpenAI.ChatCompletionContentPartText => p.type === 'text').map(p => p.text).join('');
        result.push({ role: 'assistant' as const, content: textContent || null });
      }
    }

    return result;
  }

  private parseResponse(response: OpenAI.ChatCompletion): LlmResponse {
    const choice = response.choices[0];
    if (!choice) {
      return { content: [], stopReason: 'end_turn' };
    }

    const content: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let text = '';

    if (choice.message.content) {
      text = choice.message.content;
      content.push({ type: 'text', text });
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        if (tc.type !== 'function') continue;
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments);
        } catch {}
        toolCalls.push({ id: tc.id, name: tc.function.name, input });
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
    }

    return {
      content,
      text: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: response.usage
        ? {
            input_tokens: response.usage.prompt_tokens,
            output_tokens: response.usage.completion_tokens,
          }
        : undefined,
      stopReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
    };
  }
}
