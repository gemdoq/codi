import * as fs from 'fs';
import * as path from 'path';

/**
 * Load CODI.md files hierarchically from CWD up to root,
 * plus CODI.local.md and .codi/rules/*.
 */
export function loadCodiMd(): string {
  const fragments: string[] = [];
  let dir = process.cwd();
  const root = path.parse(dir).root;

  // Walk up directories
  while (dir !== root) {
    loadFromDir(dir, fragments);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return fragments.join('\n\n---\n\n');
}

function loadFromDir(dir: string, fragments: string[]): void {
  // CODI.md
  const codiPath = path.join(dir, 'CODI.md');
  if (fs.existsSync(codiPath)) {
    try {
      let content = fs.readFileSync(codiPath, 'utf-8');
      content = processImports(content, dir);
      fragments.push(`[CODI.md from ${dir}]\n${content}`);
    } catch {
      // Skip unreadable files
    }
  }

  // CODI.local.md (local overrides, gitignored)
  const localPath = path.join(dir, 'CODI.local.md');
  if (fs.existsSync(localPath)) {
    try {
      const content = fs.readFileSync(localPath, 'utf-8');
      fragments.push(`[CODI.local.md from ${dir}]\n${content}`);
    } catch {
      // Skip
    }
  }

  // .codi/rules/*.md
  const rulesDir = path.join(dir, '.codi', 'rules');
  if (fs.existsSync(rulesDir)) {
    try {
      const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md')).sort();
      for (const file of files) {
        const content = fs.readFileSync(path.join(rulesDir, file), 'utf-8');
        fragments.push(`[Rule: ${file}]\n${content}`);
      }
    } catch {
      // Skip
    }
  }
}

/**
 * Process @path/to/import directives in CODI.md
 */
function processImports(content: string, baseDir: string): string {
  return content.replace(/@([\w./-]+)/g, (match, importPath) => {
    const resolved = path.resolve(baseDir, importPath);
    if (fs.existsSync(resolved)) {
      try {
        return fs.readFileSync(resolved, 'utf-8');
      } catch {
        return match;
      }
    }
    return match;
  });
}
