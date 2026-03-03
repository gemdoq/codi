import { exec } from 'child_process';
import type { ToolResult } from '../tools/tool.js';
import { configManager, type HookConfig } from '../config/config.js';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'SessionEnd' | 'PreCompact' | 'Stop';

export interface HookResult {
  proceed: boolean;
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

export class HookManager {
  async runHooks(
    event: HookEvent,
    context: {
      tool?: string;
      args?: Record<string, unknown>;
      result?: ToolResult;
      sessionId?: string;
      cwd?: string;
    }
  ): Promise<HookResult> {
    const config = configManager.get();
    const hookConfigs = config.hooks[event];
    if (!hookConfigs || hookConfigs.length === 0) {
      return { proceed: true };
    }

    for (const hookConfig of hookConfigs) {
      // Check matcher
      if (context.tool && hookConfig.matcher) {
        const matcher = new RegExp(hookConfig.matcher);
        if (!matcher.test(context.tool)) continue;
      }

      for (const hook of hookConfig.hooks) {
        if (hook.type === 'command' && hook.command) {
          const result = await this.runCommandHook(hook.command, context, hook.timeout);
          if (!result.proceed) return result;
          if (result.updatedInput) {
            context.args = result.updatedInput;
          }
        }
      }
    }

    return { proceed: true };
  }

  private async runCommandHook(
    command: string,
    context: Record<string, unknown>,
    timeout?: number
  ): Promise<HookResult> {
    return new Promise((resolve) => {
      const stdinData = JSON.stringify({
        tool: context['tool'],
        args: context['args'],
        session_id: context['sessionId'],
        cwd: context['cwd'] || process.cwd(),
      });

      const proc = exec(command, {
        timeout: timeout || 5000,
        cwd: process.cwd(),
        env: { ...process.env },
      }, (err, stdout, stderr) => {
        if (err) {
          // Exit code 2 means block
          if ((err as any).code === 2) {
            resolve({
              proceed: false,
              reason: stderr || stdout || 'Blocked by hook',
            });
            return;
          }
          // Other errors: warn but proceed
          resolve({ proceed: true });
          return;
        }

        // Try to parse JSON output
        try {
          const output = JSON.parse(stdout);
          resolve({
            proceed: output.decision !== 'block',
            reason: output.reason,
            updatedInput: output.updatedInput,
          });
        } catch {
          resolve({ proceed: true });
        }
      });

      // Send context via stdin
      if (proc.stdin) {
        proc.stdin.write(stdinData);
        proc.stdin.end();
      }
    });
  }
}

export const hookManager = new HookManager();
