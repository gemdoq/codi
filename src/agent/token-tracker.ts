import type { LlmUsage } from '../llm/types.js';
import { getModelCost } from '../llm/types.js';

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  requests: number;
}

export interface RequestCost {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: number;
}

export interface SessionStats extends TokenStats {
  lastRequestCost: RequestCost | null;
  avgCostPerRequest: number;
}

export class TokenTracker {
  // Global (accumulated) counters
  private inputTokens = 0;
  private outputTokens = 0;
  private requests = 0;

  // Per-session counters
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private sessionRequests = 0;
  private lastRequestCost: RequestCost | null = null;

  private model = '';

  setModel(model: string): void {
    this.model = model;
  }

  track(usage: LlmUsage): void {
    // Update global
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    this.requests++;

    // Update session
    this.sessionInputTokens += usage.input_tokens;
    this.sessionOutputTokens += usage.output_tokens;
    this.sessionRequests++;

    // Track per-request cost
    const costs = getModelCost(this.model);
    const reqCost =
      (usage.input_tokens / 1000) * costs.input + (usage.output_tokens / 1000) * costs.output;

    this.lastRequestCost = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cost: reqCost,
      timestamp: Date.now(),
    };
  }

  getStats(): TokenStats {
    const costs = getModelCost(this.model);
    const cost =
      (this.inputTokens / 1000) * costs.input + (this.outputTokens / 1000) * costs.output;

    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      cost,
      requests: this.requests,
    };
  }

  getSessionStats(): SessionStats {
    const costs = getModelCost(this.model);
    const cost =
      (this.sessionInputTokens / 1000) * costs.input +
      (this.sessionOutputTokens / 1000) * costs.output;

    return {
      inputTokens: this.sessionInputTokens,
      outputTokens: this.sessionOutputTokens,
      totalTokens: this.sessionInputTokens + this.sessionOutputTokens,
      cost,
      requests: this.sessionRequests,
      lastRequestCost: this.lastRequestCost,
      avgCostPerRequest: this.sessionRequests > 0 ? cost / this.sessionRequests : 0,
    };
  }

  resetSession(): void {
    this.sessionInputTokens = 0;
    this.sessionOutputTokens = 0;
    this.sessionRequests = 0;
    this.lastRequestCost = null;
  }

  getCost(): number {
    return this.getStats().cost;
  }

  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.requests = 0;
  }

  format(): string {
    const stats = this.getStats();
    const parts = [
      `Requests: ${stats.requests}`,
      `Input: ${this.formatTokens(stats.inputTokens)}`,
      `Output: ${this.formatTokens(stats.outputTokens)}`,
      `Total: ${this.formatTokens(stats.totalTokens)}`,
    ];
    if (stats.cost > 0) {
      parts.push(`Cost: $${stats.cost.toFixed(4)}`);
    }
    return parts.join(' | ');
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }
}

export const tokenTracker = new TokenTracker();
