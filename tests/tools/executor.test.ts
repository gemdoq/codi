import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { Tool } from '../../src/tools/tool.js';
import type { ToolCall } from '../../src/llm/types.js';

// Mock the renderer to avoid console output
vi.mock('../../src/ui/renderer.js', () => ({
  renderToolCall: () => '',
  renderToolResult: () => '',
}));

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: overrides.name ?? 'test-tool',
    description: overrides.description ?? 'A test tool',
    inputSchema: overrides.inputSchema ?? { type: 'object' },
    dangerous: overrides.dangerous ?? false,
    readOnly: overrides.readOnly ?? false,
    execute: overrides.execute ?? vi.fn(async () => ({ success: true, output: 'ok' })),
  };
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: overrides.id ?? 'call-1',
    name: overrides.name ?? 'test-tool',
    input: overrides.input ?? {},
  };
}

describe('ToolExecutor', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('executes a safe tool successfully', async () => {
    const tool = makeTool({ name: 'safe', execute: vi.fn(async () => ({ success: true, output: 'done' })) });
    registry.register(tool);
    const executor = new ToolExecutor(registry);
    const result = await executor.executeOne(makeToolCall({ name: 'safe' }));
    expect(result.result.success).toBe(true);
    expect(result.result.output).toBe('done');
    expect(result.toolName).toBe('safe');
  });

  it('executes a dangerous tool when permission is granted', async () => {
    const tool = makeTool({ name: 'danger', dangerous: true });
    registry.register(tool);
    const permissionCheck = vi.fn(async () => true);
    const executor = new ToolExecutor(registry, { permissionCheck });
    const result = await executor.executeOne(makeToolCall({ name: 'danger' }));
    expect(result.result.success).toBe(true);
    expect(permissionCheck).toHaveBeenCalled();
  });

  it('returns error when permission is denied for dangerous tool', async () => {
    const tool = makeTool({ name: 'danger', dangerous: true });
    registry.register(tool);
    const permissionCheck = vi.fn(async () => false);
    const executor = new ToolExecutor(registry, { permissionCheck });
    const result = await executor.executeOne(makeToolCall({ name: 'danger' }));
    expect(result.result.success).toBe(false);
    expect(result.result.error).toContain('Permission denied');
  });

  it('returns error for unregistered tool', async () => {
    const executor = new ToolExecutor(registry);
    const result = await executor.executeOne(makeToolCall({ name: 'nonexistent' }));
    expect(result.result.success).toBe(false);
    expect(result.result.error).toContain('Unknown tool');
  });

  it('executeMany runs safe tools in parallel', async () => {
    const order: string[] = [];
    const toolA = makeTool({
      name: 'a',
      execute: async () => { order.push('a'); return { success: true, output: 'a' }; },
    });
    const toolB = makeTool({
      name: 'b',
      execute: async () => { order.push('b'); return { success: true, output: 'b' }; },
    });
    registry.registerAll([toolA, toolB]);
    const executor = new ToolExecutor(registry);
    const results = await executor.executeMany([
      makeToolCall({ id: 'c1', name: 'a' }),
      makeToolCall({ id: 'c2', name: 'b' }),
    ]);
    expect(results).toHaveLength(2);
    // Results should be in original order
    expect(results[0]!.toolName).toBe('a');
    expect(results[1]!.toolName).toBe('b');
  });

  it('executeMany runs dangerous tools sequentially', async () => {
    const order: string[] = [];
    const toolA = makeTool({
      name: 'a',
      dangerous: true,
      execute: async () => { order.push('a'); return { success: true, output: 'a' }; },
    });
    const toolB = makeTool({
      name: 'b',
      dangerous: true,
      execute: async () => { order.push('b'); return { success: true, output: 'b' }; },
    });
    registry.registerAll([toolA, toolB]);
    const executor = new ToolExecutor(registry);
    const results = await executor.executeMany([
      makeToolCall({ id: 'c1', name: 'a' }),
      makeToolCall({ id: 'c2', name: 'b' }),
    ]);
    expect(results).toHaveLength(2);
    // Dangerous tools executed sequentially => order is guaranteed
    expect(order).toEqual(['a', 'b']);
  });

  it('preHook can block execution', async () => {
    const tool = makeTool({ name: 'blocked' });
    registry.register(tool);
    const preHook = vi.fn(async () => ({ proceed: false }));
    const executor = new ToolExecutor(registry, { preHook });
    const result = await executor.executeOne(makeToolCall({ name: 'blocked' }));
    expect(result.result.success).toBe(false);
    expect(result.result.error).toContain('blocked by hook');
  });

  it('preHook can modify input', async () => {
    const executeFn = vi.fn(async (input: Record<string, unknown>) => ({
      success: true,
      output: String(input['modified']),
    }));
    const tool = makeTool({ name: 'modifiable', execute: executeFn });
    registry.register(tool);
    const preHook = vi.fn(async () => ({
      proceed: true,
      updatedInput: { modified: 'yes' },
    }));
    const executor = new ToolExecutor(registry, { preHook });
    await executor.executeOne(makeToolCall({ name: 'modifiable' }));
    expect(executeFn).toHaveBeenCalledWith({ modified: 'yes' });
  });

  it('postHook is called after execution', async () => {
    const tool = makeTool({ name: 'hooked' });
    registry.register(tool);
    const postHook = vi.fn(async () => {});
    const executor = new ToolExecutor(registry, { postHook });
    await executor.executeOne(makeToolCall({ name: 'hooked' }));
    expect(postHook).toHaveBeenCalledOnce();
    expect(postHook).toHaveBeenCalledWith('hooked', expect.any(Object), expect.objectContaining({ success: true }));
  });

  it('returns error result when tool throws', async () => {
    const tool = makeTool({
      name: 'thrower',
      execute: async () => { throw new Error('boom'); },
    });
    registry.register(tool);
    const executor = new ToolExecutor(registry);
    const result = await executor.executeOne(makeToolCall({ name: 'thrower' }));
    expect(result.result.success).toBe(false);
    expect(result.result.error).toContain('boom');
  });
});
