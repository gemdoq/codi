import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'process';

const SETTINGS_DIR = path.join(
  process.env['HOME'] || process.env['USERPROFILE'] || '~',
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
  console.log(chalk.dim('  API key not found. Let\'s set one up!'));
  console.log('');

  // Provider selection
  console.log(chalk.bold('  Which AI provider would you like to use?'));
  console.log('');
  console.log(`  ${chalk.cyan('1.')} Google Gemini ${chalk.green('(Free tier available)')}`);
  console.log(`  ${chalk.cyan('2.')} OpenAI (GPT-4o, etc.)`);
  console.log(`  ${chalk.cyan('3.')} Anthropic (Claude)`);
  console.log(`  ${chalk.cyan('4.')} Ollama ${chalk.green('(Free, local)')}`);
  console.log('');

  const choice = await rl.question(chalk.cyan('  Choice [1]: '));
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
      console.log(chalk.green('  ✓ Ollama selected! No API key needed.'));
      console.log(chalk.dim('  Make sure Ollama is running: ollama serve'));
      console.log(chalk.dim('  And pull a model: ollama pull llama3.1'));
      console.log('');
      console.log(chalk.dim('  Start Codi with:'));
      console.log(chalk.cyan('    codi --provider ollama --model llama3.1'));
      console.log('');
      rl.close();
      return null;
    default:
      console.log(chalk.yellow('  Invalid choice. Using Gemini (default).'));
      break;
  }

  // API key input
  if (signupUrl) {
    console.log('');
    console.log(chalk.bold('  Get your API key:'));
    console.log(chalk.cyan(`  → ${signupUrl}`));
    console.log('');
  }

  const apiKey = await rl.question(chalk.cyan('  Paste your API key: '));
  rl.close();

  if (!apiKey.trim()) {
    console.log(chalk.yellow('\n  No API key provided. Setup cancelled.'));
    console.log(chalk.dim(`  You can set it later: export ${envVarName}=your-key\n`));
    return null;
  }

  // Save method selection
  const rl2 = readline.createInterface({ input, output });
  console.log('');
  console.log(chalk.bold('  How would you like to save it?'));
  console.log('');
  console.log(`  ${chalk.cyan('1.')} Save to ~/.codi/settings.json ${chalk.green('(Recommended)')}`);
  console.log(`  ${chalk.cyan('2.')} Show export command (manual setup)`);
  console.log('');

  const saveChoice = await rl2.question(chalk.cyan('  Choice [1]: '));
  rl2.close();

  const trimmedKey = apiKey.trim();

  if (saveChoice.trim() === '2') {
    console.log('');
    console.log(chalk.bold('  Add this to your shell profile (~/.zshrc or ~/.bashrc):'));
    console.log('');
    console.log(chalk.cyan(`    export ${envVarName}=${trimmedKey}`));
    console.log('');
    console.log(chalk.dim('  Then restart your terminal or run: source ~/.zshrc'));
    console.log('');
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
    console.log(chalk.green('  ✓ Settings saved to ~/.codi/settings.json'));
    console.log(chalk.dim(`  Provider: ${provider} | Model: ${model}`));
    console.log('');
  } catch (err) {
    console.log(chalk.red(`\n  Failed to save settings: ${err}`));
    console.log(chalk.dim(`  Set manually: export ${envVarName}=${trimmedKey}\n`));
  }

  return { apiKey: trimmedKey, provider };
}
