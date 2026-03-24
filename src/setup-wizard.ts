import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'process';
import { setLocale, detectOsLocale, t, type Locale } from './i18n/index.js';

const isWindows = os.platform() === 'win32';

const SETTINGS_DIR = path.join(
  process.env['HOME'] || process.env['USERPROFILE'] || os.homedir(),
  '.codi'
);
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

interface SetupResult {
  apiKey: string;
  provider: string;
}

export async function needsSetup(): Promise<boolean> {
  // Check if any API key is available
  if (process.env['GEMINI_API_KEY']) return false;
  if (process.env['OPENAI_API_KEY']) return false;
  if (process.env['ANTHROPIC_API_KEY']) return false;

  // Check settings file
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const content = fs.readFileSync(SETTINGS_PATH, 'utf-8');
      const settings = JSON.parse(content);
      if (settings.apiKeys?.openai || settings.apiKeys?.anthropic) {
        return false;
      }
    } catch {
      // Invalid settings file
    }
  }

  return true;
}

export async function runSetupWizard(): Promise<SetupResult | null> {
  const rl = readline.createInterface({ input, output });

  console.log('');
  console.log(chalk.cyan.bold('  ╭─────────────────────────────────────╮'));
  console.log(chalk.cyan.bold('  │') + chalk.white.bold('     Codi (코디) - First Time Setup   ') + chalk.cyan.bold('│'));
  console.log(chalk.cyan.bold('  ╰─────────────────────────────────────╯'));
  console.log('');

  // ── Language selection (always shown in both languages) ──
  console.log(chalk.bold('  Select your language / 언어를 선택하세요:'));
  console.log('');
  console.log(`  ${chalk.cyan('1.')} English`);
  console.log(`  ${chalk.cyan('2.')} 한국어 (Korean)`);
  console.log(`  ${chalk.cyan('3.')} Auto-detect / 자동 감지`);
  console.log('');

  const langChoice = await rl.question(chalk.cyan('  Choice / 선택 [3]: '));
  const langTrimmed = langChoice.trim() || '3';

  let selectedLocale: Locale;
  switch (langTrimmed) {
    case '1':
      selectedLocale = 'en';
      break;
    case '2':
      selectedLocale = 'ko';
      break;
    case '3':
    default:
      selectedLocale = detectOsLocale();
      break;
  }
  setLocale(selectedLocale);

  // From here on, use t() for all messages
  console.log('');
  console.log(chalk.dim(`  ${t('setup.noKey')}`));
  console.log('');

  // Provider selection
  console.log(chalk.bold(`  ${t('setup.selectProvider')}`));
  console.log('');
  console.log(`  ${chalk.cyan('1.')} ${t('setup.gemini')} ${chalk.green(t('setup.gemini.tag'))}`);
  console.log(`  ${chalk.cyan('2.')} ${t('setup.openai')}`);
  console.log(`  ${chalk.cyan('3.')} ${t('setup.anthropic')}`);
  console.log(`  ${chalk.cyan('4.')} ${t('setup.ollama')} ${chalk.green(t('setup.ollama.tag'))}`);
  console.log('');

  const choice = await rl.question(chalk.cyan(`  ${t('setup.choice', '1')}`));
  const providerChoice = choice.trim() || '1';

  let provider = 'openai';
  let envVarName = 'GEMINI_API_KEY';
  let keyName = 'openai';
  let signupUrl = '';
  let model = 'gemini-2.5-flash';

  switch (providerChoice) {
    case '1':
      provider = 'openai';
      envVarName = 'GEMINI_API_KEY';
      keyName = 'openai';
      signupUrl = 'https://aistudio.google.com/apikey';
      model = 'gemini-2.5-flash';
      break;
    case '2':
      provider = 'openai';
      envVarName = 'OPENAI_API_KEY';
      keyName = 'openai';
      signupUrl = 'https://platform.openai.com/api-keys';
      model = 'gpt-4o';
      break;
    case '3':
      provider = 'anthropic';
      envVarName = 'ANTHROPIC_API_KEY';
      keyName = 'anthropic';
      signupUrl = 'https://console.anthropic.com/settings/keys';
      model = 'claude-sonnet-4-20250514';
      break;
    case '4':
      console.log('');
      console.log(chalk.green(`  ✓ ${t('setup.ollama.selected')}`));
      console.log(chalk.dim(`  ${t('setup.ollama.hint1')}`));
      console.log(chalk.dim(`  ${t('setup.ollama.hint2')}`));
      console.log('');
      console.log(chalk.dim(`  ${t('setup.ollama.start')}`));
      console.log(chalk.cyan('    codi --provider ollama --model llama3.1'));
      console.log('');
      saveLocale(selectedLocale);
      rl.close();
      return null;
    default:
      console.log(chalk.yellow(`  ${t('setup.invalidChoice')}`));
      break;
  }

  // API key input
  if (signupUrl) {
    console.log('');
    console.log(chalk.bold(`  ${t('setup.getKey')}`));
    console.log(chalk.cyan(`  → ${signupUrl}`));
    console.log('');
  }

  const apiKey = await rl.question(chalk.cyan(`  ${t('setup.pasteKey')}`));
  rl.close();

  if (!apiKey.trim()) {
    console.log(chalk.yellow(`\n  ${t('setup.noKeyProvided')}`));
    const laterCmd = isWindows
      ? `$env:${envVarName}="your-key"`
      : `export ${envVarName}=your-key`;
    console.log(chalk.dim(`  ${t('setup.setLater', laterCmd)}\n`));
    saveLocale(selectedLocale);
    return null;
  }

  // Save method selection
  const rl2 = readline.createInterface({ input, output });
  console.log('');
  console.log(chalk.bold(`  ${t('setup.saveMethod')}`));
  console.log('');
  console.log(`  ${chalk.cyan('1.')} ${t('setup.saveFile')} ${chalk.green(t('setup.saveFile.tag'))}`);
  console.log(`  ${chalk.cyan('2.')} ${t('setup.saveManual')}`);
  console.log('');

  const saveChoice = await rl2.question(chalk.cyan(`  ${t('setup.choice', '1')}`));
  rl2.close();

  const trimmedKey = apiKey.trim();

  if (saveChoice.trim() === '2') {
    console.log('');
    if (isWindows) {
      console.log(chalk.bold(`  ${t('setup.win.permanent')}`));
      console.log('');
      console.log(chalk.cyan(`    [System.Environment]::SetEnvironmentVariable('${envVarName}', '${trimmedKey}', 'User')`));
      console.log('');
      console.log(chalk.dim(`  ${t('setup.win.temporary')}`));
      console.log(chalk.cyan(`    $env:${envVarName}="${trimmedKey}"`));
    } else {
      console.log(chalk.bold(`  ${t('setup.unix.profile')}`));
      console.log('');
      console.log(chalk.cyan(`    export ${envVarName}=${trimmedKey}`));
      console.log('');
      console.log(chalk.dim(`  ${t('setup.unix.reload')}`));
    }
    console.log('');
    saveLocale(selectedLocale);
    return { apiKey: trimmedKey, provider };
  }

  // Save to settings file
  try {
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      try {
        settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      } catch {
        settings = {};
      }
    }

    if (!settings['apiKeys'] || typeof settings['apiKeys'] !== 'object') {
      settings['apiKeys'] = {};
    }
    (settings['apiKeys'] as Record<string, string>)[keyName] = trimmedKey;

    // Save locale
    settings['locale'] = selectedLocale;

    if (providerChoice === '2') {
      settings['provider'] = 'openai';
      settings['model'] = model;
      settings['baseUrls'] = {};
    } else if (providerChoice === '3') {
      settings['provider'] = 'anthropic';
      settings['model'] = model;
    }

    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');

    console.log('');
    console.log(chalk.green(`  ✓ ${t('setup.saved')}`));
    console.log(chalk.dim(`  ${t('setup.providerModel', provider, model)}`));
    console.log('');
  } catch (err) {
    console.log(chalk.red(`\n  ${t('setup.saveFailed', String(err))}`));
    const manualCmd = isWindows
      ? `$env:${envVarName}="${trimmedKey}"`
      : `export ${envVarName}=${trimmedKey}`;
    console.log(chalk.dim(`  ${t('setup.setManually', manualCmd)}\n`));
  }

  return { apiKey: trimmedKey, provider };
}

/**
 * Save locale to settings file (for cases where we don't save the full settings).
 */
function saveLocale(locale: Locale): void {
  try {
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }

    let settings: Record<string, unknown> = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      try {
        settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      } catch {
        settings = {};
      }
    }

    settings['locale'] = locale;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  } catch {
    // Non-fatal
  }
}
