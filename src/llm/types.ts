export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean };

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens';

export interface LlmResponse {
  content: ContentBlock[];
  text?: string;
  toolCalls?: ToolCall[];
  usage?: LlmUsage;
  stopReason?: StopReason;
}

export interface StreamCallbacks {
  onToken?: (text: string) => void;
  onToolUse?: (toolCall: ToolCall) => void;
}

export interface LlmRequestOptions {
  messages: Message[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  callbacks?: StreamCallbacks;
}

// Cost per 1K tokens for known models
export const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
  'claude-opus-4-20250514': { input: 0.015, output: 0.075 },
  'claude-haiku-3-5-20241022': { input: 0.0008, output: 0.004 },
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4.1': { input: 0.002, output: 0.008 },
  'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
  'gpt-4.1-nano': { input: 0.0001, output: 0.0004 },
};

export function getModelCost(model: string): { input: number; output: number } {
  return MODEL_COSTS[model] ?? { input: 0, output: 0 };
}
