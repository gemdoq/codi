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

/** Display width of a single character */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0)!;
  if (code < 0x20) return 0;
  return isFullWidthCodePoint(code) ? 2 : 1;
}

/** Display width of a string (CJK-aware, strip ANSI) */
function stringWidth(str: string): number {
  const clean = stripAnsi(str);
  let w = 0;
  for (const ch of clean) w += charWidth(ch);
  return w;
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
      this.entries = content.split('\n').filter(Boolean)
        .map(line => line.replace(/\\n/g, '\n'))
        .slice(-MAX_HISTORY);
    } catch { this.entries = []; }
  }

  save(): void {
    try {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
      const lines = this.entries.map(e => e.replace(/\n/g, '\\n'));
      fs.writeFileSync(HISTORY_FILE, lines.join('\n') + '\n', 'utf-8');
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

// ── Key type for _ttyWrite ──────────────────────────────────────────

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

// ── Repl ─────────────────────────────────────────────────────────────

export class Repl {
  private rl: readline.Interface | null = null;
  private keyBindings = new KeyBindingManager();
  private running = false;
  private pasteFilter: PasteFilter | null = null;
  private options: ReplOptions;
  private lastInterruptTime = 0;
  private history = new HistoryManager();

  // Multi-line editing state
  private mlLines: string[] = [''];
  private mlLineIdx = 0;
  private mlColIdx = 0;
  private mlActive = false; // true when lines.length > 1
  private mlTotalRows = 0;  // total display rows of the rendered multi-line block

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

  /** Get the prompt string for a given line index */
  private getLinePrompt(lineIdx: number): string {
    return lineIdx === 0 ? renderPrompt() : chalk.dim('... ');
  }

  /** Get the plain (no ANSI) prompt width for a given line index */
  private getLinePromptWidth(lineIdx: number): number {
    return lineIdx === 0 ? stringWidth(renderPrompt()) : 4; // "... " = 4
  }

  /**
   * Render the entire multi-line input block from scratch.
   * Moves cursor to correct position at the end.
   */
  private refreshMultiline(): void {
    if (!this.rl) return;
    const cols = process.stdout.columns || 80;

    // Move cursor to the beginning of the block (row 0 of our content)
    if (this.mlTotalRows > 0) {
      // Move up to the top of the previously rendered block
      process.stdout.write(`\x1B[${this.mlTotalRows}A`);
    }
    // Move to column 0
    process.stdout.write('\r');
    // Clear from here to end of screen
    process.stdout.write('\x1B[J');

    // Render all lines
    let totalRows = 0;
    for (let i = 0; i < this.mlLines.length; i++) {
      const prompt = this.getLinePrompt(i);
      const fullLine = prompt + this.mlLine(i);

      process.stdout.write(fullLine);

      // Calculate how many display rows this line takes
      const displayPos = calcDisplayPos(fullLine, cols);
      const lineRows = displayPos.rows + (displayPos.cols > 0 ? 1 : 1);
      totalRows += lineRows;

      // Write newline after each line except the last
      if (i < this.mlLines.length - 1) {
        process.stdout.write('\n');
      }
    }

    // Calculate total rows (0-indexed from top)
    // We need the total rows occupied to know how far up to go next time
    let totalDisplayRows = 0;
    for (let i = 0; i < this.mlLines.length; i++) {
      const prompt = this.getLinePrompt(i);
      const fullLine = prompt + this.mlLine(i);
      const dp = calcDisplayPos(fullLine, cols);
      totalDisplayRows += dp.rows; // rows above the last row of this line
      if (i < this.mlLines.length - 1) {
        totalDisplayRows += 1; // the newline
      }
    }
    this.mlTotalRows = totalDisplayRows;

    // Now position cursor at the correct location
    // First, figure out where the cursor should be (mlLineIdx, mlColIdx)
    const cursorPrompt = this.getLinePrompt(this.mlLineIdx);
    const cursorContent = cursorPrompt + this.mlLine(this.mlLineIdx).slice(0, this.mlColIdx);
    const cursorDP = calcDisplayPos(cursorContent, cols);

    // How many rows from the current position (end of last line) to the cursor line?
    // Current position = end of last line
    const lastPrompt = this.getLinePrompt(this.mlLines.length - 1);
    const lastFull = lastPrompt + this.mlLine(this.mlLines.length - 1);
    const lastDP = calcDisplayPos(lastFull, cols);

    // Rows from end of last line to bottom of block = 0 (we're there)
    // Rows from top of block to cursor:
    let rowsFromTopToCursor = 0;
    for (let i = 0; i < this.mlLineIdx; i++) {
      const p = this.getLinePrompt(i);
      const fl = p + this.mlLine(i);
      const dp = calcDisplayPos(fl, cols);
      rowsFromTopToCursor += dp.rows + 1; // +1 for the newline
    }
    rowsFromTopToCursor += cursorDP.rows;

    // Rows from top of block to end of last line:
    let rowsFromTopToEnd = 0;
    for (let i = 0; i < this.mlLines.length - 1; i++) {
      const p = this.getLinePrompt(i);
      const fl = p + this.mlLine(i);
      const dp = calcDisplayPos(fl, cols);
      rowsFromTopToEnd += dp.rows + 1;
    }
    rowsFromTopToEnd += lastDP.rows;

    const rowsUp = rowsFromTopToEnd - rowsFromTopToCursor;
    if (rowsUp > 0) {
      process.stdout.write(`\x1B[${rowsUp}A`);
    }
    // Move to correct column
    process.stdout.write(`\r\x1B[${cursorDP.cols}C`);
  }

  /** Safely get a line from mlLines (returns '' for out of bounds) */
  private mlLine(idx: number): string {
    return this.mlLines[idx] ?? '';
  }

  /** Reset multi-line state to single empty line */
  private mlReset(): void {
    this.mlLines = [''];
    this.mlLineIdx = 0;
    this.mlColIdx = 0;
    this.mlActive = false;
    this.mlTotalRows = 0;
  }

  /** Sync readline's line/cursor from our multi-line state (for the current line) */
  private mlSyncToReadline(): void {
    if (!this.rl) return;
    const r = this.rl as any;
    r.line = this.mlLine(this.mlLineIdx);
    r.cursor = this.mlColIdx;
  }

  /** Sync our multi-line state from readline (after readline processes a key) */
  private mlSyncFromReadline(): void {
    if (!this.rl) return;
    const r = this.rl as any;
    this.mlLines[this.mlLineIdx] = r.line;
    this.mlColIdx = r.cursor;
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
    rlAny.getCursorPos = function() {
      const cols = this.columns || process.stdout.columns || 80;
      const prompt = this._prompt || '';
      const beforeCursor = prompt + (this.line || '').slice(0, this.cursor);
      return calcDisplayPos(beforeCursor, cols);
    };

    // ── Override _ttyWrite for multi-line editing ──
    const origTtyWrite = rlAny._ttyWrite.bind(rlAny);
    const self = this;

    rlAny._ttyWrite = function(s: string, key: Key) {
      if (!key) key = {};

      // Ctrl+C in multi-line → cancel and reset
      if (key.name === 'c' && key.ctrl && self.mlActive) {
        // Clear the multi-line display
        if (self.mlTotalRows > 0) {
          process.stdout.write(`\x1B[${self.mlTotalRows}A`);
        }
        process.stdout.write('\r\x1B[J');
        self.mlReset();
        // Reset readline state
        this.line = '';
        this.cursor = 0;
        this._refreshLine();
        return;
      }

      // Ctrl+Enter / Alt+Enter / Shift+Enter → insert newline
      const isNewline =
        (key.name === 'return' && (key.ctrl || key.meta || key.shift)) ||
        (key.name === 'j' && key.ctrl); // Ctrl+J = newline on most terminals

      if (isNewline) {
        if (!self.mlActive) {
          // Enter multi-line mode: take current readline content as line 0
          self.mlLines = [this.line || ''];
          self.mlColIdx = this.cursor || 0;
          self.mlLineIdx = 0;
          self.mlActive = true;

          // Calculate initial mlTotalRows from the current single-line display
          const cols = process.stdout.columns || 80;
          const prompt = self.getLinePrompt(0);
          const dp = calcDisplayPos(prompt + self.mlLine(0), cols);
          self.mlTotalRows = dp.rows;
        } else {
          self.mlSyncFromReadline();
        }

        // Split current line at cursor
        const currentLine = self.mlLine(self.mlLineIdx);
        const before = currentLine.slice(0, self.mlColIdx);
        const after = currentLine.slice(self.mlColIdx);

        self.mlLines[self.mlLineIdx] = before;
        self.mlLines.splice(self.mlLineIdx + 1, 0, after);
        self.mlLineIdx++;
        self.mlColIdx = 0;

        // Update readline to show the new current line
        this.line = after;
        this.cursor = 0;
        this._prompt = self.getLinePrompt(self.mlLineIdx);

        self.refreshMultiline();
        return;
      }

      // Enter (no modifier) → submit
      if (key.name === 'return' && !key.ctrl && !key.meta && !key.shift) {
        if (self.mlActive) {
          self.mlSyncFromReadline();
          const fullText = self.mlLines.join('\n');

          // Clear multi-line display and move to after it
          // (Already at cursor position — move to end first)
          const cols = process.stdout.columns || 80;
          let rowsFromTopToEnd = 0;
          for (let i = 0; i < self.mlLines.length - 1; i++) {
            const p = self.getLinePrompt(i);
            const fl = p + self.mlLine(i);
            const dp = calcDisplayPos(fl, cols);
            rowsFromTopToEnd += dp.rows + 1;
          }
          const lastP = self.getLinePrompt(self.mlLines.length - 1);
          const lastFL = lastP + self.mlLine(self.mlLines.length - 1);
          const lastDP = calcDisplayPos(lastFL, cols);
          rowsFromTopToEnd += lastDP.rows;

          // Move cursor to current position in block first
          let rowsFromTopToCursor = 0;
          for (let i = 0; i < self.mlLineIdx; i++) {
            const p = self.getLinePrompt(i);
            const fl = p + self.mlLine(i);
            const dp = calcDisplayPos(fl, cols);
            rowsFromTopToCursor += dp.rows + 1;
          }
          const curP = self.getLinePrompt(self.mlLineIdx);
          const curContent = curP + self.mlLine(self.mlLineIdx).slice(0, self.mlColIdx);
          const curDP = calcDisplayPos(curContent, cols);
          rowsFromTopToCursor += curDP.rows;

          const downToEnd = rowsFromTopToEnd - rowsFromTopToCursor;
          if (downToEnd > 0) {
            process.stdout.write(`\x1B[${downToEnd}B`);
          }

          process.stdout.write('\n');
          self.mlReset();

          // Emit the full multi-line text as a line event
          this.line = '';
          this.cursor = 0;
          this._prompt = renderPrompt();
          this.emit('line', fullText);
          return;
        }
        // Single line — let readline handle normally
        origTtyWrite(s, key);
        return;
      }

      // Up arrow
      if (key.name === 'up' && !key.ctrl && !key.meta) {
        if (self.mlActive && self.mlLineIdx > 0) {
          self.mlSyncFromReadline();
          self.mlLineIdx--;
          // Try to keep similar column position
          self.mlColIdx = Math.min(self.mlColIdx, self.mlLine(self.mlLineIdx).length);
          self.mlSyncToReadline();
          this._prompt = self.getLinePrompt(self.mlLineIdx);
          self.refreshMultiline();
          return;
        }
        // At first line or single-line → history (let readline handle)
        if (self.mlActive) {
          // Already at line 0 in multi-line — don't navigate history
          return;
        }
        origTtyWrite(s, key);
        return;
      }

      // Down arrow
      if (key.name === 'down' && !key.ctrl && !key.meta) {
        if (self.mlActive && self.mlLineIdx < self.mlLines.length - 1) {
          self.mlSyncFromReadline();
          self.mlLineIdx++;
          self.mlColIdx = Math.min(self.mlColIdx, self.mlLine(self.mlLineIdx).length);
          self.mlSyncToReadline();
          this._prompt = self.getLinePrompt(self.mlLineIdx);
          self.refreshMultiline();
          return;
        }
        // At last line or single-line → history (let readline handle)
        if (self.mlActive) {
          // Already at last line — don't navigate history
          return;
        }
        origTtyWrite(s, key);
        return;
      }

      // Backspace at beginning of line in multi-line → merge with previous line
      if ((key.name === 'backspace') && self.mlActive) {
        self.mlSyncFromReadline();
        if (self.mlColIdx === 0 && self.mlLineIdx > 0) {
          const prevLine = self.mlLine(self.mlLineIdx - 1);
          const curLine = self.mlLine(self.mlLineIdx);
          self.mlLines[self.mlLineIdx - 1] = prevLine + curLine;
          self.mlLines.splice(self.mlLineIdx, 1);
          self.mlLineIdx--;
          self.mlColIdx = prevLine.length;

          if (self.mlLines.length === 1) {
            self.mlActive = false;
          }

          self.mlSyncToReadline();
          this._prompt = self.getLinePrompt(self.mlLineIdx);
          self.refreshMultiline();
          return;
        }
        // Normal backspace within line — let readline handle, then sync back
        origTtyWrite(s, key);
        self.mlSyncFromReadline();
        self.refreshMultiline();
        return;
      }

      // Delete at end of line in multi-line → merge with next line
      if ((key.name === 'delete') && self.mlActive) {
        self.mlSyncFromReadline();
        if (self.mlColIdx === self.mlLine(self.mlLineIdx).length && self.mlLineIdx < self.mlLines.length - 1) {
          const curLine = self.mlLine(self.mlLineIdx);
          const nextLine = self.mlLine(self.mlLineIdx + 1);
          self.mlLines[self.mlLineIdx] = curLine + nextLine;
          self.mlLines.splice(self.mlLineIdx + 1, 1);

          if (self.mlLines.length === 1) {
            self.mlActive = false;
          }

          self.mlSyncToReadline();
          this._prompt = self.getLinePrompt(self.mlLineIdx);
          self.refreshMultiline();
          return;
        }
        origTtyWrite(s, key);
        self.mlSyncFromReadline();
        self.refreshMultiline();
        return;
      }

      // All other keys in multi-line mode
      if (self.mlActive) {
        origTtyWrite(s, key);
        self.mlSyncFromReadline();
        self.refreshMultiline();
        return;
      }

      // Single-line mode — pass through to readline normally
      origTtyWrite(s, key);
    };

    // ── Handle paste: inject directly into readline state ──
    this.pasteFilter.on('paste-complete', (text: string) => {
      if (!this.rl) return;
      const r = this.rl as any;

      const pasteLines = text.split('\n');

      if (pasteLines.length === 1) {
        // Single line paste — simple inject
        if (this.mlActive) {
          this.mlSyncFromReadline();
          const cur = this.mlLine(this.mlLineIdx);
          const before = cur.slice(0, this.mlColIdx);
          const after = cur.slice(this.mlColIdx);
          this.mlLines[this.mlLineIdx] = before + (pasteLines[0] ?? '') + after;
          this.mlColIdx += (pasteLines[0] ?? '').length;
          this.mlSyncToReadline();
          this.refreshMultiline();
        } else {
          const before = r.line.slice(0, r.cursor);
          const after = r.line.slice(r.cursor);
          const pl0 = pasteLines[0] ?? '';
          r.line = before + pl0 + after;
          r.cursor += pl0.length;
          r._refreshLine();
        }
        return;
      }

      // Multi-line paste
      if (!this.mlActive) {
        // Enter multi-line mode
        this.mlLines = [r.line || ''];
        this.mlColIdx = r.cursor || 0;
        this.mlLineIdx = 0;
        this.mlActive = true;

        const cols = process.stdout.columns || 80;
        const prompt = this.getLinePrompt(0);
        const dp = calcDisplayPos(prompt + this.mlLine(0), cols);
        this.mlTotalRows = dp.rows;
      } else {
        this.mlSyncFromReadline();
      }

      // Insert paste lines at cursor
      const curLine = this.mlLine(this.mlLineIdx);
      const before = curLine.slice(0, this.mlColIdx);
      const after = curLine.slice(this.mlColIdx);

      // First paste line merges with content before cursor
      this.mlLines[this.mlLineIdx] = before + (pasteLines[0] ?? '');

      // Middle paste lines are inserted as new lines
      for (let i = 1; i < pasteLines.length - 1; i++) {
        this.mlLines.splice(this.mlLineIdx + i, 0, pasteLines[i] ?? '');
      }

      // Last paste line merges with content after cursor
      const lastPasteIdx = this.mlLineIdx + pasteLines.length - 1;
      const lastPasteLine = pasteLines[pasteLines.length - 1] ?? '';
      this.mlLines.splice(lastPasteIdx, 0, lastPasteLine + after);

      this.mlLineIdx = lastPasteIdx;
      this.mlColIdx = lastPasteLine.length;

      this.mlSyncToReadline();
      r._prompt = this.getLinePrompt(this.mlLineIdx);
      this.refreshMultiline();
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
        this.mlReset();

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

        await this.processInput(trimmed);
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
