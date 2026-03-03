import type { LlmRequestOptions, LlmResponse } from './types.js';

export interface LlmProvider {
  readonly name: string;
  readonly model: string;

  chat(options: LlmRequestOptions): Promise<LlmResponse>;
  setModel(model: string): void;
  listModels(): Promise<string[]>;
}

export type ProviderName = 'anthropic' | 'openai' | 'ollama';

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}
