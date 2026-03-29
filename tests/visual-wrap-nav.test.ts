/**
 * Visual line wrap UP/DOWN navigation simulation test
 *
 * When a single-line entry wraps visually across multiple terminal rows,
 * UP/DOWN should navigate between visual rows first, and only trigger
 * history navigation at the top/bottom visual row boundaries.
 */
import { describe, it, expect } from 'vitest';

// Simplified calcDisplayPos for ASCII-only (matches src/repl.ts logic)
function calcDisplayPos(str: string, cols: number): { rows: number; cols: number } {
  let offset = 0;
  for (const ch of str) {
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
    offset += 1; // simplified: all chars width 1
  }
  const c = offset % cols;
  const r = (offset - c) / cols;
  return { rows: r, cols: c };
}

// Simulates the UP visual wrap logic from repl.ts
function simulateUpVisualWrap(
  prompt: string,
  line: string,
  cursor: number,
  cols: number,
): { navigated: boolean; newCursor: number } {
  const prevRows = calcDisplayPos(prompt + line, cols).rows;
  if (prevRows === 0) {
    return { navigated: false, newCursor: cursor }; // no wrapping, go to history
  }

  const curDP = calcDisplayPos(prompt + line.slice(0, cursor), cols);
  if (curDP.rows > 0) {
    const targetRow = curDP.rows - 1;
    const targetCol = curDP.cols;
    let newCursor = 0;
    for (let pos = 0; pos <= cursor; pos++) {
      const dp = calcDisplayPos(prompt + line.slice(0, pos), cols);
      if (dp.rows === targetRow) {
        newCursor = pos;
        if (dp.cols >= targetCol) break;
      } else if (dp.rows > targetRow) {
        break;
      }
    }
    return { navigated: true, newCursor };
  }

  return { navigated: false, newCursor: cursor }; // at first row, go to history
}

// Simulates the DOWN visual wrap logic
function simulateDownVisualWrap(
  prompt: string,
  line: string,
  cursor: number,
  cols: number,
): { navigated: boolean; newCursor: number } {
  const totalDP = calcDisplayPos(prompt + line, cols);
  if (totalDP.rows === 0) {
    return { navigated: false, newCursor: cursor }; // no wrapping
  }

  const curDP = calcDisplayPos(prompt + line.slice(0, cursor), cols);
  if (curDP.rows < totalDP.rows) {
    const targetRow = curDP.rows + 1;
    const targetCol = curDP.cols;
    let newCursor = line.length;
    for (let pos = cursor; pos <= line.length; pos++) {
      const dp = calcDisplayPos(prompt + line.slice(0, pos), cols);
      if (dp.rows === targetRow) {
        newCursor = pos;
        if (dp.cols >= targetCol) break;
      } else if (dp.rows > targetRow) {
        break;
      }
    }
    return { navigated: true, newCursor };
  }

  return { navigated: false, newCursor: cursor }; // at last row, go to history
}

describe('Visual line wrap navigation', () => {
  // Terminal width 20 columns, prompt "> " (2 chars)
  // So first row has 18 chars of text before wrapping
  const cols = 20;
  const prompt = '> ';

  describe('UP arrow', () => {
    it('should navigate history when line fits in one visual row', () => {
      const line = 'short text'; // 10 chars + 2 prompt = 12, < 20
      const result = simulateUpVisualWrap(prompt, line, line.length, cols);
      expect(result.navigated).toBe(false); // should go to history
    });

    it('should move cursor up when on second visual row', () => {
      // "abcdefghijklmnopqr" = 18 chars on row 0, "stuvwxyz" on row 1
      const line = 'abcdefghijklmnopqrstuvwxyz'; // 26 chars + 2 prompt = 28
      // Cursor at end (row 1, col 10)
      const result = simulateUpVisualWrap(prompt, line, line.length, cols);
      expect(result.navigated).toBe(true);
      // Should move to row 0, col 10 → cursor at position 8 (prompt takes 2 cols on row 0)
      // Row 0: prompt(2) + line[0..17] = 20 cols
      // Row 1: line[18..25] = 8 chars, cursor at end = col 8
      // Target: row 0, col 8 → prompt(2) + 6 chars = col 8 → cursor 6
      const targetDP = calcDisplayPos(prompt + line.slice(0, result.newCursor), cols);
      expect(targetDP.rows).toBe(0);
    });

    it('should go to history when cursor is on first visual row', () => {
      const line = 'abcdefghijklmnopqrstuvwxyz'; // wraps
      // Cursor at position 5 (row 0)
      const result = simulateUpVisualWrap(prompt, line, 5, cols);
      expect(result.navigated).toBe(false);
    });

    it('should handle cursor at start of second row', () => {
      const line = 'abcdefghijklmnopqrstuvwxyz';
      // Cursor at position 18 (start of row 1)
      const result = simulateUpVisualWrap(prompt, line, 18, cols);
      expect(result.navigated).toBe(true);
      const dp = calcDisplayPos(prompt + line.slice(0, result.newCursor), cols);
      expect(dp.rows).toBe(0);
      // col 0 on row 1 maps to start of row 0 → cursor 0 → but prompt takes 2 cols
      // so calcDisplayPos("> " + "", 20) = {rows:0, cols:2}, meaning col 2 is the closest
      expect(dp.cols).toBeLessThanOrEqual(2);
    });
  });

  describe('DOWN arrow', () => {
    it('should navigate history when line fits in one visual row', () => {
      const line = 'short';
      const result = simulateDownVisualWrap(prompt, line, 0, cols);
      expect(result.navigated).toBe(false);
    });

    it('should move cursor down when on first visual row of wrapped line', () => {
      const line = 'abcdefghijklmnopqrstuvwxyz';
      // Cursor at position 5 (row 0, col 7)
      const result = simulateDownVisualWrap(prompt, line, 5, cols);
      expect(result.navigated).toBe(true);
      const dp = calcDisplayPos(prompt + line.slice(0, result.newCursor), cols);
      expect(dp.rows).toBe(1);
    });

    it('should go to history when cursor is on last visual row', () => {
      const line = 'abcdefghijklmnopqrstuvwxyz';
      // Cursor at position 22 (on row 1, which is last)
      const result = simulateDownVisualWrap(prompt, line, 22, cols);
      expect(result.navigated).toBe(false);
    });

    it('should preserve column position when moving down', () => {
      const line = 'abcdefghijklmnopqrstuvwxyz';
      // Cursor at col 5 on row 0 → should land at col 5 on row 1
      const curDP = calcDisplayPos(prompt + line.slice(0, 3), cols);
      expect(curDP.rows).toBe(0);
      expect(curDP.cols).toBe(5); // prompt(2) + 3 = col 5

      const result = simulateDownVisualWrap(prompt, line, 3, cols);
      expect(result.navigated).toBe(true);
      const newDP = calcDisplayPos(prompt + line.slice(0, result.newCursor), cols);
      expect(newDP.rows).toBe(1);
      expect(newDP.cols).toBe(5); // same column
    });
  });

  describe('Multi-row wrapping (3+ rows)', () => {
    const longLine = 'a'.repeat(50); // 50 chars + 2 prompt = 52 → 3 rows in 20-col terminal
    // Row 0: prompt(2) + 18 'a' = 20
    // Row 1: 20 'a' = 20
    // Row 2: 12 'a' = 12

    it('should navigate row by row with UP', () => {
      // Cursor at end → row 2
      let result = simulateUpVisualWrap(prompt, longLine, longLine.length, cols);
      expect(result.navigated).toBe(true);
      let dp = calcDisplayPos(prompt + longLine.slice(0, result.newCursor), cols);
      expect(dp.rows).toBe(1);

      // From row 1 → row 0
      result = simulateUpVisualWrap(prompt, longLine, result.newCursor, cols);
      expect(result.navigated).toBe(true);
      dp = calcDisplayPos(prompt + longLine.slice(0, result.newCursor), cols);
      expect(dp.rows).toBe(0);

      // From row 0 → history
      result = simulateUpVisualWrap(prompt, longLine, result.newCursor, cols);
      expect(result.navigated).toBe(false);
    });

    it('should navigate row by row with DOWN', () => {
      // Cursor at start → row 0
      let result = simulateDownVisualWrap(prompt, longLine, 0, cols);
      expect(result.navigated).toBe(true);
      let dp = calcDisplayPos(prompt + longLine.slice(0, result.newCursor), cols);
      expect(dp.rows).toBe(1);

      // From row 1 → row 2
      result = simulateDownVisualWrap(prompt, longLine, result.newCursor, cols);
      expect(result.navigated).toBe(true);
      dp = calcDisplayPos(prompt + longLine.slice(0, result.newCursor), cols);
      expect(dp.rows).toBe(2);

      // From row 2 → history
      result = simulateDownVisualWrap(prompt, longLine, result.newCursor, cols);
      expect(result.navigated).toBe(false);
    });
  });

  describe('Edge cases', () => {
    it('should handle line that exactly fills terminal width', () => {
      // prompt(2) + 18 chars = exactly 20 → fills row 0 completely
      // Does this cause prevRows > 0? In readline, the cursor wraps to row 1 col 0
      const line = 'a'.repeat(18);
      const dp = calcDisplayPos(prompt + line, cols);
      // 20 chars total → row 1, col 0 (cursor wraps)
      expect(dp.rows).toBe(1);
      expect(dp.cols).toBe(0);

      // Cursor at end → technically row 1 col 0
      const result = simulateUpVisualWrap(prompt, line, line.length, cols);
      expect(result.navigated).toBe(true);
    });

    it('should handle empty line', () => {
      const result = simulateUpVisualWrap(prompt, '', 0, cols);
      expect(result.navigated).toBe(false);
    });
  });
});
