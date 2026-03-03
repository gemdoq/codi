import { Ollama } from 'ollama';
import type { LlmProvider } from './provider.js';
import type {
  LlmRequestOptions,
  LlmResponse,
  ContentBlock,
  ToolCall,
  Message,
} from './types.js';

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  model: string;
  private client: Ollama;
  private maxTokens: number;

  constructor(config: { model?: string; maxTokens?: number; baseUrl?: string }) {
    this.client = new Ollama({
      host: config.baseUrl || process.env['OLLAMA_HOST'] || 'http://localhost:11434',
    });
    this.model = config.model || 'llama3.1';
    this.maxTokens = config.maxTokens || 4096;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async listModels(): Promise<string[]> {
    try {
      const models = await this.client.list();
      return models.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  async chat(options: LlmRequestOptions): Promise<LlmResponse> {
    const messages = this.convertMessages(options.messages, options.systemPrompt);

    const tools = options.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    if (options.stream && options.callbacks) {
      return this.streamChat(messages, tools, options);
    }

    const response = await this.client.chat({
      model: this.model,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
      options: {
        num_predict: options.maxTokens || this.maxTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      },
    });

    return this.parseResponse(response);
  }

  private async streamChat(
    messages: any[],
    tools: any[] | undefined,
    options: LlmRequestOptions
  ): Promise<LlmResponse> {
    const response = await this.client.chat({
      model: this.model,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
      stream: true,
      options: {
        num_predict: options.maxTokens || this.maxTokens,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      },
    });

    let text = '';
    const toolCalls: ToolCall[] = [];

    for await (const chunk of response) {
      if (chunk.message?.content) {
        text += chunk.message.content;
        options.callbacks?.onToken?.(chunk.message.content);
      }

      if (chunk.message?.tool_calls) {
        for (const tc of chunk.message.tool_calls) {
          toolCalls.push({
            id: `ollama_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: tc.function.name,
            input: tc.function.arguments as Record<string, unknown>,
          });
        }
      }
    }

    const content: ContentBlock[] = [];
    if (text) content.push({ type: 'text', text });
    for (const tc of toolCalls) {
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
    }

    return {
      content,
      text: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  }

  private convertMessages(messages: Message[], systemPrompt?: string): any[] {
    const result: any[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const m of messages) {
      if (typeof m.content === 'string') {
        result.push({ role: m.role, content: m.content });
        continue;
      }

      // Flatten content blocks for Ollama
      const textParts: string[] = [];
      const images: string[] = [];

      for (const block of m.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'image') {
          images.push(block.source.data);
        } else if (block.type === 'tool_result') {
          textParts.push(`[Tool Result: ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}]`);
        } else if (block.type === 'tool_use') {
          textParts.push(`[Tool Call: ${block.name}(${JSON.stringify(block.input)})]`);
        }
      }

      result.push({
        role: m.role,
        content: textParts.join('\n'),
        ...(images.length > 0 ? { images } : {}),
      });
    }

    return result;
  }

  private parseResponse(response: any): LlmResponse {
    const content: ContentBlock[] = [];
    const toolCalls: ToolCall[] = [];
    let text = '';

    if (response.message?.content) {
      text = response.message.content;
      content.push({ type: 'text', text });
    }

    if (response.message?.tool_calls) {
      for (const tc of response.message.tool_calls) {
        const toolCall: ToolCall = {
          id: `ollama_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: tc.function.name,
          input: tc.function.arguments as Record<string, unknown>,
        };
        toolCalls.push(toolCall);
        content.push({ type: 'tool_use', ...toolCall });
      }
    }

    return {
      content,
      text: text || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: response.eval_count
        ? { input_tokens: response.prompt_eval_count ?? 0, output_tokens: response.eval_count }
        : undefined,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
    };
  }
}
