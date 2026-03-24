#!/usr/bin/env node

import chalk from 'chalk';
import { needsSetup, runSetupWizard } from './setup-wizard.js';
import { configManager } from './config/config.js';
import { Repl } from './repl.js';
import { agentLoop } from './agent/agent-loop.js';
import { Conversation } from './agent/conversation.js';
import { buildSystemPrompt, type PromptContext } from './agent/system-prompt.js';
import { tokenTracker } from './agent/token-tracker.js';
import { statusLine } from './ui/status-line.js';
import { ContextCompressor } from './agent/context-compressor.js';
import { memoryManager } from './agent/memory.js';
import { sessionManager } from './agent/session.js';
import { checkpointManager } from './agent/checkpoint.js';
import { loadCodiMd } from './agent/codi-md.js';
import { setMode, getMode } from './agent/mode-manager.js';
import { ToolRegistry } from './tools/registry.js';
import { checkPermission, setPermissionMode } from './security/permission-manager.js';
import { hookManager } from './hooks/hook-manager.js';
import { mcpManager } from './mcp/mcp-manager.js';
import { createSubAgentHandler } from './agent/sub-agent.js';
import { setSubAgentHandler } from './tools/sub-agent-tool.js';
import { stopSpinner } from './ui/spinner.js';
import { logger } from './utils/logger.js';
import { setLocale, detectOsLocale, getLocale, t, type Locale } from './i18n/index.js';
import {
  createBuiltinCommands,
  loadCustomCommands,
  type SlashCommandContext,
} from './config/slash-commands.js';

// Import all tools
import { fileReadTool } from './tools/file-read.js';
import { fileWriteTool } from './tools/file-write.js';
import { fileEditTool } from './tools/file-edit.js';
import { fileMultiEditTool } from './tools/file-multi-edit.js';
import { globTool } from './tools/glob.js';
import { grepTool } from './tools/grep.js';
import { bashTool } from './tools/bash.js';
import { listDirTool } from './tools/list-dir.js';
import { gitTool } from './tools/git.js';
import { webFetchTool } from './tools/web-fetch.js';
import { webSearchTool } from './tools/web-search.js';
import { notebookEditTool } from './tools/notebook-edit.js';
import { subAgentTool } from './tools/sub-agent-tool.js';
import { taskCreateTool, taskUpdateTool, taskListTool, taskGetTool } from './tools/task-tools.js';
import { askUserTool } from './tools/ask-user.js';
import { updateMemoryTool } from './tools/memory-tool.js';

// Import providers
import { AnthropicProvider } from './llm/anthropic.js';
import { OpenAIProvider } from './llm/openai.js';
import { OllamaProvider } from './llm/ollama.js';
import type { LlmProvider } from './llm/provider.js';

// ─── CLI Argument Parsing ────────────────────────────────────────────

interface CliArgs {
  model?: string;
  provider?: string;
  prompt?: string;
  continue?: boolean;
  resume?: string;
  help?: boolean;
  version?: boolean;
  plan?: boolean;
  yolo?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  let i = 2; // Skip node and script path

  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case '--model':
      case '-m':
        args.model = argv[++i];
        break;
      case '--provider':
        args.provider = argv[++i];
        break;
      case '-p':
        args.prompt = argv.slice(i + 1).join(' ');
        i = argv.length;
        break;
      case '-c':
      case '--continue':
        args.continue = true;
        break;
      case '-r':
      case '--resume':
        args.resume = argv[++i];
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      case '--plan':
        args.plan = true;
        break;
      case '--yolo':
        args.yolo = true;
        break;
      default:
        // Treat as prompt if no flag
        if (!arg.startsWith('-')) {
          args.prompt = argv.slice(i).join(' ');
          i = argv.length;
        }
        break;
    }
    i++;
  }

  return args;
}

function printHelp(): void {
  console.log(`
${chalk.cyan.bold('Codi (코디)')} - AI Code Agent for Terminal

${chalk.bold('Usage:')}
  codi [options] [prompt]

${chalk.bold('Options:')}
  -m, --model <model>    Set the model (default: gemini-2.5-flash)
  --provider <name>      Set the provider (openai, anthropic, ollama)
  -p <prompt>            Run a single prompt and exit
  -c, --continue         Continue the last session
  -r, --resume <id>      Resume a specific session
  --plan                 Start in plan mode (read-only)
  --yolo                 Skip all permission checks
  -h, --help             Show this help
  -v, --version          Show version

${chalk.bold('Environment:')}
  GEMINI_API_KEY         Google Gemini API key (default provider)
  OPENAI_API_KEY         OpenAI API key
  ANTHROPIC_API_KEY      Anthropic API key

${chalk.bold('Examples:')}
  codi                                   # Start interactive session
  codi -p "explain main.ts"              # Single prompt
  codi --provider anthropic              # Use Anthropic Claude
  codi --model gpt-4o --provider openai  # Use OpenAI GPT-4o
  codi -c                                # Continue last session
`);
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.version) {
    try {
      const { readFileSync } = await import('fs');
      const { fileURLToPath } = await import('url');
      const p = await import('path');
      const dir = p.dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(readFileSync(p.join(dir, '..', 'package.json'), 'utf-8'));
      console.log(`codi v${pkg.version}`);
    } catch {
      console.log('codi v0.1.8');
    }
    process.exit(0);
  }

  // First-time setup wizard
  if (await needsSetup()) {
    const result = await runSetupWizard();
    if (result) {
      // Reload config after setup
      configManager.reload();
    }
  }

  // Load config
  const config = configManager.get();
  const providerName = args.provider || config.provider;
  const modelName = args.model || config.model;

  // Initialize locale
  if (config.locale === 'auto') {
    setLocale(detectOsLocale());
  } else if (config.locale) {
    setLocale(config.locale as Locale);
  }

  // Create LLM provider
  let provider: LlmProvider;
  switch (providerName) {
    case 'anthropic':
      provider = new AnthropicProvider({
        apiKey: config.apiKeys.anthropic,
        model: modelName,
        maxTokens: config.maxTokens,
        baseUrl: config.baseUrls.anthropic,
      });
      break;
    case 'ollama':
      provider = new OllamaProvider({
        model: modelName,
        maxTokens: config.maxTokens,
        baseUrl: config.baseUrls.ollama,
      });
      break;
    case 'openai':
    default:
      provider = new OpenAIProvider({
        apiKey: config.apiKeys.openai || process.env['GEMINI_API_KEY'],
        model: modelName,
        maxTokens: config.maxTokens,
        baseUrl: config.baseUrls.openai,
      });
      break;
  }

  // Build fallback providers
  function createProviderFromConfig(pName: string, pModel: string): LlmProvider {
    switch (pName) {
      case 'anthropic':
        return new AnthropicProvider({
          apiKey: config.apiKeys.anthropic,
          model: pModel,
          maxTokens: config.maxTokens,
          baseUrl: config.baseUrls.anthropic,
        });
      case 'ollama':
        return new OllamaProvider({
          model: pModel,
          maxTokens: config.maxTokens,
          baseUrl: config.baseUrls.ollama,
        });
      case 'openai':
      default:
        return new OpenAIProvider({
          apiKey: config.apiKeys.openai || process.env['GEMINI_API_KEY'],
          model: pModel,
          maxTokens: config.maxTokens,
          baseUrl: config.baseUrls.openai,
        });
    }
  }

  const fallbackProviders: LlmProvider[] = config.fallbackModels.map(
    (fb) => createProviderFromConfig(fb.provider, fb.model)
  );

  // Setup token tracker
  tokenTracker.setModel(modelName);
  statusLine.update({ model: modelName, provider: providerName });

  // Setup tool registry
  const registry = new ToolRegistry();
  registry.registerAll([
    fileReadTool,
    fileWriteTool,
    fileEditTool,
    fileMultiEditTool,
    globTool,
    grepTool,
    bashTool,
    listDirTool,
    gitTool,
    webFetchTool,
    webSearchTool,
    notebookEditTool,
    subAgentTool,
    taskCreateTool,
    taskUpdateTool,
    taskListTool,
    taskGetTool,
    askUserTool,
    updateMemoryTool,
  ]);

  // Setup sub-agent handler
  const subAgentHandler = createSubAgentHandler(provider, registry);
  setSubAgentHandler(subAgentHandler);

  // Initialize MCP
  try {
    await mcpManager.initialize(registry);
  } catch {
    // MCP initialization failure is non-fatal
  }

  // Setup conversation
  const conversation = new Conversation();
  const compressor = new ContextCompressor({
    threshold: config.autoCompactThreshold,
  });

  // Load CODI.md and memory
  const codiMd = loadCodiMd();
  const memory = config.memoryEnabled ? memoryManager.buildMemoryPrompt() : '';

  function buildPrompt(): string {
    const context: PromptContext = {
      model: provider.model,
      provider: provider.name,
      cwd: process.cwd(),
      codiMd: codiMd || undefined,
      memory: memory || undefined,
      planMode: getMode() === 'plan',
      locale: getLocale(),
    };
    return buildSystemPrompt(context);
  }

  conversation.setSystemPrompt(buildPrompt());

  // Set permission mode
  if (args.yolo) {
    setPermissionMode('yolo');
  } else if (args.plan) {
    setPermissionMode('plan');
    setMode('plan');
    statusLine.update({ mode: 'plan' });
  }

  // Resume session if requested
  if (args.continue || args.resume) {
    const id = args.resume || sessionManager.getLatest()?.id;
    if (id) {
      const session = sessionManager.load(id);
      if (session) {
        const data = session.conversation.serialize();
        for (const msg of data.messages) {
          if (msg.role === 'user') conversation.addUserMessage(msg.content);
          else if (msg.role === 'assistant') conversation.addAssistantMessage(msg.content);
        }
        console.log(chalk.dim(`✓ ${t('cmd.resume.done', id, String(data.messages.length))}`));
      }
    }
  }

  // Run hooks - session start
  logger.info('세션 시작', { provider: providerName, model: modelName, cwd: process.cwd(), planMode: getMode() === 'plan', yolo: !!args.yolo });
  await hookManager.runHooks('SessionStart', { cwd: process.cwd() });

  // Interactive model selection (Mode B) — when rate limited with no fallback
  const interactiveModelSelect = async (): Promise<LlmProvider | null> => {
    const readline = await import('node:readline/promises');
    const { stdin, stdout } = await import('process');

    console.log(chalk.yellow(`\n${t('agent.selectModel.fetching')}`));

    // Collect available models from all configured providers
    const providerEntries: Array<{ providerName: string; model: string }> = [];

    const providers: Array<{ name: string; create: () => LlmProvider }> = [];
    if (config.apiKeys.openai || process.env['GEMINI_API_KEY']) {
      providers.push({ name: 'openai', create: () => createProviderFromConfig('openai', 'temp') });
    }
    if (config.apiKeys.anthropic) {
      providers.push({ name: 'anthropic', create: () => createProviderFromConfig('anthropic', 'temp') });
    }
    // Ollama — always try (local, no key needed)
    providers.push({ name: 'ollama', create: () => createProviderFromConfig('ollama', 'temp') });

    for (const p of providers) {
      try {
        const tmpProvider = p.create();
        const models = await tmpProvider.listModels();
        for (const m of models) {
          providerEntries.push({ providerName: p.name, model: m });
        }
      } catch {
        // Provider not available
      }
    }

    if (providerEntries.length === 0) {
      console.log(chalk.yellow(t('agent.selectModel.noModels')));
      return null;
    }

    console.log(chalk.bold(`\n${t('agent.selectModel.available')}\n`));
    for (let i = 0; i < providerEntries.length; i++) {
      const e = providerEntries[i]!;
      console.log(`  ${chalk.cyan(`${i + 1}.`)} ${e.providerName}/${e.model}`);
    }
    console.log('');

    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(chalk.cyan(`${t('agent.selectModel.prompt')} `));
    rl.close();

    const trimmed = answer.trim();
    if (!trimmed) {
      console.log(chalk.dim(t('agent.selectModel.cancelled')));
      return null;
    }

    const idx = parseInt(trimmed, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= providerEntries.length) {
      console.log(chalk.yellow(t('agent.selectModel.invalid')));
      return null;
    }

    const selected = providerEntries[idx]!;
    const newProvider = createProviderFromConfig(selected.providerName, selected.model);
    console.log(chalk.green(`✓ ${t('agent.selectModel.switched', selected.providerName, selected.model)}`));
    return newProvider;
  };

  const handleProviderSwitch = (newProvider: LlmProvider) => {
    provider = newProvider;
    tokenTracker.setModel(newProvider.model);
    statusLine.update({ model: newProvider.model, provider: newProvider.name });
    // Update sub-agent handler with new provider
    const newSubAgentHandler = createSubAgentHandler(newProvider, registry);
    setSubAgentHandler(newSubAgentHandler);
  };

  // Single prompt mode
  if (args.prompt) {
    await agentLoop(args.prompt, {
      provider,
      conversation,
      registry,
      systemPrompt: conversation.getSystemPrompt(),
      permissionCheck: checkPermission,
      preHook: async (toolName, input) => hookManager.runHooks('PreToolUse', { tool: toolName, args: input }),
      postHook: async (toolName, input, result) => { await hookManager.runHooks('PostToolUse', { tool: toolName, args: input, result }); },
      planMode: getMode() === 'plan',
      fallbackProviders: [...fallbackProviders],
      onProviderSwitch: handleProviderSwitch,
      interactiveModelSelect,
    });
    logger.info('세션 종료 (single prompt)');
    await hookManager.runHooks('SessionEnd', {});
    await mcpManager.disconnectAll();
    process.exit(0);
  }

  // Interactive REPL mode
  const slashCommands = [...createBuiltinCommands(), ...loadCustomCommands()];

  const cmdCtx: SlashCommandContext = {
    conversation,
    provider,
    compressor,
    exitFn: async () => {
      stopSpinner();
      console.log(chalk.dim(`\n${t('repl.saving')}...`));
      sessionManager.save(conversation, undefined, provider.model);
      await hookManager.runHooks('SessionEnd', {});
      await mcpManager.disconnectAll();
    },
    setProvider: (name: string, model: string) => {
      const newProvider = name || providerName;
      provider = createProviderFromConfig(newProvider, model);
      tokenTracker.setModel(model);
      statusLine.update({ model, provider: newProvider });
      const newSubAgentHandler = createSubAgentHandler(provider, registry);
      setSubAgentHandler(newSubAgentHandler);
    },
    reloadSystemPrompt: () => {
      conversation.setSystemPrompt(buildPrompt());
    },
  };

  const repl = new Repl({
    onMessage: async (message) => {
      // Create checkpoint before each turn
      const preview = typeof message === 'string'
        ? message.slice(0, 50)
        : (message.find((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')?.text?.slice(0, 50) || 'image');
      checkpointManager.create(conversation, preview);

      // Auto-compact if needed
      if (compressor.shouldCompress(conversation)) {
        console.log(chalk.dim(t('agent.autoCompact')));
        await compressor.compress(conversation, provider);
        conversation.setSystemPrompt(buildPrompt());
      }

      await agentLoop(message, {
        provider,
        conversation,
        registry,
        systemPrompt: conversation.getSystemPrompt(),
        permissionCheck: checkPermission,
        preHook: async (toolName, input) => hookManager.runHooks('PreToolUse', { tool: toolName, args: input }),
        postHook: async (toolName, input, result) => { await hookManager.runHooks('PostToolUse', { tool: toolName, args: input, result }); },
        planMode: getMode() === 'plan',
        fallbackProviders: [...fallbackProviders],
        onProviderSwitch: handleProviderSwitch,
        interactiveModelSelect,
      });
    },

    onSlashCommand: async (command: string, args: string): Promise<boolean> => {
      // Find matching command
      const cmd = slashCommands.find(
        (c) => c.name === command || c.aliases?.includes(command)
      );
      if (!cmd) return false;
      return cmd.handler(args, cmdCtx);
    },

    onInterrupt: () => {
      stopSpinner();
    },

    onExit: async () => {
      stopSpinner();
      logger.info('세션 종료 (REPL exit)');
      console.log(chalk.dim(`\n${t('repl.saving')}...`));
      sessionManager.save(conversation, undefined, provider.model);
      checkpointManager.cleanup();
      await hookManager.runHooks('SessionEnd', {});
      await mcpManager.disconnectAll();
    },
  });

  // SIGTERM (Docker, etc.)
  process.on('SIGTERM', async () => {
    stopSpinner();
    logger.info('세션 종료 (SIGTERM)');
    sessionManager.save(conversation, undefined, provider.model);
    await hookManager.runHooks('SessionEnd', {});
    await mcpManager.disconnectAll();
    process.exit(0);
  });

  await repl.start();
}

main().catch((err) => {
  logger.error('치명적 오류', {}, err instanceof Error ? err : new Error(String(err)));
  console.error(chalk.red(`Fatal error: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
