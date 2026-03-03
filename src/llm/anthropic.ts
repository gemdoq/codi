import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider } from './provider.js';
import type {
  LlmRequestOptions,
  LlmResponse,
  ContentBlock,
  ToolCall,
  Message,
} from './types.js';

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  model: string;
  private client: Anthropic;
  private maxTokens: number;

  constructor(config: { apiKey?: string; model?: string; maxTokens?: number; baseUrl?: string }) {
    this.client = new Anthropic({
      apiKey: config.apiKey || process.env['ANTHROPIC_API_KEY'],
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
    this.model = config.model || 'claude-sonnet-4-20250514';
    this.maxTokens = config.maxTokens || 8192;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async listModels(): Promise<string[]> {
    return [
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-haiku-3-5-20241022',
    ];
  }

  async chat(options: LlmRequestOptions): Promise<LlmResponse> {
    const messages = this.convertMessages(options.messages);
    const tools = options.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));

    if (options.stream && options.callbacks) {
      return this.streamChat(messages, options);
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    return this.parseResponse(response);
  }

  private async streamChat(
    messages: Anthropic.MessageParam[],
    options: LlmRequestOptions
  ): Promise<LlmResponse> {
    const tools = options.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    stream.on('text', (text) => {
      options.callbacks?.onToken?.(text);
    });

    const response = await stream.finalMessage();
    return this.parseResponse(response);
  }

  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (typeof m.content === 'string') {
          return { role: m.role as 'user' | 'assistant', content: m.content };
        }

        const blocks: Anthropic.ContentBlockParam[] = m.content.map((block) => {
          switch (block.type) {
            case 'text':
              return { type: 'text' as const, text: block.text };
            case 'image':
              return {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: block.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: block.source.data,
                },
              };
            case 'tool_use':
              return {
                type: 'tool_use' as const,
                id: block.id,
                name: block.name,
                input: block.input,
              };
            case 'tool_result':
              return {
                type: 'tool_result' as const,
                tool_use_id: block.tool_use_id,
                content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
                ...(block.is_error ? { is_error: true } : {}),
              };
            default:
              return { type: 'text' as const, text: JSON.stringify(block) };
          }
        });

        return { role: m.role as 'user' | 'assistant', content: blocks };
      });
  }

  private parseResponse(response: Anthropic.Message): LlmResponse {
    const content: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let text = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
        text += block.text;
      } else if (block.type === 'tool_use') {
        const tc: ToolCall = {
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        };
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
        toolCalls.push(tc);
      }
    }

    return {
      content,
      text: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
      stopReason: response.stop_reason as LlmResponse['stopReason'],
    };
  }
}
