import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'process';
import * as os from 'os';
import * as fs from 'fs';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { edit } from 'external-editor';
import { KeyBindingManager } from './ui/keybindings.js';
import { renderPrompt, renderMarkdown, renderError, renderInfo } from './ui/renderer.js';
import { t } from './i18n/index.js';
import { statusLine } from './ui/status-line.js';
import { completer } from './ui/completer.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as path from 'path';
import { registerPromptHandler, unregisterPromptHandler } from './ui/stdin-prompt.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HISTORY_DIR = path.join(os.homedir(), '.codi');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history');
const MAX_HISTORY = 1000;

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    return `v${pkg.version}`;
  } catch {
    return 'v0.1.4';
  }
}

import type { ContentBlock } from './llm/types.js';

export interface ReplOptions {
  onMessage: (message: string | ContentBlock[]) => Promise<void>;
  onSlashCommand: (command: string, args: string) => Promise<boolean>;
  onInterrupt: () => void;
  onExit?: () => Promise<void>;
}

/**
 * Self-managed history that persists to disk on every addition.
 */
class HistoryManager {
  private entries: string[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
      this.entries = content.split('\n').filter(Boolean).slice(-MAX_HISTORY);
    } catch {
      this.entries = [];
    }
  }

  save(): void {
    try {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, this.entries.join('\n') + '\n', 'utf-8');
    } catch {
      // non-fatal
    }
  }

  add(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('/')) return;
    if (this.entries.length > 0 && this.entries[this.entries.length - 1] === trimmed) return;

    this.entries.push(trimmed);
    if (this.entries.length > MAX_HISTORY) {
      this.entries = this.entries.slice(-MAX_HISTORY);
    }
    this.save();
  }

  /**
   * Get entries in readline's expected format: newest first.
   */
  getForReadline(): string[] {
    return [...this.entries].reverse();
  }
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
  private history = new HistoryManager();

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

    // readline expects history in newest-first order
    const historyForReadline = this.history.getForReadline();

    this.rl = readline.createInterface({
      input,
      output,
      prompt: renderPrompt(),
      completer: (line: string, cb: (err: null, result: [string[], string]) => void) => {
        const result = completer(line);
        cb(null, result);
      },
      terminal: true,
      history: historyForReadline,
      historySize: MAX_HISTORY,
    } as any);

    // Fallback: if readline didn't pick up the history option, inject it directly
    const rlAny = this.rl as any;
    if (!rlAny.history || rlAny.history.length === 0) {
      if (historyForReadline.length > 0) {
        rlAny.history = [...historyForReadline];
      }
    }

    // Enable bracket paste mode (modern terminals including Windows Terminal support it)
    if (process.stdin.isTTY) {
      process.stdout.write('\x1B[?2004h');
    }

    // 공유 프롬프트 핸들러 등록 (permission-manager, ask-user가 이것을 사용)
    registerPromptHandler((prompt: string) => {
      if (!this.rl) return Promise.reject(new Error('REPL not running'));
      process.stdout.write(prompt);
      return new Promise<string>((resolve) => {
        this.rl!.once('line', (answer: string) => {
          resolve(answer);
        });
      });
    });

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
            if (now - this.lastInterruptTime < 2000) {
              this.gracefulExit().catch(() => process.exit(1));
              return;
            }
            this.lastInterruptTime = now;
            this.options.onInterrupt();
            console.log(chalk.dim(`\n${t('repl.ctrlc')}`));
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

        // Save to our persistent history (writes to disk immediately)
        this.history.add(trimmed);

        // Clean up readline's in-session history: remove slash commands and duplicates
        {
          const rlHist: string[] | undefined = rlAny.history;
          if (rlHist && rlHist.length > 0) {
            if (trimmed.startsWith('/') || !trimmed) {
              rlHist.shift();
            } else if (rlHist.length > 1 && rlHist[0] === rlHist[1]) {
              rlHist.shift();
            }
          }
        }

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
      console.log(renderError(t('repl.unknownCmd', command)));
      return;
    }

    // Bang prefix → direct shell execution
    if (input.startsWith('!')) {
      const cmd = input.slice(1).trim();
      if (!cmd) return;
      try {
        const isWin = os.platform() === 'win32';
        const shell = isWin ? 'powershell.exe' : undefined;
        const finalCmd = isWin ? `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${cmd}` : cmd;
        const result = execSync(finalCmd, {
          encoding: 'utf-8',
          stdio: ['inherit', 'pipe', 'pipe'],
          timeout: 30_000,
          shell,
        });
        console.log(result);
      } catch (err: any) {
        if (err.stderr) console.error(chalk.red(err.stderr));
        else if (err.stdout) console.log(err.stdout);
        else console.error(renderError(String(err.message)));
      }
      return;
    }

    // @ prefix → file reference
    const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
    const MIME_MAP: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
    };
    const atMatches = input.match(/@([\w.\/\\:~-]+)/g);
    let hasImages = false;
    const imageBlocks: ContentBlock[] = [];
    let message = input;

    if (atMatches) {
      for (const match of atMatches) {
        const filePath = match.slice(1);
        try {
          const ext = path.extname(filePath).toLowerCase();
          if (IMAGE_EXTS.has(ext)) {
            const data = readFileSync(filePath);
            const base64 = data.toString('base64');
            const mime = MIME_MAP[ext] || 'image/png';
            imageBlocks.push({
              type: 'image',
              source: { type: 'base64', media_type: mime, data: base64 },
            });
            message = message.replace(match, `[이미지: ${path.basename(filePath)}]`);
            hasImages = true;
          } else {
            const content = readFileSync(filePath, 'utf-8');
            message = message.replace(match, `\n[File: ${filePath}]\n\`\`\`\n${content}\n\`\`\`\n`);
          }
        } catch {
          // Leave as-is if file doesn't exist
        }
      }
    }

    if (hasImages) {
      const blocks: ContentBlock[] = [
        { type: 'text', text: message.trim() },
        ...imageBlocks,
      ];
      await this.options.onMessage(blocks);
    } else {
      await this.options.onMessage(message);
    }
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
    unregisterPromptHandler();
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  async gracefulExit(): Promise<void> {
    this.history.save();
    this.stop();
    if (this.options.onExit) {
      await this.options.onExit();
    }
    console.log(chalk.dim(`\n${t('repl.goodbye')}\n`));
    process.exit(0);
  }

  private printWelcome(): void {
    console.log('');
    console.log(chalk.cyan.bold('  ╭─────────────────────────────╮'));
    const versionPad = `    Codi (코디) ${getVersion()}`.padEnd(29);
    console.log(chalk.cyan.bold('  │') + chalk.white.bold(versionPad) + chalk.cyan.bold('│'));
    const subtitle = t('repl.welcome.subtitle').padEnd(29).slice(0, 29);
    console.log(chalk.cyan.bold('  │') + chalk.dim(`   ${subtitle}`) + chalk.cyan.bold('│'));
    console.log(chalk.cyan.bold('  ╰─────────────────────────────╯'));
    console.log('');
    console.log(chalk.dim(`  ${t('repl.welcome.help')}`));
    console.log(chalk.dim(`  ${t('repl.welcome.multiline')}`));
    console.log('');
  }
}
