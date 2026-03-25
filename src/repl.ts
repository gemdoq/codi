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

// ── CJK display width helpers ────────────────────────────────────────

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]|\x1B\][^\x07]*\x07/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

function isFullWidthCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115F) ||  // Hangul Jamo
    code === 0x2329 || code === 0x232A ||   // Angle brackets
    (code >= 0x2E80 && code <= 0x303E) ||   // CJK Radicals Supplement
    (code >= 0x3040 && code <= 0x33BF) ||   // Hiragana, Katakana, CJK Symbols
    (code >= 0x3400 && code <= 0x4DBF) ||   // CJK Unified Ext A
    (code >= 0x4E00 && code <= 0x9FFF) ||   // CJK Unified Ideographs
    (code >= 0xA960 && code <= 0xA97C) ||   // Hangul Jamo Extended-A
    (code >= 0xAC00 && code <= 0xD7AF) ||   // Hangul Syllables
    (code >= 0xD7B0 && code <= 0xD7FF) ||   // Hangul Jamo Extended-B
    (code >= 0xF900 && code <= 0xFAFF) ||   // CJK Compatibility Ideographs
    (code >= 0xFE10 && code <= 0xFE19) ||   // Vertical Forms
    (code >= 0xFE30 && code <= 0xFE6F) ||   // CJK Compatibility Forms
    (code >= 0xFF01 && code <= 0xFF60) ||   // Fullwidth Forms
    (code >= 0xFFE0 && code <= 0xFFE6) ||   // Fullwidth Signs
    (code >= 0x1F300 && code <= 0x1F9FF) || // Emojis (Misc Symbols & Pictographs + Emoticons + etc.)
    (code >= 0x20000 && code <= 0x2FFFF) || // CJK Unified Ext B-F
    (code >= 0x30000 && code <= 0x3FFFF)    // CJK Unified Ext G+
  );
}

function getDisplayWidth(str: string): number {
  const clean = stripAnsi(str);
  let width = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0)!;
    if (isFullWidthCodePoint(code)) {
      width += 2;
    } else if (code >= 0x20) {
      width += 1;
    }
  }
  return width;
}

// ── PasteFilter Transform ────────────────────────────────────────────

/**
 * Transform stream that intercepts bracket paste escape sequences.
 * Buffers pasted content and emits it as a single chunk so readline
 * processes it in one event-loop tick, preventing per-character redraws.
 */
class PasteFilter extends Transform {
  private pasteBuf = '';
  public isPasteActive = false;

  // Forward TTY interface so readline treats this as a terminal input
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

    // Bracket paste: pipe stdin through PasteFilter
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

    // Fallback: if readline didn't pick up the history option, inject it directly
    const rlAny = this.rl as any;
    if (!rlAny.history || rlAny.history.length === 0) {
      if (historyForReadline.length > 0) {
        rlAny.history = [...historyForReadline];
      }
    }

    // ── Replace readline's _refreshLine with CJK-aware implementation ──
    // Node.js readline's _refreshLine uses relative cursor movement
    // ("go up N rows") based on its own width calculation. For Hangul/CJK
    // wide characters, this calculation drifts and causes ghost prompts.
    //
    // Our replacement tracks the physical cursor row independently
    // (prevCursorRow) so we always move to the exact correct position.
    const pasteFilter = this.pasteFilter;
    let prevCursorRow = 0;
    let refreshScheduled = false;

    // Also fix _getCursorPos and _getDisplayPos used by _moveCursor (arrow keys)
    rlAny._getDisplayPos = function(str: string) {
      const cols = this.columns || process.stdout.columns || 80;
      const width = getDisplayWidth(str);
      return { rows: Math.floor(width / cols), cols: width % cols };
    };

    rlAny._getCursorPos = function() {
      const cols = this.columns || process.stdout.columns || 80;
      const beforeCursor = (this._prompt || '') + (this.line || '').slice(0, this.cursor);
      const width = getDisplayWidth(beforeCursor);
      return { rows: Math.floor(width / cols), cols: width % cols };
    };

    // Track cursor row changes from _moveCursor (arrow keys, home, end)
    const origMoveCursor = rlAny._moveCursor.bind(rlAny);
    rlAny._moveCursor = function(dx: number) {
      origMoveCursor(dx);
      const pos = this._getCursorPos();
      prevCursorRow = pos.rows;
    };

    // Reset tracking when prompt is displayed
    const origPrompt = rlAny.prompt.bind(rlAny);
    rlAny.prompt = function(...args: any[]) {
      prevCursorRow = 0;
      origPrompt(...args);
    };

    const doRefresh = () => {
      const rl = this.rl;
      if (!rl) return;
      const r = rl as any;
      const prompt = r._prompt || '';
      const line = r.line || '';
      const fullLine = prompt + line;
      const cols = r.columns || process.stdout.columns || 80;

      // 1. Move from tracked physical cursor row to row 0 (prompt start)
      if (prevCursorRow > 0) {
        output.write(`\x1B[${prevCursorRow}A`);
      }
      output.write('\r');       // column 0
      output.write('\x1B[J');   // clear from cursor to end of screen

      // 2. Write prompt + content using readline's output method
      r._writeToOutput(fullLine);

      // 3. Calculate where the writing cursor ended up
      const fullWidth = getDisplayWidth(fullLine);
      const endRow = Math.floor(fullWidth / cols);
      const endCol = fullWidth % cols;

      // 4. Calculate where the editing cursor should be
      const beforeCursor = prompt + line.slice(0, r.cursor);
      const cursorWidth = getDisplayWidth(beforeCursor);
      const cursorRow = Math.floor(cursorWidth / cols);
      const cursorCol = cursorWidth % cols;

      // 5. Move from end-of-content to editing cursor position
      if (endRow > cursorRow) {
        output.write(`\x1B[${endRow - cursorRow}A`);
      }
      // Handle edge case: if endCol is 0 and text exactly fills last column,
      // terminal may have wrapped cursor to next line already
      if (endCol === 0 && fullWidth > 0 && fullWidth % cols === 0) {
        // Cursor wrapped to next line, need to go up one more
        output.write('\x1B[1A');
        if (endRow > cursorRow) {
          // Already moved up, adjust: go back down one less
        }
      }
      output.write(`\x1B[${cursorCol + 1}G`); // absolute column (1-based)

      // 6. Track physical cursor row for next refresh
      prevCursorRow = cursorRow;
    };

    rlAny._refreshLine = function() {
      if (pasteFilter.isPasteActive) return;
      if (!refreshScheduled) {
        refreshScheduled = true;
        queueMicrotask(() => {
          refreshScheduled = false;
          doRefresh();
        });
      }
    };

    // Enable bracket paste mode on terminal
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
