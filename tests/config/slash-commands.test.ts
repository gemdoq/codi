import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBuiltinCommands, type SlashCommand, type SlashCommandContext } from '../../src/config/slash-commands.js';

function findCommand(commands: SlashCommand[], name: string): SlashCommand {
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) throw new Error(`Command not found: ${name}`);
  return cmd;
}

function createMockContext(overrides?: Partial<SlashCommandContext>): SlashCommandContext {
  return {
    conversation: {
      addUserMessage: vi.fn(),
      clear: vi.fn(),
      getMessages: vi.fn(() => []),
      getMessageCount: vi.fn(() => 0),
      estimateTokens: vi.fn(() => 0),
      setSystemPrompt: vi.fn(),
      serialize: vi.fn(() => ({ systemPrompt: '', messages: [] })),
    } as unknown as SlashCommandContext['conversation'],
    provider: {} as SlashCommandContext['provider'],
    compressor: {} as SlashCommandContext['compressor'],
    setProvider: vi.fn(),
    reloadSystemPrompt: vi.fn(),
    ...overrides,
  };
}

describe('slash commands registration', () => {
  it('includes /commit command', () => {
    const commands = createBuiltinCommands();
    expect(findCommand(commands, '/commit')).toBeDefined();
  });

  it('includes /review command', () => {
    const commands = createBuiltinCommands();
    expect(findCommand(commands, '/review')).toBeDefined();
  });

  it('includes /search command', () => {
    const commands = createBuiltinCommands();
    expect(findCommand(commands, '/search')).toBeDefined();
  });

  it('includes /fix command', () => {
    const commands = createBuiltinCommands();
    expect(findCommand(commands, '/fix')).toBeDefined();
  });
});

describe('/commit', () => {
  let commands: SlashCommand[];
  let ctx: SlashCommandContext;

  beforeEach(() => {
    commands = createBuiltinCommands();
    ctx = createMockContext();
  });

  it('returns true with no changes', async () => {
    vi.doMock('child_process', () => ({
      execSync: vi.fn(() => ''),
    }));

    const cmd = findCommand(commands, '/commit');
    // When diff is empty, should return true
    const result = await cmd.handler('', ctx);
    // If git is not available in test env, it returns true anyway
    expect(result).toBe(true);
  });

  it('has correct description', () => {
    const cmd = findCommand(commands, '/commit');
    expect(cmd.description).toContain('commit');
  });
});

describe('/review', () => {
  let commands: SlashCommand[];
  let ctx: SlashCommandContext;

  beforeEach(() => {
    commands = createBuiltinCommands();
    ctx = createMockContext();
  });

  it('returns true with no changes', async () => {
    const cmd = findCommand(commands, '/review');
    const result = await cmd.handler('', ctx);
    expect(result).toBe(true);
  });

  it('has correct description', () => {
    const cmd = findCommand(commands, '/review');
    expect(cmd.description).toContain('review');
  });
});

describe('/search', () => {
  let commands: SlashCommand[];
  let ctx: SlashCommandContext;

  beforeEach(() => {
    commands = createBuiltinCommands();
    ctx = createMockContext();
  });

  it('returns true when no args provided', async () => {
    const cmd = findCommand(commands, '/search');
    const result = await cmd.handler('', ctx);
    expect(result).toBe(true);
  });

  it('returns true (direct output) regardless of results', async () => {
    const cmd = findCommand(commands, '/search');
    const result = await cmd.handler('some-keyword', ctx);
    expect(result).toBe(true);
  });

  it('has correct description', () => {
    const cmd = findCommand(commands, '/search');
    expect(cmd.description).toContain('Search');
  });
});

describe('/fix', () => {
  let commands: SlashCommand[];
  let ctx: SlashCommandContext;

  beforeEach(() => {
    commands = createBuiltinCommands();
    ctx = createMockContext();
  });

  it('returns true when no args provided', async () => {
    const cmd = findCommand(commands, '/fix');
    const result = await cmd.handler('', ctx);
    expect(result).toBe(true);
  });

  it('returns true when command succeeds', async () => {
    const cmd = findCommand(commands, '/fix');
    const result = await cmd.handler('echo hello', ctx);
    expect(result).toBe(true);
  });

  it('returns false and injects prompt when command fails', async () => {
    const childProcess = await import('child_process');
    const spy = vi.spyOn(childProcess, 'execSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('Command failed'), { stderr: 'some error output', stdout: '' });
    });

    const cmd = findCommand(commands, '/fix');
    const result = await cmd.handler('npm run build', ctx);
    expect(result).toBe(false);
    expect(ctx.conversation.addUserMessage).toHaveBeenCalledTimes(1);
    const msg = (ctx.conversation.addUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(msg).toContain('에러가 발생했어');

    spy.mockRestore();
  });

  it('has correct description', () => {
    const cmd = findCommand(commands, '/fix');
    expect(cmd.description).toContain('auto-fix');
  });
});
