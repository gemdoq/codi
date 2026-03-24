import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { tokenTracker } from '../agent/token-tracker.js';
import { sessionManager } from '../agent/session.js';
import { memoryManager } from '../agent/memory.js';
import { checkpointManager } from '../agent/checkpoint.js';
import { setMode, getMode } from '../agent/mode-manager.js';
import { statusLine } from '../ui/status-line.js';
import { mcpManager } from '../mcp/mcp-manager.js';
import { configManager } from './config.js';
import { t } from '../i18n/index.js';
import { setLocale, getLocale, getLocaleDisplayName, getSupportedLocales, type Locale } from '../i18n/index.js';
import type { Conversation } from '../agent/conversation.js';
import type { LlmProvider } from '../llm/provider.js';
import type { ContextCompressor } from '../agent/context-compressor.js';

export interface SlashCommandContext {
  conversation: Conversation;
  provider: LlmProvider;
  compressor: ContextCompressor;
  setProvider: (name: string, model: string) => void;
  reloadSystemPrompt: () => void;
  exitFn?: () => Promise<void>;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  handler: (args: string, ctx: SlashCommandContext) => Promise<boolean>;
}

export function createBuiltinCommands(): SlashCommand[] {
  return [
    {
      name: '/help',
      description: 'Show available commands',
      handler: async () => {
        const commands = createBuiltinCommands();
        console.log(chalk.bold(`\n${t('cmd.help.title')}\n`));
        for (const cmd of commands) {
          const aliases = cmd.aliases ? chalk.dim(` (${cmd.aliases.join(', ')})`) : '';
          console.log(`  ${chalk.cyan(cmd.name)}${aliases} - ${cmd.description}`);
        }
        console.log('');
        console.log(chalk.dim(`  ${t('cmd.help.prefixes')}`));
        console.log(chalk.dim(`  ${t('cmd.help.multiline')}`));
        console.log('');
        return true;
      },
    },
    {
      name: '/quit',
      aliases: ['/exit'],
      description: 'Exit Codi',
      handler: async (_args, ctx) => {
        if (ctx.exitFn) {
          await ctx.exitFn();
        }
        console.log(chalk.dim(`\n${t('cmd.quit.bye')}\n`));
        process.exit(0);
      },
    },
    {
      name: '/clear',
      aliases: ['/reset', '/new'],
      description: 'Clear conversation history',
      handler: async (_args, ctx) => {
        ctx.conversation.clear();
        ctx.reloadSystemPrompt();
        console.log(chalk.green(`✓ ${t('cmd.clear.done')}`));
        return true;
      },
    },
    {
      name: '/model',
      description: 'Switch model or provider (e.g., /model gpt-4o, /model ollama:llama3.1)',
      handler: async (args, ctx) => {
        if (!args) {
          const info = statusLine.getInfo();
          console.log(chalk.cyan(t('cmd.model.current', info.model, info.provider)));
          return true;
        }

        if (args.includes(':')) {
          const [provider, model] = args.split(':');
          ctx.setProvider(provider!, model!);
        } else {
          ctx.setProvider('', args);
        }
        console.log(chalk.green(`✓ ${t('cmd.model.switched', args)}`));
        return true;
      },
    },
    {
      name: '/compact',
      description: 'Compress conversation history (optional: focus hint)',
      handler: async (args, ctx) => {
        console.log(chalk.dim(t('cmd.compact.compressing')));
        await ctx.compressor.compress(ctx.conversation, ctx.provider, args || undefined);
        ctx.reloadSystemPrompt();
        console.log(chalk.green(`✓ ${t('cmd.compact.done')}`));
        return true;
      },
    },
    {
      name: '/cost',
      description: 'Show token usage and cost',
      handler: async () => {
        const session = tokenTracker.getSessionStats();
        const total = tokenTracker.getStats();

        console.log(chalk.bold(`\n${t('cmd.cost.title')}\n`));

        // Session stats
        console.log(chalk.cyan(`  ${t('cmd.cost.session')}`));
        console.log(`    ${t('cmd.cost.requests', String(session.requests))}`);
        console.log(`    ${t('cmd.cost.input', formatTokens(session.inputTokens))}`);
        console.log(`    ${t('cmd.cost.output', formatTokens(session.outputTokens))}`);
        console.log(`    ${t('cmd.cost.total', formatTokens(session.totalTokens))}`);
        console.log(`    ${t('cmd.cost.cost', session.cost.toFixed(4))}`);
        if (session.requests > 0) {
          console.log(`    ${t('cmd.cost.avg', session.avgCostPerRequest.toFixed(4))}`);
        }
        if (session.lastRequestCost) {
          console.log(chalk.dim(`    ${t('cmd.cost.last', session.lastRequestCost.cost.toFixed(4), formatTokens(session.lastRequestCost.inputTokens), formatTokens(session.lastRequestCost.outputTokens))}`));
        }

        // Total stats (only show if different from session)
        if (total.requests !== session.requests) {
          console.log('');
          console.log(chalk.cyan(`  ${t('cmd.cost.accumulated')}`));
          console.log(`    ${t('cmd.cost.requests', String(total.requests))}`);
          console.log(`    ${t('cmd.cost.input', formatTokens(total.inputTokens))}`);
          console.log(`    ${t('cmd.cost.output', formatTokens(total.outputTokens))}`);
          console.log(`    ${t('cmd.cost.total', formatTokens(total.totalTokens))}`);
          console.log(`    ${t('cmd.cost.cost', total.cost.toFixed(4))}`);
        }

        console.log('');
        return true;
      },
    },
    {
      name: '/config',
      description: 'Show current configuration',
      handler: async () => {
        const config = configManager.get();
        console.log(chalk.bold(`\n${t('cmd.config.title')}\n`));
        console.log(chalk.dim(JSON.stringify(config, null, 2)));
        console.log(chalk.dim(`\n${t('cmd.config.files', configManager.getConfigPaths().join(', ') || t('cmd.config.none'))}`));
        console.log('');
        return true;
      },
    },
    {
      name: '/permissions',
      description: 'Show permission rules',
      handler: async () => {
        const config = configManager.get();
        console.log(chalk.bold(`\n${t('cmd.permissions.title')}\n`));
        console.log(chalk.green(`  ${t('cmd.permissions.allow')}`) + config.permissions.allow.join(', '));
        console.log(chalk.red(`  ${t('cmd.permissions.deny')}`) + (config.permissions.deny.join(', ') || t('cmd.config.none')));
        console.log(chalk.yellow(`  ${t('cmd.permissions.ask')}`) + config.permissions.ask.join(', '));
        console.log('');
        return true;
      },
    },
    {
      name: '/save',
      description: 'Save current session',
      handler: async (args, ctx) => {
        const name = args || undefined;
        const id = sessionManager.save(ctx.conversation, name, statusLine.getInfo().model);
        console.log(chalk.green(`✓ ${t('cmd.save.done', id)}`));
        return true;
      },
    },
    {
      name: '/resume',
      aliases: ['/continue'],
      description: 'Resume a saved session',
      handler: async (args, ctx) => {
        const id = args || sessionManager.getLatest()?.id;
        if (!id) {
          console.log(chalk.yellow(t('cmd.resume.noSessions')));
          return true;
        }

        const session = sessionManager.load(id);
        if (!session) {
          console.log(chalk.red(t('cmd.resume.notFound', id)));
          return true;
        }

        // Replace current conversation
        const data = session.conversation.serialize();
        ctx.conversation.clear();
        ctx.conversation.setSystemPrompt(data.systemPrompt);
        for (const msg of data.messages) {
          if (msg.role === 'user') ctx.conversation.addUserMessage(msg.content);
          else if (msg.role === 'assistant') ctx.conversation.addAssistantMessage(msg.content);
        }

        console.log(chalk.green(`✓ ${t('cmd.resume.done', id, String(session.meta.messageCount))}`));
        return true;
      },
    },
    {
      name: '/fork',
      description: 'Fork current conversation into a new session',
      handler: async (args, ctx) => {
        const name = args || `fork-${Date.now()}`;
        const id = sessionManager.save(ctx.conversation, name, statusLine.getInfo().model);
        console.log(chalk.green(`✓ ${t('cmd.fork.done', id)}`));
        return true;
      },
    },
    {
      name: '/plan',
      description: 'Toggle plan mode (read-only analysis)',
      handler: async () => {
        const current = getMode();
        const newMode = current === 'plan' ? 'execute' : 'plan';
        setMode(newMode);
        statusLine.update({ mode: newMode });
        const modeLabel = newMode === 'plan' ? t('cmd.plan.plan') : t('cmd.plan.execute');
        console.log(chalk.cyan(t('cmd.plan.mode', modeLabel)));
        return true;
      },
    },
    {
      name: '/memory',
      description: 'Show or edit auto memory',
      handler: async () => {
        const index = memoryManager.loadIndex();
        const topics = memoryManager.listTopics();

        console.log(chalk.bold(`\n${t('cmd.memory.title')}\n`));
        console.log(chalk.dim(`${t('cmd.memory.dir', memoryManager.getMemoryDir())}`));

        if (index) {
          console.log(chalk.dim(`\n${t('cmd.memory.index')}`));
          console.log(index);
        } else {
          console.log(chalk.dim(`\n${t('cmd.memory.empty')}`));
        }

        if (topics.length > 0) {
          console.log(chalk.dim(`\n${t('cmd.memory.topics', topics.join(', '))}`));
        }
        console.log('');
        return true;
      },
    },
    {
      name: '/init',
      description: 'Initialize CODI.md in the current project',
      handler: async () => {
        const codiPath = path.join(process.cwd(), 'CODI.md');
        if (fs.existsSync(codiPath)) {
          console.log(chalk.yellow(t('cmd.init.exists')));
          return true;
        }

        const content = `# Project: ${path.basename(process.cwd())}

## Overview
<!-- Describe your project here -->

## Architecture
<!-- Key architectural decisions -->

## Development
<!-- Development guidelines, commands, etc. -->

## Conventions
<!-- Code style, naming conventions, etc. -->
`;
        fs.writeFileSync(codiPath, content, 'utf-8');
        console.log(chalk.green(`✓ ${t('cmd.init.done')}`));
        return true;
      },
    },
    {
      name: '/export',
      description: 'Export conversation to a file',
      handler: async (args, ctx) => {
        const filePath = args || `conversation-${Date.now()}.md`;
        const messages = ctx.conversation.getMessages();

        let md = `# Codi Conversation Export\n\nDate: ${new Date().toISOString()}\n\n---\n\n`;
        for (const msg of messages) {
          const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Codi' : 'System';
          const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
          md += `## ${role}\n\n${content}\n\n---\n\n`;
        }

        fs.writeFileSync(filePath, md, 'utf-8');
        console.log(chalk.green(`✓ ${t('cmd.export.done', filePath)}`));
        return true;
      },
    },
    {
      name: '/tasks',
      description: 'Show task list',
      handler: async () => {
        const { taskManager } = await import('../tools/task-tools.js');
        const tasks = taskManager.list();
        if (tasks.length === 0) {
          console.log(chalk.dim(`\n${t('cmd.tasks.empty')}\n`));
          return true;
        }
        console.log(chalk.bold(`\n${t('cmd.tasks.title')}\n`));
        for (const task of tasks) {
          const statusIcon = task.status === 'completed' ? chalk.green('✓') :
            task.status === 'in_progress' ? chalk.yellow('⟳') : chalk.dim('○');
          console.log(`  ${statusIcon} #${task.id} ${task.subject} [${task.status}]`);
        }
        console.log('');
        return true;
      },
    },
    {
      name: '/status',
      description: 'Show system status',
      handler: async () => {
        const config = configManager.get();
        const info = statusLine.getInfo();
        const mcpServers = mcpManager.listServers();

        console.log(chalk.bold(`\n${t('cmd.status.title')}\n`));
        console.log(`  Version:  0.1.0`);
        console.log(`  Model:    ${info.model}`);
        console.log(`  Provider: ${config.provider}`);
        console.log(`  Mode:     ${getMode()}`);
        console.log(`  Locale:   ${getLocale()}`);
        console.log(`  Tokens:   ${tokenTracker.format()}`);
        console.log(`  MCP:      ${mcpServers.length} server(s)`);
        for (const s of mcpServers) {
          console.log(`    - ${s.name} (${s.tools.length} tools)`);
        }
        console.log('');
        return true;
      },
    },
    {
      name: '/context',
      description: 'Show context window usage',
      handler: async (_args, ctx) => {
        const estimated = ctx.conversation.estimateTokens();
        const max = 200_000;
        const pct = Math.round((estimated / max) * 100);
        const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));

        console.log(chalk.bold(`\n${t('cmd.context.title')}\n`));
        console.log(`  ${bar} ${pct}%`);
        console.log(`  ${t('cmd.context.tokens', estimated.toLocaleString(), max.toLocaleString())}`);
        console.log(`  ${t('cmd.context.messages', String(ctx.conversation.getMessageCount()))}`);
        console.log('');
        return true;
      },
    },
    {
      name: '/rewind',
      description: 'Rewind to a previous checkpoint',
      handler: async (_args, ctx) => {
        const checkpoints = checkpointManager.list();
        if (checkpoints.length === 0) {
          console.log(chalk.yellow(t('cmd.rewind.noCheckpoints')));
          return true;
        }

        const result = checkpointManager.rewind();
        if (!result) {
          console.log(chalk.yellow(t('cmd.rewind.nothing')));
          return true;
        }

        // Restore conversation
        const data = result.conversation.serialize();
        ctx.conversation.clear();
        ctx.conversation.setSystemPrompt(data.systemPrompt);
        for (const msg of data.messages) {
          if (msg.role === 'user') ctx.conversation.addUserMessage(msg.content);
          else if (msg.role === 'assistant') ctx.conversation.addAssistantMessage(msg.content);
        }

        console.log(chalk.green(`✓ ${t('cmd.rewind.done', result.description ? `: ${result.description}` : '')}`));
        return true;
      },
    },
    {
      name: '/diff',
      description: 'Show git diff of current changes',
      handler: async () => {
        try {
          const { execSync } = await import('child_process');
          const diff = execSync('git diff', { encoding: 'utf-8', cwd: process.cwd() });
          if (!diff.trim()) {
            console.log(chalk.dim(`\n${t('cmd.diff.noChanges')}\n`));
          } else {
            const { renderDiff } = await import('../ui/renderer.js');
            console.log('\n' + renderDiff('', '', diff) + '\n');
          }
        } catch {
          console.log(chalk.yellow(t('cmd.diff.notGit')));
        }
        return true;
      },
    },
    {
      name: '/commit',
      description: 'Generate commit message and commit with AI',
      handler: async (_args, ctx) => {
        const { execSync } = await import('child_process');
        try {
          const staged = execSync('git diff --cached', { encoding: 'utf-8', cwd: process.cwd() });
          const unstaged = execSync('git diff', { encoding: 'utf-8', cwd: process.cwd() });

          if (!staged.trim() && unstaged.trim()) {
            const untracked = execSync('git ls-files --others --exclude-standard', {
              encoding: 'utf-8',
              cwd: process.cwd(),
            }).trim();

            if (untracked) {
              console.log(chalk.yellow(`\n${t('cmd.commit.untracked')}`));
              for (const f of untracked.split('\n').slice(0, 10)) {
                console.log(chalk.dim(`  ${f}`));
              }
              if (untracked.split('\n').length > 10) {
                console.log(chalk.dim(`  ${t('cmd.commit.andMore', String(untracked.split('\n').length - 10))}`));
              }
              console.log('');
            }

            console.log(chalk.dim(t('cmd.commit.autoStaging')));
            execSync('git add -u', { encoding: 'utf-8', cwd: process.cwd() });
          }

          const finalDiff = execSync('git diff --cached', { encoding: 'utf-8', cwd: process.cwd() });
          if (!finalDiff.trim()) {
            console.log(chalk.dim(`\n${t('cmd.commit.noChanges')}\n`));
            return true;
          }

          let conventionHint = '';
          try {
            const recentLog = execSync('git log --oneline -10', {
              encoding: 'utf-8',
              cwd: process.cwd(),
            }).trim();

            if (recentLog) {
              const conventionalPattern = /^[a-f0-9]+\s+(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\(.+\))?[!]?:/;
              const lines = recentLog.split('\n');
              const conventionalCount = lines.filter((l) => conventionalPattern.test(l)).length;

              if (conventionalCount >= 3) {
                conventionHint = `\n\n이 프로젝트는 Conventional Commits 형식을 사용합니다 (예: feat:, fix:, chore: 등). 같은 형식을 따라주세요.`;
              }

              conventionHint += `\n\n최근 커밋 참고:\n\`\`\`\n${recentLog}\n\`\`\``;
            }
          } catch {
            // ignore
          }

          ctx.conversation.addUserMessage(
            `다음 git diff를 분석해서 적절한 커밋 메시지를 생성하고, git 도구로 커밋해줘. 이미 스테이징 완료되었으므로 add 없이 commit만 하면 됩니다.${conventionHint}\n\n\`\`\`diff\n${finalDiff}\n\`\`\``
          );
          return false;
        } catch {
          console.log(chalk.yellow(t('cmd.diff.notGit')));
          return true;
        }
      },
    },
    {
      name: '/review',
      description: 'AI code review of current changes',
      handler: async (_args, ctx) => {
        const { execSync } = await import('child_process');
        try {
          const staged = execSync('git diff --cached', { encoding: 'utf-8', cwd: process.cwd() });
          const unstaged = execSync('git diff', { encoding: 'utf-8', cwd: process.cwd() });
          const diff = staged + unstaged;
          if (!diff.trim()) {
            console.log(chalk.dim(`\n${t('cmd.review.noChanges')}\n`));
            return true;
          }
          ctx.conversation.addUserMessage(
            `다음 git diff를 코드 리뷰해줘. 보안 취약점, 버그, 성능, 코드 스타일 관점에서 분석하고 개선 사항을 알려줘.\n\n\`\`\`diff\n${diff}\n\`\`\``
          );
          return false;
        } catch {
          console.log(chalk.yellow(t('cmd.diff.notGit')));
          return true;
        }
      },
    },
    {
      name: '/search',
      description: 'Search past conversation sessions',
      handler: async (args) => {
        if (!args) {
          console.log(chalk.yellow(t('cmd.search.usage')));
          return true;
        }
        const home = process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();
        const sessionsDir = path.join(home, '.codi', 'sessions');
        if (!fs.existsSync(sessionsDir)) {
          console.log(chalk.dim(`\n${t('cmd.search.noSessions')}\n`));
          return true;
        }
        const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
        const results: { sessionId: string; date: string; preview: string }[] = [];
        const keyword = args.toLowerCase();

        for (const file of files) {
          if (results.length >= 10) break;
          const filePath = path.join(sessionsDir, file);
          const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
          for (const line of lines) {
            if (results.length >= 10) break;
            if (line.toLowerCase().includes(keyword)) {
              const sessionId = file.replace('.jsonl', '');
              const stat = fs.statSync(filePath);
              const date = stat.mtime.toISOString().split('T')[0]!;
              const preview = line.length > 100 ? line.slice(0, 100) + '...' : line;
              results.push({ sessionId, date, preview });
              break;
            }
          }
        }

        if (results.length === 0) {
          console.log(chalk.dim(`\n${t('cmd.search.noResults', args)}\n`));
        } else {
          console.log(chalk.bold(`\n${t('cmd.search.results', args)}\n`));
          for (const r of results) {
            console.log(`  ${chalk.cyan(r.sessionId)} ${chalk.dim(r.date)}`);
            console.log(`    ${chalk.dim(r.preview)}`);
          }
          console.log('');
        }
        return true;
      },
    },
    {
      name: '/fix',
      description: 'Run a command and auto-fix errors (e.g., /fix npm run build)',
      handler: async (args, ctx) => {
        if (!args) {
          console.log(chalk.yellow(t('cmd.fix.usage')));
          return true;
        }
        const { execSync } = await import('child_process');
        try {
          const isWin = os.platform() === 'win32';
          const shell = isWin ? 'powershell.exe' : undefined;
          const fixCmd = isWin ? `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${args}` : args;
          const cmdOutput = execSync(fixCmd, { encoding: 'utf-8', cwd: process.cwd(), stdio: 'pipe', shell });
          console.log(chalk.green(`\n✓ ${t('cmd.fix.success')}\n`));
          if (cmdOutput.trim()) console.log(chalk.dim(cmdOutput));
          return true;
        } catch (err: unknown) {
          const error = err as { stdout?: string; stderr?: string };
          const errorOutput = (error.stderr || '') + (error.stdout || '');
          console.log(chalk.red(`\n${t('cmd.fix.failed', args)}\n`));
          ctx.conversation.addUserMessage(
            `다음 명령어를 실행했더니 에러가 발생했어. 에러를 분석하고 코드를 수정해줘.\n\nCommand: ${args}\n\n\`\`\`\n${errorOutput}\n\`\`\``
          );
          return false;
        }
      },
    },
    {
      name: '/undo',
      description: 'Undo the most recent file edit (rollback from backup)',
      handler: async (args) => {
        const { getBackupHistory, undoLast } = await import('../tools/file-backup.js');

        if (args === 'list') {
          const history = getBackupHistory();
          if (history.length === 0) {
            console.log(chalk.dim(`\n${t('cmd.undo.noHistory')}\n`));
            return true;
          }
          console.log(chalk.bold(`\n${t('cmd.undo.history', String(Math.min(history.length, 20)))}\n`));
          const recent = history.slice(-20).reverse();
          for (let i = 0; i < recent.length; i++) {
            const entry = recent[i]!;
            const time = new Date(entry.timestamp).toLocaleTimeString();
            const tag = entry.wasNew ? chalk.yellow(t('cmd.undo.newFile')) : chalk.cyan(t('cmd.undo.modified'));
            console.log(`  ${i + 1}. ${tag} ${entry.originalPath} ${chalk.dim(time)}`);
          }
          console.log('');
          return true;
        }

        const entry = undoLast();
        if (!entry) {
          console.log(chalk.yellow(`\n${t('cmd.undo.nothing')}\n`));
          return true;
        }

        const action = entry.wasNew ? t('cmd.undo.deleted') : t('cmd.undo.restored');
        console.log(chalk.green(`\n✓ ${t('cmd.undo.done', entry.originalPath)}`));
        console.log(chalk.dim(`  ${action}`));
        console.log('');
        return true;
      },
    },
    {
      name: '/branch',
      description: 'Create and switch to a new branch, or show current branch',
      handler: async (args) => {
        const { execSync } = await import('child_process');
        try {
          if (!args) {
            const current = execSync('git branch --show-current', {
              encoding: 'utf-8',
              cwd: process.cwd(),
            }).trim();
            const branches = execSync('git branch -a', {
              encoding: 'utf-8',
              cwd: process.cwd(),
            }).trim();
            console.log(chalk.bold(`\n${t('cmd.branch.current', chalk.green(current || t('cmd.branch.detached')))}\n`));
            console.log(branches);
            console.log('');
          } else {
            const name = args.trim();
            execSync(`git checkout -b ${name}`, {
              encoding: 'utf-8',
              cwd: process.cwd(),
            });
            console.log(chalk.green(`\n✓ ${t('cmd.branch.created', name)}\n`));
          }
        } catch (err: unknown) {
          const error = err as { stderr?: string; message?: string };
          const msg = error.stderr || error.message || 'Unknown error';
          console.log(chalk.red(`\n${t('cmd.branch.failed', msg.trim())}\n`));
        }
        return true;
      },
    },
    {
      name: '/stash',
      description: 'Git stash management (pop, list, drop, or save)',
      handler: async (args) => {
        const { execSync } = await import('child_process');
        const sub = args.trim().split(/\s+/);
        const action = sub[0] || 'push';

        const allowed = ['push', 'pop', 'list', 'drop', 'show', 'apply', 'clear'];
        if (!allowed.includes(action)) {
          console.log(chalk.yellow(t('cmd.stash.usage', allowed.join('|'))));
          return true;
        }

        try {
          if (action === 'clear') {
            console.log(chalk.yellow(`⚠ ${t('cmd.stash.clearWarn')}`));
          }

          const cmd = `git stash ${args.trim() || 'push'}`;
          const cmdOutput = execSync(cmd, {
            encoding: 'utf-8',
            cwd: process.cwd(),
          });
          console.log(cmdOutput.trim() ? `\n${cmdOutput.trim()}\n` : chalk.dim(`\n${t('cmd.stash.noOutput')}\n`));
        } catch (err: unknown) {
          const error = err as { stderr?: string; stdout?: string; message?: string };
          const msg = error.stderr || error.stdout || error.message || 'Unknown error';
          console.log(chalk.red(`\n${t('cmd.stash.failed', msg.trim())}\n`));
        }
        return true;
      },
    },
    {
      name: '/pr',
      description: 'Generate a pull request description from current branch diff',
      handler: async (_args, ctx) => {
        const { execSync } = await import('child_process');
        try {
          const currentBranch = execSync('git branch --show-current', {
            encoding: 'utf-8',
            cwd: process.cwd(),
          }).trim();

          if (!currentBranch) {
            console.log(chalk.yellow(t('cmd.pr.notOnBranch')));
            return true;
          }

          let baseBranch = 'main';
          try {
            execSync('git rev-parse --verify main', {
              encoding: 'utf-8',
              cwd: process.cwd(),
              stdio: 'pipe',
            });
          } catch {
            try {
              execSync('git rev-parse --verify master', {
                encoding: 'utf-8',
                cwd: process.cwd(),
                stdio: 'pipe',
              });
              baseBranch = 'master';
            } catch {
              console.log(chalk.yellow(t('cmd.pr.noBase')));
              return true;
            }
          }

          if (currentBranch === baseBranch) {
            console.log(chalk.yellow(t('cmd.pr.onBase', baseBranch)));
            return true;
          }

          let commitLog = '';
          try {
            commitLog = execSync(`git log ${baseBranch}..HEAD --oneline`, {
              encoding: 'utf-8',
              cwd: process.cwd(),
            }).trim();
          } catch {
            // no merge base
          }

          if (!commitLog) {
            console.log(chalk.yellow(t('cmd.pr.noCommits', baseBranch)));
            return true;
          }

          let diffStat = '';
          try {
            diffStat = execSync(`git diff ${baseBranch}...HEAD --stat`, {
              encoding: 'utf-8',
              cwd: process.cwd(),
            }).trim();
          } catch {
            // ignore
          }

          let diff = '';
          try {
            diff = execSync(`git diff ${baseBranch}...HEAD`, {
              encoding: 'utf-8',
              cwd: process.cwd(),
              maxBuffer: 10 * 1024 * 1024,
            });
            if (diff.length > 50_000) {
              diff = diff.slice(0, 50_000) + '\n\n... (diff truncated, too large)';
            }
          } catch {
            // ignore
          }

          console.log(chalk.dim(`\n${t('cmd.pr.analyzing', String(commitLog.split('\n').length), currentBranch)}\n`));

          ctx.conversation.addUserMessage(
            `현재 브랜치 \`${currentBranch}\`에서 \`${baseBranch}\`로 보낼 Pull Request 설명을 생성해줘.\n\n다음 형식의 마크다운으로 출력해줘:\n- **Title**: PR 제목 (70자 이내, 영문)\n- **## Summary**: 변경 사항 요약 (1-3 bullet points)\n- **## Changes**: 주요 변경 파일 및 내용\n- **## Test Plan**: 테스트 계획 체크리스트\n\n### Commits:\n\`\`\`\n${commitLog}\n\`\`\`\n\n### Diff stat:\n\`\`\`\n${diffStat}\n\`\`\`\n\n### Full diff:\n\`\`\`diff\n${diff}\n\`\`\``
          );
          return false;
        } catch {
          console.log(chalk.yellow(t('cmd.diff.notGit')));
          return true;
        }
      },
    },
    {
      name: '/mcp',
      description: 'Show MCP server status',
      handler: async () => {
        const servers = mcpManager.listServers();
        if (servers.length === 0) {
          console.log(chalk.dim(`\n${t('cmd.mcp.noServers')}\n`));
          console.log(chalk.dim(t('cmd.mcp.addHint')));
          return true;
        }

        console.log(chalk.bold(`\n${t('cmd.mcp.title')}\n`));
        for (const s of servers) {
          console.log(`  ${chalk.green('●')} ${s.name}`);
          for (const tool of s.tools) {
            console.log(chalk.dim(`    - ${tool}`));
          }
        }
        console.log('');
        return true;
      },
    },
    {
      name: '/lang',
      aliases: ['/language', '/locale'],
      description: 'Change UI language (e.g., /lang ko, /lang en)',
      handler: async (args, ctx) => {
        if (!args) {
          console.log(chalk.cyan(t('cmd.lang.current', getLocaleDisplayName(getLocale()))));
          console.log(chalk.dim(t('cmd.lang.available')));
          return true;
        }

        const code = args.trim().toLowerCase();
        const supported = getSupportedLocales();
        if (!supported.includes(code as Locale)) {
          console.log(chalk.yellow(t('cmd.lang.usage')));
          console.log(chalk.dim(t('cmd.lang.available')));
          return true;
        }

        setLocale(code as Locale);

        // Save to user config
        try {
          const home = process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();
          const settingsPath = path.join(home, '.codi', 'settings.json');
          let settings: Record<string, unknown> = {};
          if (fs.existsSync(settingsPath)) {
            try {
              settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            } catch {
              settings = {};
            }
          }
          settings['locale'] = code;
          const dir = path.dirname(settingsPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
        } catch {
          // Non-fatal
        }

        // Reload system prompt with new locale
        ctx.reloadSystemPrompt();

        console.log(chalk.green(`✓ ${t('cmd.lang.changed', getLocaleDisplayName(code as Locale))}`));
        return true;
      },
    },
  ];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Custom slash commands from .codi/commands/
export function loadCustomCommands(): SlashCommand[] {
  const commands: SlashCommand[] = [];
  const home = process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();

  const dirs = [
    path.join(home, '.codi', 'commands'),
    path.join(process.cwd(), '.codi', 'commands'),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));

    for (const file of files) {
      const name = '/' + file.replace('.md', '');
      const filePath = path.join(dir, file);

      commands.push({
        name,
        description: `Custom command from ${path.relative(process.cwd(), filePath)}`,
        handler: async (_args, ctx) => {
          let content = fs.readFileSync(filePath, 'utf-8');

          // Variable substitution
          content = content
            .replace(/\{\{cwd\}\}/g, process.cwd())
            .replace(/\{\{date\}\}/g, new Date().toISOString().split('T')[0]!)
            .replace(/\{\{file_path\}\}/g, _args || '');

          // Inject as a user message
          await ctx.conversation.addUserMessage(content);
          return false; // Don't consume - let the agent process it
        },
      });
    }
  }

  return commands;
}
