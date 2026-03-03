import * as fs from 'fs';
import * as path from 'path';

const allowedDirs: Set<string> = new Set();

export function addAllowedDir(dir: string): void {
  allowedDirs.add(path.resolve(dir));
}

export function validatePath(filePath: string): { valid: boolean; resolved: string; error?: string } {
  const resolved = path.resolve(filePath);

  // Check if path is within CWD or allowed directories
  const cwd = process.cwd();
  const isInCwd = resolved.startsWith(cwd + path.sep) || resolved === cwd;
  const isInAllowed = [...allowedDirs].some(
    (dir) => resolved.startsWith(dir + path.sep) || resolved === dir
  );

  // Allow home directory config paths
  const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
  const isInCodiConfig = home && resolved.startsWith(path.join(home, '.codi'));

  if (!isInCwd && !isInAllowed && !isInCodiConfig) {
    return {
      valid: false,
      resolved,
      error: `Path '${resolved}' is outside the working directory. CWD: ${cwd}`,
    };
  }

  // Follow symlinks and re-validate
  try {
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      const realIsValid =
        real.startsWith(cwd + path.sep) ||
        real === cwd ||
        [...allowedDirs].some((d) => real.startsWith(d + path.sep) || real === d) ||
        (home && real.startsWith(path.join(home, '.codi')));

      if (!realIsValid) {
        return {
          valid: false,
          resolved: real,
          error: `Symlink target '${real}' is outside allowed directories.`,
        };
      }
    }
  } catch {
    // File doesn't exist yet or can't resolve - that's fine for creation
  }

  return { valid: true, resolved };
}
