import type { LlmUsage } from '../llm/types.js';
import { getModelCost } from '../llm/types.js';

export interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  requests: number;
}

export class TokenTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private requests = 0;
  private model = '';

  setModel(model: string): void {
    this.model = model;
  }

  track(usage: LlmUsage): void {
    this.inputTokens += usage.input_tokens;
    this.outputTokens += usage.output_tokens;
    this.requests++;
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
