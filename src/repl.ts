import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'process';
import { Transform, type TransformCallback } from 'stream';
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

// ── PasteFilter Transform ────────────────────────────────────────────

/**
 * Transform stream that intercepts bracket paste escape sequences.
 *
 * During paste (between ESC[200~ and ESC[201~), sets isPasteActive=true.
 * After paste ends, pushes the entire buffered content as one chunk,
 * then emits 'paste-end' so the REPL can do a single _refreshLine.
 */
class PasteFilter extends Transform {
  private pasteBuf = '';
  public isPasteActive = false;

  get isTTY(): boolean { return !!process.stdin.isTTY; }
  setRawMode(mode: boolean): this {
    if (typeof (process.stdin as any).setRawMode === 'function') {
      (process.stdin as any).setRawMode(mode);
    }
    return this;
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    let data = chunk.toString('utf-8');

    while (data.length > 0) {
      if (!this.isPasteActive) {
        const idx = data.indexOf('\x1B[200~');
        if (idx < 0) {
          this.push(data);
          data = '';
        } else {
          if (idx > 0) this.push(data.slice(0, idx));
          this.isPasteActive = true;
          this.pasteBuf = '';
          data = data.slice(idx + 6);
        }
      } else {
        const idx = data.indexOf('\x1B[201~');
        if (idx < 0) {
          this.pasteBuf += data;
          data = '';
        } else {
          this.pasteBuf += data.slice(0, idx);
          this.isPasteActive = false;
          const cleaned = this.pasteBuf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          if (cleaned) this.push(cleaned);
          this.pasteBuf = '';
          data = data.slice(idx + 6);
        }
      }
    }
    callback();
  }
}

// ── HistoryManager ───────────────────────────────────────────────────

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

  getForReadline(): string[] {
    return [...this.entries].reverse();
  }
}

// ── Repl ─────────────────────────────────────────────────────────────

export class Repl {
  private rl: readline.Interface | null = null;
  private keyBindings = new KeyBindingManager();
  private running = false;
  private multilineBuffer: string[] = [];
  private inMultiline = false;
  private pasteFilter: PasteFilter | null = null;
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

    const historyForReadline = this.history.getForReadline();

    this.pasteFilter = new PasteFilter();
    input.pipe(this.pasteFilter);

    this.rl = readline.createInterface({
      input: this.pasteFilter as any,
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

    const rlAny = this.rl as any;
    if (!rlAny.history || rlAny.history.length === 0) {
      if (historyForReadline.length > 0) {
        rlAny.history = [...historyForReadline];
      }
    }

    // ── Patch _insertString to suppress ALL output during bracket paste ──
    //
    // Root cause of the ghost prompt bug:
    // readline's _insertString has two code paths:
    //   (a) cursor at end + same row → directly writes char to output (_writeToOutput)
    //   (b) cursor in middle OR row changes → calls _refreshLine
    //
    // During fast paste, path (a) writes chars directly to the terminal,
    // causing the terminal to wrap lines. But _refreshLine (path b) tracks
    // rows via prevRows, which gets out of sync when paste is debounced
    // or suppressed. This mismatch causes _refreshLine to not go up far
    // enough, leaving "ghost" duplicate prompts above.
    //
    // Fix: during bracket paste, suppress ALL output from _insertString
    // (both paths). Only update the internal line/cursor state.
    // After paste ends, one normal _refreshLine draws everything correctly.

    const pasteFilter = this.pasteFilter;

    // Get the Symbol keys for readline's private methods
    const proto = Object.getPrototypeOf(this.rl);
    const symbols = Object.getOwnPropertySymbols(proto);
    const kInsertString = symbols.find(s => s.toString().includes('_insertString'));
    const kRefreshLine = symbols.find(s => s.toString().includes('RefreshLine') && !s.toString().includes('getDisplay'));
    const kWriteToOutput = symbols.find(s => s.toString().includes('writeToOutput') || s.toString().includes('WriteToOutput'));

    // Symbol properties on the prototype are getter-only, so use
    // Object.defineProperty on the instance to override them.
    if (kInsertString) {
      const origInsertString = proto[kInsertString];

      Object.defineProperty(rlAny, kInsertString, {
        value: function(c: string) {
          if (pasteFilter.isPasteActive) {
            if (this.cursor < this.line.length) {
              const beg = this.line.slice(0, this.cursor);
              const end = this.line.slice(this.cursor);
              this.line = beg + c + end;
              this.cursor += c.length;
            } else {
              this.line += c;
              this.cursor += c.length;
            }
            return;
          }
          origInsertString.call(this, c);
        },
        writable: true,
        configurable: true,
      });
    }

    if (kRefreshLine) {
      const origRefreshLine = proto[kRefreshLine];
      let pendingPasteRefresh = false;

      Object.defineProperty(rlAny, kRefreshLine, {
        value: function() {
          if (pasteFilter.isPasteActive) {
            if (!pendingPasteRefresh) {
              pendingPasteRefresh = true;
              queueMicrotask(() => {
                pendingPasteRefresh = false;
                origRefreshLine.call(this);
              });
            }
            return;
          }
          origRefreshLine.call(this);
        },
        writable: true,
        configurable: true,
      });
    }

    // Enable bracket paste mode
    if (process.stdin.isTTY) {
      process.stdout.write('\x1B[?2004h');
    }

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

        this.history.add(trimmed);

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
  }

  private async processInput(input: string): Promise<void> {
    const lower = input.toLowerCase();
    if (lower === 'exit' || lower === 'quit' || lower === 'q') {
      await this.gracefulExit();
      return;
    }

    if (input.startsWith('/')) {
      const spaceIdx = input.indexOf(' ');
      const command = spaceIdx === -1 ? input : input.slice(0, spaceIdx);
      const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1).trim();
      const handled = await this.options.onSlashCommand(command, args);
      if (handled) return;
      console.log(renderError(t('repl.unknownCmd', command)));
      return;
    }

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
    if (process.stdin.isTTY) {
      process.stdout.write('\x1B[?2004l');
    }
    if (this.pasteFilter) {
      input.unpipe(this.pasteFilter);
      this.pasteFilter.destroy();
      this.pasteFilter = null;
    }
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
