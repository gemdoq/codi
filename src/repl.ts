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

// ── CJK display width (matching Node.js readline's _getDisplayPos) ───

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]|\x1B\][^\x07]*\x07/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

function isFullWidthCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115F) ||
    code === 0x2329 || code === 0x232A ||
    (code >= 0x2E80 && code <= 0x303E) ||
    (code >= 0x3040 && code <= 0x33BF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0xA960 && code <= 0xA97C) ||
    (code >= 0xAC00 && code <= 0xD7AF) ||
    (code >= 0xD7B0 && code <= 0xD7FF) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE10 && code <= 0xFE19) ||
    (code >= 0xFE30 && code <= 0xFE6F) ||
    (code >= 0xFF01 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6) ||
    (code >= 0x1F300 && code <= 0x1F9FF) ||
    (code >= 0x20000 && code <= 0x2FFFF) ||
    (code >= 0x30000 && code <= 0x3FFFF)
  );
}

/**
 * Calculate display position matching Node.js readline's _getDisplayPos exactly.
 * Includes CJK end-of-line padding: when a 2-width character would land on the
 * last column, it wraps to the next line with 1 column of padding.
 */
function calcDisplayPos(str: string, cols: number): { rows: number; cols: number } {
  const clean = stripAnsi(str);
  let offset = 0;
  for (const ch of clean) {
    if (ch === '\n') {
      offset = (Math.ceil(offset / cols) || 1) * cols;
      continue;
    }
    if (ch === '\t') {
      offset += 8 - (offset % 8);
      continue;
    }
    const code = ch.codePointAt(0)!;
    if (code < 0x20) continue;
    const w = isFullWidthCodePoint(code) ? 2 : 1;
    if (w === 2 && (offset + 1) % cols === 0) {
      offset++; // padding: 2-width char at last column wraps to next line
    }
    offset += w;
  }
  const c = offset % cols;
  const r = (offset - c) / cols;
  return { rows: r, cols: c };
}

// ── PasteFilter Transform ────────────────────────────────────────────

/**
 * Transform stream that intercepts bracket paste escape sequences.
 * During paste, content is NOT pushed to readline. Instead, 'paste-complete'
 * is emitted with the buffered text so the REPL can inject it directly
 * into readline's state and do a single clean refresh.
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
          // Don't push to readline — emit event for direct injection
          if (cleaned) this.emit('paste-complete', cleaned);
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

  constructor() { this.load(); }

  private load(): void {
    try {
      const content = fs.readFileSync(HISTORY_FILE, 'utf-8');
      this.entries = content.split('\n').filter(Boolean).slice(-MAX_HISTORY);
    } catch { this.entries = []; }
  }

  save(): void {
    try {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
      fs.writeFileSync(HISTORY_FILE, this.entries.join('\n') + '\n', 'utf-8');
    } catch { /* non-fatal */ }
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

  getForReadline(): string[] { return [...this.entries].reverse(); }
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
      key: 'l', ctrl: true,
      handler: () => { process.stdout.write('\x1B[2J\x1B[0f'); },
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

    // ── Override getCursorPos with CJK-aware calculation ──
    // readline's _insertString calls this.getCursorPos() to detect row changes.
    // If the row calculation is wrong, _refreshLine is skipped when it shouldn't be,
    // causing prevRows to drift from the physical cursor → ghost prompts.
    // This override matches Node's _getDisplayPos exactly (including CJK end-of-line padding).
    rlAny.getCursorPos = function() {
      const cols = this.columns || process.stdout.columns || 80;
      const prompt = this._prompt || '';
      const beforeCursor = prompt + (this.line || '').slice(0, this.cursor);
      return calcDisplayPos(beforeCursor, cols);
    };

    // ── Handle paste: inject directly into readline state ──
    // PasteFilter emits 'paste-complete' instead of pushing to readline.
    // We directly set rl.line/cursor and do one _refreshLine.
    // This avoids per-character processing and keeps prevRows in sync.
    this.pasteFilter.on('paste-complete', (text: string) => {
      if (!this.rl) return;
      const r = this.rl as any;
      // Insert at cursor position
      const before = r.line.slice(0, r.cursor);
      const after = r.line.slice(r.cursor);
      r.line = before + text + after;
      r.cursor += text.length;
      // Single clean refresh — prevRows is correct because no intermediate output happened
      r._refreshLine();
    });

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
          const onLine = (data: string) => { cleanup(); resolve(data); };
          const onClose = () => { cleanup(); reject(new Error('closed')); };
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
    } catch { return null; }
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
