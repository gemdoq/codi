import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

// Import after mocking
import { getMode, setMode, isPlanMode, savePlan, loadPlan, listPlans } from '../../src/agent/mode-manager.js';

describe('mode-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mode to default
    setMode('execute');
  });

  it('initial mode is execute', () => {
    expect(getMode()).toBe('execute');
  });

  it('setMode to plan and getMode returns plan', () => {
    setMode('plan');
    expect(getMode()).toBe('plan');
  });

  it('isPlanMode returns true in plan mode', () => {
    setMode('plan');
    expect(isPlanMode()).toBe(true);
  });

  it('isPlanMode returns false in execute mode', () => {
    setMode('execute');
    expect(isPlanMode()).toBe(false);
  });

  it('savePlan creates directory and writes file', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = savePlan('my-plan', '# Plan content');
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join('.codi', 'plans')),
      { recursive: true }
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('my-plan.md'),
      '# Plan content',
      'utf-8'
    );
    expect(result).toContain('my-plan.md');
  });

  it('loadPlan returns file content when plan exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('# Saved plan');
    const content = loadPlan('my-plan');
    expect(content).toBe('# Saved plan');
    expect(fs.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining('my-plan.md'),
      'utf-8'
    );
  });

  it('loadPlan returns null when plan does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadPlan('nonexistent')).toBeNull();
  });

  it('listPlans returns plan names from directory', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['plan-a.md', 'plan-b.md', 'notes.txt'] as any);
    const plans = listPlans();
    expect(plans).toEqual(['plan-a', 'plan-b']);
  });

  it('listPlans returns empty array when directory does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(listPlans()).toEqual([]);
  });
});
