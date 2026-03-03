import { exec, spawn } from 'child_process';
import type { Tool, ToolResult } from './tool.js';
import { makeToolResult, makeToolError } from './tool.js';

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
  description: `Execute a bash command. Supports timeout (max 600s, default 120s) and background execution. The working directory persists between calls.`,
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

    if (runInBackground) {
      return runBackgroundTask(command);
    }

    return new Promise((resolve) => {
      exec(command, {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        shell: process.env['SHELL'] || '/bin/bash',
        cwd: process.cwd(),
        env: { ...process.env },
      }, (err, stdout, stderr) => {
        if (err) {
          const exitCode = err.code;
          const output = [
            stdout ? `stdout:\n${stdout}` : '',
            stderr ? `stderr:\n${stderr}` : '',
            `Exit code: ${exitCode}`,
          ].filter(Boolean).join('\n\n');

          if ((err as any).killed) {
            resolve(makeToolError(`Command timed out after ${timeout / 1000}s\n${output}`));
          } else {
            resolve(makeToolResult(output || `Command failed with exit code ${exitCode}`));
          }
          return;
        }

        const output = [
          stdout ? stdout : '',
          stderr ? `stderr:\n${stderr}` : '',
        ].filter(Boolean).join('\n');

        resolve(makeToolResult(output || '(no output)'));
      });
    });
  },
};

function runBackgroundTask(command: string): ToolResult {
  const taskId = `bg_${++taskCounter}`;

  const proc = spawn(command, {
    shell: process.env['SHELL'] || '/bin/bash',
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
    task.process.kill('SIGTERM');
    task.status = 'done';
    return true;
  } catch {
    return false;
  }
}
