import { spawn } from 'child_process';
import * as os from 'os';
import chalk from 'chalk';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';
import { validateCommand } from '../security/command-validator.js';
import { getPermissionMode } from '../security/permission-manager.js';
import { logger } from '../utils/logger.js';

export type BashOutputCallback = (chunk: string) => void;

// 현재 실행에 사용할 onOutput 콜백 (executor에서 설정)
let _currentOnOutput: BashOutputCallback | null = null;

export function setBashOutputCallback(cb: BashOutputCallback | null): void {
  _currentOnOutput = cb;
}

function getDefaultShell(): string {
  if (os.platform() === 'win32') {
    // PowerShell is preferred on Windows — it supports many Unix-like commands
    // (mkdir, rm, cat, curl, etc.) and handles paths more gracefully than cmd.exe
    return 'powershell.exe';
  }
  return process.env['SHELL'] || '/bin/bash';
}

// Background tasks storage
const backgroundTasks: Map<string, {
  process: ReturnType<typeof spawn>;
  output: string;
  status: string;
  exitCode?: number;
}> = new Map();

let taskCounter = 0;

export const bashTool: Tool = {
  name: 'bash',
  description: `Execute a shell command. Supports timeout (max 600s, default 120s) and background execution. The working directory persists between calls. Uses the platform default shell (bash on Unix, PowerShell on Windows).`,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
      description: { type: 'string', description: 'Brief description of what the command does' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (max 600000, default 120000)' },
      run_in_background: { type: 'boolean', description: 'Run in background and return a task ID' },
    },
    required: ['command'],
  },
  dangerous: true,
  readOnly: false,

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const command = String(input['command']);
    const timeout = Math.min(Number(input['timeout']) || 120_000, 600_000);
    const runInBackground = input['run_in_background'] === true;

    if (!command.trim()) {
      return makeToolError('Command cannot be empty');
    }

    // --yolo 모드가 아닐 때만 명령어 검증 수행
    if (getPermissionMode() !== 'yolo') {
      const validation = validateCommand(command);
      if (!validation.allowed) {
        return makeToolError(`명령어가 차단되었습니다: ${validation.reason}`);
      }
      if (validation.level === 'warned') {
        console.log(chalk.yellow(`⚠ 경고: ${validation.reason}`));
      }
    }

    if (runInBackground) {
      return runBackgroundTask(command);
    }

    return new Promise((resolve) => {
      // On Windows, prefix command with UTF-8 encoding to prevent Korean text corruption
      const finalCommand = os.platform() === 'win32'
        ? `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`
        : command;

      const startTime = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const proc = spawn(finalCommand, {
        shell: getDefaultShell(),
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // 타임아웃 처리
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        // SIGTERM 후 5초 내 종료되지 않으면 SIGKILL
        setTimeout(() => proc.kill('SIGKILL'), 5000);
      }, timeout);

      const onOutput = _currentOnOutput;

      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        if (onOutput) {
          onOutput(chunk);
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        if (onOutput) {
          onOutput(chunk);
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        const exitCode = code ?? 1;

        if (timedOut) {
          logger.info('bash 명령어 실행', { command, exitCode, durationMs, timedOut: true });
          const output = [
            stdout ? `stdout:\n${stdout}` : '',
            stderr ? `stderr:\n${stderr}` : '',
            `Exit code: ${exitCode}`,
          ].filter(Boolean).join('\n\n');
          resolve(makeToolError(`Command timed out after ${timeout / 1000}s\n${output}`));
          return;
        }

        if (exitCode !== 0) {
          logger.info('bash 명령어 실행', { command, exitCode, durationMs, timedOut: false });
          const output = [
            stdout ? `stdout:\n${stdout}` : '',
            stderr ? `stderr:\n${stderr}` : '',
            `Exit code: ${exitCode}`,
          ].filter(Boolean).join('\n\n');
          resolve(makeToolResult(output || `Command failed with exit code ${exitCode}`));
          return;
        }

        logger.info('bash 명령어 실행', { command, exitCode: 0, durationMs });

        const output = [
          stdout ? stdout : '',
          stderr ? `stderr:\n${stderr}` : '',
        ].filter(Boolean).join('\n');

        resolve(makeToolResult(output || '(no output)'));
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        logger.info('bash 명령어 실행 실패', { command, durationMs, error: err.message });
        resolve(makeToolError(`Failed to execute command: ${err.message}`));
      });
    });
  },
};

function runBackgroundTask(command: string): ToolResult {
  const taskId = `bg_${++taskCounter}`;
  const bgCommand = os.platform() === 'win32'
    ? `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`
    : command;

  const proc = spawn(bgCommand, {
    shell: getDefaultShell(),
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  const task: { process: ReturnType<typeof spawn>; output: string; status: string; exitCode?: number } = { process: proc, output: '', status: 'running', exitCode: undefined };
  backgroundTasks.set(taskId, task);

  proc.stdout?.on('data', (data) => {
    task.output += data.toString();
  });

  proc.stderr?.on('data', (data) => {
    task.output += data.toString();
  });

  proc.on('close', (code) => {
    task.status = code === 0 ? 'done' : 'error';
    task.exitCode = code ?? 1;
  });

  proc.on('error', (err) => {
    task.status = 'error';
    task.output += `\nProcess error: ${err.message}`;
  });

  return makeToolResult(`Background task started with ID: ${taskId}\nUse task_output tool to check results.`);
}

// Utility to get background task output
export function getBackgroundTaskOutput(taskId: string): { status: string; output: string } | null {
  const task = backgroundTasks.get(taskId);
  if (!task) return null;
  return { status: task.status, output: task.output };
}

export function stopBackgroundTask(taskId: string): boolean {
  const task = backgroundTasks.get(taskId);
  if (!task || task.status !== 'running') return false;
  try {
    task.process.kill();
    task.status = 'done';
    return true;
  } catch {
    return false;
  }
}
