import chalk from 'chalk';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { highlight } from 'cli-highlight';
import { createTwoFilesPatch } from 'diff';

// marked-terminal exports a constructor that creates a marked renderer
const renderer = new (TerminalRenderer as any)({
  codespan: chalk.cyan,
  strong: chalk.bold,
  em: chalk.italic,
  heading: chalk.green.bold,
  firstHeading: chalk.magenta.underline.bold,
  code: chalk.yellow,
  link: chalk.blue,
  href: chalk.blue.underline,
  unescape: true,
  emoji: false,
  width: process.stdout.columns || 100,
  tab: 2,
});

marked.setOptions({ renderer });

export function renderMarkdown(text: string): string {
  try {
    const rendered = marked.parse(text);
    return (typeof rendered === 'string' ? rendered : '').trimEnd();
  } catch {
    return text;
  }
}

export function renderDiff(filePath: string, oldContent: string, newContent: string): string {
  // If all three params are strings and oldContent/newContent look like a diff, render directly
  if (!filePath && !oldContent && newContent) {
    return colorDiffLines(newContent);
  }

  const patch = createTwoFilesPatch(
    `a/${filePath}`,
    `b/${filePath}`,
    oldContent,
    newContent,
    '',
    '',
    { context: 3 }
  );

  return colorDiffLines(patch);
}

function colorDiffLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) {
        return chalk.bold(line);
      }
      if (line.startsWith('+')) {
        return chalk.green(line);
      }
      if (line.startsWith('-')) {
        return chalk.red(line);
      }
      if (line.startsWith('@@')) {
        return chalk.cyan(line);
      }
      return chalk.dim(line);
    })
    .join('\n');
}

export function renderCodeBlock(code: string, language?: string): string {
  try {
    return highlight(code, { language, ignoreIllegals: true });
  } catch {
    return chalk.cyan(code);
  }
}

export function renderToolCall(toolName: string, args: Record<string, unknown>): string {
  const header = chalk.yellow(`⚡ ${toolName}`);
  const argStr = Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === 'string' && v.length > 100 ? v.slice(0, 100) + '...' : String(v);
      return chalk.dim(`  ${k}: `) + val;
    })
    .join('\n');
  return `${header}\n${argStr}`;
}

export function renderToolResult(toolName: string, result: string, isError: boolean, durationMs?: number): string {
  const icon = isError ? chalk.red('✗') : chalk.green('✓');
  const duration = durationMs != null ? chalk.dim(` (${formatDuration(durationMs)})`) : '';
  const header = `${icon} ${chalk.yellow(toolName)}${duration}`;
  const content = isError ? chalk.red(result) : chalk.dim(result);
  const maxLen = 500;
  const truncated = content.length > maxLen ? content.slice(0, maxLen) + chalk.dim('\n... (truncated)') : content;
  return `${header}\n${truncated}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function renderError(message: string): string {
  return chalk.red(`✗ ${message}`);
}

export function renderWarning(message: string): string {
  return chalk.yellow(`⚠ ${message}`);
}

export function renderInfo(message: string): string {
  return chalk.blue(`ℹ ${message}`);
}

export function renderSuccess(message: string): string {
  return chalk.green(`✓ ${message}`);
}

export function renderUserMessage(message: string): string {
  return chalk.white(message);
}

export function renderAssistantPrefix(): string {
  return chalk.green.bold('codi');
}

export function renderPrompt(): string {
  return chalk.cyan.bold('codi > ');
}
