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
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      const content = raw.replace(/^\uFEFF/, ''); // Strip BOM (PowerShell UTF-8)
      this.entries = content.split('\n')
        .map(line => line.replace(/\r$/, '')) // Strip Windows CRLF
        .filter(Boolean)
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
  private mlActive = false;
  private mlCursorRow = 0;
  private mlLastNewlineAt = 0;

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

  private getLinePrompt(lineIdx: number): string {
    return lineIdx === 0 ? renderPrompt() : chalk.dim('... ');
  }

  private mlLine(idx: number): string {
    return this.mlLines[idx] ?? '';
  }

  private mlReset(): void {
    this.mlLines = [''];
    this.mlLineIdx = 0;
    this.mlColIdx = 0;
    this.mlActive = false;
    this.mlCursorRow = 0;
  }

  /** Enter multi-line mode from current readline state */
  private mlEnterFromReadline(): void {
    if (!this.rl) return;
    const r = this.rl as any;
    const text = r.line || '';
    const cursor = r.cursor || 0;

    if (text.includes('\n')) {
      // History item with newlines — split into lines
      this.mlLines = text.split('\n');
      // Find which line the cursor is on
      let pos = 0;
      this.mlLineIdx = 0;
      for (let i = 0; i < this.mlLines.length; i++) {
        const lineLen = (this.mlLines[i] ?? '').length;
        if (pos + lineLen >= cursor) {
          this.mlLineIdx = i;
          this.mlColIdx = cursor - pos;
          break;
        }
        pos += lineLen + 1; // +1 for \n
      }
    } else {
      this.mlLines = [text];
      this.mlLineIdx = 0;
      this.mlColIdx = cursor;
    }
    this.mlActive = true;

    // Calculate current cursor row for refreshMultiline
    const cols = process.stdout.columns || 80;
    const beforeCursor = this.getLinePrompt(0) + text.slice(0, cursor);
    const dp = calcDisplayPos(beforeCursor, cols);
    this.mlCursorRow = dp.rows;
  }

  /** Sync readline's line/cursor to current mlLine */
  private mlSyncToReadline(): void {
    if (!this.rl) return;
    const r = this.rl as any;
    r.line = this.mlLine(this.mlLineIdx);
    r.cursor = this.mlColIdx;
  }

  /** Sync mlLines/mlColIdx from readline after it processes a key */
  private mlSyncFromReadline(): void {
    if (!this.rl) return;
    const r = this.rl as any;
    this.mlLines[this.mlLineIdx] = r.line;
    this.mlColIdx = r.cursor;
  }

  /**
   * Render the entire multi-line block from scratch.
   * 1. Move to top of block using mlCursorRow
   * 2. Clear to end of screen
   * 3. Render all lines
   * 4. Position cursor at mlLineIdx/mlColIdx
   * 5. Save new mlCursorRow
   */
  private refreshMultiline(): void {
    if (!this.rl) return;
    const cols = process.stdout.columns || 80;

    // Step 1: Move to top of block
    if (this.mlCursorRow > 0) {
      process.stdout.write(`\x1B[${this.mlCursorRow}A`);
    }
    process.stdout.write('\r\x1B[J');

    // Step 2: Render all lines
    for (let i = 0; i < this.mlLines.length; i++) {
      const prompt = this.getLinePrompt(i);
      process.stdout.write(prompt + this.mlLine(i));
      if (i < this.mlLines.length - 1) {
        process.stdout.write('\n');
      }
    }

    // Step 3: Calculate positions
    let rowsFromTopToCursor = 0;
    for (let i = 0; i < this.mlLineIdx; i++) {
      const fl = this.getLinePrompt(i) + this.mlLine(i);
      const dp = calcDisplayPos(fl, cols);
      rowsFromTopToCursor += dp.rows + 1;
    }
    const cursorContent = this.getLinePrompt(this.mlLineIdx) + this.mlLine(this.mlLineIdx).slice(0, this.mlColIdx);
    const cursorDP = calcDisplayPos(cursorContent, cols);
    rowsFromTopToCursor += cursorDP.rows;

    let rowsFromTopToEnd = 0;
    for (let i = 0; i < this.mlLines.length - 1; i++) {
      const fl = this.getLinePrompt(i) + this.mlLine(i);
      const dp = calcDisplayPos(fl, cols);
      rowsFromTopToEnd += dp.rows + 1;
    }
    const lastFl = this.getLinePrompt(this.mlLines.length - 1) + this.mlLine(this.mlLines.length - 1);
    const lastDP = calcDisplayPos(lastFl, cols);
    rowsFromTopToEnd += lastDP.rows;

    // Step 4: Move cursor to correct position
    const moveUp = rowsFromTopToEnd - rowsFromTopToCursor;
    if (moveUp > 0) {
      process.stdout.write(`\x1B[${moveUp}A`);
    }
    process.stdout.write('\r');
    if (cursorDP.cols > 0) {
      process.stdout.write(`\x1B[${cursorDP.cols}C`);
    }

    // Step 5: Save cursor row
    this.mlCursorRow = rowsFromTopToCursor;
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

    // ── Suppress readline's own rendering in multi-line mode ──
    const origWriteToOutput = rlAny._writeToOutput.bind(rlAny);
    const origRefreshLine = rlAny._refreshLine.bind(rlAny);
    const self = this;
    let suppressRendering = false;

    rlAny._writeToOutput = function(str: string) {
      if (self.mlActive || suppressRendering) return;
      origWriteToOutput(str);
    };

    rlAny._refreshLine = function() {
      if (self.mlActive || suppressRendering) return;
      origRefreshLine();
    };

    // ── Find kSubstringSearch symbol to reset before history navigation ──
    const kSubstringSearch = Object.getOwnPropertySymbols(rlAny)
      .find((s: symbol) => s.description === 'kSubstringSearch');

    // ── Override _ttyWrite for multi-line editing ──
    const origTtyWrite = rlAny._ttyWrite.bind(rlAny);

    rlAny._ttyWrite = function(s: string, key: Key) {
      if (!key) key = {};

      // Debug: log key events when CODI_DEBUG_KEYS is set
      if (process.env['CODI_DEBUG_KEYS']) {
        const seq = s ? [...s].map(c => '0x' + c.charCodeAt(0).toString(16)).join(' ') : 'null';
        process.stderr.write(`[KEY] name=${key.name} ctrl=${key.ctrl} shift=${key.shift} meta=${key.meta} seq=${key.sequence ? [...key.sequence].map(c => '0x' + c.charCodeAt(0).toString(16)).join(' ') : 'null'} ml=${self.mlActive} li=${self.mlLineIdx}/${self.mlLines.length} histIdx=${this.historyIndex} cursor=${this.cursor} prevRows=${this.prevRows} line=${JSON.stringify((this.line||'').slice(0,50))}\n`);
      }

      // ── Ctrl+D → always exit (even with text in prompt or permission prompt) ──
      if (key.name === 'd' && key.ctrl) {
        if (self.mlActive) {
          // Clear multi-line display before exit
          if (self.mlCursorRow > 0) {
            process.stdout.write(`\x1B[${self.mlCursorRow}A`);
          }
          process.stdout.write('\r\x1B[J');
          self.mlReset();
        }
        self.gracefulExit().catch(() => process.exit(1));
        return;
      }

      // ── Newline detection ──
      const seq = key.sequence || '';
      const isKittyModifiedEnter = seq.startsWith('\x1b[13;') && seq.endsWith('u');
      const isNewline =
        isKittyModifiedEnter ||
        key.name === 'enter' ||
        (key.name === 'return' && (key.ctrl || key.meta || key.shift)) ||
        (key.name === 'j' && key.ctrl);

      if (isNewline) {
        self.mlLastNewlineAt = Date.now();

        if (!self.mlActive) {
          self.mlLines = [this.line || ''];
          self.mlColIdx = this.cursor || 0;
          self.mlLineIdx = 0;
          self.mlActive = true;
          // Calculate where cursor currently is on screen
          const cols = process.stdout.columns || 80;
          const dp = calcDisplayPos(
            self.getLinePrompt(0) + (this.line || '').slice(0, this.cursor || 0),
            cols,
          );
          self.mlCursorRow = dp.rows;
        } else {
          self.mlSyncFromReadline();
        }

        // Split current line at cursor
        const curLine = self.mlLine(self.mlLineIdx);
        const before = curLine.slice(0, self.mlColIdx);
        const after = curLine.slice(self.mlColIdx);
        self.mlLines[self.mlLineIdx] = before;
        self.mlLines.splice(self.mlLineIdx + 1, 0, after);
        self.mlLineIdx++;
        self.mlColIdx = 0;

        // Sync readline to new current line
        this.line = after;
        this.cursor = 0;
        this._prompt = self.getLinePrompt(self.mlLineIdx);

        self.refreshMultiline();
        return;
      }

      // ── Suppress trailing \r after newline insertion ──
      if (key.name === 'return' && !key.ctrl && !key.meta && !key.shift && (Date.now() - self.mlLastNewlineAt < 100)) {
        return;
      }

      // ── Enter (submit) ──
      if (key.name === 'return' && !key.ctrl && !key.meta && !key.shift) {
        if (self.mlActive) {
          self.mlSyncFromReadline();
          const fullText = self.mlLines.join('\n');

          // Move cursor to end of block
          const cols = process.stdout.columns || 80;
          let rowsFromTopToEnd = 0;
          for (let i = 0; i < self.mlLines.length - 1; i++) {
            const fl = self.getLinePrompt(i) + self.mlLine(i);
            const dp = calcDisplayPos(fl, cols);
            rowsFromTopToEnd += dp.rows + 1;
          }
          const lastFl = self.getLinePrompt(self.mlLines.length - 1) + self.mlLine(self.mlLines.length - 1);
          rowsFromTopToEnd += calcDisplayPos(lastFl, cols).rows;

          const downToEnd = rowsFromTopToEnd - self.mlCursorRow;
          if (downToEnd > 0) process.stdout.write(`\x1B[${downToEnd}B`);
          process.stdout.write('\n');

          self.mlReset();
          this.line = '';
          this.cursor = 0;
          this.prevRows = 0;
          this._prompt = renderPrompt();
          this.emit('line', fullText);
          return;
        }
        origTtyWrite(s, key);
        return;
      }

      // ── Ctrl+C in multi-line → cancel ──
      if (key.name === 'c' && key.ctrl && self.mlActive) {
        if (self.mlCursorRow > 0) {
          process.stdout.write(`\x1B[${self.mlCursorRow}A`);
        }
        process.stdout.write('\r\x1B[J');
        self.mlReset();
        this.line = '';
        this.cursor = 0;
        this.prevRows = 0;
        this._prompt = renderPrompt();
        origRefreshLine();
        return;
      }

      // ── Up arrow ──
      if (key.name === 'up' && !key.ctrl && !key.meta) {
        if (process.env['CODI_DEBUG_KEYS']) {
          process.stderr.write(`[UP] mlActive=${self.mlActive} mlLineIdx=${self.mlLineIdx} mlLines.len=${self.mlLines.length} prevRows=${this.prevRows} cursor=${this.cursor} line=${JSON.stringify((this.line||'').slice(0,50))}\n`);
        }
        if (self.mlActive) {
          self.mlSyncFromReadline();
          const cols = process.stdout.columns || 80;
          const prompt = self.getLinePrompt(self.mlLineIdx);
          const curLine = self.mlLine(self.mlLineIdx);
          const curDP = calcDisplayPos(prompt + curLine.slice(0, self.mlColIdx), cols);

          if (curDP.rows > 0) {
            // Current logical line wraps visually and cursor is NOT on first visual row
            // → move cursor up one visual row within the same logical line
            const targetRow = curDP.rows - 1;
            const targetCol = curDP.cols;
            let newCol = 0;
            for (let pos = 0; pos <= self.mlColIdx; pos++) {
              const dp = calcDisplayPos(prompt + curLine.slice(0, pos), cols);
              if (dp.rows === targetRow) {
                newCol = pos;
                if (dp.cols >= targetCol) break;
              } else if (dp.rows > targetRow) break;
            }
            self.mlColIdx = newCol;
            self.mlSyncToReadline();
            self.refreshMultiline();
            if (process.env['CODI_DEBUG_KEYS']) {
              process.stderr.write(`[UP-ML-VWRAP] line=${self.mlLineIdx} row=${curDP.rows}→${targetRow} col=${newCol}\n`);
            }
            return;
          }

          if (self.mlLineIdx > 0) {
            // At first visual row of current line → move to previous logical line
            const prevLineIdx = self.mlLineIdx - 1;
            const prevPrompt = self.getLinePrompt(prevLineIdx);
            const prevLine = self.mlLine(prevLineIdx);
            const prevDP = calcDisplayPos(prevPrompt + prevLine, cols);
            if (prevDP.rows > 0) {
              // Previous line also wraps → land on its last visual row at same column
              const targetRow = prevDP.rows;
              const targetCol = curDP.cols;
              let newCol = prevLine.length;
              for (let pos = 0; pos <= prevLine.length; pos++) {
                const dp = calcDisplayPos(prevPrompt + prevLine.slice(0, pos), cols);
                if (dp.rows === targetRow) {
                  newCol = pos;
                  if (dp.cols >= targetCol) break;
                } else if (dp.rows > targetRow) break;
              }
              self.mlLineIdx = prevLineIdx;
              self.mlColIdx = newCol;
            } else {
              // Previous line fits in one visual row
              self.mlLineIdx = prevLineIdx;
              self.mlColIdx = Math.min(self.mlColIdx, prevLine.length);
            }
            self.mlSyncToReadline();
            this._prompt = self.getLinePrompt(self.mlLineIdx);
            self.refreshMultiline();
            return;
          }

          // At first visual row of first logical line → fall through to history
        }

        // ── Visual wrap navigation (single-line wrapping across multiple visual rows) ──
        // Note: DO NOT rely on this.prevRows — it tracks cursor row, not total line rows
        if (!self.mlActive) {
          const cols = process.stdout.columns || 80;
          const prompt = this._prompt || '';
          const line = this.line || '';
          const totalDP = calcDisplayPos(prompt + line, cols);
          if (totalDP.rows > 0) {
            const curDP = calcDisplayPos(prompt + line.slice(0, this.cursor), cols);
            if (curDP.rows > 0) {
              // Not on first visual row → move cursor up one visual row
              const targetRow = curDP.rows - 1;
              const targetCol = curDP.cols;
              let newCursor = 0;
              for (let pos = 0; pos <= this.cursor; pos++) {
                const dp = calcDisplayPos(prompt + line.slice(0, pos), cols);
                if (dp.rows === targetRow) {
                  newCursor = pos;
                  if (dp.cols >= targetCol) break;
                } else if (dp.rows > targetRow) {
                  break;
                }
              }
              this.cursor = newCursor;
              if (process.env['CODI_DEBUG_KEYS']) {
                process.stderr.write(`[UP-VWRAP] row=${curDP.rows}→${targetRow} col=${targetCol} cursor=${newCursor}\n`);
              }
              origRefreshLine();
              return;
            }
          }
        }

        // At first line of multi-line OR single-line → navigate history
        const wasML = self.mlActive;
        const savedLineIdx = self.mlLineIdx;
        const savedColIdx = self.mlColIdx;

        if (wasML) {
          self.mlSyncFromReadline();
          const fullText = self.mlLines.join('\n');
          // Clear multi-line display
          if (self.mlCursorRow > 0) process.stdout.write(`\x1B[${self.mlCursorRow}A`);
          process.stdout.write('\r\x1B[J');
          // Restore full text to readline so it saves to history buffer
          self.mlReset();
          this.line = fullText;
          this.cursor = fullText.length;
          this.prevRows = 0;
          this._prompt = self.getLinePrompt(0);
        }

        // Reset substring search so LEFT/RIGHT don't break history navigation
        this.cursor = (this.line || '').length;
        if (kSubstringSearch) this[kSubstringSearch] = '';

        const textBefore = this.line || '';
        suppressRendering = true;
        origTtyWrite(s, key);
        suppressRendering = false;

        const newText = this.line || '';

        if (process.env['CODI_DEBUG_KEYS']) {
          process.stderr.write(`[UP-HIST] wasML=${wasML} before=${JSON.stringify(textBefore).slice(0,30)} after=${JSON.stringify(newText).slice(0,30)} histIdx=${this.historyIndex} changed=${newText !== textBefore}\n`);
        }

        // If text didn't change (no more history) and was multi-line, restore original state
        if (newText === textBefore && wasML) {
          self.mlLines = newText.split('\n');
          self.mlActive = true;
          self.mlLineIdx = savedLineIdx;
          self.mlColIdx = savedColIdx;
          self.mlSyncToReadline();
          this._prompt = self.getLinePrompt(self.mlLineIdx);
          self.mlCursorRow = 0;
          self.refreshMultiline();
          return;
        }

        if (newText.includes('\n')) {
          // New history item is multi-line — clear old single-line render if needed
          if (!wasML) {
            const oldRows = this.prevRows || 0;
            if (oldRows > 0) process.stdout.write(`\x1B[${oldRows}A`);
            process.stdout.write('\r\x1B[J');
          }
          self.mlLines = newText.split('\n');
          self.mlActive = true;
          // UP → cursor at last line
          self.mlLineIdx = self.mlLines.length - 1;
          self.mlColIdx = self.mlLine(self.mlLineIdx).length;
          self.mlSyncToReadline();
          this._prompt = self.getLinePrompt(self.mlLineIdx);
          self.mlCursorRow = 0;
          self.refreshMultiline();
        } else {
          // Single-line result
          if (wasML) this.prevRows = 0;
          origRefreshLine();
        }
        return;
      }

      // ── Down arrow ──
      if (key.name === 'down' && !key.ctrl && !key.meta) {
        if (process.env['CODI_DEBUG_KEYS']) {
          process.stderr.write(`[DOWN] mlActive=${self.mlActive} mlLineIdx=${self.mlLineIdx} mlLines.len=${self.mlLines.length} prevRows=${this.prevRows} cursor=${this.cursor} line=${JSON.stringify((this.line||'').slice(0,50))}\n`);
        }
        if (self.mlActive) {
          self.mlSyncFromReadline();
          const cols = process.stdout.columns || 80;
          const prompt = self.getLinePrompt(self.mlLineIdx);
          const curLine = self.mlLine(self.mlLineIdx);
          const curDP = calcDisplayPos(prompt + curLine.slice(0, self.mlColIdx), cols);
          const totalDP = calcDisplayPos(prompt + curLine, cols);

          if (curDP.rows < totalDP.rows) {
            // Current logical line wraps visually and cursor is NOT on last visual row
            // → move cursor down one visual row within the same logical line
            const targetRow = curDP.rows + 1;
            const targetCol = curDP.cols;
            let newCol = curLine.length;
            for (let pos = self.mlColIdx; pos <= curLine.length; pos++) {
              const dp = calcDisplayPos(prompt + curLine.slice(0, pos), cols);
              if (dp.rows === targetRow) {
                newCol = pos;
                if (dp.cols >= targetCol) break;
              } else if (dp.rows > targetRow) break;
            }
            self.mlColIdx = newCol;
            self.mlSyncToReadline();
            self.refreshMultiline();
            if (process.env['CODI_DEBUG_KEYS']) {
              process.stderr.write(`[DOWN-ML-VWRAP] line=${self.mlLineIdx} row=${curDP.rows}→${targetRow} col=${newCol}\n`);
            }
            return;
          }

          if (self.mlLineIdx < self.mlLines.length - 1) {
            // At last visual row of current line → move to next logical line
            const nextLineIdx = self.mlLineIdx + 1;
            const nextPrompt = self.getLinePrompt(nextLineIdx);
            const nextLine = self.mlLine(nextLineIdx);
            const nextDP = calcDisplayPos(nextPrompt + nextLine, cols);
            if (nextDP.rows > 0) {
              // Next line also wraps → land on its first visual row at same column
              const targetCol = curDP.cols;
              let newCol = 0;
              for (let pos = 0; pos <= nextLine.length; pos++) {
                const dp = calcDisplayPos(nextPrompt + nextLine.slice(0, pos), cols);
                if (dp.rows === 0) {
                  newCol = pos;
                  if (dp.cols >= targetCol) break;
                } else break;
              }
              self.mlLineIdx = nextLineIdx;
              self.mlColIdx = newCol;
            } else {
              // Next line fits in one visual row
              self.mlLineIdx = nextLineIdx;
              self.mlColIdx = Math.min(self.mlColIdx, nextLine.length);
            }
            self.mlSyncToReadline();
            this._prompt = self.getLinePrompt(self.mlLineIdx);
            self.refreshMultiline();
            return;
          }

          // At last visual row of last logical line → fall through to history
        }

        // ── Visual wrap navigation (single-line wrapping across multiple visual rows) ──
        // Note: DO NOT rely on this.prevRows — it tracks cursor row, not total line rows
        if (!self.mlActive) {
          const cols = process.stdout.columns || 80;
          const prompt = this._prompt || '';
          const line = this.line || '';
          const totalDP = calcDisplayPos(prompt + line, cols);
          const curDP = calcDisplayPos(prompt + line.slice(0, this.cursor), cols);
          if (curDP.rows < totalDP.rows) {
            // Not on last visual row → move cursor down one visual row
            const targetRow = curDP.rows + 1;
            const targetCol = curDP.cols;
            let newCursor = line.length; // default to end
            for (let pos = this.cursor; pos <= line.length; pos++) {
              const dp = calcDisplayPos(prompt + line.slice(0, pos), cols);
              if (dp.rows === targetRow) {
                newCursor = pos;
                if (dp.cols >= targetCol) break;
              } else if (dp.rows > targetRow) {
                break;
              }
            }
            this.cursor = newCursor;
            if (process.env['CODI_DEBUG_KEYS']) {
              process.stderr.write(`[DOWN-VWRAP] row=${curDP.rows}→${targetRow} col=${targetCol} cursor=${newCursor}\n`);
            }
            origRefreshLine();
            return;
          }
        }

        // At last line of multi-line OR single-line → navigate history
        const wasML = self.mlActive;
        const savedLineIdx = self.mlLineIdx;
        const savedColIdx = self.mlColIdx;

        if (wasML) {
          self.mlSyncFromReadline();
          const fullText = self.mlLines.join('\n');
          if (self.mlCursorRow > 0) process.stdout.write(`\x1B[${self.mlCursorRow}A`);
          process.stdout.write('\r\x1B[J');
          self.mlReset();
          this.line = fullText;
          this.cursor = fullText.length;
          this.prevRows = 0;
          this._prompt = self.getLinePrompt(0);
        }

        // Reset substring search so LEFT/RIGHT don't break history navigation
        this.cursor = (this.line || '').length;
        if (kSubstringSearch) this[kSubstringSearch] = '';

        const textBefore = this.line || '';
        suppressRendering = true;
        origTtyWrite(s, key);
        suppressRendering = false;

        const newText = this.line || '';

        if (process.env['CODI_DEBUG_KEYS']) {
          process.stderr.write(`[DOWN-HIST] wasML=${wasML} before=${JSON.stringify(textBefore).slice(0,30)} after=${JSON.stringify(newText).slice(0,30)} histIdx=${this.historyIndex} changed=${newText !== textBefore}\n`);
        }

        if (newText === textBefore && wasML) {
          self.mlLines = newText.split('\n');
          self.mlActive = true;
          self.mlLineIdx = savedLineIdx;
          self.mlColIdx = savedColIdx;
          self.mlSyncToReadline();
          this._prompt = self.getLinePrompt(self.mlLineIdx);
          self.mlCursorRow = 0;
          self.refreshMultiline();
          return;
        }

        if (newText.includes('\n')) {
          if (!wasML) {
            const oldRows = this.prevRows || 0;
            if (oldRows > 0) process.stdout.write(`\x1B[${oldRows}A`);
            process.stdout.write('\r\x1B[J');
          }
          self.mlLines = newText.split('\n');
          self.mlActive = true;
          // DOWN → cursor at first line
          self.mlLineIdx = 0;
          self.mlColIdx = 0;
          self.mlSyncToReadline();
          this._prompt = self.getLinePrompt(0);
          self.mlCursorRow = 0;
          self.refreshMultiline();
        } else {
          if (wasML) this.prevRows = 0;
          origRefreshLine();
        }
        return;
      }

      // ── Backspace in multi-line ──
      if (key.name === 'backspace' && self.mlActive) {
        self.mlSyncFromReadline();
        if (self.mlColIdx === 0 && self.mlLineIdx > 0) {
          // Merge with previous line
          const prevLine = self.mlLine(self.mlLineIdx - 1);
          const curLine = self.mlLine(self.mlLineIdx);
          self.mlLines[self.mlLineIdx - 1] = prevLine + curLine;
          self.mlLines.splice(self.mlLineIdx, 1);
          self.mlLineIdx--;
          self.mlColIdx = prevLine.length;
          if (self.mlLines.length === 1) self.mlActive = false;
          self.mlSyncToReadline();
          this._prompt = self.getLinePrompt(self.mlLineIdx);
          if (self.mlActive) {
            self.refreshMultiline();
          } else {
            // Back to single line — let readline render
            this.prevRows = 0;
            origRefreshLine();
          }
          return;
        }
        // Normal backspace — let readline process
        origTtyWrite(s, key);
        self.mlSyncFromReadline();
        self.refreshMultiline();
        return;
      }

      // ── Delete in multi-line ──
      if (key.name === 'delete' && self.mlActive) {
        self.mlSyncFromReadline();
        if (self.mlColIdx === self.mlLine(self.mlLineIdx).length && self.mlLineIdx < self.mlLines.length - 1) {
          // Merge with next line
          const curLine = self.mlLine(self.mlLineIdx);
          const nextLine = self.mlLine(self.mlLineIdx + 1);
          self.mlLines[self.mlLineIdx] = curLine + nextLine;
          self.mlLines.splice(self.mlLineIdx + 1, 1);
          if (self.mlLines.length === 1) self.mlActive = false;
          self.mlSyncToReadline();
          this._prompt = self.getLinePrompt(self.mlLineIdx);
          if (self.mlActive) {
            self.refreshMultiline();
          } else {
            this.prevRows = 0;
            origRefreshLine();
          }
          return;
        }
        origTtyWrite(s, key);
        self.mlSyncFromReadline();
        self.refreshMultiline();
        return;
      }

      // ── All other keys in multi-line mode ──
      if (self.mlActive) {
        // Let readline process the key (output is suppressed by _writeToOutput override)
        origTtyWrite(s, key);
        // Sync back and re-render
        self.mlSyncFromReadline();
        self.refreshMultiline();
        return;
      }

      // ── Single-line mode — pass through ──
      const lineBeforePassthrough = this.line;
      const cursorBeforePassthrough = this.cursor;
      const prevRowsBefore = this.prevRows;
      origTtyWrite(s, key);
      if (process.env['CODI_DEBUG_KEYS']) {
        process.stderr.write(`[AFTER] name=${key.name} line=${JSON.stringify((this.line||'').slice(0,50))} cursor=${this.cursor} prevRows=${this.prevRows} lineBefore=${JSON.stringify((lineBeforePassthrough||'').slice(0,50))} cursorBefore=${cursorBeforePassthrough} prevRowsBefore=${prevRowsBefore}\n`);
      }
    };

    // ── Handle paste ──
    this.pasteFilter.on('paste-complete', (text: string) => {
      if (!this.rl) return;
      const r = this.rl as any;

      const pasteLines = text.split('\n');

      if (pasteLines.length === 1) {
        // Single line paste
        const pl = pasteLines[0] ?? '';
        if (this.mlActive) {
          this.mlSyncFromReadline();
          const cur = this.mlLine(this.mlLineIdx);
          this.mlLines[this.mlLineIdx] = cur.slice(0, this.mlColIdx) + pl + cur.slice(this.mlColIdx);
          this.mlColIdx += pl.length;
          this.mlSyncToReadline();
          this.refreshMultiline();
        } else {
          const before = r.line.slice(0, r.cursor);
          const after = r.line.slice(r.cursor);
          r.line = before + pl + after;
          r.cursor += pl.length;
          r._refreshLine();
        }
        return;
      }

      // Multi-line paste
      if (!this.mlActive) {
        this.mlLines = [r.line || ''];
        this.mlColIdx = r.cursor || 0;
        this.mlLineIdx = 0;
        this.mlActive = true;
        const cols = process.stdout.columns || 80;
        const dp = calcDisplayPos(
          this.getLinePrompt(0) + (r.line || '').slice(0, r.cursor || 0),
          cols,
        );
        this.mlCursorRow = dp.rows;
      } else {
        this.mlSyncFromReadline();
      }

      const curLine = this.mlLine(this.mlLineIdx);
      const before = curLine.slice(0, this.mlColIdx);
      const after = curLine.slice(this.mlColIdx);

      this.mlLines[this.mlLineIdx] = before + (pasteLines[0] ?? '');
      for (let i = 1; i < pasteLines.length - 1; i++) {
        this.mlLines.splice(this.mlLineIdx + i, 0, pasteLines[i] ?? '');
      }
      const lastPasteIdx = this.mlLineIdx + pasteLines.length - 1;
      const lastPl = pasteLines[pasteLines.length - 1] ?? '';
      this.mlLines.splice(lastPasteIdx, 0, lastPl + after);

      this.mlLineIdx = lastPasteIdx;
      this.mlColIdx = lastPl.length;
      this.mlSyncToReadline();
      r._prompt = this.getLinePrompt(this.mlLineIdx);
      this.refreshMultiline();
    });

    // Enable bracket paste mode + kitty keyboard protocol
    if (process.stdin.isTTY) {
      process.stdout.write('\x1B[?2004h');
      process.stdout.write('\x1B[>1u');
    }

    registerPromptHandler((prompt: string) => {
      if (!this.rl) return Promise.reject(new Error('REPL not running'));
      process.stdout.write(prompt);
      return new Promise<string>((resolve, reject) => {
        const onLine = (answer: string) => {
          this.rl?.removeListener('close', onClose);
          resolve(answer);
        };
        const onClose = () => {
          this.rl?.removeListener('line', onLine);
          reject(new Error('closed'));
        };
        this.rl!.once('line', onLine);
        this.rl!.once('close', onClose);
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
      process.stdout.write('\x1B[<u');
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
