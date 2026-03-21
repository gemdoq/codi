import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'process';
import * as os from 'os';
import * as fs from 'fs';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { edit } from 'external-editor';
import { KeyBindingManager } from './ui/keybindings.js';
import { renderPrompt, renderMarkdown, renderError, renderInfo } from './ui/renderer.js';
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

  private loadHistory(): string[] {
    try {
      const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
      return content.split('\n').filter(Boolean).slice(-MAX_HISTORY);
    } catch {
      // 파일이 없거나 읽기 실패 시 빈 히스토리
      return [];
    }
  }

  private saveHistory(): void {
    if (!this.rl) return;
    try {
      // readline.history는 최신순(역순)이므로 reverse하여 시간순으로 저장
      const rlAny = this.rl as any;
      const history: string[] = rlAny.history ?? [];
      const entries = history.slice(0, MAX_HISTORY).reverse();
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, entries.join('\n') + '\n', 'utf-8');
    } catch {
      // 히스토리 저장 실패는 무시
    }
  }

  private shouldSaveToHistory(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('/')) return false;
    return true;
  }

  async start(): Promise<void> {
    this.running = true;

    const loadedHistory = this.loadHistory();

    this.rl = readline.createInterface({
      input,
      output,
      prompt: renderPrompt(),
      completer: (line: string) => completer(line),
      terminal: true,
      history: loadedHistory,
      historySize: MAX_HISTORY,
    } as any);

    // readline/promises에서 history 옵션이 무시될 수 있으므로 직접 설정
    const rlAny = this.rl as any;
    if (rlAny.history && loadedHistory.length > 0) {
      // history 배열은 최신순(역순)으로 저장됨
      rlAny.history.length = 0;
      for (let i = loadedHistory.length - 1; i >= 0; i--) {
        rlAny.history.push(loadedHistory[i]);
      }
    }

    // Setup bracket paste mode detection (skip on Windows — breaks Ctrl+V paste)
    if (process.stdin.isTTY && os.platform() !== 'win32') {
      process.stdout.write('\x1B[?2004h'); // Enable bracket paste
    }

    // Windows: intercept Ctrl+V (raw 0x16) and read from clipboard via PowerShell
    if (os.platform() === 'win32' && process.stdin.isTTY) {
      process.stdin.on('keypress', (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
        if (key && key.sequence === '\x16') {
          try {
            const clip = execSync(
              'powershell -NoProfile -command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard"',
              { encoding: 'utf-8', timeout: 5000, env: { ...process.env } }
            ).replace(/\r\n/g, '\n').replace(/\n$/, '');
            if (clip && this.rl) {
              // For multiline paste, only take the first line into readline
              // and append the rest as continuation
              const firstNewline = clip.indexOf('\n');
              if (firstNewline === -1) {
                this.rl.write(clip);
              } else {
                // Write first line, then user can press Enter
                this.rl.write(clip.replace(/\n/g, '\\'));
              }
            }
          } catch {}
        }
      });
    }

    // 공유 프롬프트 핸들러 등록 (permission-manager, ask-user가 이것을 사용)
    // rl.question() 대신 직접 line 이벤트를 사용하여 중복 에코 방지
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

        // 히스토리 필터링: 슬래시 커맨드/빈 줄 제거 + 연속 중복 제거
        {
          const rlAny = this.rl as any;
          const hist: string[] | undefined = rlAny.history;
          if (hist && hist.length > 0) {
            // readline은 입력을 history[0]에 자동 추가함
            if (!this.shouldSaveToHistory(trimmed)) {
              hist.shift(); // 저장하면 안 되는 항목 제거
            } else if (hist.length > 1 && hist[0] === hist[1]) {
              hist.shift(); // 연속 중복 제거
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
          // Ctrl+D or readline closed
          await this.gracefulExit();
          return;
        }
      }
    }

    if (process.stdin.isTTY && os.platform() !== 'win32') {
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

    // @ prefix → file reference (prepend file content or image as ContentBlock[])
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
      // Send as ContentBlock[] so LLM receives actual image data
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
    this.saveHistory();
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
    const versionPad = `    Codi (코디) ${getVersion()}`.padEnd(29);
    console.log(chalk.cyan.bold('  │') + chalk.white.bold(versionPad) + chalk.cyan.bold('│'));
    console.log(chalk.cyan.bold('  │') + chalk.dim('   AI Code Agent for Terminal ') + chalk.cyan.bold('│'));
    console.log(chalk.cyan.bold('  ╰─────────────────────────────╯'));
    console.log('');
    console.log(chalk.dim('  Type /help for commands, Ctrl+D to quit'));
    console.log(chalk.dim('  Use \\ at end of line for multiline input'));
    console.log('');
  }
}
