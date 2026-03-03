export interface PermissionRule {
  tool: string;
  pattern?: string; // Optional argument pattern
}

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export function parseRule(rule: string): PermissionRule {
  const match = rule.match(/^(\w+)(?:\((.+)\))?$/);
  if (match) {
    return { tool: match[1]!, pattern: match[2] };
  }
  return { tool: rule };
}

export function matchesRule(rule: PermissionRule, toolName: string, input: Record<string, unknown>): boolean {
  if (rule.tool !== toolName) return false;

  if (!rule.pattern) return true;

  // Check if any input value matches the pattern
  const pattern = new RegExp(rule.pattern.replace(/\*/g, '.*'));
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && pattern.test(value)) {
      return true;
    }
  }

  return false;
}

export function evaluatePermission(
  toolName: string,
  input: Record<string, unknown>,
  rules: { allow: string[]; deny: string[]; ask: string[] }
): PermissionDecision {
  // Deny takes precedence
  for (const rule of rules.deny) {
    if (matchesRule(parseRule(rule), toolName, input)) {
      return 'deny';
    }
  }

  // Then ask
  for (const rule of rules.ask) {
    if (matchesRule(parseRule(rule), toolName, input)) {
      return 'ask';
    }
  }

  // Then allow
  for (const rule of rules.allow) {
    if (matchesRule(parseRule(rule), toolName, input)) {
      return 'allow';
    }
  }

  // Default: ask for dangerous tools, allow for safe
  return 'ask';
}
