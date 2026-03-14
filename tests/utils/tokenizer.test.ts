import { describe, it, expect } from 'vitest';
import { countTokens, countMessageTokens, countContentBlockTokens } from '../../src/utils/tokenizer.js';
import type { ContentBlock } from '../../src/llm/types.js';

describe('countTokens', () => {
  it('빈 문자열은 0을 반환한다', () => {
    expect(countTokens('')).toBe(0);
  });

  it('null/undefined도 0을 반환한다', () => {
    expect(countTokens(null as unknown as string)).toBe(0);
    expect(countTokens(undefined as unknown as string)).toBe(0);
  });

  it('일반 텍스트에 대해 0이 아닌 합리적인 값을 반환한다', () => {
    const tokens = countTokens('Hello, world!');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it('긴 텍스트에 대해 비례적으로 큰 값을 반환한다', () => {
    const short = countTokens('Hello');
    const long = countTokens('Hello '.repeat(100));
    expect(long).toBeGreaterThan(short);
  });

  it('한글 텍스트도 처리한다', () => {
    const tokens = countTokens('안녕하세요, 세계!');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it('알 수 없는 모델은 cl100k_base로 폴백한다', () => {
    const tokens = countTokens('Hello, world!', 'totally-unknown-model-xyz');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(100);
  });

  it('지정된 모델로도 동작한다', () => {
    const tokens = countTokens('Hello, world!', 'gpt-4');
    expect(tokens).toBeGreaterThan(0);
  });

  it('비정상적으로 큰 값을 반환하지 않는다', () => {
    const text = 'This is a normal sentence.';
    const tokens = countTokens(text);
    // 한 문장이 100토큰 이상일 리 없다
    expect(tokens).toBeLessThan(100);
  });
});

describe('countMessageTokens', () => {
  it('string content를 처리한다', () => {
    const tokens = countMessageTokens('Hello, world!');
    expect(tokens).toBeGreaterThan(0);
  });

  it('ContentBlock[] content를 처리한다', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello, world!' },
    ];
    const tokens = countMessageTokens(blocks);
    expect(tokens).toBeGreaterThan(0);
  });

  it('빈 문자열은 0을 반환한다', () => {
    expect(countMessageTokens('')).toBe(0);
  });

  it('빈 ContentBlock 배열은 0을 반환한다', () => {
    expect(countMessageTokens([])).toBe(0);
  });
});

describe('countContentBlockTokens', () => {
  it('text 블록의 토큰을 카운트한다', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'World' },
    ];
    const tokens = countContentBlockTokens(blocks);
    expect(tokens).toBeGreaterThan(0);
  });

  it('tool_use 블록의 토큰을 카운트한다', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_use', id: 'test-1', name: 'bash', input: { command: 'ls -la' } },
    ];
    const tokens = countContentBlockTokens(blocks);
    expect(tokens).toBeGreaterThan(0);
  });

  it('tool_result 블록(string content)의 토큰을 카운트한다', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: 'test-1', content: 'file1.ts\nfile2.ts' },
    ];
    const tokens = countContentBlockTokens(blocks);
    expect(tokens).toBeGreaterThan(0);
  });

  it('tool_result 블록(ContentBlock[] content)의 토큰을 카운트한다', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool_result',
        tool_use_id: 'test-1',
        content: [{ type: 'text', text: 'result data' }],
      },
    ];
    const tokens = countContentBlockTokens(blocks);
    expect(tokens).toBeGreaterThan(0);
  });

  it('여러 블록 타입의 토큰을 합산한다', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'id1', name: 'test', input: { key: 'value' } },
    ];
    const textOnly: ContentBlock[] = [{ type: 'text', text: 'Hello' }];
    const toolOnly: ContentBlock[] = [{ type: 'tool_use', id: 'id1', name: 'test', input: { key: 'value' } }];

    const combined = countContentBlockTokens(blocks);
    const separate = countContentBlockTokens(textOnly) + countContentBlockTokens(toolOnly);
    expect(combined).toBe(separate);
  });
});
