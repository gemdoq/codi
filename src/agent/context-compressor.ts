import type { LlmProvider } from '../llm/provider.js';
import type { Conversation } from './conversation.js';

export interface CompressorOptions {
  threshold: number; // 0-1, fraction of context window to trigger
  maxContextTokens: number; // Model's context window size
  keepRecentMessages: number; // Number of recent messages to preserve
}

const DEFAULT_OPTIONS: CompressorOptions = {
  threshold: 0.7,
  maxContextTokens: 200_000,
  keepRecentMessages: 6,
};

export class ContextCompressor {
  private options: CompressorOptions;

  constructor(options?: Partial<CompressorOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  shouldCompress(conversation: Conversation): boolean {
    const estimatedTokens = conversation.estimateTokens();
    return estimatedTokens > this.options.maxContextTokens * this.options.threshold;
  }

  async compress(
    conversation: Conversation,
    provider: LlmProvider,
    focusHint?: string
  ): Promise<void> {
    const messages = conversation.getMessages();
    if (messages.length <= this.options.keepRecentMessages) return;

    // Get messages to summarize (everything except recent)
    const toSummarize = messages.slice(0, -this.options.keepRecentMessages);

    // Build summary prompt
    const summaryContent = toSummarize
      .map((m) => {
        const role = m.role;
        const content = typeof m.content === 'string'
          ? m.content
          : m.content
              .map((b) => {
                if (b.type === 'text') return b.text;
                if (b.type === 'tool_use') return `[Tool: ${b.name}]`;
                if (b.type === 'tool_result') return `[Result: ${typeof b.content === 'string' ? b.content.slice(0, 200) : '...'}]`;
                return '';
              })
              .filter(Boolean)
              .join('\n');
        return `${role}: ${content}`;
      })
      .join('\n\n');

    const prompt = focusHint
      ? `Summarize this conversation concisely, focusing on: ${focusHint}\n\n${summaryContent}`
      : `Summarize this conversation concisely, preserving key decisions, code changes, file paths, and important context:\n\n${summaryContent}`;

    try {
      const response = await provider.chat({
        messages: [{ role: 'user', content: prompt }],
        systemPrompt: 'You are a conversation summarizer. Create a concise but complete summary that preserves all important technical details, file paths, decisions made, and context needed to continue the conversation.',
        maxTokens: 2000,
      });

      const summary = response.text || 'Previous conversation context.';
      conversation.compact(summary, this.options.keepRecentMessages);
    } catch {
      // If summarization fails, just truncate
      conversation.truncateTo(this.options.keepRecentMessages + 2);
    }
  }
}
