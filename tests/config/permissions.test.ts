import { describe, it, expect } from 'vitest';
import { parseRule, matchesRule, evaluatePermission } from '../../src/config/permissions.js';

describe('parseRule', () => {
  it('parses simple tool name', () => {
    expect(parseRule('bash')).toEqual({ tool: 'bash' });
  });

  it('parses tool name with pattern', () => {
    expect(parseRule('bash(npm *)')).toEqual({ tool: 'bash', pattern: 'npm *' });
  });

  it('parses tool name with complex pattern', () => {
    expect(parseRule('file_write(/src/.*)')).toEqual({ tool: 'file_write', pattern: '/src/.*' });
  });

  it('handles rule that does not match pattern format', () => {
    // A rule with hyphens won't match \w+, so it falls through to the default
    const result = parseRule('my-tool');
    expect(result.tool).toBe('my-tool');
  });
});

describe('matchesRule', () => {
  it('matches by tool name only', () => {
    const rule = { tool: 'bash' };
    expect(matchesRule(rule, 'bash', {})).toBe(true);
  });

  it('returns false when tool name does not match', () => {
    const rule = { tool: 'bash' };
    expect(matchesRule(rule, 'file_read', {})).toBe(false);
  });

  it('matches tool name with pattern against input value', () => {
    const rule = { tool: 'bash', pattern: 'npm .*' };
    expect(matchesRule(rule, 'bash', { command: 'npm install' })).toBe(true);
  });

  it('returns false when pattern does not match input', () => {
    const rule = { tool: 'bash', pattern: 'npm .*' };
    expect(matchesRule(rule, 'bash', { command: 'rm -rf /' })).toBe(false);
  });

  it('converts wildcard * to .* for matching', () => {
    const rule = { tool: 'bash', pattern: 'npm *' };
    expect(matchesRule(rule, 'bash', { command: 'npm test' })).toBe(true);
  });

  it('checks all input values for pattern match', () => {
    const rule = { tool: 'file_write', pattern: '/src/.*' };
    expect(matchesRule(rule, 'file_write', { path: '/src/main.ts', content: 'hello' })).toBe(true);
  });

  it('returns false when no input values match pattern', () => {
    const rule = { tool: 'file_write', pattern: '/src/.*' };
    expect(matchesRule(rule, 'file_write', { path: '/etc/passwd', content: 'hello' })).toBe(false);
  });

  it('ignores non-string input values', () => {
    const rule = { tool: 'test', pattern: '42' };
    expect(matchesRule(rule, 'test', { count: 42 })).toBe(false);
  });
});

describe('evaluatePermission', () => {
  const emptyRules = { allow: [] as string[], deny: [] as string[], ask: [] as string[] };

  it('returns deny when deny rule matches', () => {
    const rules = { ...emptyRules, deny: ['bash'] };
    expect(evaluatePermission('bash', {}, rules)).toBe('deny');
  });

  it('returns ask when ask rule matches', () => {
    const rules = { ...emptyRules, ask: ['bash'] };
    expect(evaluatePermission('bash', {}, rules)).toBe('ask');
  });

  it('returns allow when allow rule matches', () => {
    const rules = { ...emptyRules, allow: ['bash'] };
    expect(evaluatePermission('bash', {}, rules)).toBe('allow');
  });

  it('deny takes precedence over ask and allow', () => {
    const rules = { allow: ['bash'], deny: ['bash'], ask: ['bash'] };
    expect(evaluatePermission('bash', {}, rules)).toBe('deny');
  });

  it('ask takes precedence over allow', () => {
    const rules = { allow: ['bash'], deny: [] as string[], ask: ['bash'] };
    expect(evaluatePermission('bash', {}, rules)).toBe('ask');
  });

  it('returns ask as default when no rules match', () => {
    expect(evaluatePermission('bash', {}, emptyRules)).toBe('ask');
  });

  it('evaluates with pattern-based rules', () => {
    const rules = { ...emptyRules, deny: ['bash(rm *)'] };
    expect(evaluatePermission('bash', { command: 'rm -rf /' }, rules)).toBe('deny');
    expect(evaluatePermission('bash', { command: 'ls -la' }, rules)).toBe('ask');
  });

  it('handles empty rules arrays', () => {
    expect(evaluatePermission('any_tool', { any: 'input' }, emptyRules)).toBe('ask');
  });
});
