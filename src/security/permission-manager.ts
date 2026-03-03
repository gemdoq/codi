import * as readline from 'node:readline/promises';
import chalk from 'chalk';
import type { Tool } from '../tools/tool.js';
import { evaluatePermission } from '../config/permissions.js';
import { configManager } from '../config/config.js';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'yolo';

const sessionAllowed: Set<string> = new Set();
const sessionDenied: Set<string> = new Set();

let currentMode: PermissionMode = 'default';

export function setPermissionMode(mode: PermissionMode): void {
  currentMode = mode;
}

export function getPermissionMode(): PermissionMode {
  return currentMode;
}

export async function checkPermission(
  tool: Tool,
  input: Record<string, unknown>
): Promise<boolean> {
  // Non-dangerous tools are always allowed
  if (!tool.dangerous) return true;

  // YOLO mode allows everything
  if (currentMode === 'yolo') return true;

  // Accept edits mode auto-approves file modifications
  if (currentMode === 'acceptEdits' && ['write_file', 'edit_file', 'multi_edit'].includes(tool.name)) {
    return true;
  }

  // Plan mode blocks non-readOnly tools
  if (currentMode === 'plan' && !tool.readOnly) {
    return false;
  }

  const config = configManager.get();
  const decision = evaluatePermission(tool.name, input, config.permissions);

  if (decision === 'allow') return true;
  if (decision === 'deny') {
    console.log(chalk.red(`✗ Permission denied for ${tool.name} (denied by rule)`));
    return false;
  }

  // Check session memory
  const key = `${tool.name}:${JSON.stringify(input)}`;
  if (sessionAllowed.has(tool.name)) return true;
  if (sessionDenied.has(tool.name)) return false;

  // Ask user
  return promptUser(tool, input);
}

async function promptUser(tool: Tool, input: Record<string, unknown>): Promise<boolean> {
  console.log('');
  console.log(chalk.yellow.bold(`⚠ Permission Required: ${tool.name}`));

  // Show relevant input parameters
  const relevantParams = Object.entries(input).filter(([, v]) => v !== undefined);
  for (const [key, value] of relevantParams) {
    const displayValue = typeof value === 'string' && value.length > 200
      ? value.slice(0, 200) + '...'
      : String(value);
    console.log(chalk.dim(`  ${key}: `) + displayValue);
  }
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      chalk.yellow(`Allow? [${chalk.bold('Y')}es / ${chalk.bold('n')}o / ${chalk.bold('a')}lways for this tool] `)
    );
    rl.close();

    const choice = answer.trim().toLowerCase();

    if (choice === 'a' || choice === 'always') {
      sessionAllowed.add(tool.name);
      return true;
    }

    if (choice === 'n' || choice === 'no') {
      return false;
    }

    // Default to yes
    return true;
  } catch {
    rl.close();
    return false;
  }
}

export function resetSessionPermissions(): void {
  sessionAllowed.clear();
  sessionDenied.clear();
}
