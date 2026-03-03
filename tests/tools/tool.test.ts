import { describe, it, expect } from 'vitest';
import { makeToolResult, makeToolError } from '../../src/tools/tool.js';

describe('makeToolResult', () => {
  it('returns success: true with output', () => {
    const result = makeToolResult('hello');
    expect(result).toEqual({ success: true, output: 'hello', metadata: undefined });
  });

  it('includes metadata when provided', () => {
    const metadata = { filePath: '/tmp/test.ts', linesChanged: 5 };
    const result = makeToolResult('done', metadata);
    expect(result.success).toBe(true);
    expect(result.output).toBe('done');
    expect(result.metadata).toEqual(metadata);
  });

  it('handles empty string output', () => {
    const result = makeToolResult('');
    expect(result.success).toBe(true);
    expect(result.output).toBe('');
  });

  it('handles special characters and unicode', () => {
    const result = makeToolResult('한글 테스트 🎉 <script>alert("xss")</script>');
    expect(result.success).toBe(true);
    expect(result.output).toBe('한글 테스트 🎉 <script>alert("xss")</script>');
  });
});

describe('makeToolError', () => {
  it('returns success: false with error', () => {
    const result = makeToolError('something failed');
    expect(result.success).toBe(false);
    expect(result.output).toBe('something failed');
    expect(result.error).toBe('something failed');
  });

  it('includes metadata when provided', () => {
    const metadata = { tokensUsed: 100 };
    const result = makeToolError('failed', metadata);
    expect(result.success).toBe(false);
    expect(result.error).toBe('failed');
    expect(result.metadata).toEqual(metadata);
  });

  it('handles empty string error', () => {
    const result = makeToolError('');
    expect(result.success).toBe(false);
    expect(result.output).toBe('');
    expect(result.error).toBe('');
  });

  it('handles special characters and unicode', () => {
    const result = makeToolError('오류 발생: 파일을 찾을 수 없습니다 ❌');
    expect(result.success).toBe(false);
    expect(result.error).toBe('오류 발생: 파일을 찾을 수 없습니다 ❌');
  });
});
