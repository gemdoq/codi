import chalk from 'chalk';

export interface StatusInfo {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  mode?: 'plan' | 'execute';
}

export class StatusLine {
  private info: StatusInfo = {
    model: '',
    provider: '',
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
  };
  private enabled: boolean = true;

  update(partial: Partial<StatusInfo>): void {
    Object.assign(this.info, partial);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  render(): string {
    if (!this.enabled) return '';
    const { model, inputTokens, outputTokens, cost, mode } = this.info;

    const parts: string[] = [];
    if (model) parts.push(chalk.cyan(`[${model}]`));
    if (mode === 'plan') parts.push(chalk.yellow('[PLAN]'));
    parts.push(chalk.dim(`in:${this.formatTokens(inputTokens)}`));
    parts.push(chalk.dim(`out:${this.formatTokens(outputTokens)}`));
    if (cost > 0) parts.push(chalk.green(`$${cost.toFixed(4)}`));

    return parts.join(chalk.dim(' | '));
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  getInfo(): StatusInfo {
    return { ...this.info };
  }
}

export const statusLine = new StatusLine();
