import type { Message, ContentBlock } from '../llm/types.js';

export class Conversation {
  private messages: Message[] = [];
  private systemPrompt: string = '';

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  addUserMessage(content: string | ContentBlock[]): void {
    this.messages.push({ role: 'user', content });
  }

  addAssistantMessage(content: string | ContentBlock[]): void {
    this.messages.push({ role: 'assistant', content });
  }

  addToolResults(results: Array<{ tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }>): void {
    const blocks: ContentBlock[] = results.map((r) => ({
      type: 'tool_result' as const,
      tool_use_id: r.tool_use_id,
      content: r.content,
      is_error: r.is_error,
    }));
    this.messages.push({ role: 'user', content: blocks });
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getLastMessage(): Message | undefined {
    return this.messages[this.messages.length - 1];
  }

  getMessageCount(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages = [];
  }

  /**
   * Replace old messages with a summary, keeping recent messages intact.
   */
  compact(summary: string, keepRecent: number = 4): void {
    if (this.messages.length <= keepRecent) return;

    const recent = this.messages.slice(-keepRecent);
    this.messages = [
      { role: 'user', content: `[Previous conversation summary]\n${summary}` },
      { role: 'assistant', content: 'Understood. I have the context from our previous conversation.' },
      ...recent,
    ];
  }

  /**
   * Fork the conversation at the current point.
   */
  fork(): Conversation {
    const forked = new Conversation();
    forked.systemPrompt = this.systemPrompt;
    forked.messages = [...this.messages.map((m) => ({ ...m }))];
    return forked;
  }

  /**
   * Truncate to a specific number of messages from the end.
   */
  truncateTo(count: number): void {
    if (this.messages.length > count) {
      this.messages = this.messages.slice(-count);
    }
  }

  /**
   * Serialize for session saving.
   */
  serialize(): { systemPrompt: string; messages: Message[] } {
    return {
      systemPrompt: this.systemPrompt,
      messages: this.messages,
    };
  }

  /**
   * Restore from serialized data.
   */
  static deserialize(data: { systemPrompt: string; messages: Message[] }): Conversation {
    const conv = new Conversation();
    conv.systemPrompt = data.systemPrompt;
    conv.messages = data.messages;
    return conv;
  }

  /**
   * Estimate rough token count (very approximate).
   */
  estimateTokens(): number {
    let chars = this.systemPrompt.length;
    for (const msg of this.messages) {
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      } else {
        for (const block of msg.content) {
          if (block.type === 'text') chars += block.text.length;
          else if (block.type === 'tool_use') chars += JSON.stringify(block.input).length;
          else if (block.type === 'tool_result') {
            chars += typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length;
          }
        }
      }
    }
    // Rough estimate: ~4 chars per token
    return Math.ceil(chars / 4);
  }
}
