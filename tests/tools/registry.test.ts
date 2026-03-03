import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { Tool } from '../../src/tools/tool.js';

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: overrides.name ?? 'test-tool',
    description: overrides.description ?? 'A test tool',
    inputSchema: overrides.inputSchema ?? { type: 'object', properties: {} },
    dangerous: overrides.dangerous ?? false,
    readOnly: overrides.readOnly ?? false,
    execute: overrides.execute ?? (async () => ({ success: true, output: 'ok' })),
  };
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('register + get returns the tool', () => {
    const tool = makeTool({ name: 'my-tool' });
    registry.register(tool);
    expect(registry.get('my-tool')).toBe(tool);
  });

  it('registerAll registers multiple tools', () => {
    const tools = [makeTool({ name: 'a' }), makeTool({ name: 'b' }), makeTool({ name: 'c' })];
    registry.registerAll(tools);
    expect(registry.listNames()).toEqual(['a', 'b', 'c']);
  });

  it('has returns true for existing tool', () => {
    registry.register(makeTool({ name: 'exists' }));
    expect(registry.has('exists')).toBe(true);
  });

  it('has returns false for non-existing tool', () => {
    expect(registry.has('nope')).toBe(false);
  });

  it('remove deletes a tool', () => {
    registry.register(makeTool({ name: 'to-remove' }));
    expect(registry.remove('to-remove')).toBe(true);
    expect(registry.has('to-remove')).toBe(false);
  });

  it('list returns all registered tools', () => {
    const toolA = makeTool({ name: 'a' });
    const toolB = makeTool({ name: 'b' });
    registry.registerAll([toolA, toolB]);
    expect(registry.list()).toEqual([toolA, toolB]);
  });

  it('listNames returns all tool names', () => {
    registry.registerAll([makeTool({ name: 'x' }), makeTool({ name: 'y' })]);
    expect(registry.listNames()).toEqual(['x', 'y']);
  });

  it('getToolDefinitions returns LLM JSON schema', () => {
    registry.register(makeTool({ name: 'tool1', description: 'desc1', inputSchema: { type: 'object' } }));
    const defs = registry.getToolDefinitions();
    expect(defs).toEqual([
      { name: 'tool1', description: 'desc1', input_schema: { type: 'object' } },
    ]);
  });

  it('getToolDefinitions filters by readOnly', () => {
    registry.registerAll([
      makeTool({ name: 'reader', readOnly: true }),
      makeTool({ name: 'writer', readOnly: false }),
    ]);
    const defs = registry.getToolDefinitions({ readOnly: true });
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe('reader');
  });

  it('getToolDefinitions filters by names', () => {
    registry.registerAll([makeTool({ name: 'a' }), makeTool({ name: 'b' }), makeTool({ name: 'c' })]);
    const defs = registry.getToolDefinitions({ names: ['a', 'c'] });
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name)).toEqual(['a', 'c']);
  });

  it('clone creates an independent copy', () => {
    registry.register(makeTool({ name: 'original' }));
    const cloned = registry.clone();
    registry.register(makeTool({ name: 'added-after' }));
    expect(cloned.has('added-after')).toBe(false);
    expect(cloned.has('original')).toBe(true);
  });

  it('subset creates a partial registry', () => {
    registry.registerAll([makeTool({ name: 'a' }), makeTool({ name: 'b' }), makeTool({ name: 'c' })]);
    const sub = registry.subset(['a', 'c']);
    expect(sub.listNames()).toEqual(['a', 'c']);
    expect(sub.has('b')).toBe(false);
  });

  it('duplicate registration overwrites', () => {
    registry.register(makeTool({ name: 'dup', description: 'first' }));
    registry.register(makeTool({ name: 'dup', description: 'second' }));
    expect(registry.get('dup')!.description).toBe('second');
  });

  it('get returns undefined for unregistered tool', () => {
    expect(registry.get('ghost')).toBeUndefined();
  });
});
