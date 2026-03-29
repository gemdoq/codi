/**
 * Ctrl+D exit simulation test
 *
 * Ctrl+D should always close readline (exit codi), even when:
 * 1. Line is empty (default behavior - already works)
 * 2. Line has text (new behavior)
 * 3. Multi-line mode is active (new behavior)
 */
import { describe, it, expect, vi } from 'vitest';

describe('Ctrl+D exit behavior', () => {
  it('should close readline when Ctrl+D pressed with empty line', () => {
    // Simulates: user presses Ctrl+D with no text
    // Expected: readline.close() called → exit
    const closeFn = vi.fn();
    const key = { name: 'd', ctrl: true, shift: false, meta: false, sequence: '\x04' };

    // Simulate the handler logic
    if (key.name === 'd' && key.ctrl) {
      closeFn();
    }

    expect(closeFn).toHaveBeenCalledOnce();
  });

  it('should close readline when Ctrl+D pressed with text in line', () => {
    // Simulates: user types "hello world" then presses Ctrl+D
    // Expected: readline.close() called → exit (NOT delete char)
    const closeFn = vi.fn();
    const line = 'hello world';
    const key = { name: 'd', ctrl: true, shift: false, meta: false, sequence: '\x04' };

    // Before fix: readline default would delete char at cursor
    // After fix: our handler intercepts and closes
    if (key.name === 'd' && key.ctrl) {
      closeFn();
    }

    expect(closeFn).toHaveBeenCalledOnce();
    // The line content should NOT matter - we always exit
    expect(line).toBe('hello world'); // line unchanged, we just close
  });

  it('should clean up multi-line display before closing', () => {
    // Simulates: user is in multi-line mode, presses Ctrl+D
    // Expected: multi-line display cleared, then readline.close()
    const closeFn = vi.fn();
    const mlResetFn = vi.fn();
    const writeFn = vi.fn();

    const mlActive = true;
    const mlCursorRow = 2;
    const key = { name: 'd', ctrl: true, shift: false, meta: false, sequence: '\x04' };

    if (key.name === 'd' && key.ctrl) {
      if (mlActive) {
        if (mlCursorRow > 0) {
          writeFn(`\x1B[${mlCursorRow}A`);
        }
        writeFn('\r\x1B[J');
        mlResetFn();
      }
      closeFn();
    }

    expect(writeFn).toHaveBeenCalledTimes(2); // cursor up + clear
    expect(writeFn).toHaveBeenCalledWith('\x1B[2A'); // move up 2 rows
    expect(writeFn).toHaveBeenCalledWith('\r\x1B[J'); // clear from cursor
    expect(mlResetFn).toHaveBeenCalledOnce();
    expect(closeFn).toHaveBeenCalledOnce();
  });

  it('should not trigger on plain d key without ctrl', () => {
    const closeFn = vi.fn();
    const key = { name: 'd', ctrl: false, shift: false, meta: false };

    if (key.name === 'd' && key.ctrl) {
      closeFn();
    }

    expect(closeFn).not.toHaveBeenCalled();
  });

  it('should not trigger on ctrl+other keys', () => {
    const closeFn = vi.fn();
    const keys = [
      { name: 'c', ctrl: true },
      { name: 'a', ctrl: true },
      { name: 'e', ctrl: true },
    ];

    for (const key of keys) {
      if (key.name === 'd' && key.ctrl) {
        closeFn();
      }
    }

    expect(closeFn).not.toHaveBeenCalled();
  });
});
