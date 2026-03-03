import { describe, it, expect, beforeEach } from 'vitest';
import { TokenTracker } from '../../src/agent/token-tracker.js';

describe('TokenTracker', () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    tracker = new TokenTracker();
  });

  it('starts with zero stats', () => {
    const stats = tracker.getStats();
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
    expect(stats.totalTokens).toBe(0);
    expect(stats.cost).toBe(0);
    expect(stats.requests).toBe(0);
  });

  it('tracks token usage', () => {
    tracker.track({ input_tokens: 100, output_tokens: 50 });
    const stats = tracker.getStats();
    expect(stats.inputTokens).toBe(100);
    expect(stats.outputTokens).toBe(50);
    expect(stats.totalTokens).toBe(150);
    expect(stats.requests).toBe(1);
  });

  it('accumulates across multiple track calls', () => {
    tracker.track({ input_tokens: 100, output_tokens: 50 });
    tracker.track({ input_tokens: 200, output_tokens: 100 });
    tracker.track({ input_tokens: 300, output_tokens: 150 });
    const stats = tracker.getStats();
    expect(stats.inputTokens).toBe(600);
    expect(stats.outputTokens).toBe(300);
    expect(stats.totalTokens).toBe(900);
    expect(stats.requests).toBe(3);
  });

  it('calculates cost for known model', () => {
    tracker.setModel('gpt-4o');
    tracker.track({ input_tokens: 1000, output_tokens: 1000 });
    // gpt-4o: input=0.0025/1K, output=0.01/1K
    // cost = (1000/1000)*0.0025 + (1000/1000)*0.01 = 0.0125
    const cost = tracker.getCost();
    expect(cost).toBeCloseTo(0.0125, 6);
  });

  it('returns zero cost for unknown model', () => {
    tracker.setModel('unknown-model-xyz');
    tracker.track({ input_tokens: 1000, output_tokens: 1000 });
    expect(tracker.getCost()).toBe(0);
  });

  it('resets to initial state', () => {
    tracker.track({ input_tokens: 500, output_tokens: 250 });
    tracker.reset();
    const stats = tracker.getStats();
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
    expect(stats.requests).toBe(0);
  });

  it('formats output as human-readable string', () => {
    tracker.track({ input_tokens: 100, output_tokens: 50 });
    const formatted = tracker.format();
    expect(formatted).toContain('Requests: 1');
    expect(formatted).toContain('Input: 100');
    expect(formatted).toContain('Output: 50');
    expect(formatted).toContain('Total: 150');
  });

  it('formats output with cost for known model', () => {
    tracker.setModel('gpt-4o');
    tracker.track({ input_tokens: 1000, output_tokens: 1000 });
    const formatted = tracker.format();
    expect(formatted).toContain('Cost: $');
  });

  it('formats large numbers with K and M suffixes', () => {
    tracker.track({ input_tokens: 1_500_000, output_tokens: 2500 });
    const formatted = tracker.format();
    expect(formatted).toContain('1.5M');
    expect(formatted).toContain('2.5K');
  });

  it('increments request count correctly', () => {
    for (let i = 0; i < 5; i++) {
      tracker.track({ input_tokens: 10, output_tokens: 5 });
    }
    expect(tracker.getStats().requests).toBe(5);
  });
});
