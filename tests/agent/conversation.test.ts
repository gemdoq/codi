import { describe, it, expect, beforeEach } from 'vitest';
import { Conversation } from '../../src/agent/conversation.js';

describe('Conversation', () => {
  let conv: Conversation;

  beforeEach(() => {
    conv = new Conversation();
  });

  it('sets and gets system prompt', () => {
    conv.setSystemPrompt('You are helpful.');
    expect(conv.getSystemPrompt()).toBe('You are helpful.');
  });

  it('adds user message (string)', () => {
    conv.addUserMessage('hello');
    const msgs = conv.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'hello' });
  });

  it('adds user message (ContentBlock[])', () => {
    const blocks = [{ type: 'text' as const, text: 'hello with blocks' }];
    conv.addUserMessage(blocks);
    const msgs = conv.getMessages();
    expect(msgs[0]!.content).toEqual(blocks);
  });

  it('adds assistant message', () => {
    conv.addAssistantMessage('I can help!');
    const msgs = conv.getMessages();
    expect(msgs[0]).toEqual({ role: 'assistant', content: 'I can help!' });
  });

  it('adds tool results', () => {
    conv.addToolResults([
      { tool_use_id: 'id1', content: 'result1' },
      { tool_use_id: 'id2', content: 'error!', is_error: true },
    ]);
    const msgs = conv.getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe('user');
    const blocks = msgs[0]!.content as Array<{ type: string; tool_use_id: string; content: string; is_error?: boolean }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe('tool_result');
    expect(blocks[0]!.tool_use_id).toBe('id1');
    expect(blocks[1]!.is_error).toBe(true);
  });

  it('getMessages returns a copy', () => {
    conv.addUserMessage('msg');
    const msgs = conv.getMessages();
    msgs.push({ role: 'user', content: 'injected' });
    expect(conv.getMessageCount()).toBe(1);
  });

  it('getLastMessage returns the last message', () => {
    conv.addUserMessage('first');
    conv.addAssistantMessage('second');
    expect(conv.getLastMessage()).toEqual({ role: 'assistant', content: 'second' });
  });

  it('getLastMessage returns undefined for empty conversation', () => {
    expect(conv.getLastMessage()).toBeUndefined();
  });

  it('getMessageCount returns correct count', () => {
    expect(conv.getMessageCount()).toBe(0);
    conv.addUserMessage('a');
    conv.addAssistantMessage('b');
    expect(conv.getMessageCount()).toBe(2);
  });

  it('clear resets messages', () => {
    conv.addUserMessage('a');
    conv.addAssistantMessage('b');
    conv.clear();
    expect(conv.getMessageCount()).toBe(0);
    expect(conv.getMessages()).toEqual([]);
  });

  it('compact replaces old messages with summary', () => {
    for (let i = 0; i < 10; i++) {
      conv.addUserMessage(`msg-${i}`);
    }
    conv.compact('Summary of first 6 messages', 4);
    const msgs = conv.getMessages();
    // 2 summary messages + 4 kept recent = 6
    expect(msgs).toHaveLength(6);
    expect((msgs[0]!.content as string)).toContain('Summary of first 6 messages');
    expect(msgs[1]!.role).toBe('assistant');
    // Last 4 should be the original recent messages
    expect(msgs[2]!.content).toBe('msg-6');
    expect(msgs[5]!.content).toBe('msg-9');
  });

  it('compact does nothing when messages <= keepRecent', () => {
    conv.addUserMessage('a');
    conv.addUserMessage('b');
    conv.compact('should not replace', 4);
    expect(conv.getMessageCount()).toBe(2);
  });

  it('fork creates an independent copy', () => {
    conv.setSystemPrompt('sys');
    conv.addUserMessage('hello');
    const forked = conv.fork();
    conv.addAssistantMessage('modified original');
    expect(forked.getMessageCount()).toBe(1);
    expect(forked.getSystemPrompt()).toBe('sys');
  });

  it('truncateTo keeps only last N messages', () => {
    for (let i = 0; i < 10; i++) {
      conv.addUserMessage(`msg-${i}`);
    }
    conv.truncateTo(3);
    expect(conv.getMessageCount()).toBe(3);
    expect(conv.getMessages()[0]!.content).toBe('msg-7');
  });

  it('truncateTo does nothing when count >= messages length', () => {
    conv.addUserMessage('a');
    conv.truncateTo(5);
    expect(conv.getMessageCount()).toBe(1);
  });

  it('serialize and deserialize round-trip', () => {
    conv.setSystemPrompt('prompt');
    conv.addUserMessage('hi');
    conv.addAssistantMessage('hello');
    const data = conv.serialize();
    const restored = Conversation.deserialize(data);
    expect(restored.getSystemPrompt()).toBe('prompt');
    expect(restored.getMessageCount()).toBe(2);
    expect(restored.getMessages()).toEqual(conv.getMessages());
  });

  it('estimateTokens returns token count using tiktoken', () => {
    conv.setSystemPrompt('Hello world');
    conv.addUserMessage('This is a test message');
    const tokens = conv.estimateTokens();
    // tiktoken 기반이므로 정확한 토큰 수는 다를 수 있으나, 0보다 큰 합리적인 값이어야 한다
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(50);
  });

  it('handles empty conversation state', () => {
    expect(conv.getSystemPrompt()).toBe('');
    expect(conv.getMessages()).toEqual([]);
    expect(conv.getMessageCount()).toBe(0);
    expect(conv.getLastMessage()).toBeUndefined();
    expect(conv.estimateTokens()).toBe(0);
  });
});
