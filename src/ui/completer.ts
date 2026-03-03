import * as fs from 'fs';
import * as path from 'path';

const SLASH_COMMANDS = [
  '/help', '/quit', '/exit', '/clear', '/reset', '/new',
  '/model', '/compact', '/cost', '/config', '/permissions',
  '/diff', '/save', '/resume', '/continue', '/fork',
  '/plan', '/memory', '/init', '/export', '/tasks',
  '/status', '/context', '/rewind', '/mcp',
];

export function completer(line: string): [string[], string] {
  // Slash command completion
  if (line.startsWith('/')) {
    const matches = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(line));
    return [matches, line];
  }

  // File path completion (after @)
  if (line.includes('@')) {
    const atIndex = line.lastIndexOf('@');
    const partial = line.slice(atIndex + 1);
    const dir = path.dirname(partial) || '.';
    const base = path.basename(partial);

    try {
      const entries = fs.readdirSync(dir === '' ? '.' : dir);
      const matches = entries
        .filter((e) => e.startsWith(base))
        .map((e) => {
          const full = dir === '.' ? e : path.join(dir, e);
          try {
            return fs.statSync(full).isDirectory() ? full + '/' : full;
          } catch {
            return full;
          }
        })
        .map((p) => line.slice(0, atIndex + 1) + p);
      return [matches, line];
    } catch {
      return [[], line];
    }
  }

  return [[], line];
}
