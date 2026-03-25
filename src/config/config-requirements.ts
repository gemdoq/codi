import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'process';
import { detectOsLocale, setLocale, getSupportedLocales, type Locale } from '../i18n/index.js';
import type { CodiConfig } from './config.js';

const isWindows = os.platform() === 'win32';

/**
 * A required config field definition.
 *
 * To add a new required field:
 * 1. Add an entry to REQUIRED_FIELDS below
 * 2. That's it — the repair wizard handles the rest automatically
 */
export interface ConfigRequirement {
  /** Unique identifier */
  id: string;
  /** Lower priority = prompted first (locale should be 0 so subsequent prompts use the right language) */
  priority: number;
  /** Check if this requirement is satisfied */
  isSatisfied: (config: CodiConfig) => boolean;
  /** Prompt the user for this value. Returns partial settings to merge into settings.json. */
  repair: (rl: readline.Interface) => Promise<Record<string, unknown>>;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Read raw settings.json to check if a field was explicitly set by the user
 * (as opposed to filled in by DEFAULT_CONFIG).
 */
function readRawSettings(): Record<string, unknown> {
  const home = process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();
  const paths = [
    path.join(home, '.codi', 'settings.json'),
    path.join(process.cwd(), '.codi', 'settings.json'),
    path.join(process.cwd(), '.codi', 'settings.local.json'),
  ];

  const merged: Record<string, unknown> = {};
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const content = JSON.parse(fs.readFileSync(p, 'utf-8'));
        Object.assign(merged, content);
      }
    } catch {
      // skip invalid files
    }
  }
  return merged;
}

// ── Required Fields ─────────────────────────────────────────────────

const VALID_LOCALES = new Set(['auto', ...getSupportedLocales()]);

export const REQUIRED_FIELDS: ConfigRequirement[] = [
  {
    id: 'locale',
    priority: 0,
    isSatisfied: (_config) => {
      // Check raw settings file, not merged config (which has default 'auto')
      const raw = readRawSettings();
      return typeof raw['locale'] === 'string' && raw['locale'] !== '' && VALID_LOCALES.has(raw['locale']);
    },
    repair: async (rl) => {
      // Locale prompt is always bilingual (we don't know the user's language yet)
      console.log('');
      console.log(chalk.bold('  Select your language / 언어를 선택하세요:'));
      console.log('');
      console.log(`  ${chalk.cyan('1.')} English`);
      console.log(`  ${chalk.cyan('2.')} 한국어 (Korean)`);
      console.log(`  ${chalk.cyan('3.')} Auto-detect / 자동 감지`);
      console.log('');

      const answer = await rl.question(chalk.cyan('  Choice / 선택 [3]: '));
      const trimmed = answer.trim() || '3';

      let locale: Locale;
      switch (trimmed) {
        case '1': locale = 'en'; break;
        case '2': locale = 'ko'; break;
        default:  locale = detectOsLocale(); break;
      }

      setLocale(locale);
      return { locale };
    },
  },
  {
    id: 'apiKey',
    priority: 1,
    isSatisfied: (config) => {
      // Satisfied if any API key exists (in config or environment)
      return !!(
        config.apiKeys?.openai ||
        config.apiKeys?.anthropic ||
        process.env['GEMINI_API_KEY'] ||
        process.env['OPENAI_API_KEY'] ||
        process.env['ANTHROPIC_API_KEY']
      );
    },
    repair: async (rl) => {
      // Minimal API key prompt (simpler than full setup wizard)
      console.log('');
      console.log(chalk.yellow('  ⚠ API key is missing / API 키가 없습니다'));
      console.log('');
      console.log(chalk.bold('  Select a provider / 제공자를 선택하세요:'));
      console.log('');
      console.log(`  ${chalk.cyan('1.')} Google Gemini`);
      console.log(`  ${chalk.cyan('2.')} OpenAI`);
      console.log(`  ${chalk.cyan('3.')} Anthropic (Claude)`);
      console.log(`  ${chalk.cyan('4.')} Ollama (no key needed / 키 불필요)`);
      console.log('');

      const choice = await rl.question(chalk.cyan('  Choice / 선택 [1]: '));
      const providerChoice = choice.trim() || '1';

      if (providerChoice === '4') {
        console.log(chalk.green('  ✓ Ollama — no API key required'));
        return {};
      }

      let keyName = 'openai';
      let signupUrl = '';
      let provider = 'openai';
      let model = 'gemini-2.5-flash';

      switch (providerChoice) {
        case '1':
          keyName = 'openai';
          signupUrl = 'https://aistudio.google.com/apikey';
          model = 'gemini-2.5-flash';
          break;
        case '2':
          keyName = 'openai';
          signupUrl = 'https://platform.openai.com/api-keys';
          model = 'gpt-4o';
          provider = 'openai';
          break;
        case '3':
          keyName = 'anthropic';
          signupUrl = 'https://console.anthropic.com/settings/keys';
          model = 'claude-sonnet-4-20250514';
          provider = 'anthropic';
          break;
      }

      if (signupUrl) {
        console.log(chalk.dim(`  → ${signupUrl}`));
        console.log('');
      }

      const apiKey = await rl.question(chalk.cyan('  API key: '));
      if (!apiKey.trim()) {
        const envHint = isWindows ? '$env:GEMINI_API_KEY="your-key"' : 'export GEMINI_API_KEY=your-key';
        console.log(chalk.yellow(`  Skipped. Set later: ${envHint}`));
        return {};
      }

      const result: Record<string, unknown> = {
        apiKeys: { [keyName]: apiKey.trim() },
      };

      // Set provider/model if not Gemini default
      if (providerChoice === '2') {
        result['provider'] = 'openai';
        result['model'] = model;
        result['baseUrls'] = {};
      } else if (providerChoice === '3') {
        result['provider'] = provider;
        result['model'] = model;
      }

      return result;
    },
  },
];

// ── Public API ──────────────────────────────────────────────────────

/**
 * Get list of missing required config fields.
 * Returns them sorted by priority (lowest first).
 */
export function getMissingFields(config: CodiConfig): ConfigRequirement[] {
  return REQUIRED_FIELDS
    .filter((req) => !req.isSatisfied(config))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Run the repair wizard for missing config fields.
 * Only prompts for fields that are actually missing.
 * Returns true if any changes were made.
 */
export async function runRepairWizard(missing: ConfigRequirement[]): Promise<boolean> {
  if (missing.length === 0) return false;

  const home = process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();
  const settingsDir = path.join(home, '.codi');
  const settingsPath = path.join(settingsDir, 'settings.json');

  console.log('');
  console.log(chalk.cyan.bold('  ╭──────────────────────────────────────╮'));
  console.log(chalk.cyan.bold('  │') + chalk.white.bold('  Codi — Configuration Required       ') + chalk.cyan.bold('│'));
  console.log(chalk.cyan.bold('  ╰──────────────────────────────────────╯'));

  const rl = readline.createInterface({ input, output });
  let changed = false;

  for (const field of missing) {
    try {
      const partial = await field.repair(rl);
      if (Object.keys(partial).length > 0) {
        // Merge into settings file
        let settings: Record<string, unknown> = {};
        if (fs.existsSync(settingsPath)) {
          try {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
          } catch {
            settings = {};
          }
        }

        // Deep merge for nested objects like apiKeys
        for (const [key, value] of Object.entries(partial)) {
          if (typeof value === 'object' && value !== null && !Array.isArray(value) &&
              typeof settings[key] === 'object' && settings[key] !== null) {
            settings[key] = { ...(settings[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
          } else {
            settings[key] = value;
          }
        }

        if (!fs.existsSync(settingsDir)) {
          fs.mkdirSync(settingsDir, { recursive: true });
        }
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        changed = true;
      }
    } catch {
      // User cancelled or error — continue to next field
    }
  }

  rl.close();

  if (changed) {
    console.log('');
    console.log(chalk.green('  ✓ Configuration updated / 설정이 업데이트되었습니다'));
    console.log('');
  }

  return changed;
}
