import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'process';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { edit } from 'external-editor';
import { KeyBindingManager } from './ui/keybindings.js';
import { renderPrompt, renderMarkdown, renderError, renderInfo } from './ui/renderer.js';
import { statusLine } from './ui/status-line.js';
import { completer } from './ui/completer.js';

export interface ReplOptions {
  onMessage: (message: string) => Promise<void>;
  onSlashCommand: (command: string, args: string) => Promise<boolean>;
  onInterrupt: () => void;
  onExit?: () => Promise<void>;
}

export class Repl {
  private rl: readline.Interface | null = null;
  private keyBindings = new KeyBindingManager();
  private running = false;
  private multilineBuffer: string[] = [];
  private inMultiline = false;
  private pasteMode = false;
  private options: ReplOptions;
  private lastInterruptTime = 0;

  constructor(options: ReplOptions) {
    this.options = options;
    this.setupKeyBindings();
  }

  private setupKeyBindings(): void {
    this.keyBindings.register({
      key: 'l',
      ctrl: true,
      handler: () => {
        process.stdout.write('\x1B[2J\x1B[0f');
      },
      description: 'Clear screen',
    });
  }

  async start(): Promise<void> {
    this.running = true;

    this.rl = readline.createInterface({
      input,
      output,
      prompt: renderPrompt(),
      completer: (line: string) => completer(line),
      terminal: true,
    });

    // Setup bracket paste mode detection
    if (process.stdin.isTTY) {
      process.stdout.write('\x1B[?2004h'); // Enable bracket paste
    }

    this.printWelcome();

    while (this.running) {
      try {
        const statusStr = statusLine.render();
        if (statusStr) {
          output.write(chalk.dim(statusStr) + '\n');
        }

        this.rl.setPrompt(renderPrompt());
        this.rl.prompt();

        const line = await new Promise<string>((resolve, reject) => {
          const onLine = (data: string) => {
            cleanup();
            resolve(data);
          };
          const onClose = () => {
            cleanup();
            reject(new Error('closed'));
          };
          const onSigint = () => {
            cleanup();
            const now = Date.now();
            // Double Ctrl+C within 2 seconds → exit
            if (now - this.lastInterruptTime < 2000) {
              this.gracefulExit().catch(() => process.exit(1));
              return;
            }
            this.lastInterruptTime = now;
            this.options.onInterrupt();
            console.log(chalk.dim('\n(Press Ctrl+C again to exit)'));
            resolve('');
          };
          const cleanup = () => {
            this.rl!.removeListener('line', onLine);
            this.rl!.removeListener('close', onClose);
            this.rl!.removeListener('SIGINT', onSigint);
          };
          this.rl!.on('line', onLine);
          this.rl!.on('close', onClose);
          this.rl!.on('SIGINT', onSigint);
        });

        const trimmed = line.trim();
        if (!trimmed) continue;

        // Multiline: line ending with \
        if (trimmed.endsWith('\\')) {
          this.multilineBuffer.push(trimmed.slice(0, -1));
          this.inMultiline = true;
          this.rl.setPrompt(chalk.dim('... '));
          continue;
        }

        let fullInput: string;
        if (this.inMultiline) {
          this.multilineBuffer.push(trimmed);
          fullInput = this.multilineBuffer.join('\n');
          this.multilineBuffer = [];
          this.inMultiline = false;
        } else {
          fullInput = trimmed;
        }

        await this.processInput(fullInput);
      } catch (err) {
        if (err instanceof Error && err.message === 'closed') {
          // Ctrl+D or readline closed
          await this.gracefulExit();
          return;
        }
      }
    }

    if (process.stdin.isTTY) {
      process.stdout.write('\x1B[?2004l'); // Disable bracket paste
    }
  }

  private async processInput(input: string): Promise<void> {
    // Direct exit commands (without slash)
    const lower = input.toLowerCase();
    if (lower === 'exit' || lower === 'quit' || lower === 'q') {
      await this.gracefulExit();
      return;
    }

    // Slash commands
    if (input.startsWith('/')) {
      const spaceIdx = input.indexOf(' ');
      const command = spaceIdx === -1 ? input : input.slice(0, spaceIdx);
      const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();
      const handled = await this.options.onSlashCommand(command, args);
      if (handled) return;
      console.log(renderError(`Unknown command: ${command}. Type /help for available commands.`));
      return;
    }

    // Bang prefix → direct bash execution
    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      if (!cmd) return;
      try {
        const result = execSync(cmd, {
          encoding: 'utf-8',
          stdio: ['inherit', 'pipe', 'pipe'],
          timeout: 30_000,
        });
        console.log(result);
      } catch (err: any) {
        if (err.stderr) console.error(chalk.red(err.stderr));
        else if (err.stdout) console.log(err.stdout);
        else console.error(renderError(String(err.message)));
      }
      return;
    }

    // @ prefix → file reference (prepend file content)
    let message = input;
    const atMatches = input.match(/@([\w./-]+)/g);
    if (atMatches) {
      for (const match of atMatches) {
        const filePath = match.slice(1);
        try {
          const { readFileSync } = await import('fs');
          const content = readFileSync(filePath, 'utf-8');
          message = message.replace(match, `\n[File: ${filePath}]\n\`\`\`\n${content}\n\`\`\`\n`);
        } catch {
          // Leave as-is if file doesn't exist
        }
      }
    }

    await this.options.onMessage(message);
  }

  openEditor(): string | null {
    try {
      const text = edit('', { postfix: '.md' });
      return text.trim() || null;
    } catch {
      return null;
    }
  }

  stop(): void {
    this.running = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  async gracefulExit(): Promise<void> {
    this.stop();
    if (this.options.onExit) {
      await this.options.onExit();
    }
    console.log(chalk.dim('\nGoodbye!\n'));
    process.exit(0);
  }

  private printWelcome(): void {
    console.log('');
    console.log(chalk.cyan.bold('  ╭─────────────────────────────╮'));
    console.log(chalk.cyan.bold('  │') + chalk.white.bold('    Codi (코디) v0.1.0       ') + chalk.cyan.bold('│'));
    console.log(chalk.cyan.bold('  │') + chalk.dim('   AI Code Agent for Terminal ') + chalk.cyan.bold('│'));
    console.log(chalk.cyan.bold('  ╰─────────────────────────────╯'));
    console.log('');
    console.log(chalk.dim('  Type /help for commands, Ctrl+D to quit'));
    console.log(chalk.dim('  Use \\ at end of line for multiline input'));
    console.log('');
  }
}
