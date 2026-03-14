import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { tokenTracker } from '../agent/token-tracker.js';
import { sessionManager } from '../agent/session.js';
import { memoryManager } from '../agent/memory.js';
import { checkpointManager } from '../agent/checkpoint.js';
import { setMode, getMode, listPlans } from '../agent/mode-manager.js';
import { statusLine } from '../ui/status-line.js';
import { mcpManager } from '../mcp/mcp-manager.js';
import { configManager } from './config.js';
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
        console.log(chalk.bold('\nAvailable Commands:\n'));
        for (const cmd of commands) {
          const aliases = cmd.aliases ? chalk.dim(` (${cmd.aliases.join(', ')})`) : '';
          console.log(`  ${chalk.cyan(cmd.name)}${aliases} - ${cmd.description}`);
        }
        console.log('');
        console.log(chalk.dim('  Prefixes: ! (bash), @ (file reference)'));
        console.log(chalk.dim('  Use \\ at end of line for multiline input'));
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
        console.log(chalk.dim('\nGoodbye!\n'));
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
        console.log(chalk.green('✓ Conversation cleared'));
        return true;
      },
    },
    {
      name: '/model',
      description: 'Switch model or provider (e.g., /model gpt-4o, /model ollama:llama3.1)',
      handler: async (args, ctx) => {
        if (!args) {
          const info = statusLine.getInfo();
          console.log(chalk.cyan(`Current model: ${info.model} (${info.provider})`));
          return true;
        }

        if (args.includes(':')) {
          const [provider, model] = args.split(':');
          ctx.setProvider(provider!, model!);
        } else {
          ctx.setProvider('', args);
        }
        console.log(chalk.green(`✓ Model switched to: ${args}`));
        return true;
      },
    },
    {
      name: '/compact',
      description: 'Compress conversation history (optional: focus hint)',
      handler: async (args, ctx) => {
        console.log(chalk.dim('Compressing conversation...'));
        await ctx.compressor.compress(ctx.conversation, ctx.provider, args || undefined);
        ctx.reloadSystemPrompt();
        console.log(chalk.green('✓ Conversation compressed'));
        return true;
      },
    },
    {
      name: '/cost',
      description: 'Show token usage and cost',
      handler: async () => {
        const session = tokenTracker.getSessionStats();
        const total = tokenTracker.getStats();

        console.log(chalk.bold('\nToken Usage & Cost:\n'));

        // Session stats
        console.log(chalk.cyan('  [Current Session]'));
        console.log(`    Requests:    ${session.requests}`);
        console.log(`    Input:       ${formatTokens(session.inputTokens)}`);
        console.log(`    Output:      ${formatTokens(session.outputTokens)}`);
        console.log(`    Total:       ${formatTokens(session.totalTokens)}`);
        console.log(`    Cost:        $${session.cost.toFixed(4)}`);
        if (session.requests > 0) {
          console.log(`    Avg/Request: $${session.avgCostPerRequest.toFixed(4)}`);
        }
        if (session.lastRequestCost) {
          console.log(chalk.dim(`    Last Request: $${session.lastRequestCost.cost.toFixed(4)} (${formatTokens(session.lastRequestCost.inputTokens)} in / ${formatTokens(session.lastRequestCost.outputTokens)} out)`));
        }

        // Total stats (only show if different from session)
        if (total.requests !== session.requests) {
          console.log('');
          console.log(chalk.cyan('  [Total Accumulated]'));
          console.log(`    Requests:    ${total.requests}`);
          console.log(`    Input:       ${formatTokens(total.inputTokens)}`);
          console.log(`    Output:      ${formatTokens(total.outputTokens)}`);
          console.log(`    Total:       ${formatTokens(total.totalTokens)}`);
          console.log(`    Cost:        $${total.cost.toFixed(4)}`);
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
        console.log(chalk.bold('\nConfiguration:\n'));
        console.log(chalk.dim(JSON.stringify(config, null, 2)));
        console.log(chalk.dim(`\nConfig files: ${configManager.getConfigPaths().join(', ') || '(none)'}`));
        console.log('');
        return true;
      },
    },
    {
      name: '/permissions',
      description: 'Show permission rules',
      handler: async () => {
        const config = configManager.get();
        console.log(chalk.bold('\nPermission Rules:\n'));
        console.log(chalk.green('  Allow: ') + config.permissions.allow.join(', '));
        console.log(chalk.red('  Deny:  ') + (config.permissions.deny.join(', ') || '(none)'));
        console.log(chalk.yellow('  Ask:   ') + config.permissions.ask.join(', '));
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
        console.log(chalk.green(`✓ Session saved: ${id}`));
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
          console.log(chalk.yellow('No sessions found. Use /save to save a session first.'));
          return true;
        }

        const session = sessionManager.load(id);
        if (!session) {
          console.log(chalk.red(`Session not found: ${id}`));
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

        console.log(chalk.green(`✓ Resumed session: ${id} (${session.meta.messageCount} messages)`));
        return true;
      },
    },
    {
      name: '/fork',
      description: 'Fork current conversation into a new session',
      handler: async (args, ctx) => {
        const name = args || `fork-${Date.now()}`;
        const id = sessionManager.save(ctx.conversation, name, statusLine.getInfo().model);
        console.log(chalk.green(`✓ Conversation forked: ${id}`));
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
        console.log(chalk.cyan(`Mode: ${newMode === 'plan' ? 'PLAN (read-only)' : 'EXECUTE'}`));
        return true;
      },
    },
    {
      name: '/memory',
      description: 'Show or edit auto memory',
      handler: async () => {
        const index = memoryManager.loadIndex();
        const topics = memoryManager.listTopics();

        console.log(chalk.bold('\nAuto Memory:\n'));
        console.log(chalk.dim(`Directory: ${memoryManager.getMemoryDir()}`));

        if (index) {
          console.log(chalk.dim('\nMEMORY.md:'));
          console.log(index);
        } else {
          console.log(chalk.dim('\nNo memory saved yet.'));
        }

        if (topics.length > 0) {
          console.log(chalk.dim(`\nTopics: ${topics.join(', ')}`));
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
          console.log(chalk.yellow('CODI.md already exists'));
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
        console.log(chalk.green('✓ Created CODI.md'));
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
        console.log(chalk.green(`✓ Exported to ${filePath}`));
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
          console.log(chalk.dim('\nNo tasks.\n'));
          return true;
        }
        console.log(chalk.bold('\nTasks:\n'));
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
        const stats = tokenTracker.getStats();
        const mcpServers = mcpManager.listServers();

        console.log(chalk.bold('\nCodi Status:\n'));
        console.log(`  Version:  0.1.0`);
        console.log(`  Model:    ${info.model}`);
        console.log(`  Provider: ${config.provider}`);
        console.log(`  Mode:     ${getMode()}`);
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

        console.log(chalk.bold('\nContext Window:\n'));
        console.log(`  ${bar} ${pct}%`);
        console.log(`  ~${estimated.toLocaleString()} / ${max.toLocaleString()} tokens`);
        console.log(`  Messages: ${ctx.conversation.getMessageCount()}`);
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
          console.log(chalk.yellow('No checkpoints available.'));
          return true;
        }

        const result = checkpointManager.rewind();
        if (!result) {
          console.log(chalk.yellow('No checkpoint to rewind to.'));
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

        console.log(chalk.green(`✓ Rewound to checkpoint${result.description ? `: ${result.description}` : ''}`));
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
            console.log(chalk.dim('\nNo changes.\n'));
          } else {
            const { renderDiff } = await import('../ui/renderer.js');
            console.log('\n' + renderDiff('', '', diff) + '\n');
          }
        } catch {
          console.log(chalk.yellow('Not a git repository or git not available.'));
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

          // 스테이징된 변경이 없으면 수정된 파일 자동 스테이징
          if (!staged.trim() && unstaged.trim()) {
            // 추적되지 않는 파일 확인
            const untracked = execSync('git ls-files --others --exclude-standard', {
              encoding: 'utf-8',
              cwd: process.cwd(),
            }).trim();

            if (untracked) {
              console.log(chalk.yellow(`\n주의: 추적되지 않는 파일이 있습니다 (자동 스테이징 안 됨):`));
              for (const f of untracked.split('\n').slice(0, 10)) {
                console.log(chalk.dim(`  ${f}`));
              }
              if (untracked.split('\n').length > 10) {
                console.log(chalk.dim(`  ... 외 ${untracked.split('\n').length - 10}개`));
              }
              console.log('');
            }

            // 수정된 파일만 자동 스테이징 (추적되지 않는 파일 제외)
            console.log(chalk.dim('수정된 파일을 자동 스테이징합니다...'));
            execSync('git add -u', { encoding: 'utf-8', cwd: process.cwd() });
          }

          // 스테이징 후 최종 diff 확인
          const finalDiff = execSync('git diff --cached', { encoding: 'utf-8', cwd: process.cwd() });
          if (!finalDiff.trim()) {
            console.log(chalk.dim('\nNo changes to commit.\n'));
            return true;
          }

          // 최근 커밋 로그를 분석하여 컨벤션 감지
          let conventionHint = '';
          try {
            const recentLog = execSync('git log --oneline -10', {
              encoding: 'utf-8',
              cwd: process.cwd(),
            }).trim();

            if (recentLog) {
              // Conventional Commits 패턴 감지 (feat:, fix:, chore: 등)
              const conventionalPattern = /^[a-f0-9]+\s+(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\(.+\))?[!]?:/;
              const lines = recentLog.split('\n');
              const conventionalCount = lines.filter((l) => conventionalPattern.test(l)).length;

              if (conventionalCount >= 3) {
                conventionHint = `\n\n이 프로젝트는 Conventional Commits 형식을 사용합니다 (예: feat:, fix:, chore: 등). 같은 형식을 따라주세요.`;
              }

              conventionHint += `\n\n최근 커밋 참고:\n\`\`\`\n${recentLog}\n\`\`\``;
            }
          } catch {
            // 커밋 로그 조회 실패 무시
          }

          ctx.conversation.addUserMessage(
            `다음 git diff를 분석해서 적절한 커밋 메시지를 생성하고, git 도구로 커밋해줘. 이미 스테이징 완료되었으므로 add 없이 commit만 하면 됩니다.${conventionHint}\n\n\`\`\`diff\n${finalDiff}\n\`\`\``
          );
          return false;
        } catch {
          console.log(chalk.yellow('Not a git repository or git not available.'));
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
            console.log(chalk.dim('\nNo changes to review.\n'));
            return true;
          }
          ctx.conversation.addUserMessage(
            `다음 git diff를 코드 리뷰해줘. 보안 취약점, 버그, 성능, 코드 스타일 관점에서 분석하고 개선 사항을 알려줘.\n\n\`\`\`diff\n${diff}\n\`\`\``
          );
          return false;
        } catch {
          console.log(chalk.yellow('Not a git repository or git not available.'));
          return true;
        }
      },
    },
    {
      name: '/search',
      description: 'Search past conversation sessions',
      handler: async (args) => {
        if (!args) {
          console.log(chalk.yellow('Usage: /search <keyword>'));
          return true;
        }
        const home = process.env['HOME'] || process.env['USERPROFILE'] || os.homedir();
        const sessionsDir = path.join(home, '.codi', 'sessions');
        if (!fs.existsSync(sessionsDir)) {
          console.log(chalk.dim('\nNo sessions found.\n'));
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
              break; // one match per session
            }
          }
        }

        if (results.length === 0) {
          console.log(chalk.dim(`\nNo results for "${args}".\n`));
        } else {
          console.log(chalk.bold(`\nSearch results for "${args}":\n`));
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
          console.log(chalk.yellow('Usage: /fix <command>'));
          return true;
        }
        const { execSync } = await import('child_process');
        try {
          const isWin = os.platform() === 'win32';
          const shell = isWin ? 'powershell.exe' : undefined;
          const fixCmd = isWin ? `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${args}` : args;
          const output = execSync(fixCmd, { encoding: 'utf-8', cwd: process.cwd(), stdio: 'pipe', shell });
          console.log(chalk.green(`\n✓ Command succeeded. No errors to fix.\n`));
          if (output.trim()) console.log(chalk.dim(output));
          return true;
        } catch (err: unknown) {
          const error = err as { stdout?: string; stderr?: string };
          const errorOutput = (error.stderr || '') + (error.stdout || '');
          console.log(chalk.red(`\nCommand failed: ${args}\n`));
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
            console.log(chalk.dim('\n되돌릴 파일 변경 이력이 없습니다.\n'));
            return true;
          }
          console.log(chalk.bold(`\n파일 변경 이력 (최근 ${Math.min(history.length, 20)}개):\n`));
          const recent = history.slice(-20).reverse();
          for (let i = 0; i < recent.length; i++) {
            const entry = recent[i]!;
            const time = new Date(entry.timestamp).toLocaleTimeString();
            const tag = entry.wasNew ? chalk.yellow('[새 파일]') : chalk.cyan('[수정]');
            console.log(`  ${i + 1}. ${tag} ${entry.originalPath} ${chalk.dim(time)}`);
          }
          console.log('');
          return true;
        }

        const entry = undoLast();
        if (!entry) {
          console.log(chalk.yellow('\n되돌릴 변경 사항이 없습니다.\n'));
          return true;
        }

        const action = entry.wasNew ? '삭제됨 (새로 생성된 파일)' : '이전 상태로 복원됨';
        console.log(chalk.green(`\n✓ 되돌리기 완료: ${entry.originalPath}`));
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
            // 이름 없으면 현재 브랜치 및 전체 목록 표시
            const current = execSync('git branch --show-current', {
              encoding: 'utf-8',
              cwd: process.cwd(),
            }).trim();
            const branches = execSync('git branch -a', {
              encoding: 'utf-8',
              cwd: process.cwd(),
            }).trim();
            console.log(chalk.bold(`\nCurrent branch: ${chalk.green(current || '(detached HEAD)')}\n`));
            console.log(branches);
            console.log('');
          } else {
            const name = args.trim();
            execSync(`git checkout -b ${name}`, {
              encoding: 'utf-8',
              cwd: process.cwd(),
            });
            console.log(chalk.green(`\n✓ Created and switched to branch: ${name}\n`));
          }
        } catch (err: unknown) {
          const error = err as { stderr?: string; message?: string };
          const msg = error.stderr || error.message || 'Unknown error';
          console.log(chalk.red(`\nBranch operation failed: ${msg.trim()}\n`));
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
          console.log(chalk.yellow(`Usage: /stash [${allowed.join('|')}]`));
          return true;
        }

        try {
          // stash clear는 위험하므로 경고
          if (action === 'clear') {
            console.log(chalk.yellow('⚠ This will drop all stashes permanently.'));
          }

          const cmd = `git stash ${args.trim() || 'push'}`;
          const output = execSync(cmd, {
            encoding: 'utf-8',
            cwd: process.cwd(),
          });
          console.log(output.trim() ? `\n${output.trim()}\n` : chalk.dim('\n(no output)\n'));
        } catch (err: unknown) {
          const error = err as { stderr?: string; stdout?: string; message?: string };
          const msg = error.stderr || error.stdout || error.message || 'Unknown error';
          console.log(chalk.red(`\nStash operation failed: ${msg.trim()}\n`));
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
          // 현재 브랜치 확인
          const currentBranch = execSync('git branch --show-current', {
            encoding: 'utf-8',
            cwd: process.cwd(),
          }).trim();

          if (!currentBranch) {
            console.log(chalk.yellow('Not on a branch (detached HEAD).'));
            return true;
          }

          // 기본 브랜치 탐색 (main 또는 master)
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
              console.log(chalk.yellow('Cannot find base branch (main or master).'));
              return true;
            }
          }

          if (currentBranch === baseBranch) {
            console.log(chalk.yellow(`Already on ${baseBranch}. Switch to a feature branch first.`));
            return true;
          }

          // 커밋 로그와 diff 수집
          let commitLog = '';
          try {
            commitLog = execSync(`git log ${baseBranch}..HEAD --oneline`, {
              encoding: 'utf-8',
              cwd: process.cwd(),
            }).trim();
          } catch {
            // merge-base가 없는 경우
          }

          if (!commitLog) {
            console.log(chalk.yellow(`No commits ahead of ${baseBranch}.`));
            return true;
          }

          let diffStat = '';
          try {
            diffStat = execSync(`git diff ${baseBranch}...HEAD --stat`, {
              encoding: 'utf-8',
              cwd: process.cwd(),
            }).trim();
          } catch {
            // diff stat 실패 무시
          }

          let diff = '';
          try {
            diff = execSync(`git diff ${baseBranch}...HEAD`, {
              encoding: 'utf-8',
              cwd: process.cwd(),
              maxBuffer: 10 * 1024 * 1024,
            });
            // diff가 너무 크면 잘라내기
            if (diff.length > 50_000) {
              diff = diff.slice(0, 50_000) + '\n\n... (diff truncated, too large)';
            }
          } catch {
            // diff 실패 무시
          }

          console.log(chalk.dim(`\nAnalyzing ${commitLog.split('\n').length} commit(s) from ${currentBranch}...\n`));

          ctx.conversation.addUserMessage(
            `현재 브랜치 \`${currentBranch}\`에서 \`${baseBranch}\`로 보낼 Pull Request 설명을 생성해줘.\n\n다음 형식의 마크다운으로 출력해줘:\n- **Title**: PR 제목 (70자 이내, 영문)\n- **## Summary**: 변경 사항 요약 (1-3 bullet points)\n- **## Changes**: 주요 변경 파일 및 내용\n- **## Test Plan**: 테스트 계획 체크리스트\n\n### Commits:\n\`\`\`\n${commitLog}\n\`\`\`\n\n### Diff stat:\n\`\`\`\n${diffStat}\n\`\`\`\n\n### Full diff:\n\`\`\`diff\n${diff}\n\`\`\``
          );
          return false;
        } catch {
          console.log(chalk.yellow('Not a git repository or git not available.'));
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
          console.log(chalk.dim('\nNo MCP servers connected.\n'));
          console.log(chalk.dim('Add servers in .codi/mcp.json or ~/.codi/mcp.json'));
          return true;
        }

        console.log(chalk.bold('\nMCP Servers:\n'));
        for (const s of servers) {
          console.log(`  ${chalk.green('●')} ${s.name}`);
          for (const t of s.tools) {
            console.log(chalk.dim(`    - ${t}`));
          }
        }
        console.log('');
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
