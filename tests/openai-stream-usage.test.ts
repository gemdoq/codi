/**
 * OpenAI streaming usage tracking simulation test
 *
 * Verifies that:
 * 1. stream_options: { include_usage: true } causes usage in final chunk
 * 2. Usage is correctly captured from streaming chunks
 * 3. Fallback works when stream_options is not supported
 */
import { describe, it, expect, vi } from 'vitest';

// Simulate OpenAI streaming chunk structure (matching SDK types)
interface MockChunk {
  choices: Array<{ delta: { content?: string; tool_calls?: any[] } }>;
  usage?: { prompt_tokens: number; completion_tokens: number } | null;
}

// Simulates the streaming usage capture logic from openai.ts
function simulateStreamChat(chunks: MockChunk[]): {
  text: string;
  usage?: { input_tokens: number; output_tokens: number };
} {
  let text = '';
  let usage: { input_tokens: number; output_tokens: number } | undefined;

  for (const chunk of chunks) {
    // Capture usage from the final chunk
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens,
        output_tokens: chunk.usage.completion_tokens,
      };
    }

    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      text += delta.content;
    }
  }

  return { text, usage };
}

describe('OpenAI streaming usage tracking', () => {
  it('should capture usage from final streaming chunk', () => {
    const chunks: MockChunk[] = [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
      // Final chunk with usage (sent when stream_options.include_usage = true)
      { choices: [{ delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 50 } },
    ];

    const result = simulateStreamChat(chunks);
    expect(result.text).toBe('Hello world');
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
  });

  it('should return undefined usage when no usage chunk exists', () => {
    const chunks: MockChunk[] = [
      { choices: [{ delta: { content: 'Hello' } }] },
      { choices: [{ delta: { content: ' world' } }] },
    ];

    const result = simulateStreamChat(chunks);
    expect(result.text).toBe('Hello world');
    expect(result.usage).toBeUndefined();
  });

  it('should handle null usage in chunk', () => {
    const chunks: MockChunk[] = [
      { choices: [{ delta: { content: 'test' } }] },
      { choices: [{ delta: {} }], usage: null },
    ];

    const result = simulateStreamChat(chunks);
    expect(result.text).toBe('test');
    expect(result.usage).toBeUndefined(); // null is falsy, so not captured
  });

  it('should handle empty choices in usage chunk', () => {
    const chunks: MockChunk[] = [
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [], usage: { prompt_tokens: 200, completion_tokens: 80 } },
    ];

    const result = simulateStreamChat(chunks);
    expect(result.text).toBe('ok');
    expect(result.usage).toEqual({ input_tokens: 200, output_tokens: 80 });
  });

  it('should use last usage if multiple chunks have usage', () => {
    const chunks: MockChunk[] = [
      { choices: [{ delta: { content: 'a' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      { choices: [{ delta: { content: 'b' } }], usage: { prompt_tokens: 20, completion_tokens: 10 } },
    ];

    const result = simulateStreamChat(chunks);
    expect(result.text).toBe('ab');
    expect(result.usage).toEqual({ input_tokens: 20, output_tokens: 10 });
  });
});

describe('stream_options fallback logic', () => {
  it('should try with stream_options first, then fallback without', async () => {
    const createFn = vi.fn();

    // First call with stream_options → throws (unsupported)
    createFn.mockRejectedValueOnce(new Error('400 stream_options not supported'));

    // Second call without stream_options → succeeds
    createFn.mockResolvedValueOnce({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    });

    // Simulate the fallback logic
    const baseParams = { model: 'test', messages: [], stream: true as const };
    let stream;
    try {
      stream = await createFn({ ...baseParams, stream_options: { include_usage: true } });
    } catch {
      stream = await createFn(baseParams);
    }

    expect(createFn).toHaveBeenCalledTimes(2);
    expect(createFn.mock.calls[0][0]).toHaveProperty('stream_options');
    expect(createFn.mock.calls[1][0]).not.toHaveProperty('stream_options');
  });

  it('should not fallback when stream_options works', async () => {
    const createFn = vi.fn();

    createFn.mockResolvedValueOnce({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true, value: undefined }),
      }),
    });

    const baseParams = { model: 'test', messages: [], stream: true as const };
    let stream;
    try {
      stream = await createFn({ ...baseParams, stream_options: { include_usage: true } });
    } catch {
      stream = await createFn(baseParams);
    }

    expect(createFn).toHaveBeenCalledTimes(1);
    expect(createFn.mock.calls[0][0]).toHaveProperty('stream_options');
  });
});
