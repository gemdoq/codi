import * as fs from 'fs';
import * as path from 'path';

export type AgentMode = 'plan' | 'execute';

let currentMode: AgentMode = 'execute';

export function getMode(): AgentMode {
  return currentMode;
}

export function setMode(mode: AgentMode): void {
  currentMode = mode;
}

export function isPlanMode(): boolean {
  return currentMode === 'plan';
}

export function savePlan(name: string, content: string): string {
  const planDir = path.join(process.cwd(), '.codi', 'plans');
  if (!fs.existsSync(planDir)) {
    fs.mkdirSync(planDir, { recursive: true });
  }

  const planPath = path.join(planDir, `${name}.md`);
  fs.writeFileSync(planPath, content, 'utf-8');
  return planPath;
}

export function loadPlan(name: string): string | null {
  const planPath = path.join(process.cwd(), '.codi', 'plans', `${name}.md`);
  if (!fs.existsSync(planPath)) return null;
  return fs.readFileSync(planPath, 'utf-8');
}

export function listPlans(): string[] {
  const planDir = path.join(process.cwd(), '.codi', 'plans');
  if (!fs.existsSync(planDir)) return [];
  return fs.readdirSync(planDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace('.md', ''));
}
